const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { KeyPair } = require("near-api-js");
const { nep413Payload, signInText, checkSignIn, issueToken, readToken } = require("./chat-auth");

// Signs exactly as a NEP-413 wallet does: sha256 of the borsh payload, ed25519.
function walletSign(kp, accountId, recipient, ts) {
  const message = signInText(accountId, ts);
  const nonce = crypto.randomBytes(32);
  const hash = crypto.createHash("sha256").update(nep413Payload({ message, nonce, recipient })).digest();
  const { signature } = kp.sign(new Uint8Array(hash));
  return { accountId, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(signature).toString("base64"), message, nonce: nonce.toString("base64") };
}

test("a wallet's NEP-413 sign-in is accepted", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const now = Date.now();
  assert.strictEqual(checkSignIn(walletSign(kp, "bob.testnet", "hm.testnet", now), { recipient: "hm.testnet", now }), null);
});

test("a signature for another contract, account or key is refused", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const now = Date.now();
  const s = walletSign(kp, "bob.testnet", "other.testnet", now);
  assert.strictEqual(checkSignIn(s, { recipient: "hm.testnet", now }), "signature does not match");
  const t = walletSign(kp, "bob.testnet", "hm.testnet", now);
  assert.strictEqual(checkSignIn({ ...t, accountId: "eve.testnet" }, { recipient: "hm.testnet", now }), "unexpected sign-in text");
  const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  assert.strictEqual(checkSignIn({ ...t, publicKey: other }, { recipient: "hm.testnet", now }), "signature does not match");
});

test("an old sign-in is refused", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const now = Date.now();
  const s = walletSign(kp, "bob.testnet", "hm.testnet", now - 11 * 60 * 1000);
  assert.strictEqual(checkSignIn(s, { recipient: "hm.testnet", now }), "sign-in expired, try again");
});

test("session tokens are bound to the secret and expire", () => {
  const now = Date.now();
  const { token } = issueToken("s3cret", "bob.testnet", now);
  assert.strictEqual(readToken("s3cret", token, now), "bob.testnet");
  assert.strictEqual(readToken("other", token, now), null);
  assert.strictEqual(readToken("s3cret", token, now + 25 * 60 * 60 * 1000), null);
  const [data, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "eve.testnet", exp: now + 1e9 })).toString("base64url");
  assert.strictEqual(readToken("s3cret", `${forged}.${sig}`, now), null);
  assert.ok(data);
});
