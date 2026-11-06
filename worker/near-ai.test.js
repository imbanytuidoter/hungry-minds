const test = require("node:test");
const assert = require("node:assert");
const { verifySignature, sha256, stripThinking } = require("./near-ai");

// A stand-in for the TEE's key: what NEAR AI signs, signed the same way (EIP-191 personal-sign).
async function signed(model, requestBody, responseBody, { kind = "provider_tee" } = {}) {
  const { privateKeyToAccount, generatePrivateKey } = require("viem/accounts");
  const acct = privateKeyToAccount(generatePrivateKey());
  const text = kind === "gateway" ? `${sha256(requestBody)}:${sha256(responseBody)}` : `${model}:${sha256(requestBody)}:${sha256(responseBody)}`;
  return { text, signature: await acct.signMessage({ message: text }), signing_address: acct.address, signing_algo: "ecdsa", signature_kind: kind };
}

const M = "Qwen/Qwen3.8-27B";
const REQ = JSON.stringify({ model: M, messages: [{ role: "user", content: "hi" }] });
const RES = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "hello!" } }] });

test("a signature over these exact bodies verifies", async () => {
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES, sig: await signed(M, REQ, RES) }), true);
});

test("a gateway signature (no model in the text) verifies too", async () => {
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES, sig: await signed(M, REQ, RES, { kind: "gateway" }) }), true);
});

test("a changed reply fails", async () => {
  const sig = await signed(M, REQ, RES);
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES.replace("hello", "HELLO"), sig }), false);
});

test("another model's signature fails", async () => {
  const sig = await signed("other/model", REQ, RES);
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES, sig }), false);
});

test("a signer that is not the claimed address fails", async () => {
  const sig = await signed(M, REQ, RES);
  sig.signing_address = "0x000000000000000000000000000000000000dEaD";
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES, sig }), false);
});

test("no signature is not verified", async () => {
  assert.equal(await verifySignature({ model: M, requestBody: REQ, responseBody: RES, sig: null }), false);
});

test("thinking is stripped from the reply", () => {
  assert.equal(stripThinking("<think>let me see…</think>\nHello there"), "Hello there");
  assert.equal(stripThinking("plain"), "plain");
});
