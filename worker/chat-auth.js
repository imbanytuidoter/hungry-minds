// Sign-in for off-chain chat: the player's wallet signs one NEP-413 message, we check it
// here, and hand back a session token so the following messages need no wallet at all.
// Pure helpers, split out so they're testable without starting the worker.

const crypto = require("crypto");
const { utils } = require("near-api-js");

const NEP413_TAG = 2147484061; // 2^31 + 413, fixed by NEP-413
const SESSION_MS = 24 * 60 * 60 * 1000;
// The signed text must be fresh, so an old signature can't be replayed to open a session.
const SIGNED_MAX_AGE_MS = 10 * 60 * 1000;

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};

/** The bytes a NEP-413 wallet hashes and signs (borsh: tag, message, nonce, recipient, callbackUrl). */
function nep413Payload({ message, nonce, recipient, callbackUrl }) {
  const n = Buffer.from(nonce);
  if (n.length !== 32) throw new Error("nonce must be 32 bytes");
  return Buffer.concat([
    u32(NEP413_TAG),
    str(message),
    n,
    str(recipient),
    callbackUrl ? Buffer.concat([Buffer.from([1]), str(callbackUrl)]) : Buffer.from([0]),
  ]);
}

/** The exact text the site asks the wallet to sign. */
const signInText = (accountId, ts) => `Sign in to Hungry Minds chat as ${accountId}\n${ts}`;

/** True if `signature` (base64) is `publicKey`'s NEP-413 signature over these fields. */
function verifyNep413({ publicKey, signature, message, nonce, recipient, callbackUrl }) {
  const hash = crypto.createHash("sha256").update(nep413Payload({ message, nonce, recipient, callbackUrl })).digest();
  return utils.PublicKey.fromString(publicKey).verify(new Uint8Array(hash), new Uint8Array(Buffer.from(signature, "base64")));
}

/** Checks a sign-in apart from the on-chain key lookup; returns an error string or null. */
function checkSignIn(body, { recipient, now = Date.now() }) {
  const { accountId, publicKey, signature, message, nonce } = body || {};
  if (![accountId, publicKey, signature, message, nonce].every((v) => typeof v === "string")) return "bad sign-in";
  const ts = Number(message.split("\n")[1]);
  if (message !== signInText(accountId, ts)) return "unexpected sign-in text";
  if (!(Math.abs(now - ts) < SIGNED_MAX_AGE_MS)) return "sign-in expired, try again";
  let ok = false;
  try {
    ok = verifyNep413({ publicKey, signature, message, nonce: Buffer.from(nonce, "base64"), recipient });
  } catch {
    ok = false;
  }
  return ok ? null : "signature does not match";
}

const mac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

function issueToken(secret, accountId, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({ a: accountId, exp: now + SESSION_MS })).toString("base64url");
  return { token: `${data}.${mac(secret, data)}`, expires: now + SESSION_MS };
}

/** The account a token was issued to, or null if it is forged or expired. */
function readToken(secret, token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const want = mac(secret, data);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const { a, exp } = JSON.parse(Buffer.from(data, "base64url").toString());
    return typeof a === "string" && exp > now ? a : null;
  } catch {
    return null;
  }
}

module.exports = { nep413Payload, verifyNep413, signInText, checkSignIn, issueToken, readToken, SESSION_MS };
