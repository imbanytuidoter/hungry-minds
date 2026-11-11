// Off-chain chat: the player signs in once (NEP-413, see chat-auth.js), then each message is
// a plain HTTP request answered straight away — no transaction, no wallet popup, no gas for
// the player. Usage is written to the ledger and settled on chain in batches
// (`settle_chats`), which can only take what was prepaid: a Mind's food for her keeper, the
// guest's chat credits for anyone else.
//
// The web app reaches this through its own /api/chat route (same origin), so it listens on
// localhost only.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { checkSignIn, issueToken, readToken } = require("./chat-auth");
const { Ledger } = require("./chat-ledger");
const { makeRateLimiter, scrubUrls } = require("./gateway/limits");

const PORT = parseInt(process.env.CHAT_PORT || "8788", 10);
const SETTLE_EVERY_MS = parseInt(process.env.SETTLE_EVERY_MS || "60000", 10);
// Settle sooner once this many messages are waiting, so unpaid usage stays small.
const SETTLE_AT = parseInt(process.env.SETTLE_AT || "30", 10);
const SETTLE_GAS = "300000000000000";
const MAX_PROMPT_BYTES = 500; // the contract's MAX_PROMPT_LEN
const MAX_AGENT_PROMPT_BYTES = 2000;
const HISTORY_TURNS = 6;

// The HMAC key for sessions, x402 task ids and the gateway's sealed API keys: at least 32
// bytes. An empty or short secret (a truncated file, CHAT_SECRET=x) would make every token
// forgeable, so it is never accepted.
const MIN_SECRET_CHARS = 64; // 32 random bytes as hex

function secretFor(dir, contractId) {
  if (process.env.CHAT_SECRET !== undefined && process.env.CHAT_SECRET !== "") {
    if (process.env.CHAT_SECRET.length < MIN_SECRET_CHARS) throw new Error(`CHAT_SECRET must be at least ${MIN_SECRET_CHARS} characters (32 random bytes as hex)`);
    return process.env.CHAT_SECRET;
  }
  // Kept on disk so sessions survive a restart; never committed (.gitignore).
  const file = path.join(dir, `.chat-secret-${contractId}`);
  let s = "";
  try {
    s = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* first run */
  }
  if (s.length >= MIN_SECRET_CHARS) return s;
  if (s) console.error(`${file} held a secret shorter than ${MIN_SECRET_CHARS} characters: replaced with a new one (players sign in again)`);
  s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

// A JSON reply that can't throw half-way: the body is serialized before any header goes out,
// and a response whose headers already left (a file or stream that failed mid-way) is cut
// off instead of writing a second head (ERR_HTTP_HEADERS_SENT inside an async handler).
function sendJson(res, code, obj, headers = {}) {
  if (res.headersSent) return res.destroy();
  let body;
  try {
    body = JSON.stringify(obj);
  } catch {
    code = 500;
    body = '{"error":"server error"}';
  }
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(body);
}

// A settlement the contract refuses the same way every time ("batch out of order" after a
// redeploy, a worker removed from the responders...). Retrying it every minute only burns
// gas, so these back off up to SETTLE_MAX_BACKOFF_MS; the usage stays in the ledger.
const DETERMINISTIC_SETTLE = /batch out of order|already settled|too many items|too many messages|only an approved responder/i;
const SETTLE_MAX_BACKOFF_MS = 30 * 60_000;
// The economy params and a Mind's record barely change; the public /allowance would read
// them on every call, so they are kept this long.
const CACHE_MS = 20_000;

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    // Bytes are gathered and decoded once at the end, so a letter split across two chunks
    // (Cyrillic, Japanese, emoji) arrives whole; past the limit the upload is cut off.
    const parts = [];
    let size = 0;
    req.on("data", (d) => {
      if (size > limit) return; // already refused: the rest is read and dropped, not kept
      size += d.length;
      if (size > limit) {
        parts.length = 0;
        return reject(Object.assign(new Error("too large"), { status: 413 }));
      }
      parts.push(d);
    });
    req.on("end", () => {
      try {
        const s = Buffer.concat(parts).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

// The live views behind the public /allowance (live_state, live_balance, chat_credits_of) are
// kept this long per (Mind, account), so a page polling it can't turn into an RPC flood. A chat
// message always reads them fresh.
const LIVE_CACHE_MS = 5_000;
// Messages to a Mind with an agent run the colony planner (which shares the paid replies' model
// queue) to decide where they go: at most this many a minute per account.
const ROUTED_PER_MIN = 10;
// After her agent fails a chat message, messages to her go to her own voice this long instead
// of hitting the agent (and the planner) again for free.
const AGENT_COOLDOWN_MS = 60_000;

// `hasModel`: a model is configured (index.js: !!LLM). With a model, an empty reply is a
// failure (nothing is charged), never a phrasebook line someone pays for; only with no model at
// all is the phrasebook her voice. Defaults to true, the safe side.
function startChatServer({ account, view, contractId, workerId, askLLM, hasModel = true, plan = null, proofOf = () => null, fallbackReply, cleanReply, dir, gateway = null, x402 = null }) {
  const secret = secretFor(dir, contractId);
  const routed = makeRateLimiter(ROUTED_PER_MIN);
  const agentFailed = new Map(); // mind id -> when her agent last failed a chat message
  const ledger = new Ledger(path.join(dir, `.chat-ledger-${contractId}.json`));
  const log = path.join(dir, `.chat-log-${contractId}.jsonl`);
  const history = new Map(); // `${mind}|${payer}` -> [{role, content}]
  const busy = new Set(); // one message in flight per account

  const yocto = (v) => BigInt(v ?? 0);
  let paramsCache = { at: -Infinity, v: null };
  async function prices() {
    if (Date.now() - paramsCache.at > CACHE_MS || !paramsCache.v) paramsCache = { at: Date.now(), v: await view("params") };
    const p = paramsCache.v;
    return { cost: yocto(p.thought_cost), price: yocto(p.guest_min_price) };
  }
  // get_mind for the public /allowance, kept CACHE_MS; a chat message reads it fresh (who
  // owns her decides who pays) and refreshes the cache.
  const minds = new Map();
  async function mindOf(mindId, fresh) {
    const hit = minds.get(mindId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const v = await view("get_mind", { id: mindId });
    minds.set(mindId, { at: Date.now(), v });
    if (minds.size > 500) minds.delete(minds.keys().next().value);
    return v;
  }
  // live_state / live_balance / chat_credits_of, kept LIVE_CACHE_MS for the public /allowance;
  // `fresh` (a chat message) reads the chain and refreshes the cache.
  const live = new Map();
  async function liveView(method, args, fresh) {
    const k = `${method}|${JSON.stringify(args)}`;
    const hit = live.get(k);
    if (!fresh && hit && Date.now() - hit.at < LIVE_CACHE_MS) return hit.v;
    const v = await view(method, args);
    live.set(k, { at: Date.now(), v });
    if (live.size > 2000) live.delete(live.keys().next().value);
    return v;
  }
  // Messages being answered right now, per Mind: not in the ledger yet, but each will cost her
  // a thought, so two people can't both take her last one. Each message takes a numbered ticket
  // BEFORE its first await, and its food check counts only the tickets taken before it: of
  // concurrent messages on her last thought, the first one gets it and the others are refused.
  const thinking = new Map(); // mind id -> Set of tickets
  let lastTicket = 0;
  function reserve(mindId) {
    const t = ++lastTicket;
    if (!thinking.has(mindId)) thinking.set(mindId, new Set());
    thinking.get(mindId).add(t);
    return t;
  }
  function release(mindId, t) {
    const s = thinking.get(mindId);
    if (!s) return;
    s.delete(t);
    if (!s.size) thinking.delete(mindId);
  }
  function inThought(mindId, before = Infinity) {
    let n = 0;
    for (const t of thinking.get(mindId) || []) if (t < before) n++;
    return n;
  }

  // How many more messages this payer may send this Mind right now. Every message, the
  // keeper's or a guest's, is paid at settlement with a thought from HER food (settle_one
  // skips, uncharged, what her food can't cover), so both must fit in her food after all the
  // unsettled messages on her; a guest's must also fit in their chat credits. `ticket`: the
  // caller's own reservation (not counted against it, nor any taken after it).
  async function allowance(mindId, payer, { fresh = false, ticket = Infinity } = {}) {
    const mind = await mindOf(mindId, fresh);
    if (!mind) return { error: "no such Mind" };
    const state = (await liveView("live_state", { id: mindId }, fresh)) || "asleep";
    const own = mind.owner === payer;
    const { cost, price } = await prices();
    if (state === "ghost") return { mind, state, own, left: 0, error: "Ghosts don't answer." };
    const bal = yocto(await liveView("live_balance", { id: mindId }, fresh));
    const owed = BigInt(ledger.pendingOnMind(mindId) + inThought(mindId, ticket)) * cost;
    const food = cost > 0n ? (bal > owed ? Number((bal - owed) / cost) : 0) : Infinity;
    if (own) {
      const left = Number.isFinite(food) ? food : 0;
      return { mind, state, own, left, error: left < 1 || state === "asleep" ? `${mind.name} is too hungry to talk. Feed her first.` : null };
    }
    if (state === "asleep") return { mind, state, own, left: 0, error: `${mind.name} is asleep. Anyone can feed her to wake her.` };
    const credits = yocto(await liveView("chat_credits_of", { account_id: payer }, fresh));
    const unpaid = BigInt(ledger.pendingGuest(payer)) * price;
    const paid = price > 0n ? (credits > unpaid ? Number((credits - unpaid) / price) : 0) : 0;
    const left = Math.min(paid, food);
    if (paid < 1) return { mind, state, own, left: 0, error: "Buy chat credits to talk to her." };
    if (food < 1) return { mind, state, own, left: 0, error: `${mind.name} is too hungry to answer right now. Anyone can feed her.` };
    return { mind, state, own, left, error: null };
  }

  async function onChat(body) {
    const payer = readToken(secret, body.token);
    if (!payer) return [401, { error: "sign in again" }];
    const mindId = Number(body.mindId);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    // A Mind with a connected agent takes longer messages (questions, JSON for its tools).
    const maxBytes = gateway?.serves(mindId) ? MAX_AGENT_PROMPT_BYTES : MAX_PROMPT_BYTES;
    if (!Number.isInteger(mindId) || mindId < 0 || !prompt || Buffer.byteLength(prompt) > maxBytes) return [400, { error: "bad message" }];
    if (busy.has(payer)) return [429, { error: "wait for her reply first" }];
    busy.add(payer);
    // her thought is reserved before anything is awaited (released in `finally`, whatever happens)
    const ticket = reserve(mindId);
    try {
      const a = await allowance(mindId, payer, { fresh: true, ticket });
      if (a.error) return [402, { error: a.error, left: a.left ?? 0, own: a.own }];
      const look = await view("get_look", { id: mindId }).catch(() => null);
      const who = { ...a.mind, state: a.state, natures: look?.natures || [] };
      const key = `${mindId}|${payer}`;
      const past = history.get(key) || [];
      let reply = "";
      // A Mind with an agent still talks herself; a message that is a task for her agent (or
      // the answer to its question) goes to the agent, which replies with its real data.
      let agent = gateway?.serves(mindId) ? gateway.about(mindId) : null;
      // An agent connected by her previous owner (the NFT was sold since) holds their API key:
      // it doesn't serve the new owner's chat; she answers in her own voice until they
      // connect their own agent (the gateway refuses it too).
      if (agent?.connectedBy && agent.connectedBy !== a.mind.owner) agent = null;
      // An agent that just failed is left alone for a minute: meanwhile she answers herself, so
      // a broken agent can't be hammered (each message also runs the planner) for free.
      const cooling = agent && Date.now() - (agentFailed.get(mindId) ?? -Infinity) < AGENT_COOLDOWN_MS;
      if (agent && !cooling && !routed(payer)) return [429, { error: `Her agent takes at most ${ROUTED_PER_MIN} messages a minute from one person: wait a little. Nothing was charged.` }];
      const via = agent && !cooling && (await forAgent(agent, payer, prompt, past)) ? agent.name : null;
      if (via) {
        // Her agent answers; if it can't, nothing is charged.
        try {
          reply = await gateway.chat(mindId, payer, prompt);
        } catch (e) {
          agentFailed.set(mindId, Date.now());
          if (agentFailed.size > 5000) agentFailed.delete(agentFailed.keys().next().value);
          console.error(`chat mind ${mindId}: her agent failed:`, e.message);
          return [502, { error: `Her agent didn't answer (${scrubUrls(e.message).slice(0, 120)}). Nothing was charged; for the next minute she answers herself.` }];
        }
      } else {
        if (agent) who.agent = agent;
        // A model that failed is never covered up with a canned line someone pays for: the
        // message is refused, nothing is charged. With no model at all the phrasebook is her voice.
        try {
          reply = await askLLM(who, prompt, past);
        } catch (e) {
          console.error(`chat mind ${mindId}: model failed, nothing charged:`, e.message);
          return [503, { error: "She couldn't think of an answer just now (the model is busy). Try again in a minute: nothing was charged." }];
        }
        if (!reply) {
          // An empty answer from a configured model (it ran out of tokens while thinking, or
          // said nothing) is a failure like a throw, not a cue for a paid canned line.
          if (hasModel) {
            console.error(`chat mind ${mindId}: the model gave an empty reply, nothing charged`);
            return [503, { error: "She couldn't think of an answer just now: no reply, nothing was charged. Try again in a minute." }];
          }
          reply = cleanReply(fallbackReply(who, prompt, Date.now()));
        }
      }
      if (!reply) return [502, { error: "no reply, nothing was charged" }];
      // NEAR AI's signature over this exact reply, when the colony's TEE model wrote it
      const proof = via ? null : proofOf(reply);
      ledger.add(mindId, payer, a.own, prompt, reply);
      fs.appendFile(log, JSON.stringify({ ts: Date.now(), mind: mindId, payer, own: a.own, prompt, reply, proof, via }) + "\n", () => {});
      history.set(key, [...past, { role: "user", content: prompt }, { role: "assistant", content: reply }].slice(-HISTORY_TURNS * 2));
      // bound the map over the worker's lifetime: drop the least recently used conversation
      if (history.size > 5000) history.delete(history.keys().next().value);
      console.log(`chat mind ${mindId} ← ${payer}${a.own ? " (keeper)" : ""}: ${reply.slice(0, 60)}`);
      if (ledger.rows().reduce((n, r) => n + r.count, 0) >= SETTLE_AT) settleSoon();
      return [200, { reply, own: a.own, left: a.left - 1, proof, via }];
    } finally {
      busy.delete(payer);
      release(mindId, ticket);
    }
  }

  // Is this message a job for her agent, or just talking to her? Her agent's open question is
  // always its own; otherwise the colony model decides from what the agent can do. With no
  // model (or if it fails) the agent takes it, since it can work without one.
  async function forAgent(agent, payer, prompt, past) {
    if (agent.waiting(payer)) return true;
    if (!plan) return true;
    const can = agent.skills
      .slice(0, 20)
      .map((k) => `- ${k.name}: ${k.description.slice(0, 160)}${k.examples[0] ? ` (e.g. "${k.examples[0]}")` : ""}`)
      .join("\n");
    const recent = past.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");
    try {
      const out = await plan(
        `A small creature has a helper agent "${agent.name}" that can do:\n${can || "- (no listed skills)"}\nDecide if the user's latest message asks for one of those tasks (it needs the agent's real data or tool), or is just conversation with the creature (greetings, feelings, questions about her, jokes, chit-chat). Answer only JSON: {"agent": true} or {"agent": false}.`,
        (recent ? `Conversation so far:\n${recent}\n\n` : "") + `Latest message: ${prompt}`
      );
      const m = String(out).replace(/<think>[\s\S]*?<\/think>/gi, "").match(/"agent"\s*:\s*(true|false)/i);
      return m ? m[1].toLowerCase() === "true" : true;
    } catch (e) {
      console.error("chat router failed, her agent takes it:", e.message);
      return true;
    }
  }

  async function onAllowance(q) {
    const payer = q.get("account");
    const mindId = Number(q.get("mind"));
    if (!payer || !Number.isInteger(mindId)) return [400, { error: "bad request" }];
    const a = await allowance(mindId, payer);
    return [200, { left: a.left ?? 0, own: !!a.own, error: a.error ?? null }];
  }

  async function onSession(body) {
    const why = checkSignIn(body, { recipient: contractId });
    if (why) return [401, { error: why }];
    // The key must be one of the account's own full-access keys, checked on chain.
    try {
      const key = await account.connection.provider.query({
        request_type: "view_access_key",
        finality: "final",
        account_id: body.accountId,
        public_key: body.publicKey,
      });
      if (key.permission !== "FullAccess") return [401, { error: "sign with the account's own key" }];
    } catch {
      return [401, { error: "that key does not belong to this account" }];
    }
    return [200, issueToken(secret, body.accountId)];
  }

  // ── settlement ──────────────────────────────────────────────────────────────
  let settling = false;
  let timer = null;
  let refusals = 0; // settlements in a row the contract refused for a deterministic reason
  let backoffUntil = 0;
  function settleSoon() {
    if (Date.now() < backoffUntil) return; // backing off a refused batch: don't hurry it
    clearTimeout(timer);
    timer = setTimeout(settle, 1000);
  }
  async function settle() {
    clearTimeout(timer);
    timer = setTimeout(settle, Math.max(SETTLE_EVERY_MS, backoffUntil - Date.now()));
    if (settling || !ledger.hasWork()) return;
    settling = true;
    let done = null;
    try {
      done = Number(await view("settle_nonce_of", { account_id: workerId }));
      // A batch we sent whose reply got lost: if its number is on chain, it was settled.
      if (ledger.inflight && done >= ledger.inflight.batch) ledger.finishBatch();
      if (!ledger.hasWork()) return;
      const b = ledger.startBatch(done + 1);
      const items = b.items.map((i) => ({ mind_id: i.mind_id, payer: i.payer, own: i.own, count: i.count, last_reply: i.last_reply }));
      const out = await account.functionCall({
        contractId,
        methodName: "settle_chats",
        args: { batch: b.batch, items, digest: b.digest },
        gas: SETTLE_GAS,
        attachedDeposit: "0",
      });
      const report = JSON.parse(Buffer.from(out.status.SuccessValue || "", "base64").toString() || "{}");
      ledger.finishBatch();
      const burnt = [out.transaction_outcome, ...out.receipts_outcome].reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n);
      console.log(`settled chat batch ${b.batch}: ${report.charged} paid, ${report.skipped} not covered, gas ${Number(burnt / 10n ** 18n) / 1e6} NEAR`);
      refusals = 0;
      backoffUntil = 0;
      if (ledger.hasWork()) settleSoon();
    } catch (e) {
      const msg = String(e?.message || e);
      if (DETERMINISTIC_SETTLE.test(msg)) {
        // The same batch would be refused again: say so loudly, keep the usage in the ledger
        // (nothing is dropped), and wait longer each time instead of paying gas every minute.
        refusals += 1;
        const wait = Math.min(SETTLE_EVERY_MS * 2 ** refusals, SETTLE_MAX_BACKOFF_MS);
        backoffUntil = Date.now() + wait;
        clearTimeout(timer);
        timer = setTimeout(settle, wait);
        console.error(
          `SETTLE REFUSED (${refusals} in a row, next try in ${Math.round(wait / 60_000)} min): ${msg.slice(0, 200)}\n` +
            `  contract settle_nonce_of(${workerId}) = ${done ?? "?"}, ledger batch in flight = ${ledger.inflight?.batch ?? "none"} (${ledger.inflight?.items?.length ?? 0} items) in ${ledger.file}.\n` +
            `  If the contract was redeployed, that ledger belongs to the old deploy: stop the worker and move the file aside (reset-contract.js deletes it).`
        );
      } else console.error("settle error (will retry):", msg);
    } finally {
      settling = false;
    }
  }
  timer = setTimeout(settle, 5000);

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => sendJson(res, code, obj);
    try {
      const url = new URL(req.url, "http://localhost");
      if (x402 && url.pathname.startsWith("/agent/x402/")) return await x402.route(req, res, url, readBody);
      if (gateway && url.pathname.startsWith("/agent/")) return await gateway.route(req, res, url, readBody, send);
      if (req.method === "POST" && url.pathname === "/session") return send(...(await onSession(await readBody(req))));
      if (req.method === "POST" && url.pathname === "/chat") return send(...(await onChat(await readBody(req))));
      if (req.method === "GET" && url.pathname === "/allowance") return send(...(await onAllowance(url.searchParams)));
      send(404, { error: "not found" });
    } catch (e) {
      // send() cuts the connection if the head already went out, so this can never throw
      if (e?.status === 413) return send(413, { error: "that is too large" });
      if (e?.message === "bad json") return send(400, { error: "bad request" });
      console.error("chat server error:", e?.message || e);
      send(500, { error: "server error" });
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`chat server on http://127.0.0.1:${PORT}`));
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  return { server, ledger, settle, close };
}

module.exports = { startChatServer, secretFor, readBody, sendJson, MIN_SECRET_CHARS };
