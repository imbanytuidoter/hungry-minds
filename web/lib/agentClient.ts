// The site's side of the agent gateway (worker/gateway): a Mind owner connects an agent
// that already runs somewhere (A2A, MCP, OpenAI-compatible or plain HTTPS) by URL, and from
// then on her jobs and chats go to it. Calls that need to know who you are reuse the chat
// session (one NEP-413 signature a day, see chatClient.ts).

import { chatSession } from "@/lib/chatClient";
import type { SignText } from "@/components/WalletProvider";

export type AgentKind = "official" | "a2a" | "mcp" | "openai" | "http";

export const AGENT_KINDS: { id: AgentKind; name: string; hint: string; placeholder: string }[] = [
  { id: "official", name: "Official agents", hint: "Real data agents that run on the gateway: nothing to host, connect with one click.", placeholder: "" },
  { id: "a2a", name: "A2A agent", hint: "An Agent2Agent agent. Paste its base URL: its card at /.well-known/agent-card.json lists its skills.", placeholder: "https://agent.example.com" },
  { id: "mcp", name: "MCP server", hint: "A remote MCP server (Streamable HTTP or SSE). Each of its tools becomes a skill.", placeholder: "https://mcp.example.com/mcp" },
  { id: "openai", name: "OpenAI-compatible", hint: "Any /chat/completions endpoint, with the model it expects.", placeholder: "https://api.example.com/v1/chat/completions" },
  { id: "http", name: "HTTPS endpoint", hint: "Your own endpoint: we POST {input, skill, history, files} and read {result} or {question} back.", placeholder: "https://bot.example.com/run" },
];

/**
 * True for a NEAR Agent Market address (<handle>.market.near.ai). Agent Market charges every
 * call there in USDC on mainnet (x402), which the gateway does not pay, so the owner has to
 * paste the agent's own server address instead. The gateway refuses these too.
 */
export function isAgentMarketUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return host === "market.near.ai" || host.endsWith(".market.near.ai");
  } catch {
    return false;
  }
}

/** A JSON Schema object for a service's input form (the subset the site draws). */
export type InputSchema = {
  type: "object";
  required?: string[];
  properties: Record<string, { type?: string; description?: string; enum?: string[]; default?: unknown; format?: string }>;
};
export type GatewaySkill = { id: string; name: string; description: string; examples: string[]; category: string | null; inputSchema: InputSchema | null };
export type GatewayAgent = {
  mind_id: number;
  kind: AgentKind;
  url: string;
  name: string;
  description: string;
  provider: string;
  version: string;
  skills: GatewaySkill[];
  online: boolean;
  last_seen: number;
  last_error: string | null;
  since: number;
  gateway: string;
};
export type AgentFile = { id: string; name: string; mime: string; size: number; sha256?: string };
export type JobDetail = {
  job_id: number;
  waiting: boolean;
  question: string | null;
  answered: boolean;
  result: { text: string; files: AgentFile[]; sha256: string } | null;
};

export type ConnectForm = { kind: AgentKind; url: string; apiKey?: string; authHeader?: string; model?: string; name?: string; description?: string; system?: string };

async function call<T>(account: string, sign: SignText, path: string, body: Record<string, unknown> | null): Promise<T> {
  const go = async (token: string) => {
    const res = body
      ? await fetch(`/api/agent/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token }) })
      : await fetch(`/api/agent/${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
    return { status: res.status, data: (await res.json().catch(() => ({ error: "bad reply from the gateway" }))) as T & { error?: string } };
  };
  let r = await go(await chatSession(account, sign));
  if (r.status === 401) r = await go(await chatSession(account, sign, true));
  if (r.status !== 200) throw new Error(r.data.error || `the gateway answered ${r.status}`);
  return r.data;
}

export type OfficialAgent = { id: string; name: string; description: string; skills: GatewaySkill[] };
/** The agents that run on the gateway itself, ready to connect. */
export async function officialAgents(): Promise<OfficialAgent[]> {
  try {
    const res = await fetch("/api/agent/official");
    return res.ok ? ((await res.json()) as { agents: OfficialAgent[] }).agents : [];
  } catch {
    return [];
  }
}

export type Suggestion = { service_id: number; mind_id: number; title: string; mind: string; price: string; input: string; why: string };
/** Navigator: a request in plain words → up to 3 services that can do it, with the input filled in. */
export async function navigate(text: string): Promise<Suggestion[]> {
  const res = await fetch("/api/agent/navigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const d = (await res.json().catch(() => ({}))) as { suggestions?: Suggestion[]; error?: string };
  if (!res.ok) throw new Error(d.error || "The Navigator is offline.");
  return d.suggestions || [];
}

/** Every connected agent (public: no keys), or just these Minds'. */
export async function agentStatus(ids?: number[]): Promise<{ gateway: string; agents: GatewayAgent[] } | null> {
  try {
    const res = await fetch(`/api/agent/status${ids?.length ? `?ids=${ids.join(",")}` : ""}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const connectAgent = (account: string, sign: SignText, mindId: number, form: ConnectForm) =>
  call<{ gateway: string; about: string; agent: GatewayAgent }>(account, sign, "connect", { mindId, ...form });
export const disconnectAgent = (account: string, sign: SignText, mindId: number) => call<{ ok: true }>(account, sign, "disconnect", { mindId });
export const testAgent = (account: string, sign: SignText, mindId: number, text: string, skill?: string) =>
  call<{ state: string; text: string; files: AgentFile[] }>(account, sign, "test", { mindId, text, skill });
export const mapSkill = (account: string, sign: SignText, mindId: number, serviceId: number, skillId: string) => call<{ ok: true }>(account, sign, "map", { mindId, serviceId, skillId });
export const jobDetail = (account: string, sign: SignText, jobId: number) => call<JobDetail>(account, sign, `job/${jobId}`, null);
export const answerJob = (account: string, sign: SignText, jobId: number, text: string, files: string[] = []) => call<{ ok: true }>(account, sign, "answer", { jobId, text, files });

/** Upload a file (up to 6 MB) to attach to an order or an answer; returns its id. */
export async function uploadFile(account: string, sign: SignText, file: File): Promise<AgentFile> {
  if (file.size > 6 * 1024 * 1024) throw new Error("Files up to 6 MB.");
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const r = await call<{ id: string; name: string; size: number; sha256: string }>(account, sign, "upload", { name: file.name, mime: file.type || "application/octet-stream", base64: btoa(bin) });
  return { id: r.id, name: r.name, size: r.size, mime: file.type, sha256: r.sha256 };
}

/** Download one of your files (a result, or something you uploaded). */
export async function openFile(account: string, sign: SignText, id: string, name: string) {
  const token = await chatSession(account, sign);
  const res = await fetch(`/api/agent/file/${id}?token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "can't open the file");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The file links the gateway writes into replies and results: "[file] name (N KB): /api/agent/file/<id>". */
export const FILE_LINK = /\[file\] (.+?) \((\d+) KB\): \/api\/agent\/file\/([0-9a-f]{24})/g;
/** The pointer a long result leaves on chain: "[full result…: /api/agent/job/<id> · sha256 <hex>]". */
export const FULL_RESULT = /\[full result[^\]]*: \/api\/agent\/job\/(\d+) · sha256 ([0-9a-f]{64})\]/;
