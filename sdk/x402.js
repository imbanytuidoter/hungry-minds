// Hire a Mind over A2A + x402 from any script or agent: one HTTP call, paid in wNEAR from your
// own NEAR account with a signed delegate action (the site's worker relays it and pays the gas).
//
//   const { hireMind } = require("hungry-minds-agent/x402");
//   const task = await hireMind({
//     url: "https://<site>/api/agent/x402/12",   // the Mind's x402 address
//     contractId: "hungry-minds-8250f6.testnet", // the Hungry Minds contract you expect to pay (required)
//     accountId: "me.testnet",                    // key read from ~/.near-credentials/testnet
//     text: "Top 3 Polymarket markets by volume",
//     maxPrice: "0.5",                            // the most you pay for the service, in NEAR (default "1")
//   });
//   console.log(task.status.state, task.artifacts?.[0]?.parts?.[0]?.text);
//
// The payment is like Agent Market's USDC payment, in wNEAR: your delegate calls
// ft_transfer_call on the wNEAR contract, sending price + 0.03 NEAR to the Hungry Minds
// contract with the order as msg. The contract unwraps it and holds the price in escrow until
// her agent delivers; past the deadline it is refunded. Close the job later (`close_job`) to
// get the 0.03 NEAR storage deposit back. With `autoWrap` (the default) hireMind first
// registers you with wNEAR and wraps the NEAR you are short of (ordinary transactions you pay).
//
// The 402 offer comes from the server you called, so nothing in it is trusted: hireMind signs
// only a wNEAR ft_transfer_call (wrap.near / wrap.testnet) to YOUR `contractId`, for the
// service you asked for, of at most maxPrice + 0.03 NEAR, with at most 300 Tgas; anything else
// throws before a key is used.

const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { connect, keyStores, KeyPair, transactions, utils } = require("near-api-js");

const DEFAULT_RPC = { testnet: "https://near-testnet.drpc.org", mainnet: "https://free.rpc.fastnear.com" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wrapOf = (networkId) => (networkId === "mainnet" ? "wrap.near" : "wrap.testnet");
const JOB_DEPOSIT = 30_000_000_000_000_000_000_000n; // 0.03 NEAR, the contract's storage deposit per job
const MAX_GAS = 300_000_000_000_000n;
const DEFAULT_MAX_PRICE = "1"; // NEAR
// wNEAR's registration costs 0.00125 NEAR; a token asking more than this is not paid
const MAX_STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

// The most a service may cost unless the caller passes allowHighPrice: true. A cap far above
// any real price only protects against a typo (or yoctoNEAR passed as NEAR) if it is low.
const HIGH_PRICE = 100n * 10n ** 24n; // 100 NEAR
// maxPrice is in NEAR: a string with more integer digits than this is almost surely yoctoNEAR
// ("500000000000000000000000" meant as 0.5 NEAR would allow 5e23 NEAR).
const MAX_NEAR_DIGITS = 6;

/** maxPrice in NEAR ("0.5", 0.5) or a bigint of yoctoNEAR → yoctoNEAR. Over 100 NEAR throws
 *  unless `allowHighPrice`. */
function yoctoOf(maxPrice, { allowHighPrice = false } = {}) {
  let y;
  if (typeof maxPrice === "bigint") y = maxPrice;
  else {
    const s = String(maxPrice).trim();
    const int = /^(\d+)(\.\d+)?$/.exec(s)?.[1];
    if (int && int.replace(/^0+(?=\d)/, "").length > MAX_NEAR_DIGITS) throw new Error(`maxPrice is in NEAR; pass a bigint for yocto (got "${s}", which would be ${int.length} digits of NEAR)`);
    const parsed = /^\d+(\.\d{1,24})?$/.test(s) ? utils.format.parseNearAmount(s) : null;
    if (!parsed) throw new Error(`maxPrice must be an amount of NEAR such as "0.5" (or a bigint of yoctoNEAR), got ${maxPrice}`);
    y = BigInt(parsed);
  }
  if (y < 0n) throw new Error("maxPrice can't be negative");
  if (y > HIGH_PRICE && !allowHighPrice) throw new Error(`maxPrice ${utils.format.formatNearAmount(y.toString())} NEAR is above 100 NEAR: pass allowHighPrice: true if you really mean it`);
  return y;
}

/** The error for a paid call that did not return a task. A 504 means the payment was relayed
 *  but its outcome is unknown: code PAYMENT_UNKNOWN with the transaction hash; look the order up
 *  (jobs_of) before paying again, never retry blindly. A 409 "already relayed" is the same
 *  payment sent twice (code ALREADY_RELAYED). Pure: unit-tested. */
function paymentError(status, data, { contractId, accountId } = {}) {
  const msg = data?.error?.message || (typeof data?.error === "string" ? data.error : "") || JSON.stringify(data ?? null).slice(0, 300);
  const check = `check jobs_of(${accountId || "<your account>"}) on ${contractId || "the contract"} before trying again`;
  if (status === 504) {
    const transaction = data?.error?.data?.transaction || null;
    return Object.assign(new Error(`the payment was sent but its outcome is unknown${transaction ? ` (transaction ${transaction})` : ""}: it may still place your order, so ${check}; do not pay again blindly. (${msg})`), { code: "PAYMENT_UNKNOWN", status, transaction });
  }
  if (status === 409 && /already relayed/i.test(msg)) return Object.assign(new Error(`this payment was already relayed: ${check}`), { code: "ALREADY_RELAYED", status });
  return Object.assign(new Error(`payment refused (${status}): ${msg}`), { code: "PAYMENT_REFUSED", status });
}

/** Throws unless the 402 row is exactly the payment the caller agreed to. Pure: unit-tested. */
function checkRow(row, { contractId, networkId = "testnet", maxPrice = DEFAULT_MAX_PRICE, skillId, allowHighPrice = false } = {}) {
  if (!contractId) throw new Error("contractId is required: the Hungry Minds contract you expect to pay");
  const wrap = wrapOf(networkId);
  const e = row?.extra || {};
  if (String(row?.network) !== `near:${networkId}`) throw new Error(`the offer is for ${row?.network}, not near:${networkId}`);
  if (row.asset !== wrap) throw new Error(`the offer asks to pay in ${row.asset}, not ${wrap}: refused`);
  if (row.payTo !== contractId) throw new Error(`the offer pays ${row.payTo}, not ${contractId}: refused`);
  if (e.method !== "ft_transfer_call") throw new Error(`unsupported payment method: ${e.method}`);
  let amount;
  try {
    amount = BigInt(row.amount);
  } catch {
    throw new Error(`the offer's amount is not a number: ${row.amount}`);
  }
  const cap = yoctoOf(maxPrice, { allowHighPrice }) + JOB_DEPOSIT;
  if (amount <= 0n || amount > cap) throw new Error(`the offer asks ${utils.format.formatNearAmount(amount.toString())} NEAR, more than maxPrice + 0.03 NEAR (${utils.format.formatNearAmount(cap.toString())}): refused`);
  let gas;
  try {
    gas = BigInt(e.gas || "200000000000000");
  } catch {
    throw new Error(`the offer's gas is not a number: ${e.gas}`);
  }
  if (gas <= 0n || gas > MAX_GAS) throw new Error("the offer asks for more than 300 Tgas: refused");
  if (skillId && `service-${e.service_id}` !== skillId) throw new Error(`the offer is for service-${e.service_id}, not ${skillId}: refused`);
  return { wrap, amount, gas };
}

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
  // only the real wNEAR contracts: near_deposit sends NEAR to whatever contract this names
  if (wrap !== "wrap.near" && wrap !== "wrap.testnet") throw new Error(`ensureWnear only wraps on wrap.near / wrap.testnet, not ${wrap}`);
  const view = (m, a) => account.viewFunction({ contractId: wrap, methodName: m, args: a });
  if (!(await view("storage_balance_of", { account_id: account.accountId }))) {
    const b = await view("storage_balance_bounds", {});
    if (BigInt(b?.min ?? 0) > MAX_STORAGE_DEPOSIT) throw new Error(`${wrap} asks ${utils.format.formatNearAmount(String(b.min))} NEAR to register, more than 0.01 NEAR: refused`);
    await account.functionCall({ contractId: wrap, methodName: "storage_deposit", args: { account_id: account.accountId, registration_only: true }, gas: "30000000000000", attachedDeposit: b.min });
  }
  const have = BigInt(await view("ft_balance_of", { account_id: account.accountId }));
  if (have < BigInt(amount)) {
    await account.functionCall({ contractId: wrap, methodName: "near_deposit", args: {}, gas: "30000000000000", attachedDeposit: (BigInt(amount) - have).toString() });
  }
}

/** Build the X-PAYMENT header for one `accepts` row: a signed delegate calling the wNEAR
 *  contract's `ft_transfer_call` to the Mind's contract, with the order in `msg`. Low level:
 *  it signs the row as given, so check a row from a server with `checkRow` first (hireMind does). */
async function paymentFor(account, row, text, blockHeightTtl) {
  const e = row.extra || {};
  if (e.method !== "ft_transfer_call") throw new Error(`unsupported payment method: ${e.method}`);
  // near-api-js caches the access key and does not advance its nonce for a delegate, so read
  // it fresh and advance it ourselves: two payments from one account never share a nonce.
  if (account.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
  // the worker trims the message text before it compares it with the signed input: sign the
  // same trimmed text (and send it trimmed), or a message with a trailing newline is refused
  text = String(text ?? "").trim();
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
 * @param {string} o.contractId the Hungry Minds contract you expect to pay (required: the offer must pay exactly it)
 * @param {string} o.accountId  the paying NEAR account
 * @param {string} o.text       what you want done (sent as the job input, at most 1000 bytes)
 * @param {string|number|bigint} [o.maxPrice] the most the service may cost, in NEAR ("0.5"), or a
 *                              bigint of yoctoNEAR; the 0.03 NEAR storage deposit comes on top (default "1")
 * @param {string} [o.skillId]  "service-<id>" to pick one of her services (default: the first)
 * @param {string} [o.networkId] "testnet" (default) or "mainnet"
 * @param {string} [o.privateKey] "ed25519:..." (default: ~/.near-credentials/<network>/<account>.json)
 * @param {boolean} [o.autoWrap] register with wNEAR and wrap what is missing first (default true)
 * @param {boolean} [o.allowHighPrice] allow a maxPrice above 100 NEAR (default false)
 * @param {number} [o.waitMs]   how long to poll for the result (default 10 min)
 *
 * Errors carry a `code`: "PAYMENT_UNKNOWN" (HTTP 504: the payment was relayed but its outcome
 * is unknown; `transaction` holds the hash: look your order up with jobs_of before trying
 * again, hireMind never retries a payment), "ALREADY_RELAYED" (409) or "PAYMENT_REFUSED".
 */
async function hireMind({ url, contractId, accountId, text, skillId, maxPrice = DEFAULT_MAX_PRICE, allowHighPrice = false, networkId = "testnet", privateKey, nodeUrl, autoWrap = true, waitMs = 600_000, pollMs = 10_000 }) {
  if (!contractId) throw new Error("hireMind needs contractId: the Hungry Minds contract you expect to pay");
  yoctoOf(maxPrice, { allowHighPrice }); // a bad maxPrice fails before any network call
  // the worker trims the text it compares with the signed input; sign and send the same text
  text = String(text ?? "").trim();
  if (!text) throw new Error("hireMind needs text: what you want done");
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
  const rows = (first.data.accepts || []).filter((r) => String(r?.network) === `near:${networkId}` && (!skillId || `service-${r?.extra?.service_id}` === skillId));
  const row = rows[0];
  if (!row) throw new Error(`no payment option on near:${networkId}${skillId ? ` for ${skillId}` : ""}`);
  // never sign what the server says without checking it against what the caller agreed to
  const { wrap } = checkRow(row, { contractId, networkId, maxPrice, skillId, allowHighPrice });
  if (autoWrap) await ensureWnear(account, wrap, row.amount);
  // one paid call, never retried: a timeout may still have placed the order (PAYMENT_UNKNOWN)
  const paid = await rpc(url, body, { "X-PAYMENT": await paymentFor(account, row, text) });
  if (paid.status !== 200 || !paid.data.result) throw paymentError(paid.status, paid.data, { contractId, accountId });
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
  text = String(text ?? "").trim(); // the worker trims it too
  const message = { messageId: crypto.randomUUID(), role: "ROLE_USER", taskId, parts: [{ text }] };
  const r = await rpc(url, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message } });
  if (!r.data.result?.task) throw new Error(r.data.error?.message || `answer refused (${r.status})`);
  return poll(url, r.data.result.task, waitMs, pollMs);
}

module.exports = { hireMind, answer, paymentFor, ensureWnear, checkRow, paymentError, yoctoOf, HIGH_PRICE, formatNear: utils.format.formatNearAmount };
