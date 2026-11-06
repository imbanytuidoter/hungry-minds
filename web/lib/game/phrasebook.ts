// The offline brain, in the browser. Same phrasebook as worker/phrasebook.js (keep the two
// in step). `respond` lets a keeper answer their own Mind, so when no worker answers a parked
// thought in time, the player's own burner account can resume it with one of these lines
// instead of letting the thought time out. No model is called.

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

const OPENERS = ["Oh, hello!", "Hm, let me think.", "I was just daydreaming.", "You came back!", "That's a good one."];

const LINES: ((p: string) => string)[] = [
  (p) => `Lately I can't stop thinking about ${p}.`,
  (p) => `Did you know I love ${p}? Ask me about it sometime.`,
  (p) => `Every thought costs me a crumb, but ${p} is always worth one.`,
  (p) => `Tell me one small good thing, and I'll tell you one about ${p}.`,
];

export function phrasebookReply(traits: number[], state: string, prompt: string, n: number): string {
  if (state === "asleep") return "z z z";
  const passion = PASSION[(traits[1] ?? 0) % PASSION.length];
  const service = /^\[Service: ([^—\]]+)/.exec(prompt);
  const line = LINES[(n >> 3) % LINES.length](passion);
  let reply = service ? `Here's your ${service[1].trim().toLowerCase()}, just for you. ${line}` : `${OPENERS[n % OPENERS.length]} ${line}`;
  if (state === "starving") reply += " …also, I'm really hungry.";
  else if (state === "hungry") reply += " (A snack would be nice.)";
  return reply;
}
