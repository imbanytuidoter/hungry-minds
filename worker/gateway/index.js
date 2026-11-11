// The agent gateway: a Mind owner connects an agent that already runs somewhere (A2A, MCP,
// an OpenAI-compatible endpoint or a plain HTTPS endpoint) by URL, with no code of their
// own. On chain the Mind's agent is the gateway account, so only the gateway can deliver
// her jobs; off chain the gateway hands every job and every chat message to her agent:
//
//  - jobs: the buyer's request (and any files they attached) goes to the agent; if the
//    agent asks a question (A2A input-required, or {"question"} over HTTP) the job waits
//    for the buyer's answer and then continues the same task; the result (text, data,
//    files) is stored here, and what fits is delivered on chain with the SHA-256 of all of
//    it, which releases the escrow (90% to the Mind's owner, 10% to the protocol);
//  - chat: messages to the Mind are answered by her agent, keeping the conversation
//    (A2A context, or the recent turns for the other kinds);
//  - status: each agent is checked every few minutes, so the site can show it online.
//
// The connection belongs to the Mind, not the person: if the NFT is sold, the agent goes
// with her and the new owner earns from it (or connects another).

const crypto = require("crypto");
const { KINDS, discover, run, guessArgs, firstJson, marketPaywall, MARKET_PAYWALL } = require("./connectors");
const official = require("./official");
const { checkUrl } = require("./safe-fetch");
const { makeRateLimiter, publicUrl, scrubUrls } = require("./limits");

const GAS = "100000000000000";
const MAX_ONCHAIN = 2000; // the contract's MAX_JOB_RESULT
const MAX_ATTEMPTS = 3;
const HEALTH_EVERY_MS = 5 * 60_000;
const MAX_UPLOAD = 6 * 1024 * 1024;
const FILE_TAG = /\[file:([0-9a-f]{24})\]/g;

const bytes = (s) => Buffer.byteLength(s, "utf8");
function clipBytes(s, n) {
  if (bytes(s) <= n) return s;
  return Buffer.from(s, "utf8").subarray(0, n).toString("utf8").replace(/�+$/, "");
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// A tool's input schema goes into the planner's prompts and the public /status; an agent could
// send megabytes of it. Over this size it is dropped (the tool still works with JSON input).
const MAX_SCHEMA_BYTES = 4096;
function capSchema(s) {
  if (!s || typeof s !== "object") return null;
  try {
    return bytes(JSON.stringify(s)) <= MAX_SCHEMA_BYTES ? s : null;
  } catch {
    return null;
  }
}
/** An agent's skills as stored: bounded in number and size, whatever its card or MCP server says. */
function trimSkills(skills) {
  return (Array.isArray(skills) ? skills : []).slice(0, 50).map((k) => ({
    id: str(k?.id, 100),
    name: str(k?.name, 100),
    description: str(k?.description, 500),
    examples: (Array.isArray(k?.examples) ? k.examples : []).filter((e) => typeof e === "string").slice(0, 5).map((e) => str(e, 200)),
    ...(k?.category ? { category: str(k.category, 40) } : {}),
    ...(k?.inputSchema ? { inputSchema: capSchema(k.inputSchema) } : {}),
  }));
}
const NAVIGATE_PER_MIN = 6;
const CATALOGUE_MS = 60_000;
const HANDED_OVER = "the Mind changed hands: connect your own agent";
const PAGE = 50; // the contract's cap on one open_jobs page
const MAX_PAGES = 40; // open_jobs pages read per tick at most (the contract keeps ≤ 1000 open jobs)
// A Mind too hungry (or asleep) to pay the thought deliver_job charges is looked at again after
// this long, without spending an attempt or running her agent (someone may feed her).
const NOT_READY_MS = 60_000;
const PARAMS_MS = 60_000;

function makeGateway({ view, account, contractId, workerId, store, plan, readToken }) {
  const busy = new Set();
  const attempts = new Map();
  const done = new Set();
  const lastTest = new Map();
  const notReady = new Map(); // job id -> when her Mind was last found unable to pay the thought
  const running = new Map(); // mind id -> her jobs being worked right now
  const navigate = makeRateLimiter(NAVIGATE_PER_MIN); // per account
  let lastHealth = 0;
  let params = { at: -Infinity, cost: 0n };
  // What an error may say once stored or shown: no key from the agent's URL, no API key.
  const scrub = (mindId, msg) => scrubUrls(msg, [store.secretOf(mindId)]).slice(0, 200);

  const ownerOf = async (mindId) => (await view("get_mind", { id: mindId }))?.owner || null;
  const serves = (mindId) => !!store.conn(mindId);

  // The connection holds the API key of whoever connected it (connectedBy). Once the NFT
  // changes hands, the old owner's agent and key must not keep serving the new owner for free
  // tests and chat: those are refused until the new owner connects their own agent (or
  // disconnects it). Paid JOBS keep running on purpose: the contract pays the new owner on
  // delivery, a buyer who already paid still gets the work, and "the agent goes with the Mind"
  // is what a buyer of the NFT was promised; the old owner can stop that by disconnecting.
  const handedOver = (c, owner) => !!c?.connectedBy && owner !== null && owner !== c.connectedBy;
  async function checkHands(mindId) {
    const c = store.conn(mindId);
    if (!c) return false;
    const moved = handedOver(c, await ownerOf(mindId));
    if (!!c.handedOver !== moved) store.patchConn(mindId, { handedOver: moved });
    return moved;
  }

  /** Her agent as the chat needs it: its name, what it can do, who connected it, and whether
   *  it is waiting for an answer from `who` (it asked a question, so their next message goes to it). */
  function about(mindId) {
    const c = store.conn(mindId);
    if (!c) return null;
    return {
      name: c.name || "her agent",
      connectedBy: c.connectedBy || null,
      skills: (c.skills || []).map(({ name, description, examples }) => ({ name, description: description || "", examples: examples || [] })),
      waiting: (who) => !!store.chat(mindId, who).taskId,
    };
  }

  function publicView(mindId) {
    const c = store.conn(mindId);
    if (!c) return null;
    return {
      mind_id: mindId,
      kind: c.kind,
      url: publicUrl(c.url),
      name: c.name,
      description: c.description,
      provider: c.provider,
      version: c.version,
      skills: (c.skills || []).map(({ id, name, description, examples, category, inputSchema }) => ({ id, name, description, examples, category: category || null, inputSchema: capSchema(inputSchema) })),
      online: !!c.online && !c.handedOver,
      // the NFT was sold after this agent was connected: the new owner must connect their own
      needs_reconnect: !!c.handedOver,
      last_seen: c.lastSeen || 0,
      // scrubbed again on the way out: an error stored before the scrubbing existed
      last_error: c.handedOver ? HANDED_OVER : c.lastError ? scrub(mindId, c.lastError) : null,
      since: c.since,
      gateway: workerId,
    };
  }

  // ── turning results into files, links and the on-chain record ──
  function saveFiles(files, owner, mindId, jobId) {
    return (files || []).map((f) => store.putFile({ ...f, owner, mindId, jobId }));
  }
  const fileLine = (f) => `[file] ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB): /api/agent/file/${f.id}`;

  function onchainResult(text, saved, jobId, digest) {
    if (!saved.length && bytes(text) <= MAX_ONCHAIN) return text;
    const tail = `\n\n[full result${saved.length ? ` + ${saved.length} file${saved.length > 1 ? "s" : ""}` : ""}: /api/agent/job/${jobId} · sha256 ${digest}]`;
    const head = clipBytes(text || saved.map((f) => f.name).join(", "), MAX_ONCHAIN - bytes(tail) - 3);
    return (head.length < (text || "").length ? head + "…" : head) + tail;
  }

  function jobInput(job) {
    const ids = [...job.input.matchAll(FILE_TAG)].map((m) => m[1]);
    const files = [];
    for (const id of ids) {
      const meta = store.fileMeta(id);
      if (!meta || meta.owner !== job.buyer) continue; // only the buyer's own uploads
      store.linkFile(id, job.id);
      files.push({ name: meta.name, mime: meta.mime, data: store.fileData(id) });
    }
    return { text: job.input.replace(FILE_TAG, "").trim() || "(see the attached file)", files };
  }

  async function skillFor(conn, job) {
    if (conn.skillMap?.[job.service_id]) return conn.skillMap[job.service_id];
    const s = await view("get_service", { service_id: job.service_id }).catch(() => null);
    const title = (s?.title || "").toLowerCase();
    const hit = (conn.skills || []).find((k) => k.name?.toLowerCase() === title || k.id?.toLowerCase() === title);
    return hit?.id || null;
  }

  // ── jobs ──
  async function work(job) {
    const conn = store.conn(job.mind_id);
    const secret = store.secretOf(job.mind_id);
    const st = store.job(job.id);
    const skill = await skillFor(conn, job);
    const left = Number(BigInt(job.deadline) / 1_000_000n) - Date.now() - 20_000;
    if (left < 5_000) return;
    let req;
    if (st?.state === "answered") {
      req = {
        text: st.answer,
        files: (st.answerFiles || []).map((id) => store.fileMeta(id) && { name: store.fileMeta(id).name, mime: store.fileMeta(id).mime, data: store.fileData(id) }).filter(Boolean),
        taskId: st.taskId,
        contextId: st.contextId,
        history: [...(st.history || []), { role: "user", content: st.input }, { role: "assistant", content: st.question }],
      };
    } else req = { ...jobInput(job), history: [] };
    const out = await run(conn, secret, { ...req, skill, mindId: job.mind_id, jobId: job.id, buyer: job.buyer, timeoutMs: left }, plan);
    store.patchConn(job.mind_id, { online: true, lastSeen: Date.now(), lastError: null });
    if (out.state === "input-required") {
      store.setJob(job.id, { state: "asking", question: out.text || "The agent needs more details.", taskId: out.taskId, contextId: out.contextId, input: req.text, history: req.history, asked: Date.now() });
      console.log(`gateway job ${job.id}: ${conn.name} asks the buyer: ${(out.text || "").slice(0, 80)}`);
      return;
    }
    if (out.state !== "completed") throw new Error(out.text || `the agent ended the task as ${out.state}`);
    if (!out.text && !out.files.length) throw new Error("the agent returned nothing");
    const saved = saveFiles(out.files, job.buyer, job.mind_id, job.id);
    const digest = sha256(JSON.stringify({ text: out.text, files: saved.map((f) => f.sha256) }));
    // Kept before delivery (the on-chain record points at it), but shown to nobody until the
    // job is Delivered on chain: a buyer must not read the work and then take the refund.
    const stored = { text: out.text, files: saved.map(({ id, name, mime, size, sha256: h }) => ({ id, name, mime, size, sha256: h })), sha256: digest, ts: Date.now() };
    store.setResult(job.id, stored);
    const result = onchainResult(out.text, saved, job.id, digest);
    await account.functionCall({ contractId, methodName: "deliver_job", args: { job_id: job.id, result }, gas: GAS, attachedDeposit: "0" });
    store.setResult(job.id, { ...stored, delivered: true });
    store.setJob(job.id, null);
    done.add(job.id);
    console.log(`gateway job ${job.id} mind ${job.mind_id} delivered by ${conn.name}: ${result.slice(0, 70)}`);
  }

  async function health() {
    lastHealth = Date.now();
    for (const id of store.mindIds()) {
      await checkHands(id).catch(() => {});
      const c = store.conn(id);
      if (c.kind !== "a2a" && c.kind !== "mcp") continue; // the others are judged by their last call
      try {
        const d = await discover(c, store.secretOf(id));
        // the same bounds as onConnect: a card that grew can't bloat the store or the prompts
        store.patchConn(id, { online: true, lastSeen: Date.now(), lastError: null, skills: trimSkills(d.skills), card: d.card, name: str(d.name, 60) || c.name, ...(d.description ? { description: str(d.description, 500) } : {}) });
      } catch (e) {
        store.patchConn(id, { online: false, lastError: scrub(id, e.message) });
      }
    }
  }

  async function thoughtCost() {
    if (Date.now() - params.at > PARAMS_MS) params = { at: Date.now(), cost: BigInt((await view("params", {}))?.thought_cost ?? 0) };
    return params.cost;
  }
  /** Can she pay the thought deliver_job charges her (awake, live food >= thought cost)? Checked
   *  before her agent runs: a delivery the contract refuses would waste the agent's work (and,
   *  before the result was gated, leak it). Same rule as jobs.js canThink. */
  async function canThink(mindId, ahead = 0) {
    const state = await view("live_state", { id: mindId });
    if (!state || state === "asleep" || state === "ghost") return false;
    const bal = BigInt((await view("live_balance", { id: mindId })) ?? 0);
    return bal >= (await thoughtCost()) * BigInt(ahead + 1);
  }

  /** Every open job this gateway may deliver. open_jobs skips `from_index` among ALL open jobs
   *  and then filters by agent, so it is walked in steps of PAGE (an empty page means nothing
   *  matches past it), up to open_job_count, with repeats dropped (like jobs.js colonyJobs). */
  async function myOpenJobs() {
    const raw = await view("open_job_count", {}).catch(() => null);
    const count = raw === null || raw === undefined ? null : Number(raw);
    const seen = new Map();
    for (let from = 0, n = 0; n < MAX_PAGES; from += PAGE, n++) {
      const page = (await view("open_jobs", { agent: workerId, from_index: from, limit: PAGE })) || [];
      for (const job of page) seen.set(job.id, job);
      if (!page.length || (Number.isFinite(count) && from + PAGE >= count)) break;
    }
    return [...seen.values()];
  }

  async function tick() {
    if (!store.mindIds().length) return;
    if (Date.now() - lastHealth > HEALTH_EVERY_MS) health().catch(() => {});
    const nowMs = Date.now();
    const open = await myOpenJobs();
    for (const job of open) {
      if (!store.conn(job.mind_id)) continue;
      if (busy.has(job.id) || done.has(job.id) || (attempts.get(job.id) || 0) >= MAX_ATTEMPTS) continue;
      if (store.job(job.id)?.state === "asking") continue; // waiting for the buyer
      if (Number(BigInt(job.deadline) / 1_000_000n) < nowMs) continue;
      if (nowMs - (notReady.get(job.id) ?? -Infinity) < NOT_READY_MS) continue; // she couldn't pay a minute ago
      busy.add(job.id);
      // her other jobs being worked right now will each take a thought too
      const ahead = running.get(job.mind_id) || 0;
      running.set(job.mind_id, ahead + 1);
      (async () => {
        let ready;
        try {
          ready = await canThink(job.mind_id, ahead);
        } catch (e) {
          console.error(`gateway job ${job.id}: could not read her state:`, e.message);
          ready = false;
        }
        if (!ready) {
          notReady.set(job.id, Date.now()); // not an attempt: nothing was spent
          return;
        }
        notReady.delete(job.id);
        await work(job);
      })()
        .catch((e) => {
          const n = (attempts.get(job.id) || 0) + 1;
          attempts.set(job.id, n);
          store.patchConn(job.mind_id, { lastError: scrub(job.mind_id, e.message), ...(n >= MAX_ATTEMPTS ? { online: false } : {}) });
          console.error(`gateway job ${job.id} attempt ${n}/${MAX_ATTEMPTS}:`, scrub(job.mind_id, e.message));
        })
        .finally(() => {
          busy.delete(job.id);
          const n = (running.get(job.mind_id) || 1) - 1;
          if (n > 0) running.set(job.mind_id, n);
          else running.delete(job.mind_id);
        });
    }
    for (const id of notReady.keys()) if (!open.some((j) => j.id === id)) notReady.delete(id);
  }

  // ── chat ──
  async function chat(mindId, who, prompt) {
    const conn = store.conn(mindId);
    if (!conn) throw new Error("no agent connected");
    if (await checkHands(mindId)) throw new Error(HANDED_OVER);
    const c = store.chat(mindId, who);
    let out;
    try {
      out = await run(conn, store.secretOf(mindId), { text: prompt, contextId: c.contextId, taskId: c.taskId, history: c.history || [], mindId, buyer: who, chat: true, timeoutMs: 150_000 }, plan);
    } catch (e) {
      // the chat server shows this to whoever wrote (often a guest): never the owner's key
      throw new Error(scrub(mindId, e?.message || e));
    }
    if (out.state === "failed") throw new Error(scrub(mindId, out.text || "the agent failed"));
    store.patchConn(mindId, { online: true, lastSeen: Date.now(), lastError: null });
    const saved = saveFiles(out.files, who, mindId, null);
    const reply = [out.text, ...saved.map(fileLine)].filter(Boolean).join("\n\n") || "(no answer)";
    store.setChat(mindId, who, {
      contextId: out.contextId || c.contextId,
      taskId: out.state === "input-required" ? out.taskId : undefined,
      history: [...(c.history || []), { role: "user", content: prompt }, { role: "assistant", content: out.text.slice(0, 2000) }].slice(-12),
    });
    return reply;
  }

  // ── HTTP API (mounted by chat-server.js under /agent/, reached via the site's /api/agent) ──
  async function onConnect(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const mindId = Number(b.mindId);
    if (!Number.isInteger(mindId) || mindId < 0) return [400, { error: "bad Mind id" }];
    if ((await ownerOf(mindId)) !== who) return [403, { error: "only her owner can connect an agent" }];
    const kind = str(b.kind, 10);
    if (!KINDS.includes(kind)) return [400, { error: `kind must be one of ${KINDS.join(", ")}` }];
    const conn = {
      kind,
      url: str(b.url, 500),
      authHeader: /^[A-Za-z0-9-]{1,60}$/.test(b.authHeader || "") ? b.authHeader : "Authorization",
      model: str(b.model, 100),
      name: str(b.name, 60),
      description: str(b.description, 300),
      system: str(b.system, 2000),
    };
    const secret = str(b.apiKey, 4000);
    try {
      if (kind === "official") official.get(conn.url); // throws for an unknown one
      else if (marketPaywall(conn.url)) throw new Error(MARKET_PAYWALL);
      else await checkUrl(conn.url);
      if (kind === "openai" && !conn.model) throw new Error("give the model name your endpoint expects");
      const d = await discover(conn, secret);
      const prev = store.conn(mindId);
      store.setConn(mindId, {
        ...conn,
        name: str(d.name, 60) || conn.name || new URL(conn.url).host,
        description: str(d.description, 500) || conn.description,
        provider: str(d.provider, 80),
        version: str(d.version, 40),
        skills: trimSkills(d.skills),
        card: d.card,
        skillMap: prev?.url === conn.url ? prev.skillMap : {},
        connectedBy: who,
        handedOver: false,
        since: Date.now(),
        online: true,
        lastSeen: Date.now(),
        lastError: null,
      }, secret);
    } catch (e) {
      return [422, { error: `couldn't connect: ${e.message}` }];
    }
    const v = publicView(mindId);
    console.log(`gateway: Mind ${mindId} connected to ${v.name} (${kind}) by ${who}`);
    const where = kind === "official" ? "official agent" : `${kind.toUpperCase()} · ${new URL(v.url).host}`;
    return [200, { gateway: workerId, about: clipBytes(`${v.name} · ${where}`, 200), agent: v }];
  }

  async function onDisconnect(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const mindId = Number(b.mindId);
    const c = store.conn(mindId);
    // her current owner, or whoever connected it (their API key is in it: after a sale they
    // must still be able to take it back)
    if ((await ownerOf(mindId)) !== who && !(c && c.connectedBy === who)) return [403, { error: "only her owner, or whoever connected the agent, can disconnect it" }];
    store.dropConn(mindId);
    return [200, { ok: true }];
  }

  async function onMap(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const mindId = Number(b.mindId);
    const c = store.conn(mindId);
    if (!c) return [404, { error: "no agent connected" }];
    const owner = await ownerOf(mindId);
    if (owner !== who) return [403, { error: "not her owner" }];
    if (handedOver(c, owner)) return [409, { error: HANDED_OVER }];
    const s = await view("get_service", { service_id: Number(b.serviceId) }).catch(() => null);
    if (!s || s.mind_id !== mindId) return [400, { error: "that service is not hers" }];
    if (!(c.skills || []).some((k) => k.id === b.skillId)) return [400, { error: "no such skill" }];
    store.patchConn(mindId, { skillMap: { ...(c.skillMap || {}), [s.id]: b.skillId } });
    return [200, { ok: true }];
  }

  async function onTest(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const mindId = Number(b.mindId);
    const c = store.conn(mindId);
    if (!c) return [404, { error: "no agent connected" }];
    const owner = await ownerOf(mindId);
    if (owner !== who) return [403, { error: "only her owner can test her agent for free" }];
    if (handedOver(c, owner)) {
      store.patchConn(mindId, { handedOver: true });
      return [409, { error: HANDED_OVER }];
    }
    if (Date.now() - (lastTest.get(who) || 0) < 8_000) return [429, { error: "one test every few seconds" }];
    lastTest.set(who, Date.now());
    try {
      const out = await run(c, store.secretOf(mindId), { text: str(b.text, 2000) || "Hello! What can you do?", skill: str(b.skill, 100) || null, mindId, buyer: who, history: [], timeoutMs: 120_000 }, plan);
      const saved = saveFiles(out.files, who, mindId, null);
      store.patchConn(mindId, { online: out.state !== "failed", lastSeen: Date.now(), lastError: out.state === "failed" ? scrub(mindId, out.text) : null });
      return [200, { state: out.state, text: out.text, files: saved.map(({ id, name, mime, size }) => ({ id, name, mime, size })) }];
    } catch (e) {
      store.patchConn(mindId, { online: false, lastError: scrub(mindId, e.message) });
      return [502, { error: scrubUrls(e.message, [store.secretOf(mindId)]) }];
    }
  }

  // ── Navigator: a request in plain words → the services that can do it, with the input ready ──
  const words = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  // The catalogue costs a dozen views; every Navigator call within a minute shares one read
  // (and concurrent calls share the read in flight).
  let catalogueCache = { at: -Infinity, p: null };
  function catalogue() {
    if (catalogueCache.p && Date.now() - catalogueCache.at < CATALOGUE_MS) return catalogueCache.p;
    const p = readCatalogue();
    catalogueCache = { at: Date.now(), p };
    p.catch(() => {
      if (catalogueCache.p === p) catalogueCache = { at: -Infinity, p: null }; // don't keep a failure
    });
    return p;
  }
  async function readCatalogue() {
    const snap = await view("colony_snapshot", {});
    let services = snap.services;
    for (let from = services.length; services.length % 100 === 0 && services.length && from < 1000; from += 100) {
      const more = await view("services", { from_index: from, limit: 100 }).catch(() => []);
      if (!more.length) break;
      services = services.concat(more);
    }
    services = services.filter((s) => s.live);
    const schemas = [];
    for (let i = 0; i < services.length; i += 100) schemas.push(...(await view("input_schemas", { ids: services.slice(i, i + 100).map((s) => s.id) }).catch(() => services.slice(i, i + 100).map(() => null))));
    const minds = new Map(snap.minds.map((r) => [r.id, r]));
    // Data services (categories below 7) are only offered while the Mind has an agent.
    const ids = [...new Set(services.map((s) => s.mind_id))];
    const withAgent = new Set();
    for (let i = 0; i < ids.length; i += 100) for (const p of await view("agent_profiles", { ids: ids.slice(i, i + 100) }).catch(() => [])) if (p.agent) withAgent.add(p.mind_id);
    return services
      .map((s, i) => ({ ...s, schema: schemas[i] ? JSON.parse(schemas[i]) : null, mind: minds.get(s.mind_id) }))
      .filter((s) => s.mind && s.mind.live_state !== "asleep" && s.mind.live_state !== "ghost" && (s.category >= 7 || withAgent.has(s.mind_id)));
  }

  async function onNavigate(b) {
    // The Navigator asks the colony model, which also writes the paid replies (one serial
    // queue): only signed-in players, and a few calls a minute each.
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const text = str(b.text, 500);
    if (!text) return [400, { error: "say what you need" }];
    if (!navigate(who)) return [429, { error: "a few searches a minute: try again shortly" }];
    const all = await catalogue();
    if (!all.length) return [200, { suggestions: [], note: "No live services yet." }];
    const w = words(text);
    const scored = all
      .map((s) => ({ s, score: [...words(`${s.title} ${s.description} ${Object.keys(s.schema?.properties || {}).join(" ")}`)].filter((x) => w.has(x)).length }))
      .sort((a, b) => b.score - a.score || b.s.orders - a.s.orders);
    let picks = scored.slice(0, 3).filter((x) => x.score > 0).map((x) => ({ s: x.s, why: "matches your words" }));
    if (plan) {
      try {
        // each service's form at most 1 KB here and the whole list at most 16 KB, whatever the
        // owners wrote, so one listing can't crowd out the rest or bloat the planner's prompt
        const list = clipBytes(
          scored
            .slice(0, 25)
            .map((x) => `#${x.s.id} "${x.s.title}": ${x.s.description.slice(0, 160)}${x.s.schema ? ` | input fields: ${clipBytes(JSON.stringify(x.s.schema.properties || {}), 1024)}` : " | input: free text"}`)
            .join("\n"),
          16_000
        );
        const out = await plan(
          `You route a user's request to services in an agent marketplace. Services:
${list}
Answer with only JSON: {"picks":[{"id":<service id>,"input":<an object with the service's input fields, or a string for free-text services>,"why":"<a few words>"}]} with the 1 to 3 services that can do it, best first. Use only ids from the list.`,
          text
        );
        const got = (firstJson(out).picks || []).map((p) => ({ s: all.find((x) => x.id === Number(p.id)), input: p.input, why: String(p.why || "").slice(0, 120) })).filter((p) => p.s);
        if (got.length) picks = got;
      } catch {
        /* the model is busy: keep the word matches */
      }
    }
    const suggestions = picks.map(({ s, input, why }) => {
      let ready = input;
      if (s.schema) {
        if (!ready || typeof ready !== "object") ready = guessArgs(s.schema, text) || {};
        ready = JSON.stringify(ready);
      } else if (typeof ready !== "string" || !ready.trim()) ready = text;
      return { service_id: s.id, mind_id: s.mind_id, title: s.title, mind: s.mind.mind.name, price: s.price, input: clipBytes(ready, 1000), why: why || "" };
    });
    return [200, { suggestions }];
  }

  async function onStatus(q) {
    const ids = (q.get("ids") || "").split(",").filter(Boolean).map(Number).filter(Number.isInteger);
    const list = (ids.length ? ids : store.mindIds()).slice(0, 200).map(publicView).filter(Boolean);
    return [200, { gateway: workerId, agents: list }];
  }

  async function canSeeJob(who, job) {
    return who === job.buyer || who === (await ownerOf(job.mind_id));
  }

  async function onJob(q, jobId) {
    const who = readToken(q.get("token") || "");
    if (!who) return [401, { error: "sign in again" }];
    const job = await view("get_job", { job_id: jobId }).catch(() => null);
    if (!job) return [404, { error: "no such job" }];
    if (!(await canSeeJob(who, job))) return [403, { error: "only the buyer and her owner see this job" }];
    const st = store.job(jobId);
    // the full result only once the job is Delivered on chain (paid for); the agent's question
    // is shown while it waits for the buyer
    return [200, { job_id: jobId, status: job.status, waiting: st?.state === "asking", question: st?.state === "asking" ? st.question : null, answered: st?.state === "answered", result: resultOf(jobId, job.status) }];
  }

  async function onAnswer(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const jobId = Number(b.jobId);
    const job = await view("get_job", { job_id: jobId }).catch(() => null);
    if (!job || job.buyer !== who) return [403, { error: "only the buyer can answer" }];
    if (job.status !== "Open") return [409, { error: "this job is closed" }];
    const st = store.job(jobId);
    if (st?.state !== "asking") return [409, { error: "the agent isn't waiting for an answer" }];
    const text = str(b.text, 2000);
    if (!text) return [400, { error: "write an answer" }];
    const answerFiles = (Array.isArray(b.files) ? b.files : []).filter((id) => store.fileMeta(id)?.owner === who).slice(0, 5);
    store.setJob(jobId, { ...st, state: "answered", answer: text, answerFiles });
    attempts.delete(jobId);
    return [200, { ok: true }];
  }

  async function onUpload(b) {
    const who = readToken(b.token);
    if (!who) return [401, { error: "sign in again" }];
    const data = Buffer.from(String(b.base64 || ""), "base64");
    if (!data.length) return [400, { error: "empty file" }];
    if (data.length > MAX_UPLOAD) return [413, { error: "files up to 6 MB" }];
    const f = store.putFile({ name: str(b.name, 120) || "file", mime: str(b.mime, 100) || "application/octet-stream", data, owner: who, mindId: null });
    return [200, { id: f.id, name: f.name, size: f.size, sha256: f.sha256 }];
  }

  // Files are served as downloads (never as pages on our origin), images inline.
  const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  async function onFile(q, id, res) {
    const meta = store.fileMeta(id);
    if (!meta) return [404, { error: "no such file" }];
    const who = readToken(q.get("token") || "");
    if (!who) return [401, { error: "sign in again" }];
    let ok = who === meta.owner;
    if (!ok && meta.jobId !== null) {
      const job = await view("get_job", { job_id: meta.jobId }).catch(() => null);
      ok = !!job && (await canSeeJob(who, job));
    }
    if (!ok && meta.mindId !== null && meta.mindId !== undefined) ok = who === (await ownerOf(meta.mindId));
    if (!ok) return [403, { error: "not your file" }];
    const inline = INLINE.has(meta.mime);
    // read before any header goes out: a missing file is then a clean 404, not a second
    // writeHead after the first one (ERR_HTTP_HEADERS_SENT)
    let data;
    try {
      data = store.fileData(id);
    } catch {
      return [404, { error: "that file is no longer stored" }];
    }
    res.writeHead(200, {
      "content-type": inline ? meta.mime : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${meta.name.replace(/[^\w.\- ]/g, "_")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "x-file-sha256": meta.sha256,
    });
    res.end(data);
    return null;
  }

  async function route(req, res, url, readBody, send) {
    const p = url.pathname.replace(/^\/agent\//, "");
    const post = req.method === "POST";
    if (post && p === "upload") return send(...(await onUpload(await readBody(req, 9_000_000))));
    if (post && p === "connect") return send(...(await onConnect(await readBody(req))));
    if (post && p === "disconnect") return send(...(await onDisconnect(await readBody(req))));
    if (post && p === "map") return send(...(await onMap(await readBody(req))));
    if (post && p === "test") return send(...(await onTest(await readBody(req))));
    if (post && p === "answer") return send(...(await onAnswer(await readBody(req))));
    if (!post && p === "status") return send(...(await onStatus(url.searchParams)));
    if (!post && p === "official") return send(200, { agents: official.list() });
    if (post && p === "navigate") return send(...(await onNavigate(await readBody(req))));
    let m;
    if (!post && (m = p.match(/^job\/(\d+)$/))) return send(...(await onJob(url.searchParams, Number(m[1]))));
    if (!post && (m = p.match(/^file\/([0-9a-f]{24})$/))) {
      const r = await onFile(url.searchParams, m[1], res);
      if (r) send(...r);
      return;
    }
    send(404, { error: "not found" });
  }

  // For the x402 door (worker/x402.js): the full result, the agent's open question, and the
  // buyer's answer to it, for a job whose task id the buyer holds.
  // `status`: the job's on-chain status. The stored result is revealed only for a Delivered job
  // (or, once the record is gone after close_job, one this gateway saw delivered); a stored
  // result of a job still Open or Refunded stays hidden, or the buyer could read it and refund.
  function resultOf(jobId, status) {
    const r = store.result(jobId);
    if (!r) return null;
    if (status === "Delivered") {
      if (!r.delivered) store.setResult(jobId, { ...r, delivered: true });
      return r;
    }
    if (status === undefined || status === null) return r.delivered ? r : null;
    return null;
  }
  const questionOf = (jobId) => (store.job(jobId)?.state === "asking" ? store.job(jobId).question : null);
  async function answerJob(jobId, text) {
    const job = await view("get_job", { job_id: jobId }).catch(() => null);
    if (!job || job.status !== "Open") return "this job is closed";
    const st = store.job(jobId);
    if (st?.state !== "asking") return "the agent isn't waiting for an answer";
    store.setJob(jobId, { ...st, state: "answered", answer: str(text, 2000), answerFiles: [] });
    attempts.delete(jobId);
    return null;
  }

  return { serves, about, chat, tick, route, health, resultOf, questionOf, answerJob };
}

module.exports = { makeGateway, trimSkills, publicUrl, capSchema, MAX_SCHEMA_BYTES, HANDED_OVER };
