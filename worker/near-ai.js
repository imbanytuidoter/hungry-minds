// NEAR AI Cloud: the Mind's brain runs on a model inside a TEE (Qwen/Qwen3.8-27B by default),
// and every reply comes with the enclave's signature over the exact request and response.
//
// The signature (GET /v1/signature/<chat id>) signs the text
//   "<model id>:<sha256 of the request body>:<sha256 of the response body>"
// with an ECDSA key held in the TEE (EIP-191 personal-sign). We check that text against the
// bodies we actually sent and received, recover the signer, and keep the proof with the reply
// so the site can show it and anyone can re-check it at https://cloud.near.ai/verify.
// Docs: https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md

const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** True if `sig` really signs these exact bodies for `model`, from `sig.signing_address`. */
async function verifySignature({ model, requestBody, responseBody, sig }) {
  if (!sig || sig.signing_algo !== "ecdsa" || !sig.text || !sig.signature || !sig.signing_address) return false;
  const expected = sig.signature_kind === "gateway" ? `${sha256(requestBody)}:${sha256(responseBody)}` : `${model}:${sha256(requestBody)}:${sha256(responseBody)}`;
  if (sig.text !== expected) return false;
  const { recoverMessageAddress } = require("viem");
  try {
    const signer = await recoverMessageAddress({ message: sig.text, signature: sig.signature });
    return signer.toLowerCase() === sig.signing_address.toLowerCase();
  } catch {
    return false;
  }
}

/** The enclave's signature for a completion; it can take a moment to appear. */
async function fetchSignature({ base, key, chatId }) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res && res.ok) {
      const j = await res.json().catch(() => null);
      if (j && j.signature && !j.error_code) return j;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}

/** Turn a completion into a proof the site can show and anyone can re-check. */
async function proofFor({ base, key, model, requestBody, responseBody, chatId }) {
  const sig = chatId ? await fetchSignature({ base, key, chatId }) : null;
  const verified = sig ? await verifySignature({ model, requestBody, responseBody, sig }) : false;
  return {
    provider: "NEAR AI Cloud",
    model,
    chat_id: chatId || null,
    verified,
    signer: sig?.signing_address || null,
    kind: sig?.signature_kind || null,
    signed_text: sig?.text || null,
    signature: sig?.signature || null,
    verify_url: "https://cloud.near.ai/verify",
  };
}

/** Reasoning models think out loud between <think> tags; the Mind only says the answer. A
 *  <think> that never closes (the model ran out of tokens mid-thought) holds no answer at all:
 *  the reply is empty (a failure), never the half-finished reasoning. */
const stripThinking = (s) => {
  const out = String(s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "");
  return /<think>/i.test(out) ? "" : out.trim();
};

module.exports = { verifySignature, fetchSignature, proofFor, stripThinking, sha256 };
