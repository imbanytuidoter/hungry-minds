// Same-origin door to the worker's agent gateway (worker/gateway), which listens on
// localhost only: connect an agent by URL, test it, follow a job, answer the agent's
// questions, upload and download files; and the public x402 door to a Mind's services
// (/api/agent/x402/<mind id>, see worker/x402.js).

import { KB, readCapped, tooLarge } from "@/lib/readBody";

const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL || "http://127.0.0.1:8788";

async function forward(req: Request, path: string[]) {
  if (!path.length || path.some((p) => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) return Response.json({ error: "not found" }, { status: 404 });
  const url = `${CHAT_SERVER_URL}/agent/${path.join("/")}${new URL(req.url).search}`;
  const fwd: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["x-payment", "payment-signature"]) {
    const v = req.headers.get(h);
    if (v) fwd[h] = v;
  }
  // a file upload carries up to 6 MB as base64 (~8 MB); everything else is small JSON
  const body = req.method === "POST" ? await readCapped(req, path[0] === "upload" ? 9 * KB * KB : 64 * KB) : undefined;
  if (body === null) return tooLarge();
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: fwd,
      body,
      // connecting or testing waits for the agent itself
      signal: AbortSignal.timeout(200_000),
    });
    const headers = new Headers();
    for (const h of ["content-type", "content-disposition", "x-content-type-options", "content-security-policy", "x-file-sha256", "payment-response", "x-payment-response", "payment-required"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    // Our own deadline ran out: the worker may still be working (a paid x402 call may already
    // have placed the order), so this is not "offline" and not something to simply resend.
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      const paid = path[0] === "x402" && req.method === "POST" && (fwd["x-payment"] || fwd["payment-signature"]);
      return Response.json(
        {
          error: paid
            ? "The agent gateway took too long to answer. Your payment may still have gone through: check your order (jobs_of) before paying again."
            : "The agent gateway took too long to answer. Try again in a minute.",
        },
        { status: 504 }
      );
    }
    return Response.json({ error: "The agent gateway is offline. Try again in a minute." }, { status: 503 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function POST(req: Request, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function GET(req: Request, { params }: Ctx) {
  return forward(req, (await params).path);
}
