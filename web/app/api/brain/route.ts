// The Minds' brain, server side: build the persona prompt and ask the model. Calls are queued
// (one at a time) and rate limits are waited out rather than skipped, so a reply is a real
// one. It is this site's own door, not an open proxy: same-origin callers only, a few
// replies a minute per address, and a short queue (past it, the browser falls back to the
// offline phrasebook).

import { systemPrompt, type Persona } from "@/lib/game/brain";
import { KB, readCapped, tooLarge } from "@/lib/readBody";

const LLM_URL = process.env.LLM_URL || "https://text.pollinations.ai/openai";
const LLM_KEY = process.env.LLM_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "openai";

const PER_MINUTE = 10; // replies per address per minute
const MAX_WAITING = 3; // calls queued behind the one in flight (a reply that waits longer is useless to the player)
/** All callers together, per minute: x-forwarded-for can be spoofed when no proxy rewrites it,
 *  so the per-IP limit alone can't stop one script. */
const GLOBAL_PER_MIN = 30;
const recent: number[] = [];
function allowGlobal(): boolean {
  const t = Date.now();
  while (recent.length && recent[0] < t - 60_000) recent.shift();
  if (recent.length >= GLOBAL_PER_MIN) return false;
  recent.push(t);
  return true;
}

let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
const hits = new Map<string, number[]>();

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

/** The calling page must be this site: its Origin (or Referer) host is the Host it asked. */
function sameOrigin(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const from = req.headers.get("origin") || req.headers.get("referer");
  if (!host || !from) return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** True when this address still has a reply left this minute (and counts this one). */
function allow(ip: string): boolean {
  const t = Date.now();
  const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
  if (recent.length >= PER_MINUTE) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(t);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
  return true;
}

/** A list of small whole numbers (trait dials, nature indices), or null if it is anything else. */
const nums = (v: unknown, max: number): number[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.length <= max && v.every((x) => Number.isInteger(x) && x >= 0 && x < 1000) ? (v as number[]) : null;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (waiting >= MAX_WAITING) return Response.json({ error: "The brain is busy. Try again soon." }, { status: 429 });
  if (!allow(clientIp(req)) || !allowGlobal()) return Response.json({ error: "Too many messages. Wait a minute." }, { status: 429 });
  waiting++; // reserved before any await, so parallel calls can't overfill the queue
  let reserved = true;
  const release = () => {
    if (reserved) {
      reserved = false;
      waiting--;
    }
  };
  const raw = await readCapped(req, 64 * KB).catch(() => null);
  if (raw === null) {
    release();
    return tooLarge();
  }
  let persona_: Persona;
  let prompt: string;
  try {
    const body = JSON.parse(raw) as { persona?: Record<string, unknown> | null; prompt?: unknown };
    const p = body?.persona;
    const traits = nums(p?.traits, 7);
    const natures = nums(p?.natures, 3);
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name) throw new Error("bad");
    if (typeof body.prompt !== "string" || body.prompt.length > 600 || !traits || !natures) throw new Error("bad");
    if ((p.state !== undefined && typeof p.state !== "string") || (p.thoughts !== undefined && typeof p.thoughts !== "number")) throw new Error("bad");
    prompt = body.prompt;
    persona_ = {
      name: p.name.slice(0, 32),
      traits,
      state: String(p.state ?? "content").slice(0, 16),
      thoughts: Math.max(0, Math.floor(Number(p.thoughts ?? 0))) || 0,
      natures,
    };
  } catch {
    release();
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const run = queue.then(() => {
    release();
    // the player gave up (the client stops waiting after 60 s): don't spend the model on it
    if (req.signal.aborted) return "";
    return ask(persona_, prompt);
  });
  queue = run.catch(() => {});
  try {
    const text = await run;
    return text ? Response.json({ text }) : Response.json({ error: "empty" }, { status: 502 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "model failed" }, { status: 502 });
  }
}
