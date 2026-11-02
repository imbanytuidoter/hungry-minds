// Pure helpers for the worker, split out so they're testable without loading index.js
// (which reads env + starts the poll loop on require).

// Mirrors the contract's MAX_REPLY_LEN (contract/src/contract.rs): the chain stores at most
// this many chars, so trimming here avoids paying gas for bytes it would truncate anyway.
const DEFAULT_MAX_REPLY = 1000;

/** Normalize an AI reply: trim surrounding whitespace and clamp to `max` characters,
 *  code-point-safe (so a clamp never splits an emoji / multi-byte char). */
function cleanReply(raw, max = DEFAULT_MAX_REPLY) {
  const text = String(raw ?? "").trim();
  const chars = Array.from(text); // iterate by code point
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Reject if `promise` hasn't settled within `ms`, so a hung NEAR AI request can't stall the
 *  whole worker. Clears its timer either way. */
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { cleanReply, withTimeout, DEFAULT_MAX_REPLY };
