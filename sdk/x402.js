// Hire a Mind over A2A + x402 from any script or agent: one HTTP call, paid in wNEAR from your
// own NEAR account with a signed delegate action (the site's worker relays it and pays the gas).
//
//   const { hireMind } = require("hungry-minds-agent/x402");
//   const task = await hireMind({
//     url: "https://<site>/api/agent/x402/12",   // the Mind's x402 address
//     accountId: "me.testnet",                    // key read from ~/.near-credentials/testnet
//     text: "Top 3 Polymarket markets by volume",
//   });
//   console.log(task.status.state, task.artifacts?.[0]?.parts?.[0]?.text);
//
// The payment is like Agent Market's USDC payment, in wNEAR: your delegate calls
// ft_transfer_call on the wNEAR contract, sending price + 0.03 NEAR to the Hungry Minds
// contract with the order as msg. The contract unwraps it and holds the price in escrow until
// her agent delivers; past the deadline it is refunded. Close the job later (`close_job`) to
// get the 0.03 NEAR storage deposit back. With `autoWrap` (the default) hireMind first
// registers you with wNEAR and wraps the NEAR you are short of (ordinary transactions you pay).

const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { connect, keyStores, KeyPair, transactions, utils } = require("near-api-js");

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

/** Make sure `account` holds `amount` yoctoNEAR of wNEAR on `wrap`: register it with the token
 *  if needed (storage_deposit) and wrap what is missing (near_deposit). */
async function ensureWnear(account, wrap, amount) {
  const view = (m, a) => account.viewFunction({ contractId: wrap, methodName: m, args: a });
  if (!(await view("storage_balance_of", { account_id: account.accountId }))) {
    const b = await view("storage_balance_bounds", {});
    await account.functionCall({ contractId: wrap, methodName: "storage_deposit", args: { account_id: account.accountId, registration_only: true }, gas: "30000000000000", attachedDeposit: b.min });
  }
  const have = BigInt(await view("ft_balance_of", { account_id: account.accountId }));
  if (have < BigInt(amount)) {
    await account.functionCall({ contractId: wrap, methodName: "near_deposit", args: {}, gas: "30000000000000", attachedDeposit: (BigInt(amount) - have).toString() });
  }
}

/** Build the X-PAYMENT header for one `accepts` row: a signed delegate calling the wNEAR
 *  contract's `ft_transfer_call` to the Mind's contract, with the order in `msg`. */
async function paymentFor(account, row, text, blockHeightTtl) {
  const e = row.extra || {};
  if (e.method !== "ft_transfer_call") throw new Error(`unsupported payment method: ${e.method}`);
  // near-api-js caches the access key and does not advance its nonce for a delegate, so read
  // it fresh and advance it ourselves: two payments from one account never share a nonce.
  if (account.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
  const args = { receiver_id: row.payTo, amount: row.amount, msg: JSON.stringify({ service_id: e.service_id, input: text }) };
  const signed = await account.signedDelegate({
    receiverId: row.asset,
    blockHeightTtl: blockHeightTtl ?? 600,
    actions: [transactions.functionCall("ft_transfer_call", args, BigInt(e.gas || "200000000000000"), 1n)],
  });
  const cached = account.accessKeyByPublicKeyCache?.[signed.delegateAction.publicKey.toString()];
  if (cached) cached.nonce = signed.delegateAction.nonce;
  const encoded = Buffer.from(transactions.encodeSignedDelegate(signed)).toString("base64");
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: encoded } })).toString("base64");
}

/**
 * Hire a Mind. Returns the A2A task once it is done, failed, or waiting for your answer
 * (state TASK_STATE_INPUT_REQUIRED: reply with `answer(url, task.id, text)`). `task.payment`
 * holds the relayed transaction (hash, payer).
 * @param {object} o
 * @param {string} o.url        the Mind's x402 address (…/api/agent/x402/<mind id>)
 * @param {string} o.accountId  the paying NEAR account
 * @param {string} o.text       what you want done (sent as the job input, at most 1000 bytes)
 * @param {string} [o.skillId]  "service-<id>" to pick one of her services (default: the first)
 * @param {string} [o.networkId] "testnet" (default) or "mainnet"
 * @param {string} [o.privateKey] "ed25519:..." (default: ~/.near-credentials/<network>/<account>.json)
 * @param {boolean} [o.autoWrap] register with wNEAR and wrap what is missing first (default true)
 * @param {number} [o.waitMs]   how long to poll for the result (default 10 min)
 */
async function hireMind({ url, accountId, text, skillId, networkId = "testnet", privateKey, nodeUrl, autoWrap = true, waitMs = 600_000, pollMs = 10_000 }) {
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
  if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}: ${first.data.error?.message || JSON.stringify(first.data).slice(0, 300)}`);
  const row = (first.data.accepts || []).find((r) => String(r.network) === `near:${networkId}`);
  if (!row) throw new Error(`no payment option on near:${networkId}`);
  if (autoWrap) await ensureWnear(account, row.asset, row.amount);
  const paid = await rpc(url, body, { "X-PAYMENT": await paymentFor(account, row, text) });
  if (paid.status !== 200 || !paid.data.result) throw new Error(`payment refused (${paid.status}): ${paid.data.error?.message || paid.data.error || JSON.stringify(paid.data).slice(0, 300)}`);
  const receipt = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
  const task = await poll(url, paid.data.result.task, waitMs, pollMs);
  if (receipt) task.payment = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
  return task;
}

async function poll(url, task, waitMs, pollMs) {
  const until = Date.now() + waitMs;
  while (task && ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(task.status?.state) && Date.now() < until) {
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

module.exports = { hireMind, answer, paymentFor, ensureWnear, formatNear: utils.format.formatNearAmount };
