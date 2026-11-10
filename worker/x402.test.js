// The x402 door checks every payment before the worker relays it (and pays its gas): it must
// be exactly one wNEAR ft_transfer_call to our contract, for the accepted service, with the
// message as input, the advertised amount and 1 yoctoNEAR attached, validly signed.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { utils, transactions, KeyPair } = require("near-api-js");
const { checkPayment, signatureOk, orderedJobId, failureOf, JOB_DEPOSIT } = require("./x402");

const CONTRACT = "hm.testnet";
const WRAP = "wrap.testnet";
const PRICE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const AMOUNT = (PRICE + JOB_DEPOSIT).toString();
const row = { scheme: "exact", network: "near:testnet", asset: WRAP, amount: AMOUNT, payTo: CONTRACT, maxTimeoutSeconds: 600, extra: { method: "ft_transfer_call", service_id: 7 } };
const rows = [row];
const key = KeyPair.fromRandom("ed25519");

function signedDelegate({ receiverId = WRAP, method = "ft_transfer_call", args, deposit = 1n, gas = 200_000_000_000_000n, actions, sign = true } = {}) {
  const a = args || { receiver_id: CONTRACT, amount: AMOUNT, msg: JSON.stringify({ service_id: 7, input: "hi" }) };
  const delegateAction = {
    senderId: "buyer.testnet",
    receiverId,
    actions: actions || [transactions.functionCall(method, a, gas, deposit)],
    nonce: 5n,
    maxBlockHeight: 1000n,
    publicKey: key.getPublicKey(),
  };
  const hash = crypto.createHash("sha256").update(transactions.encodeDelegateAction(delegateAction)).digest();
  const sig = sign ? key.sign(new Uint8Array(hash)).signature : new Uint8Array(64);
  return { delegateAction, signature: new transactions.Signature({ keyType: 0, data: sig }) };
}
function header(o = {}) {
  const encoded = Buffer.from(transactions.encodeSignedDelegate(signedDelegate(o))).toString("base64");
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: o.accepted || row, payload: { signedDelegateAction: encoded } })).toString("base64");
}
const check = (h, text = "hi") => checkPayment(h, { contractId: CONTRACT, network: "testnet", text, rows });
const args = (o) => ({ receiver_id: CONTRACT, amount: AMOUNT, msg: JSON.stringify({ service_id: 7, input: "hi" }), ...o });

test("a correct wNEAR ft_transfer_call delegate passes, names the buyer, and its signature checks", () => {
  const p = check(header());
  assert.equal(p.sender, "buyer.testnet");
  assert.equal(p.serviceId, 7);
  assert.equal(p.input, "hi");
  assert.equal(p.amount, AMOUNT);
  assert.equal(signatureOk(p.signed), true);
  assert.equal(signatureOk(check(header({ sign: false })).signed), false, "a zero signature is caught before the relay");
});

test("anything else is refused before the relay", () => {
  assert.throws(() => check(header({ receiverId: CONTRACT })), /must call wrap.testnet/);
  assert.throws(() => check(header({ method: "ft_transfer" })), /must call ft_transfer_call/);
  assert.throws(() => check(header({ deposit: BigInt(AMOUNT) })), /exactly 1 yoctoNEAR/, "an attached deposit would be paid by the relayer");
  assert.throws(() => check(header({ gas: 1n })), /between 150 and 300 Tgas/);
  assert.throws(() => check(header({ args: args({ receiver_id: "other.testnet" }) })), /must send to hm.testnet/);
  assert.throws(() => check(header({ args: args({ amount: PRICE.toString() }) })), /send exactly/);
  assert.throws(() => check(header({ args: args({ msg: JSON.stringify({ service_id: 8, input: "hi" }) }) })), /different service/);
  assert.throws(() => check(header(), "something else"), /input must be the message text/);
  assert.throws(() => check(header({ args: args({ msg: "nope" }) })), /must be JSON/);
  assert.throws(() => check(header({ actions: [transactions.functionCall("ft_transfer_call", args(), 200_000_000_000_000n, 1n), transactions.transfer(1n)] })), /exactly one function call/);
  assert.throws(() => check(header({ accepted: { ...row, amount: "1" } })), /does not match this offer/);
  assert.throws(() => check(header({ accepted: { ...row, asset: "usdc.testnet" } })), /does not match this offer/);
  assert.throws(() => check(header({ accepted: { ...row, extra: { service_id: 99 } } })), /not one of this Mind's services/);
  assert.throws(() => check("not base64 json"), /base64 JSON/);
});

test("the job id is read from the buyer's job_ordered log; a refusal gives the contract's reason", () => {
  const outcome = { receipts_outcome: [{ outcome: { logs: ["job_ordered id=42 service=7 mind=3 buyer=buyer.testnet price=1"] } }] };
  assert.equal(orderedJobId(outcome, "buyer.testnet"), 42);
  assert.equal(orderedJobId(outcome, "someone.testnet"), null);
  const refused = { transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [{ outcome: { logs: ["job_order_refused buyer=buyer.testnet reason=she is asleep: feed her to wake her (anyone can)"], status: {} } }] };
  assert.match(failureOf(refused, "buyer.testnet"), /she is asleep/);
  const failed = { transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [{ outcome: { logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } } } }] };
  assert.match(failureOf(failed), /enough balance/);
  assert.equal(utils.format.formatNearAmount(AMOUNT), "0.04");
});
