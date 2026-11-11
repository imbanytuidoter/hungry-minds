// Pure helpers for the worker, split out so they're testable without loading index.js
// (which reads env + starts the poll loop on require).

// Mirrors the contract's MAX_REPLY_LEN (contract/src/contract.rs): the chain stores at most
// this many chars, so trimming here avoids paying gas for bytes it would truncate anyway.
const DEFAULT_MAX_REPLY = 1000;

// Citation / footnote markers some models append ("…rhythm.^1", "[1]", "[^2]", "【3†source】").
// A Mind's reply has no sources, so they are noise. A bare ^N counts only right after
// punctuation, so an exponent ("2^10", "x^2") survives. Keep in step with web/app/api/brain.
const FOOTNOTES = /(?:\s*(?:\[\^?\d+\]|【[^】]*】)|(?<=[.!?,;:)"'”’])\^\d+)(?=(\s*)(\S?))/g;
// A marker glued between two words ("Hi【3】there") leaves one space; otherwise nothing.
const dropFootnote = (_m, ws, next) => (next && !ws && !/[.,!?;:)]/.test(next) ? " " : "");

/** Normalize an AI reply: drop footnote markers, trim surrounding whitespace and clamp to
 *  `max` characters, code-point-safe (so a clamp never splits an emoji / multi-byte char). */
function cleanReply(raw, max = DEFAULT_MAX_REPLY) {
  const text = String(raw ?? "").replace(FOOTNOTES, dropFootnote).trim();
  const chars = Array.from(text); // iterate by code point
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

// The contract's MAX_JOB_RESULT (agents.rs): deliver_job refuses a result over 2000 BYTES,
// while cleanReply counts characters (1000 Cyrillic or emoji characters are 2000-4000 bytes).
const MAX_JOB_RESULT_BYTES = 2000;

/** Clip `s` to at most `max` UTF-8 bytes, never in the middle of a character. */
function clipUtf8(s, max = MAX_JOB_RESULT_BYTES) {
  const text = String(s ?? "");
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** May the offline phrasebook answer an on-chain thought? Only when no model is configured at
 *  all, or for the owner's own thought. A guest's thought is paid escrow: answering it with a
 *  canned line would release the escrow for nothing, so it is left to time out (full refund). */
function phrasebookAllowed({ hasModel, byOwner }) {
  return !hasModel || !!byOwner;
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

module.exports = { cleanReply, clipUtf8, phrasebookAllowed, withTimeout, DEFAULT_MAX_REPLY, MAX_JOB_RESULT_BYTES };
