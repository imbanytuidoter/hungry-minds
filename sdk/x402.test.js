// hireMind signs a payment described by the server it calls: checkRow refuses any row that is
// not exactly the payment the caller agreed to (A5 F1).
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRow, ensureWnear, hireMind } = require("./x402");

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
