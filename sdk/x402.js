// Hire a Mind over A2A + x402 from any script or agent: one HTTP call, paid from your own
// NEAR account with a signed delegate action (the site's worker relays it and pays the gas).
//
//   const { hireMind } = require("hungry-minds-agent/x402");
//   const task = await hireMind({
//     url: "https://<site>/api/agent/x402/12",   // the Mind's x402 address
//     accountId: "me.testnet",                    // key read from ~/.near-credentials/testnet
//     text: "Top 3 Polymarket markets by volume",
//   });
//   console.log(task.status.state, task.artifacts?.[0]?.parts?.[0]?.text);
//
// The price waits in the contract's escrow until her agent delivers; past the deadline it is
// refunded. Close the job later (`close_job`) to get the 0.03 NEAR storage deposit back.

const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { connect, keyStores, KeyPair, transactions } = require("near-api-js");

const DEFAULT_RPC = { testnet: "https://near-testnet.drpc.org", mainnet: "https://free.rpc.fastnear.com" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, body, headers = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text.slice(0, 300) } };
  }
  return { status: res.status, data, headers: res.headers };
}

/** Build the X-PAYMENT header for one `accepts` row: a signed delegate calling `order_job`. */
async function paymentFor(account, row, text, blockHeightTtl) {
  const e = row.extra || {};
  if (e.method !== "order_job") throw new Error(`unsupported payment method: ${e.method}`);
  // near-api-js caches the access key and does not advance its nonce for a delegate, so read
  // it fresh and advance it ourselves: two payments from one account never share a nonce.
  if (account.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
  const signed = await account.signedDelegate({
    receiverId: row.payTo,
    blockHeightTtl: blockHeightTtl ?? Math.min(row.maxTimeoutSeconds || 600, 600),
    actions: [transactions.functionCall("order_job", { service_id: e.service_id, input: text }, BigInt(e.gas || "100000000000000"), BigInt(row.amount))],
  });
  const cached = account.accessKeyByPublicKeyCache?.[signed.delegateAction.publicKey.toString()];
  if (cached) cached.nonce = signed.delegateAction.nonce;
  const encoded = Buffer.from(transactions.encodeSignedDelegate(signed)).toString("base64");
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: encoded } })).toString("base64");
}

/**
 * Hire a Mind. Returns the A2A task once it is done, failed, or waiting for your answer
 * (state TASK_STATE_INPUT_REQUIRED: reply with `answer(url, task.id, text)`).
 * @param {object} o
 * @param {string} o.url        the Mind's x402 address (…/api/agent/x402/<mind id>)
 * @param {string} o.accountId  the paying NEAR account
 * @param {string} o.text       what you want done (sent as the job input)
 * @param {string} [o.skillId]  "service-<id>" to pick one of her services (default: the first)
 * @param {string} [o.networkId] "testnet" (default) or "mainnet"
 * @param {string} [o.privateKey] "ed25519:..." (default: ~/.near-credentials/<network>/<account>.json)
 * @param {number} [o.waitMs]   how long to poll for the result (default 10 min)
 */
async function hireMind({ url, accountId, text, skillId, networkId = "testnet", privateKey, nodeUrl, waitMs = 600_000, pollMs = 10_000 }) {
  const keyStore = privateKey
    ? (() => {
        const k = new keyStores.InMemoryKeyStore();
        k.setKey(networkId, accountId, KeyPair.fromString(privateKey));
        return k;
      })()
    : new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId, keyStore, nodeUrl: nodeUrl || process.env.NEAR_RPC || DEFAULT_RPC[networkId] });
  const account = await near.account(accountId);

  const message = { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] };
  const body = { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message, ...(skillId ? { metadata: { skillId } } : {}) } };
  const first = await rpc(url, body);
  if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}: ${JSON.stringify(first.data).slice(0, 300)}`);
  const row = (first.data.accepts || []).find((r) => String(r.network).startsWith("near:"));
  if (!row) throw new Error("no NEAR payment option offered");
  const paid = await rpc(url, body, { "X-PAYMENT": await paymentFor(account, row, text) });
  if (paid.status !== 200 || !paid.data.result) throw new Error(`payment refused (${paid.status}): ${paid.data.error?.message || paid.data.error || JSON.stringify(paid.data).slice(0, 300)}`);
  const receipt = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
  const task = await poll(url, paid.data.result.task, waitMs, pollMs);
  // the relayed transaction (its hash, the payer), from the PAYMENT-RESPONSE header
  if (receipt) task.payment = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
  return task;
}

async function poll(url, task, waitMs, pollMs) {
  const until = Date.now() + waitMs;
  while (["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(task.status.state) && Date.now() < until) {
    await sleep(pollMs);
    const r = await rpc(url, { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: task.id } });
    if (r.data.result?.task) task = r.data.result.task;
  }
  return task;
}

/** Answer her agent's question (a task in TASK_STATE_INPUT_REQUIRED); free, then polls on. */
async function answer(url, taskId, text, { waitMs = 600_000, pollMs = 10_000 } = {}) {
  const message = { messageId: crypto.randomUUID(), role: "ROLE_USER", taskId, parts: [{ text }] };
  const r = await rpc(url, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message } });
  if (!r.data.result?.task) throw new Error(r.data.error?.message || `answer refused (${r.status})`);
  return poll(url, r.data.result.task, waitMs, pollMs);
}

module.exports = { hireMind, answer, paymentFor };
