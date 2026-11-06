// The Minds' brain, server side: build the persona prompt and ask the model. Calls are queued
// (one at a time) and rate limits are waited out rather than skipped, because a thought
// stays parked on chain for ~200 blocks — there is time to get a real reply.

import { systemPrompt, type Persona } from "@/lib/game/brain";

const LLM_URL = process.env.LLM_URL || "https://text.pollinations.ai/openai";
const LLM_KEY = process.env.LLM_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "openai";

let queue: Promise<unknown> = Promise.resolve();

async function ask(persona: Persona, prompt: string, attempt = 0): Promise<string> {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {}) },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 160,
      messages: [
        { role: "system", content: systemPrompt(persona) },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if ((res.status === 402 || res.status === 429) && attempt < 3) {
    const wait = Number(/Retry after (\d+)s/i.exec(await res.text())?.[1] ?? 45);
    await new Promise((r) => setTimeout(r, (Math.min(wait, 90) + 1) * 1000));
    return ask(persona, prompt, attempt + 1);
  }
  if (!res.ok) throw new Error(`model ${res.status}`);
  const data = await res.json();
  // Drop citation markers some models append ("…rhythm.^1", "[1]", "【3†source】"); a bare ^N
  // only right after punctuation, so exponents survive. Same pattern as worker/reply.js.
  const text = String(data.choices?.[0]?.message?.content ?? "")
    .replace(/(?:\s*(?:\[\^?\d+\]|【[^】]*】)|(?<=[.!?,;:)"'”’])\^\d+)(?=(\s*)(\S?))/g, (_m, ws: string, next: string) => (next && !ws && !/[.,!?;:)]/.test(next) ? " " : ""))
    .trim();
  return Array.from(text).slice(0, 1000).join("");
}

export async function POST(req: Request) {
  let body: { persona?: Persona; prompt?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { persona, prompt } = body;
  if (!persona?.name || typeof prompt !== "string" || prompt.length > 600) return Response.json({ error: "bad request" }, { status: 400 });
  const persona_: Persona = {
    name: String(persona.name).slice(0, 32),
    traits: (persona.traits ?? []).slice(0, 7).map(Number),
    state: String(persona.state ?? "content"),
    thoughts: Number(persona.thoughts ?? 0),
    natures: (persona.natures ?? []).slice(0, 3).map(Number),
  };
  const run = queue.then(() => ask(persona_, prompt));
  queue = run.catch(() => {});
  try {
    const text = await run;
    return text ? Response.json({ text }) : Response.json({ error: "empty" }, { status: 502 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "model failed" }, { status: 502 });
  }
}
