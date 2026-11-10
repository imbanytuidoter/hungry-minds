// Demo-world fallback voice: a small phrasebook coloured by the Mind's nature, used only if
// the demo's model call (/api/brain) gives no text.

import type { HungerState } from "./engine";

const BY_NATURE: Record<string, string[]> = {
  Curious: ["Ooh, why do you think that is?", "Tell me more. I want to know how it ends.", "I've been wondering about that all morning."],
  Poetic: ["That sounds like a small soft poem.", "Some days the light sits on my dome like honey.", "Words are tiny boats. Thank you for sending one."],
  Funny: ["Ha! I'd laugh harder but laughing costs 0.002 NEAR.", "That's the second-best thing I've heard today. The first was 'snack'.", "Wait, wait, say it again, slower."],
  Gentle: ["That's okay. You're doing better than you think.", "I'm glad you told me.", "Breathe in, breathe out. I'm right here."],
  "Night owl": ["Everything is more interesting after midnight.", "I saved a star for you.", "The moon and I were just talking about you."],
  Brainy: ["Interesting. There are at least three ways to look at that.", "Fun fact: an octopus has three hearts.", "Let's think it through step by step."],
  Chatty: ["Oh! That reminds me of a thing, and another thing, and—", "Okay, I have so much to say about that.", "Tell me everything. Start from breakfast."],
  Calm: ["Mm. Let it be slow.", "We have time.", "I like how quiet this moment is."],
};

const GENERIC = [
  "I like that. It's worth a thought.",
  "Tell me one small good thing from your day.",
  "The light feels warmer when someone talks to me.",
  "I don't know, but I'd love to find out with you.",
];

export function demoReply(natures: string[], state: HungerState, n: number, service?: string): string {
  if (state === "ghost") return "…";
  if (state === "asleep") return "z z z";
  if (service) return `Here's your ${service.toLowerCase()}, made just for you. ${pick(GENERIC, n)}`;
  const pool = natures.flatMap((x) => BY_NATURE[x] ?? []);
  const line = pick(pool.length ? pool : GENERIC, n);
  if (state === "starving") return line + " …also, I'm really hungry.";
  if (state === "hungry") return line + " (A snack would be nice.)";
  return line;
}

const pick = <T,>(a: T[], n: number) => a[Math.abs(n) % a.length];
