// The x402 door checks every payment before the worker relays it (and pays its gas): it must
// be exactly one order_job on our contract, for the accepted service, with the message as
// input and the advertised amount attached.
const test = require("node:test");
const assert = require("node:assert");
const { utils, transactions, KeyPair } = require("near-api-js");
const { checkPayment, orderedJobId, failureOf, JOB_DEPOSIT } = require("./x402");

const CONTRACT = "hm.testnet";
const PRICE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const AMOUNT = (PRICE + JOB_DEPOSIT).toString();
const row = { scheme: "exact", network: "near:testnet", asset: "near", amount: AMOUNT, payTo: CONTRACT, maxTimeoutSeconds: 600, extra: { method: "order_job", service_id: 7 } };
const rows = [row];

function header({ receiverId = CONTRACT, method = "order_job", args = { service_id: 7, input: "hi" }, deposit = AMOUNT, gas = 100_000_000_000_000n, actions, accepted = row } = {}) {
  const delegateAction = {
    senderId: "buyer.testnet",
    receiverId,
    actions: actions || [transactions.functionCall(method, args, gas, BigInt(deposit))],
    nonce: 5n,
    maxBlockHeight: 1000n,
    publicKey: KeyPair.fromRandom("ed25519").getPublicKey(),
  };
  const signed = { delegateAction, signature: new transactions.Signature({ keyType: 0, data: new Uint8Array(64) }) };
  const encoded = Buffer.from(transactions.encodeSignedDelegate(signed)).toString("base64");
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signedDelegateAction: encoded } })).toString("base64");
}
const check = (h, text = "hi") => checkPayment(h, { contractId: CONTRACT, network: "testnet", text, rows });

test("a correct order_job delegate passes and names the buyer", () => {
  const p = check(header());
  assert.equal(p.sender, "buyer.testnet");
  assert.equal(p.serviceId, 7);
  assert.equal(p.input, "hi");
});

test("anything else is refused before the relay", () => {
  assert.throws(() => check(header({ receiverId: "other.testnet" })), /must call hm.testnet/);
  assert.throws(() => check(header({ method: "feed" })), /must call order_job/);
  assert.throws(() => check(header({ args: { service_id: 8, input: "hi" } })), /different service/);
  assert.throws(() => check(header(), "something else"), /input must be the message text/);
  assert.throws(() => check(header({ deposit: (PRICE).toString() })), /attach exactly/);
  assert.throws(() => check(header({ gas: 400_000_000_000_000n })), /too much gas/);
  assert.throws(() => check(header({ actions: [transactions.functionCall("order_job", { service_id: 7, input: "hi" }, 1n, BigInt(AMOUNT)), transactions.transfer(1n)] })), /exactly one function call/);
  assert.throws(() => check(header({ accepted: { ...row, amount: "1" } })), /does not match this offer/);
  assert.throws(() => check(header({ accepted: { ...row, extra: { service_id: 99 } } })), /not one of this Mind's live services/);
  assert.throws(() => check("not base64 json"), /base64 JSON/);
});

test("the job id is read from the buyer's job_ordered log, and failures are reported", () => {
  const outcome = { receipts_outcome: [{ outcome: { logs: ["job_ordered id=42 service=7 mind=3 buyer=buyer.testnet price=1"] } }] };
  assert.equal(orderedJobId(outcome, "buyer.testnet"), 42);
  assert.equal(orderedJobId(outcome, "someone.testnet"), null);
  const failed = { transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: this service is paused" } } } } } } }] };
  assert.match(failureOf(failed), /this service is paused/);
  assert.equal(utils.format.formatNearAmount(AMOUNT), "0.04");
});
