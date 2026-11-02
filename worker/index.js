// Hungry Minds — off-chain thinking worker (pull model).
//
// Polls the contract for parked thoughts (`pending_requests`), builds each Mind's
// personality from its on-chain traits, asks NEAR AI for a short in-character reply,
// and resumes the thought on-chain via `respond(request_id, reply)`.
//
// This is the functional demo brain. The verified-TEE upgrade path is to run the same
// prompt-building + NEAR AI call inside an OutLayer TEE enclave (see worker/README.md),
// which signs the reply so the "verified ✓" badge is cryptographic rather than trusted.
//
// Config via env (see .env.example). Run: `node index.js`.

const { connect, keyStores, KeyPair, utils } = require("near-api-js");
const { systemPrompt } = require("./personality");
const { cleanReply, withTimeout } = require("./reply");

const CONTRACT_ID = required("CONTRACT_ID");
const WORKER_ID = required("WORKER_ID");
const WORKER_KEY = required("WORKER_KEY"); // ed25519:... full access key of WORKER_ID
const NEAR_AI_KEY = required("NEAR_AI_KEY");
const NEAR_AI_URL =
  process.env.NEAR_AI_URL || "https://cloud-api.near.ai/v1/chat/completions";
// A Private-TEE model is required for a genuinely "verified" reply.
const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL || "deepseek-v3.1";
const NETWORK = process.env.NEAR_NETWORK || "testnet";
const POLL_MS = parseInt(process.env.POLL_MS || "3000", 10);
const NEAR_AI_TIMEOUT_MS = parseInt(process.env.NEAR_AI_TIMEOUT_MS || "30000", 10);
// Give up after this many failed attempts on one request; it then times out on-chain and the
// Mind is refunded (finalize_thought), so a persistently failing thought can't be hammered.
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3", 10);
const GAS = "60000000000000"; // 60 Tgas for respond

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

async function nearAccount() {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, WORKER_ID, KeyPair.fromString(WORKER_KEY));
  const near = await connect({
    networkId: NETWORK,
    keyStore,
    nodeUrl: `https://rpc.${NETWORK}.near.org`,
  });
  return near.account(WORKER_ID);
}

async function askNearAI(mind, prompt) {
  const res = await withTimeout(
    fetch(NEAR_AI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${NEAR_AI_KEY}`,
      },
      body: JSON.stringify({
        model: NEAR_AI_MODEL,
        max_tokens: 160,
        messages: [
          { role: "system", content: systemPrompt(mind) },
          { role: "user", content: prompt },
        ],
      }),
    }),
    NEAR_AI_TIMEOUT_MS,
    "NEAR AI request"
  );
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Clamp to what the contract will store (char-safe), so we don't pay gas for truncated bytes.
  return cleanReply(data.choices?.[0]?.message?.content);
}

async function main() {
  const account = await nearAccount();
  console.log(`worker ${WORKER_ID} watching ${CONTRACT_ID} on ${NETWORK}`);

  const view = (method, args = {}) =>
    account.viewFunction({ contractId: CONTRACT_ID, methodName: method, args });

  // Avoid double-answering the same request if a reply tx is slow to land.
  const inFlight = new Set();
  // request_id -> failed attempts; a request that keeps failing is abandoned (it then times
  // out on-chain and refunds the Mind) so we never hammer it forever.
  const attempts = new Map();

  for (;;) {
    try {
      const pending = await view("pending_requests", {});
      const live = new Set(pending.map((r) => r.request_id));
      // forget attempt counts for requests that are no longer pending (answered or timed out)
      for (const id of attempts.keys()) if (!live.has(id)) attempts.delete(id);

      for (const req of pending) {
        if (inFlight.has(req.request_id)) continue;
        if ((attempts.get(req.request_id) || 0) >= MAX_ATTEMPTS) continue; // given up
        inFlight.add(req.request_id);
        handle(account, view, req, attempts).finally(() => inFlight.delete(req.request_id));
      }
    } catch (e) {
      console.error("poll error:", e.message);
    }
    await sleep(POLL_MS);
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
    const reply = await askNearAI({ ...mind, state }, req.prompt);
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
  } catch (e) {
    console.error(`#${req.request_id} attempt ${n}/${MAX_ATTEMPTS} failed:`, e.message);
    if (n >= MAX_ATTEMPTS) {
      console.error(`#${req.request_id} abandoned; it will time out on-chain and refund the Mind.`);
    }
    // Otherwise leave it parked; the next poll retries it.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
