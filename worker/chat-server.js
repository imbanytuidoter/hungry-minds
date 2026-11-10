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

const PORT = parseInt(process.env.CHAT_PORT || "8788", 10);
const SETTLE_EVERY_MS = parseInt(process.env.SETTLE_EVERY_MS || "60000", 10);
// Settle sooner once this many messages are waiting, so unpaid usage stays small.
const SETTLE_AT = parseInt(process.env.SETTLE_AT || "30", 10);
const SETTLE_GAS = "300000000000000";
const MAX_PROMPT_BYTES = 500; // the contract's MAX_PROMPT_LEN
const MAX_AGENT_PROMPT_BYTES = 2000;
const HISTORY_TURNS = 6;

function secretFor(dir, contractId) {
  if (process.env.CHAT_SECRET) return process.env.CHAT_SECRET;
  // Kept on disk so sessions survive a restart; never committed (.gitignore).
  const file = path.join(dir, `.chat-secret-${contractId}`);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}

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

function startChatServer({ account, view, contractId, workerId, askLLM, plan = null, proofOf = () => null, fallbackReply, cleanReply, dir, gateway = null, x402 = null }) {
  const secret = secretFor(dir, contractId);
  const ledger = new Ledger(path.join(dir, `.chat-ledger-${contractId}.json`));
  const log = path.join(dir, `.chat-log-${contractId}.jsonl`);
  const history = new Map(); // `${mind}|${payer}` -> [{role, content}]
  const busy = new Set(); // one message in flight per account

  const yocto = (v) => BigInt(v ?? 0);
  async function prices() {
    const p = await view("params");
    return { cost: yocto(p.thought_cost), price: yocto(p.guest_min_price) };
  }

  // How many more messages this payer may send this Mind right now.
  async function allowance(mindId, payer) {
    const mind = await view("get_mind", { id: mindId });
    if (!mind) return { error: "no such Mind" };
    const state = (await view("live_state", { id: mindId })) || "asleep";
    const own = mind.owner === payer;
    const { cost, price } = await prices();
    if (state === "ghost") return { mind, state, own, left: 0, error: "Ghosts don't answer." };
    if (own) {
      const bal = yocto(await view("live_balance", { id: mindId }));
      const unpaid = BigInt(ledger.pendingOwn(mindId)) * cost;
      const left = bal > unpaid ? Number((bal - unpaid) / cost) : 0;
      return { mind, state, own, left, error: left < 1 || state === "asleep" ? `${mind.name} is too hungry to talk. Feed her first.` : null };
    }
    if (state === "asleep") return { mind, state, own, left: 0, error: `${mind.name} is asleep. Anyone can feed her to wake her.` };
    const credits = yocto(await view("chat_credits_of", { account_id: payer }));
    const unpaid = BigInt(ledger.pendingGuest(payer)) * price;
    const left = credits > unpaid ? Number((credits - unpaid) / price) : 0;
    return { mind, state, own, left, error: left < 1 ? "Buy chat credits to talk to her." : null };
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
    try {
      const a = await allowance(mindId, payer);
      if (a.error) return [402, { error: a.error, left: a.left ?? 0, own: a.own }];
      const look = await view("get_look", { id: mindId }).catch(() => null);
      const who = { ...a.mind, state: a.state, natures: look?.natures || [] };
      const key = `${mindId}|${payer}`;
      const past = history.get(key) || [];
      let reply = "";
      // A Mind with an agent still talks herself; a message that is a task for her agent (or
      // the answer to its question) goes to the agent, which replies with its real data.
      const agent = gateway?.serves(mindId) ? gateway.about(mindId) : null;
      const via = agent && (await forAgent(agent, payer, prompt, past)) ? agent.name : null;
      if (via) {
        // Her agent answers; if it can't, nothing is charged.
        try {
          reply = await gateway.chat(mindId, payer, prompt);
        } catch (e) {
          console.error(`chat mind ${mindId}: her agent failed:`, e.message);
          return [502, { error: `Her agent didn't answer (${e.message.slice(0, 120)}). Nothing was charged.` }];
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
        if (!reply) reply = cleanReply(fallbackReply(who, prompt, Date.now()));
      }
      if (!reply) return [502, { error: "no reply, nothing was charged" }];
      // NEAR AI's signature over this exact reply, when the colony's TEE model wrote it
      const proof = via ? null : proofOf(reply);
      ledger.add(mindId, payer, a.own, prompt, reply);
      fs.appendFile(log, JSON.stringify({ ts: Date.now(), mind: mindId, payer, own: a.own, prompt, reply, proof, via }) + "\n", () => {});
      history.set(key, [...past, { role: "user", content: prompt }, { role: "assistant", content: reply }].slice(-HISTORY_TURNS * 2));
      console.log(`chat mind ${mindId} ← ${payer}${a.own ? " (keeper)" : ""}: ${reply.slice(0, 60)}`);
      if (ledger.rows().reduce((n, r) => n + r.count, 0) >= SETTLE_AT) settleSoon();
      return [200, { reply, own: a.own, left: a.left - 1, proof, via }];
    } finally {
      busy.delete(payer);
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
  function settleSoon() {
    clearTimeout(timer);
    timer = setTimeout(settle, 1000);
  }
  async function settle() {
    clearTimeout(timer);
    timer = setTimeout(settle, SETTLE_EVERY_MS);
    if (settling || !ledger.hasWork()) return;
    settling = true;
    try {
      const done = Number(await view("settle_nonce_of", { account_id: workerId }));
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
      if (ledger.hasWork()) settleSoon();
    } catch (e) {
      console.error("settle error (will retry):", e.message);
    } finally {
      settling = false;
    }
  }
  timer = setTimeout(settle, 5000);

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (x402 && url.pathname.startsWith("/agent/x402/")) return await x402.route(req, res, url, readBody);
      if (gateway && url.pathname.startsWith("/agent/")) return await gateway.route(req, res, url, readBody, send);
      if (req.method === "POST" && url.pathname === "/session") return send(...(await onSession(await readBody(req))));
      if (req.method === "POST" && url.pathname === "/chat") return send(...(await onChat(await readBody(req))));
      if (req.method === "GET" && url.pathname === "/allowance") return send(...(await onAllowance(url.searchParams)));
      send(404, { error: "not found" });
    } catch (e) {
      if (e.status === 413) return send(413, { error: "that is too large" });
      if (e.message === "bad json") return send(400, { error: "bad request" });
      console.error("chat server error:", e.message);
      send(500, { error: "server error" });
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`chat server on http://127.0.0.1:${PORT}`));
  return { server, ledger, settle };
}

module.exports = { startChatServer, secretFor, readBody };
