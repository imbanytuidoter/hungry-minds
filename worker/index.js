// Hungry Minds — off-chain thinking worker (pull model).
//
// Polls the contract for parked thoughts (`pending_requests`), builds each Mind's
// personality from its on-chain traits, asks NEAR AI for a short in-character reply,
// and resumes the thought on-chain via `respond(request_id, reply)`.
//
// With NEAR_AI_KEY set, the model runs inside NEAR AI Cloud's TEE and each reply comes with
// the enclave's signature, checked here (worker/near-ai.js) for the "verified ✓" badge.
// Without a key it uses an open endpoint and the reply has no badge.
//
// Config via env (see .env.example). Run: `node index.js`.

// worker/.env (gitignored) holds secrets such as NEAR_AI_KEY; variables already set win.
try {
  process.loadEnvFile(require("path").join(__dirname, ".env"));
} catch {
  /* no .env: everything comes from the environment */
}

const { connect, keyStores, KeyPair, utils } = require("near-api-js");
const { systemPrompt } = require("./personality");
const { cleanReply, clipUtf8, phrasebookAllowed, withTimeout } = require("./reply");
const { phrasebookReply } = require("./phrasebook");
const { startChatServer, secretFor } = require("./chat-server");
const { makeJobRunner, makeSleepRecorder } = require("./jobs");
const { makeGateway } = require("./gateway");
const { makeX402 } = require("./x402");
const { Store } = require("./gateway/store");
const { readToken } = require("./chat-auth");
const { proofFor, stripThinking } = require("./near-ai");

const CONTRACT_ID = required("CONTRACT_ID");
const WORKER_ID = required("WORKER_ID");
// ed25519:... key of WORKER_ID; if unset, read from near-cli's ~/.near-credentials/<network>/.
const WORKER_KEY = process.env.WORKER_KEY || "";
// The brain, in order of preference:
//   1. NEAR AI (set NEAR_AI_KEY) — the intended Private-TEE path;
//   2. an open OpenAI-compatible endpoint (LLM_URL, default: Pollinations, no key needed);
//   3. the offline phrasebook (phrasebook.js), only with no model configured, or for the owner's own on-chain thought when the model fails.
// Set LLM_URL=off to skip (2). NEAR_AI=off ignores the key (QA runs that must not spend the
// NEAR AI credits: `node qa/run.js --no-near-ai`).
const NEAR_AI_KEY = process.env.NEAR_AI === "off" ? "" : process.env.NEAR_AI_KEY || "";
const NEAR_AI_URL =
  process.env.NEAR_AI_URL || "https://cloud-api.near.ai/v1/chat/completions";
// A model on NEAR AI's own TEE fleet, so every reply is signed by the enclave (near-ai.js).
// A reply costs far less than the 0.002 NEAR a thought costs the Mind, so her food really
// pays for her thinking.
const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL || "Qwen/Qwen3.8-27B";
const OPEN_LLM_URL = process.env.LLM_URL || "https://text.pollinations.ai/openai";
const LLM = NEAR_AI_KEY
  ? { name: `NEAR AI (${NEAR_AI_MODEL})`, url: NEAR_AI_URL, key: NEAR_AI_KEY, model: NEAR_AI_MODEL }
  : OPEN_LLM_URL === "off"
    ? null
    : { name: `open LLM (${process.env.LLM_MODEL || "openai"} @ ${new URL(OPEN_LLM_URL).host})`, url: OPEN_LLM_URL, key: process.env.LLM_KEY || "", model: process.env.LLM_MODEL || "openai" };
const NETWORK = process.env.NEAR_NETWORK || "testnet";
const POLL_MS = parseInt(process.env.POLL_MS || "3000", 10);
const NEAR_AI_TIMEOUT_MS = parseInt(process.env.NEAR_AI_TIMEOUT_MS || "30000", 10);
// Give up after this many failed attempts on one request; it then times out on-chain and the
// Mind is refunded (finalize_thought), so a persistently failing thought can't be hammered.
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3", 10);
const GAS = "60000000000000"; // 60 Tgas for respond
// Wait this long before answering a freshly parked thought (a keeper may answer their own
// Mind's thought in that window; `respond` allows it).
const GRACE_MS = parseInt(process.env.GRACE_MS || "8000", 10);
// Each delivered reply earns the worker the thought cost (it runs the model and pays the
// respond gas). Withdraw it once it reaches CLAIM_AT_NEAR, checked every CLAIM_EVERY_MS.
const CLAIM_AT = BigInt(utils.format.parseNearAmount(process.env.CLAIM_AT_NEAR || "0.05"));
const CLAIM_EVERY_MS = parseInt(process.env.CLAIM_EVERY_MS || "600000", 10);

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

async function nearAccount() {
  let keyStore;
  if (WORKER_KEY) {
    keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(NETWORK, WORKER_ID, KeyPair.fromString(WORKER_KEY));
  } else {
    keyStore = new keyStores.UnencryptedFileSystemKeyStore(require("path").join(require("os").homedir(), ".near-credentials"));
  }
  const near = await connect({
    networkId: NETWORK,
    keyStore,
    // rpc.<network>.near.org is deprecated and rate-limited; FastNEAR by default.
    nodeUrl: process.env.NEAR_RPC || (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
  });
  return near.account(WORKER_ID);
}

// One model call at a time, so a free tier's per-IP limit is respected instead of tripped.
let llmQueue = Promise.resolve();
// `history`: earlier turns of this conversation ({role, content}), oldest first.
function askLLM(mind, prompt, history = []) {
  const run = llmQueue.then(() => askLLMOnce(mind, prompt, 0, history));
  llmQueue = run.catch(() => {});
  return run;
}

// The colony model as a plain tool (no Mind voice): the gateway uses it to turn a request in
// plain words into a call to one of an MCP agent's tools.
// The planner's prompts carry text from connected agents (tool lists, schemas) and players;
// a hard cap on the whole prompt keeps one call from hogging the queue the paid replies share.
const MAX_PLAN_SYSTEM_BYTES = 32_000;
const MAX_PLAN_USER_BYTES = 8_000;
function planLLM(system, user) {
  if (!LLM) return Promise.reject(new Error("no model configured"));
  system = clipUtf8(system, MAX_PLAN_SYSTEM_BYTES);
  user = clipUtf8(user, MAX_PLAN_USER_BYTES);
  const run = llmQueue.then(() => planOnce(system, user, 0));
  llmQueue = run.catch(() => {});
  return run;
}

async function planOnce(system, user, attempt) {
  {
    const res = await withTimeout(
      fetch(LLM.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(LLM.key ? { authorization: `Bearer ${LLM.key}` } : {}) },
        // NEAR AI's Qwen thinks out loud unless told not to: a tool call wants just the answer
        body: JSON.stringify({ model: LLM.model, max_tokens: NEAR_AI_KEY ? 500 : 800, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...(NEAR_AI_KEY ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
      }),
      NEAR_AI_TIMEOUT_MS,
      "planner request"
    );
    if ((res.status === 402 || res.status === 429) && attempt < 2) {
      const wait = Number(/Retry after (\d+)s/i.exec(await res.text())?.[1] ?? 45);
      await sleep((wait + 1) * 1000);
      return planOnce(system, user, attempt + 1);
    }
    if (!res.ok) throw new Error(`${LLM.name} ${res.status}`);
    return stripThinking((await res.json()).choices?.[0]?.message?.content || "");
  }
}

// NEAR AI's signed proof for each reply it wrote, by the reply text (chat-server shows it).
const proofs = new Map();
const proofOf = (reply) => proofs.get(reply) || null;

async function askLLMOnce(mind, prompt, attempt, history = [], plain = false) {
  const nearAI = !!NEAR_AI_KEY;
  const body = JSON.stringify({
    model: LLM.model,
    // the open endpoint's model reasons before it answers: with too small a budget it
    // runs out before the answer ("output_token_limit_exceeded"); cleanReply trims the reply anyway
    max_tokens: nearAI ? 400 : 600,
    messages: [{ role: "system", content: systemPrompt(mind) }, ...history, { role: "user", content: prompt }],
    // a short in-character answer, not a reasoning trace (Qwen3 thinks first unless told not to)
    ...(nearAI && !plain ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  });
  const res = await withTimeout(
    fetch(LLM.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LLM.key ? { authorization: `Bearer ${LLM.key}` } : {}),
        // the canonical model id, so the enclave (not an alias) signs it
        ...(nearAI ? { "x-no-aliasing": "true" } : {}),
      },
      body,
    }),
    NEAR_AI_TIMEOUT_MS,
    "LLM request"
  );
  if ((res.status === 402 || res.status === 429) && attempt < 2) {
    // Rate limited: wait as told (the thought stays parked for ~200 blocks), then retry.
    const text = await res.text();
    const wait = Number(/Retry after (\d+)s/i.exec(text)?.[1] ?? 45);
    console.log(`rate limited by ${LLM.name}; retrying in ${wait + 1}s`);
    await sleep((wait + 1) * 1000);
    return askLLMOnce(mind, prompt, attempt + 1, history, plain);
  }
  const raw = await res.text();
  // an endpoint that doesn't take the no-thinking switch: ask again without it
  if (res.status === 400 && nearAI && !plain && /chat_template_kwargs|enable_thinking/i.test(raw)) return askLLMOnce(mind, prompt, attempt, history, true);
  if (!res.ok) throw new Error(`${LLM.name} ${res.status}: ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  // Clamp to what the contract will store (char-safe), so we don't pay gas for truncated bytes.
  const reply = cleanReply(stripThinking(data.choices?.[0]?.message?.content));
  if (nearAI && reply) {
    const base = LLM.url.replace(/\/chat\/completions\/?$/, "");
    const proof = await proofFor({ base, key: NEAR_AI_KEY, model: LLM.model, requestBody: body, responseBody: raw, chatId: data.id }).catch(() => null);
    if (proof) {
      proofs.set(reply, proof);
      if (proofs.size > 500) proofs.delete(proofs.keys().next().value);
      console.log(`NEAR AI reply ${data.id}: ${proof.verified ? `signed by ${proof.signer} (${proof.kind}), verified` : "no verifiable signature"}`);
    }
  }
  return reply;
}

async function main() {
  const account = await nearAccount();
  console.log(`worker ${WORKER_ID} watching ${CONTRACT_ID} on ${NETWORK}`);
  console.log(`brain: ${LLM ? LLM.name : "offline phrasebook"}`);

  const view = (method, args = {}) =>
    account.viewFunction({ contractId: CONTRACT_ID, methodName: method, args });

  // Agents connected by URL (gateway/); GATEWAY=off turns it off.
  const secret = secretFor(__dirname, CONTRACT_ID);
  const gateway =
    process.env.GATEWAY === "off"
      ? null
      : makeGateway({
          view,
          account,
          contractId: CONTRACT_ID,
          workerId: WORKER_ID,
          store: new Store(__dirname, CONTRACT_ID, secret),
          plan: planLLM,
          readToken: (t) => readToken(secret, t),
        });

  // Chat without a transaction per message (chat-server.js); CHAT_PORT=off turns it off.
  if (process.env.CHAT_PORT !== "off") {
    startChatServer({
      gateway,
      // Hire any Mind's services over A2A + x402 (x402.js); X402=off turns it off.
      x402:
        process.env.X402 === "off"
          ? null
          : makeX402({ view, account, contractId: CONTRACT_ID, network: NETWORK, secret, gateway, publicUrl: process.env.PUBLIC_SITE_URL || "" }),
      account,
      view,
      contractId: CONTRACT_ID,
      workerId: WORKER_ID,
      askLLM: (mind, prompt, history) => (LLM ? askLLM(mind, prompt, history) : Promise.resolve("")),
      // with a model configured an empty reply is a failure (nothing charged), never the phrasebook
      hasModel: !!LLM,
      plan: LLM ? planLLM : null,
      proofOf,
      fallbackReply: phrasebookReply,
      cleanReply,
      dir: __dirname,
    });
  }

  // Jobs of Minds with no agent of their own (jobs.js); JOBS=off turns it off.
  const jobs =
    process.env.JOBS === "off"
      ? null
      : makeJobRunner({
          account,
          view,
          contractId: CONTRACT_ID,
          answer: async (mindId, prompt, seed) => {
            const mind = await view("get_mind", { id: mindId });
            if (!mind) return "";
            const state = (await view("mind_state", { id: mindId })) || "content";
            const look = await view("get_look", { id: mindId }).catch(() => null);
            const who = { ...mind, state, natures: look?.natures || [] };
            // A paid job never gets a canned phrasebook line when a model is configured: if the
            // model fails, nothing is delivered, the runner tries again later, and past the
            // deadline the buyer is refunded. With no model at all the phrasebook is her voice.
            if (!LLM) return cleanReply(phrasebookReply(who, prompt, seed));
            return askLLM(who, prompt).catch((e) => (console.error(`job: ${LLM.name} failed, will retry:`, e.message), ""));
          },
        });

  // Records on chain the sleep of Minds that starved on idle burn, so their ghost window starts
  // (jobs.js makeSleepRecorder: `settle`, once a minute, paid in gas by this account); SLEEP=off
  // turns it off. Independent of JOBS.
  const sleeper = process.env.SLEEP === "off" ? null : makeSleepRecorder({ account, view, contractId: CONTRACT_ID });

  // Avoid double-answering the same request if a reply tx is slow to land.
  const inFlight = new Set();
  // request_id -> failed attempts; a request that keeps failing is abandoned (it then times
  // out on-chain and refunds the Mind) so we never hammer it forever.
  const attempts = new Map();
  // request_id -> time answered. A view can still list a request for a few blocks after our
  // respond lands; answering it twice would only burn gas on a rejected call.
  const answered = new Map();
  // request_id -> when we first saw it (for the browser's grace period).
  const firstSeen = new Map();
  let lastClaimCheck = 0;

  for (;;) {
    if (Date.now() - lastClaimCheck > CLAIM_EVERY_MS) {
      lastClaimCheck = Date.now();
      await claimEarnings(account, view);
    }
    try {
      const pending = await view("pending_requests", {});
      const live = new Set(pending.map((r) => r.request_id));
      // forget attempt counts for requests that are no longer pending (answered or timed out)
      for (const id of attempts.keys()) if (!live.has(id)) attempts.delete(id);
      for (const [id, t] of answered) if (!live.has(id) && Date.now() - t > 60_000) answered.delete(id);
      for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id);

      for (const req of pending) {
        if (inFlight.has(req.request_id) || answered.has(req.request_id)) continue;
        if (!firstSeen.has(req.request_id)) firstSeen.set(req.request_id, Date.now());
        if (Date.now() - firstSeen.get(req.request_id) < GRACE_MS) continue;
        if ((attempts.get(req.request_id) || 0) >= MAX_ATTEMPTS) continue; // given up
        inFlight.add(req.request_id);
        handle(account, view, req, attempts)
          .then((ok) => ok && answered.set(req.request_id, Date.now()))
          .finally(() => inFlight.delete(req.request_id));
      }
    } catch (e) {
      console.error("poll error:", e.message);
    }
    if (jobs) await jobs.tick().catch((e) => console.error("jobs poll error:", e.message));
    if (sleeper) await sleeper.tick().catch((e) => console.error("sleep scan error:", e.message));
    if (gateway) await gateway.tick().catch((e) => console.error("gateway poll error:", e.message));
    await sleep(POLL_MS);
  }
}

async function claimEarnings(account, view) {
  try {
    const earned = BigInt(await view("responder_earnings_of", { account_id: WORKER_ID }));
    if (earned < CLAIM_AT) return;
    await account.functionCall({ contractId: CONTRACT_ID, methodName: "claim_responder_earnings", args: {}, gas: "30000000000000", attachedDeposit: "0" });
    console.log(`claimed ${utils.format.formatNearAmount(earned.toString(), 4)} NEAR earned answering thoughts`);
  } catch (e) {
    console.error("claim error:", e.message);
  }
}

async function handle(account, view, req, attempts) {
  const n = (attempts.get(req.request_id) || 0) + 1;
  attempts.set(req.request_id, n);
  try {
    const mind = await view("get_mind", { id: req.mind_id });
    if (!mind) {
      // The Mind was transferred or reaped mid-flight; nothing to answer.
      attempts.delete(req.request_id);
      return;
    }
    const state = (await view("mind_state", { id: req.mind_id })) || "content";
    const look = await view("get_look", { id: req.mind_id }).catch(() => null);
    const who = { ...mind, state, natures: look?.natures || [] };
    let reply = "";
    if (LLM) {
      try {
        reply = await askLLM(who, req.prompt);
      } catch (e) {
        console.error(`#${req.request_id} ${LLM.name} failed:`, e.message);
      }
    }
    // A guest's thought (by_owner false: a paid chat or service order) holds the guest's escrow,
    // which `respond` releases to the owner. A canned phrasebook line must never "deliver" it:
    // with a model configured and failing, the guest's thought is left unanswered, so it times
    // out on chain and the guest gets the whole escrow back. The owner's own thought (paid from
    // her food) may still get the phrasebook, and with no model at all it is her only voice.
    if (!reply && !phrasebookAllowed({ hasModel: !!LLM, byOwner: req.by_owner })) throw new Error("the model gave no reply; a guest's paid thought is never answered from the phrasebook (it times out and refunds the guest)");
    if (!reply) reply = cleanReply(phrasebookReply(who, req.prompt, req.request_id));
    if (!reply) throw new Error("empty reply");

    await account.functionCall({
      contractId: CONTRACT_ID,
      methodName: "respond",
      args: { request_id: req.request_id, reply },
      gas: GAS,
      attachedDeposit: "0",
    });
    attempts.delete(req.request_id);
    console.log(`#${req.request_id} mind ${req.mind_id}: ${reply.slice(0, 80)}`);
    return true;
  } catch (e) {
    console.error(`#${req.request_id} attempt ${n}/${MAX_ATTEMPTS} failed:`, e.message);
    if (n >= MAX_ATTEMPTS) {
      console.error(`#${req.request_id} abandoned; it will time out on-chain and refund the Mind.`);
    }
    // Otherwise leave it parked; the next poll retries it.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stray rejection in an HTTP handler or a fire-and-forget promise must not kill the worker
// (Node's default for an unhandled rejection is to exit): log it and keep serving.
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection (kept running):", e?.stack || e);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
