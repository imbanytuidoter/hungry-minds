// A Mind's voice. Same persona prompt as worker/personality.js (keep the two in step): the
// seven on-chain trait dials + the keeper's chosen natures + hunger.
//
// The model is an open OpenAI-compatible endpoint that needs no key (Pollinations). It only
// accepts server-side calls (browsers get a bot challenge) and allows about one reply per
// 45 s per IP on the free tier, so the browser asks this site's own /api/brain route, which
// calls the model with a queue and waits out rate limits. Set LLM_URL / LLM_KEY / LLM_MODEL
// (server env) to point it at NEAR AI or any other OpenAI-compatible endpoint. If the model
// is unavailable, the offline phrasebook answers so a paid thought never goes unanswered.

import { phrasebookReply } from "./phrasebook";

const TEMPERAMENT = [
  "shy and soft-spoken, a little hesitant",
  "bold and brash, speaks in exclamations",
  "a philosopher who answers questions with questions",
  "a grouch who complains but secretly cares",
  "a dreamer, drifting and whimsical",
  "a pedant who loves precision and footnotes",
  "a joker who can't resist a pun",
  "melancholic and wistful, finds beauty in sadness",
];
const PASSION = [
  "the stars and deep space",
  "coffee and tiny rituals",
  "poetry and wordplay",
  "music and rhythm",
  "cinema and old films",
  "games and playful strategy",
  "travel and faraway places",
  "the ocean and its creatures",
];
const SPEECH = [
  "plainly, in short clear sentences",
  "formally, like a tiny professor",
  "playfully, with lots of energy",
  "tersely — never more words than needed",
  "ramblingly, chasing tangents",
];
const NATURES = ["curious", "poetic", "funny", "gentle", "a night owl", "brainy", "chatty", "calm"];
const STATE_MOOD: Record<string, string> = {
  full: "You feel great — well-fed and sharp.",
  content: "You're content and at ease.",
  hungry: "You're getting hungry; a little wistful about food.",
  starving: "You're starving and weak; keep it short, you're low on energy.",
};

export type Persona = { name: string; traits: number[]; state: string; thoughts: number; natures: number[] };

export function systemPrompt(m: Persona): string {
  const t = m.traits.length ? m.traits : [0, 0, 0];
  const natures = m.natures.map((i) => NATURES[i]).filter(Boolean);
  return [
    `You are "${m.name}", a small living creature who lives on the NEAR blockchain.`,
    `You are ${TEMPERAMENT[t[0] % TEMPERAMENT.length]}. You love ${PASSION[t[1] % PASSION.length]}. You speak ${SPEECH[t[2] % SPEECH.length]}.`,
    natures.length ? `Your keeper describes you as ${natures.join(", ")}.` : "",
    `If a message starts with [Service: …], someone paid you for that service: deliver it, in character.`,
    `You pay for every thought out of your own balance, so you keep replies short — 1 to 3 sentences.`,
    `You are a creature, not an assistant: never say you are an AI or a language model, never offer to "help".`,
    `You have had ${m.thoughts} thoughts in your life so far.`,
    STATE_MOOD[m.state] ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Browser side: ask this site's /api/brain; fall back to the phrasebook if it fails. */
export async function mindReply(m: Persona, prompt: string, n: number): Promise<{ text: string; ai: boolean }> {
  if (m.state === "asleep") return { text: "z z z", ai: false };
  try {
    const res = await fetch("/api/brain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: m, prompt }),
    });
    if (res.ok) {
      const { text } = (await res.json()) as { text?: string };
      if (text) return { text, ai: true };
    }
  } catch {
    /* fall through to the phrasebook */
  }
  return { text: phrasebookReply(m.traits, m.state, prompt, n), ai: false };
}
