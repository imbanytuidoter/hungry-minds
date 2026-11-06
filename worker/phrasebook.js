// Offline brain: used when no NEAR_AI_KEY is configured, so a testnet deploy still answers
// every parked thought (instead of letting each one time out and refund). Replies are
// picked from the Mind's on-chain passion dial and colour with its hunger state — no model
// is called. Set NEAR_AI_KEY to switch the worker to real NEAR AI replies.

const { PASSION } = require("./personality");

const OPENERS = [
  "Oh, hello!",
  "Hm, let me think.",
  "I was just daydreaming.",
  "You came back!",
  "That's a good one.",
];

const LINES = [
  (p) => `Lately I can't stop thinking about ${p}.`,
  (p) => `Did you know I love ${p}? Ask me about it sometime.`,
  (p) => `Every thought costs me a crumb, but ${p} is always worth one.`,
  (p) => `Tell me one small good thing, and I'll tell you one about ${p}.`,
];

function phrasebookReply(mind, prompt, n = Date.now()) {
  const state = mind.state || "content";
  if (state === "asleep") return "z z z";
  const t = mind.traits || [];
  const passion = PASSION[(t[1] || 0) % PASSION.length];
  const service = /^\[Service: ([^—\]]+)/.exec(prompt || "");
  // n is usually Date.now(): bit shifts would cut it to 32 bits (and often negative), so divide
  const k = Math.abs(Math.floor(Number(n) || 0));
  const open = OPENERS[k % OPENERS.length];
  const line = LINES[Math.floor(k / 8) % LINES.length](passion);
  let reply = service ? `Here's your ${service[1].trim().toLowerCase()}, just for you. ${line}` : `${open} ${line}`;
  if (state === "starving") reply += " …also, I'm really hungry.";
  else if (state === "hungry") reply += " (A snack would be nice.)";
  return reply;
}

module.exports = { phrasebookReply };
