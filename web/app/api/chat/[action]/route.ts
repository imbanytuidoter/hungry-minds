// Same-origin door to the worker's chat server (worker/chat-server.js), which listens on
// localhost only: sign in once, then chat with no transaction per message.

const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL || "http://127.0.0.1:8788";
const ACTIONS = new Set(["session", "chat", "allowance"]);

async function forward(req: Request, action: string) {
  if (!ACTIONS.has(action)) return Response.json({ error: "not found" }, { status: 404 });
  const url = `${CHAT_SERVER_URL}/${action}${new URL(req.url).search}`;
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? await req.text() : undefined,
      // a reply waits for the model, which may be queued behind a rate limit
      signal: AbortSignal.timeout(180_000),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "The chat server is offline. Try again in a minute." }, { status: 503 });
  }
}

type Ctx = { params: Promise<{ action: string }> };
export async function POST(req: Request, { params }: Ctx) {
  return forward(req, (await params).action);
}
export async function GET(req: Request, { params }: Ctx) {
  return forward(req, (await params).action);
}
