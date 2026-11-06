// Same-origin door to the worker's agent gateway (worker/gateway), which listens on
// localhost only: connect an agent by URL, test it, follow a job, answer the agent's
// questions, upload and download files.

const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL || "http://127.0.0.1:8788";

async function forward(req: Request, path: string[]) {
  if (!path.length || path.some((p) => !/^[\w.-]+$/.test(p))) return Response.json({ error: "not found" }, { status: 404 });
  const url = `${CHAT_SERVER_URL}/agent/${path.join("/")}${new URL(req.url).search}`;
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? await req.text() : undefined,
      // connecting or testing waits for the agent itself
      signal: AbortSignal.timeout(200_000),
    });
    const headers = new Headers();
    for (const h of ["content-type", "content-disposition", "x-content-type-options", "content-security-policy", "x-file-sha256"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers });
  } catch {
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
