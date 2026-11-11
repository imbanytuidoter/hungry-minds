// hireMind signs a payment described by the server it calls: checkRow refuses any row that is
// not exactly the payment the caller agreed to (A5 F1).
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRow, ensureWnear, hireMind, yoctoOf, paymentError, paymentFor, HIGH_PRICE } = require("./x402");
const { transactions } = require("near-api-js");

const C = "hungry-minds-8250f6.testnet";
const row = (o = {}, extra = {}) => ({
  scheme: "exact",
  network: "near:testnet",
  asset: "wrap.testnet",
  payTo: C,
  amount: "40000000000000000000000", // 0.01 + 0.03 NEAR
  ...o,
  extra: { method: "ft_transfer_call", service_id: 7, gas: "200000000000000", ...extra },
});
const ok = (r, o = {}) => checkRow(r, { contractId: C, networkId: "testnet", ...o });

test("the honest row passes", () => {
  assert.equal(ok(row()).wrap, "wrap.testnet");
  assert.equal(ok(row(), { skillId: "service-7", maxPrice: "0.01" }).amount, 40_000_000_000_000_000_000_000n);
  assert.equal(checkRow(row({ network: "near:mainnet", asset: "wrap.near" }), { contractId: C, networkId: "mainnet" }).wrap, "wrap.near");
});

test("a hostile 402 row is refused before anything is signed", () => {
  assert.throws(() => checkRow(row(), {}), /contractId is required/);
  assert.throws(() => ok(row({ asset: "evil-token.testnet" })), /not wrap.testnet/);
  assert.throws(() => ok(row({ payTo: "attacker.testnet" })), /not hungry-minds/);
  assert.throws(() => ok(row({}, { method: "ft_transfer" })), /unsupported payment method/);
  assert.throws(() => ok(row({ amount: "5000000000000000000000000" })), /more than maxPrice/, "5 NEAR > 1 NEAR + 0.03 default");
  assert.throws(() => ok(row(), { maxPrice: "0.001" }), /more than maxPrice/);
  assert.throws(() => ok(row({ amount: "nope" })), /not a number/);
  assert.throws(() => ok(row({}, { gas: "300000000000001" })), /300 Tgas/);
  assert.throws(() => ok(row(), { skillId: "service-8" }), /not service-8/);
  assert.throws(() => ok(row({ network: "near:mainnet" })), /not near:testnet/);
  assert.throws(() => ok(row(), { maxPrice: "lots" }), /maxPrice must be/);
});

test("maxPrice in yoctoNEAR as a bigint works too", () => {
  assert.ok(ok(row(), { maxPrice: 10_000_000_000_000_000_000_000n }));
  assert.throws(() => ok(row(), { maxPrice: 9_999_999_999_999_999_999_999n }), /more than maxPrice/);
});

test("ensureWnear only touches the real wNEAR contract, and refuses a costly registration", async () => {
  const calls = [];
  const account = (min) => ({
    accountId: "me.testnet",
    viewFunction: async ({ methodName }) => (methodName === "storage_balance_of" ? null : methodName === "storage_balance_bounds" ? { min } : "0"),
    functionCall: async (c) => calls.push(c),
  });
  await assert.rejects(ensureWnear(account("1250000000000000000000"), "evil.testnet", "1"), /only wraps on wrap/);
  await assert.rejects(ensureWnear(account("1000000000000000000000000"), "wrap.testnet", "1"), /more than 0.01 NEAR/);
  assert.equal(calls.length, 0);
  await ensureWnear(account("1250000000000000000000"), "wrap.testnet", "1");
  assert.deepEqual(calls.map((c) => c.methodName), ["storage_deposit", "near_deposit"]);
});

test("hireMind needs contractId", async () => {
  await assert.rejects(hireMind({ url: "http://127.0.0.1:1/x", accountId: "me.testnet", text: "hi" }), /needs contractId/);
});

// ── round 2 ──
test("R2 M-2: a yoctoNEAR string passed as maxPrice throws; above 100 NEAR needs allowHighPrice", async () => {
  assert.throws(() => yoctoOf("500000000000000000000000"), /maxPrice is in NEAR; pass a bigint for yocto/);
  assert.throws(() => yoctoOf("1234567"), /pass a bigint for yocto/);
  assert.throws(() => yoctoOf("1234567.5"), /pass a bigint for yocto/);
  assert.throws(() => ok(row(), { maxPrice: "500000000000000000000000" }), /pass a bigint for yocto/);
  assert.equal(yoctoOf("0.5"), 500_000_000_000_000_000_000_000n);
  assert.equal(yoctoOf("100"), HIGH_PRICE, "exactly 100 NEAR is allowed");
  assert.throws(() => yoctoOf("100.000001"), /above 100 NEAR: pass allowHighPrice/);
  assert.throws(() => yoctoOf("999999"), /above 100 NEAR/);
  assert.throws(() => yoctoOf(HIGH_PRICE + 1n), /above 100 NEAR/, "a bigint is capped too");
  assert.equal(yoctoOf("999999", { allowHighPrice: true }), 999_999n * 10n ** 24n);
  assert.throws(() => ok(row({ amount: (101n * 10n ** 24n).toString() }), { maxPrice: "101" }), /above 100 NEAR/);
  assert.ok(ok(row({ amount: (101n * 10n ** 24n).toString() }), { maxPrice: "101", allowHighPrice: true }));
  await assert.rejects(hireMind({ url: "http://127.0.0.1:1/x", contractId: C, accountId: "me.testnet", text: "hi", maxPrice: "500000000000000000000000" }), /pass a bigint for yocto/, "before any network call");
});

test("R2 L-1: a 504 is PAYMENT_UNKNOWN with the transaction; a re-sent payment is ALREADY_RELAYED", () => {
  const e = paymentError(504, { error: { code: -32005, message: "the transaction AbC did not show up in time", data: { transaction: "AbC", payer: "me.testnet" } } }, { contractId: C, accountId: "me.testnet" });
  assert.equal(e.code, "PAYMENT_UNKNOWN");
  assert.equal(e.transaction, "AbC");
  assert.match(e.message, /check jobs_of\(me\.testnet\) on hungry-minds-8250f6\.testnet before trying again/);
  const proxy = paymentError(504, { error: "The agent gateway took too long to answer." });
  assert.equal(proxy.code, "PAYMENT_UNKNOWN", "the site proxy's own 504 too");
  assert.equal(proxy.transaction, null);
  assert.equal(paymentError(409, { error: { message: "this payment was already relayed: check your order" } }).code, "ALREADY_RELAYED");
  const refused = paymentError(402, { error: "missing field: account" });
  assert.equal(refused.code, "PAYMENT_REFUSED");
  assert.match(refused.message, /missing field: account/);
});

test("R2 L-4: the payment signs the trimmed text, as the worker compares it", async () => {
  const { KeyPair } = require("near-api-js");
  const key = KeyPair.fromRandom("ed25519");
  let signedArgs = null;
  const account = {
    signedDelegate: async ({ receiverId, actions }) => {
      signedArgs = JSON.parse(Buffer.from(actions[0].functionCall.args).toString());
      const delegateAction = { senderId: "me.testnet", receiverId, actions, nonce: 7n, maxBlockHeight: 1000n, publicKey: key.getPublicKey() };
      return { delegateAction, signature: new transactions.Signature({ keyType: 0, data: new Uint8Array(64) }) };
    },
  };
  await paymentFor(account, row(), "  check alice.testnet \n");
  assert.equal(JSON.parse(signedArgs.msg).input, "check alice.testnet");
  await assert.rejects(hireMind({ url: "http://127.0.0.1:1/x", contractId: C, accountId: "me.testnet", text: "   " }), /needs text/);
});
