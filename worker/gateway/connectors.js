// One interface over the kinds of agent a Mind owner can connect, so the rest of the
// gateway never cares which one it talks to:
//
//   discover(conn)        -> { name, description, skills: [{ id, name, description, examples }] }
//   run(conn, request)    -> { state, text, files, data, contextId, taskId }
//
// `state` is "completed", "input-required" (the agent asks the buyer something; `text` is
// the question) or "failed". `files` are [{ name, mime, data: Buffer }].
//
// Kinds:
//   a2a     an Agent2Agent agent (v1.0, or v0.3 through the SDK's compat layer), found
//           from its agent card; the official @a2a-js/sdk client does the talking.
//   mcp     an MCP server over Streamable HTTP (or the older SSE transport), through the
//           official @modelcontextprotocol/sdk client. Each tool is a skill; plain-language
//           requests are turned into tool arguments by the colony's model.
//   openai  any OpenAI-compatible /chat/completions endpoint (with a model name).
//   http    a plain HTTPS endpoint: POST JSON in, JSON or text out (see sdk/README.md).
//   official  one of the data agents that run inside the gateway (official.js).

const crypto = require("crypto");
const { makeFetch } = require("./safe-fetch");

const KINDS = ["official", "a2a", "mcp", "openai", "http"];
const official = require("./official");
const RUN_TIMEOUT_MS = 10 * 60_000; // a long A2A task is polled at most this long
const MAX_TEXT = 60_000;

function authHeaders(conn, secret) {
  if (!secret) return {};
  const name = conn.authHeader || "Authorization";
  const value = /^authorization$/i.test(name) && !/\s/.test(secret) ? `Bearer ${secret}` : secret;
  return { [name]: value };
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n…" : s);

// What an agent's tool list may put into one planner prompt: a tool's schema (or its argument
// line) at most 4 KB, the whole tool list at most 24 KB. Agents are outside code; a server
// listing megabytes of schema must not stall or crowd the colony model's shared queue.
const MAX_SCHEMA_PROMPT = 4096;
const MAX_TOOLS_PROMPT = 24_000;
function clipText(s, max) {
  s = String(s ?? "");
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (n + b > max - 3) break;
    out += ch;
    n += b;
  }
  return out + "…";
}
function schemaText(schema) {
  let s;
  try {
    s = JSON.stringify(schema || {});
  } catch {
    s = "{}";
  }
  return clipText(s, MAX_SCHEMA_PROMPT);
}

// NEAR Agent Market (market.near.ai) puts every listed agent behind its own paid A2A
// address, <handle>.market.near.ai: each call answers 402 until it is paid in USDC on
// mainnet (x402). The gateway does not pay x402, so every job would fail and be refunded.
// The owner should paste the agent's own address (the server Agent Market forwards to).
const MARKET_PAYWALL =
  "this is a NEAR Agent Market address: every call there is paid in USDC on mainnet (x402), so her jobs would fail. Paste your agent's own address instead (the server or Vercel URL Agent Market sends your jobs to)";
function marketPaywall(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return host === "market.near.ai" || host.endsWith(".market.near.ai");
  } catch {
    return false;
  }
}

// ── A2A ────────────────────────────────────────────────────────────────────────

function a2aFactory(fetchImpl) {
  const { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } = require("@a2a-js/sdk/client");
  const compat = { legacyCompat: { enabled: true } };
  return new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl, ...compat }), new RestTransportFactory({ fetchImpl, ...compat })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl, ...compat }),
      clientConfig: { acceptedOutputModes: ["text/plain", "text/markdown", "application/json", "image/png", "image/jpeg", "application/pdf", "*/*"] },
    })
  );
}

// The card: a URL ending in .json is the card itself; otherwise the well-known paths.
async function a2aCard(conn, fetchImpl) {
  const { DefaultAgentCardResolver } = require("@a2a-js/sdk/client");
  const resolver = new DefaultAgentCardResolver({ fetchImpl, legacyCompat: { enabled: true } });
  if (/\.json(\?|$)/i.test(conn.url)) return resolver.resolve(conn.url, "");
  const base = conn.url.replace(/\/+$/, "");
  try {
    return await resolver.resolve(base);
  } catch (e) {
    try {
      return await resolver.resolve(base, "/.well-known/agent.json"); // v0.2 / early v0.3 name
    } catch {
      throw new Error(`no A2A agent card at ${base}/.well-known/agent-card.json (${e.message})`);
    }
  }
}

function stateName(s) {
  if (typeof s === "number") {
    const { TaskState } = require("@a2a-js/sdk");
    s = TaskState[s] || "";
  }
  return String(s || "").toLowerCase().replace(/^task_state_/, "").replace(/_/g, "-");
}

function a2aParts(parts = [], out) {
  for (const p of parts) {
    const c = p.content;
    if (!c) continue;
    if (c.$case === "text") out.text.push(c.value);
    else if (c.$case === "data") out.data.push(c.value);
    else if (c.$case === "raw") out.files.push({ name: p.filename || "file", mime: p.mediaType || "application/octet-stream", data: Buffer.from(c.value) });
    else if (c.$case === "url") out.text.push(`${p.filename ? p.filename + ": " : ""}${c.value}`);
  }
}

function fromA2A(result) {
  const out = { text: [], data: [], files: [] };
  let state = "completed";
  let contextId, taskId;
  if (result && result.status !== undefined && result.id) {
    taskId = result.id;
    contextId = result.contextId;
    state = stateName(result.status?.state);
    for (const a of result.artifacts || []) a2aParts(a.parts, out);
    a2aParts(result.status?.message?.parts, out);
  } else if (result) {
    contextId = result.contextId;
    a2aParts(result.parts, out);
  }
  return { state, contextId, taskId, ...out };
}

async function a2aRun(conn, secret, req) {
  const fetchImpl = makeFetch(authHeaders(conn, secret));
  const { Role } = require("@a2a-js/sdk");
  const client = await a2aFactory(fetchImpl).createFromAgentCard(conn.card || (await a2aCard(conn, fetchImpl)));
  const part = (content, filename = "", mediaType = "") => ({ content, metadata: undefined, filename, mediaType });
  const parts = [part({ $case: "text", value: req.text }, "", "text/plain")];
  for (const f of req.files || []) parts.push(part({ $case: "raw", value: f.data }, f.name, f.mime));
  const message = {
    messageId: crypto.randomUUID(),
    role: Role.ROLE_USER,
    parts,
    contextId: req.contextId || "",
    taskId: req.taskId || "",
    metadata: req.skill ? { skill: req.skill } : undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  let r = fromA2A(await client.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined }));
  const until = Date.now() + Math.min(RUN_TIMEOUT_MS, req.timeoutMs || RUN_TIMEOUT_MS);
  while ((r.state === "submitted" || r.state === "working" || r.state === "unspecified") && r.taskId && Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 2500));
    r = fromA2A(await client.getTask({ id: r.taskId }));
  }
  return r;
}

// ── MCP ────────────────────────────────────────────────────────────────────────

async function mcpClient(conn, secret) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
  const fetchImpl = makeFetch(authHeaders(conn, secret));
  const url = new URL(conn.url);
  const client = new Client({ name: "hungry-minds-gateway", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetchImpl }));
    return client;
  } catch (e) {
    const legacy = new Client({ name: "hungry-minds-gateway", version: "1.0.0" });
    try {
      await legacy.connect(new SSEClientTransport(url, { fetch: fetchImpl, eventSourceInit: { fetch: fetchImpl } }));
      return legacy;
    } catch {
      throw new Error(`can't reach an MCP server at ${conn.url} (${e.message})`);
    }
  }
}

async function withMcp(conn, secret, fn) {
  const client = await mcpClient(conn, secret);
  try {
    return await fn(client);
  } finally {
    client.close().catch(() => {});
  }
}

async function mcpTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor && tools.length < 200);
  return tools;
}

function fromMcp(res) {
  const out = { state: res.isError ? "failed" : "completed", text: [], data: [], files: [] };
  for (const c of res.content || []) {
    if (c.type === "text") out.text.push(c.text);
    else if (c.type === "image" || c.type === "audio") out.files.push({ name: `${c.type}.${(c.mimeType || "").split("/")[1] || "bin"}`, mime: c.mimeType, data: Buffer.from(c.data, "base64") });
    else if (c.type === "resource") {
      const r = c.resource || {};
      if (r.text !== undefined) out.text.push(r.text);
      else if (r.blob) out.files.push({ name: (r.uri || "file").split("/").pop(), mime: r.mimeType || "application/octet-stream", data: Buffer.from(r.blob, "base64") });
    } else if (c.type === "resource_link") out.text.push(`${c.name || "link"}: ${c.uri}`);
  }
  if (res.structuredContent && !out.text.length) out.data.push(res.structuredContent);
  return out;
}

// The arguments for `tool` from a request: JSON as is, a lone string field filled with the
// text, or else the colony's model fills the schema.
async function mcpArgs(tool, text, plan) {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON after all */
    }
  }
  const schema = tool.inputSchema || {};
  const props = Object.entries(schema.properties || {});
  if (!props.length) return {};
  const strings = props.filter(([, p]) => p.type === "string" || !p.type);
  const required = schema.required || [];
  if (props.length === 1 && strings.length === 1) return { [strings[0][0]]: t };
  const filled = plan ? await planArgs(tool, t, plan).catch(() => null) : null;
  if (filled && fitsSchema(filled, schema)) return filled;
  const guess = guessArgs(schema, t);
  if (guess) return guess;
  throw new Error(`the tool ${tool.name} needs JSON arguments: ${JSON.stringify(schema).slice(0, 300)}`);
}

// Without the model: fill each required field from the text by its name and type. Names
// that look like a repo, URL, account or number take what matches in the text; the first
// remaining text field gets the whole request.
function guessArgs(schema, text) {
  const props = schema.properties || {};
  const required = schema.required?.length ? schema.required : Object.keys(props).slice(0, 1);
  const args = {};
  let whole = false;
  for (const k of required) {
    const p = props[k] || {};
    const name = k.toLowerCase();
    let v;
    if (/repo/.test(name)) v = text.match(/\b[\w.-]+\/[\w.-]+\b/)?.[0];
    else if (/url|link|uri/.test(name)) v = text.match(/https?:\/\/\S+/)?.[0];
    else if (/account|address|wallet/.test(name)) v = text.match(/\b[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet)\b|0x[0-9a-fA-F]{40}/i)?.[0];
    else if (p.type === "number" || p.type === "integer") v = Number(text.match(/-?\d+(\.\d+)?/)?.[0]);
    else if (p.type === "boolean") v = !/\b(no|false|off)\b/i.test(text);
    if ((v === undefined || Number.isNaN(v)) && (p.type === "string" || !p.type) && !whole) {
      v = text;
      whole = true;
    }
    if (v === undefined || Number.isNaN(v)) return null;
    args[k] = v;
  }
  return args;
}

function wordsOf(s) {
  return new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}
/** Without the model: the tool whose name and description share the most words with the message. */
function closestTool(tools, text) {
  const words = wordsOf(text);
  let best = tools[0];
  let score = -1;
  for (const t of tools) {
    const n = [...wordsOf(`${t.name.replace(/_/g, " ")} ${t.description || ""}`)].filter((w) => words.has(w)).length;
    if (n > score) [best, score] = [t, n];
  }
  return best;
}

function firstJson(s) {
  const m = String(s || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("the model gave no JSON");
  return JSON.parse(m[0]);
}

async function planArgs(tool, text, plan) {
  const out = await plan(
    `You fill in arguments for a tool call. Tool "${clipText(tool.name, 200)}": ${clipText(tool.description || "", 1000)}\nJSON schema of the arguments: ${schemaText(tool.inputSchema)}\nAnswer with only the JSON object of arguments.`,
    text
  );
  return firstJson(out);
}

/** True if `args` is an object with every required field of `schema` and no unknown ones. */
function fitsSchema(args, schema = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const props = schema.properties || {};
  const known = Object.keys(props);
  if (known.length && Object.keys(args).some((k) => !known.includes(k))) return false;
  return (schema.required || []).every((k) => args[k] !== undefined && args[k] !== null && args[k] !== "");
}

/** A tool's arguments in one line for the router: name: type (required). */
const argLine = (schema = {}) =>
  clipText(
    Object.entries(schema?.properties || {})
      .map(([k, p]) => `${k}: ${p?.type || "string"}${(Array.isArray(schema.required) ? schema.required : []).includes(k) ? " (required)" : ""}`)
      .join(", ") || "none",
    MAX_SCHEMA_PROMPT
  );

/** Picks the tool for a free-form chat message, or answers directly when no tool fits. */
async function mcpChoose(tools, text, history, plan) {
  if (tools.length === 1 || !plan) return { tool: closestTool(tools, text).name };
  const list = clipText(tools.map((t) => `- ${clipText(t.name, 200)}: ${(t.description || "").slice(0, 200)}\n  arguments: ${argLine(t.inputSchema)}`).join("\n"), MAX_TOOLS_PROMPT);
  const past = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join("\n");
  try {
    const out = await plan(
      `You route a user's message to one of these tools:\n${list}\nAnswer with only JSON: {"tool": "<name>", "arguments": {...}} using the tool's argument names, or {"reply": "<short answer>"} if the message needs no tool (for example a greeting).`,
      (past ? `Conversation so far:\n${past}\n\n` : "") + `Message: ${text}`
    );
    return firstJson(out);
  } catch {
    return { tool: closestTool(tools, text).name }; // the model is busy or down
  }
}

// ── OpenAI-compatible and plain HTTP ───────────────────────────────────────────

async function openaiRun(conn, secret, req) {
  const f = makeFetch({ "content-type": "application/json", ...authHeaders(conn, secret) });
  const messages = [...(conn.system ? [{ role: "system", content: conn.system }] : []), ...(req.history || []), { role: "user", content: req.text }];
  const res = await f(conn.url, { method: "POST", body: JSON.stringify({ model: conn.model || "gpt-4o-mini", messages }) });
  if (!res.ok) throw new Error(`the agent answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("the agent's reply had no message content");
  return { state: "completed", text: [String(text)], data: [], files: [] };
}

async function httpRun(conn, secret, req) {
  const f = makeFetch({ "content-type": "application/json", accept: "application/json, text/plain", ...authHeaders(conn, secret) });
  const body = {
    input: req.text,
    skill: req.skill || null,
    mind_id: req.mindId,
    job_id: req.jobId ?? null,
    buyer: req.buyer || null,
    context_id: req.contextId || null,
    history: req.history || [],
    files: (req.files || []).map((x) => ({ name: x.name, mime: x.mime, base64: x.data.toString("base64") })),
  };
  const res = await f(conn.url, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`the agent answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) return { state: "completed", text: [await res.text()], data: [], files: [] };
  const d = await res.json();
  const files = (d.files || []).filter((x) => x && x.base64).map((x) => ({ name: x.name || "file", mime: x.mime || "application/octet-stream", data: Buffer.from(x.base64, "base64") }));
  if (d.question) return { state: "input-required", text: [String(d.question)], data: [], files, contextId: d.context_id };
  if (d.error) return { state: "failed", text: [String(d.error)], data: [], files: [] };
  const text = d.result ?? d.output ?? d.text ?? d.reply;
  return {
    state: "completed",
    text: typeof text === "string" ? [text] : [],
    data: text !== undefined && typeof text !== "string" ? [text] : d.data !== undefined ? [d.data] : [],
    files,
    contextId: d.context_id,
  };
}

// ── the common interface ───────────────────────────────────────────────────────

async function discover(conn, secret) {
  if (!KINDS.includes(conn.kind)) throw new Error(`unknown agent kind ${conn.kind}`);
  if (conn.kind === "official") {
    const a = official.card(official.get(conn.url));
    return { name: a.name, description: a.description, version: "1", provider: "Hungry Minds", skills: a.skills };
  }
  if (conn.kind === "a2a") {
    const fetchImpl = makeFetch(authHeaders(conn, secret));
    const card = await a2aCard(conn, fetchImpl);
    await a2aFactory(fetchImpl).createFromAgentCard(card); // fails here if no usable transport
    return {
      name: card.name,
      description: card.description,
      version: card.version,
      provider: card.provider?.organization || "",
      card,
      skills: (card.skills || []).map((s) => ({ id: s.id, name: s.name, description: s.description, examples: s.examples || [] })),
    };
  }
  if (conn.kind === "mcp") {
    return withMcp(conn, secret, async (client) => {
      const info = client.getServerVersion() || {};
      const tools = await mcpTools(client);
      if (!tools.length) throw new Error("the MCP server lists no tools");
      return {
        name: info.title || info.name || new URL(conn.url).host,
        description: client.getInstructions?.()?.slice(0, 300) || "",
        version: info.version || "",
        provider: "",
        skills: tools.map((t) => ({ id: t.name, name: t.title || t.name, description: (t.description || "").slice(0, 500), examples: [], inputSchema: t.inputSchema })),
      };
    });
  }
  // openai / http have no catalogue: a test call proves they answer.
  const probe = conn.kind === "openai" ? await openaiRun(conn, secret, { text: "Reply with the single word: ready" }) : await httpRun(conn, secret, { text: "ping", skill: "ping" });
  if (probe.state === "failed") throw new Error(probe.text.join(" ") || "the agent returned an error");
  return { name: conn.name || new URL(conn.url).host, description: conn.description || "", version: "", provider: "", skills: [{ id: "default", name: conn.name || "Ask", description: conn.description || "", examples: [] }] };
}

/**
 * Run one request. `req`: { text, skill, files, contextId, taskId, history, mindId, jobId,
 * buyer, timeoutMs, chat }. `plan(system, user)` is the colony's model, used to turn plain
 * language into MCP tool calls.
 */
async function run(conn, secret, req, plan) {
  let r;
  if (conn.kind === "a2a") r = await a2aRun(conn, secret, req);
  else if (conn.kind === "openai") r = await openaiRun(conn, secret, req);
  else if (conn.kind === "http") r = await httpRun(conn, secret, req);
  else if (conn.kind === "official") {
    const agent = official.get(conn.url);
    let skill = agent.skills.find((k) => k.id === req.skill);
    if (!skill) {
      const asTools = agent.skills.map((k) => ({ name: k.id, description: `${k.name}: ${k.description}`, inputSchema: k.inputSchema }));
      const pick = await mcpChoose(asTools, req.text, req.history || [], plan);
      skill = agent.skills.find((k) => k.id === pick.tool) || agent.skills[0];
    }
    try {
      const args = await mcpArgs({ name: skill.id, description: skill.description, inputSchema: skill.inputSchema }, req.text, plan);
      const out = await skill.run(args || {});
      // The structured data goes along as a JSON file (a schema deliverable).
      const files = out.data !== undefined && out.data !== null ? [{ name: `${skill.id}.json`, mime: "application/json", data: Buffer.from(JSON.stringify(out.data, null, 2)) }] : [];
      r = { state: "completed", text: [out.text], data: [], files, tool: skill.id };
    } catch (e) {
      // A data source being down is a failure (retried, then refunded); a bad input is
      // something to ask the buyer about.
      if (/answered \d|fetch failed|timeout|aborted|ECONN|ENOTFOUND/i.test(e.message)) throw e;
      r = { state: "input-required", text: [`${skill.name}: ${e.message}.`], data: [], files: [] };
    }
  } else if (conn.kind === "mcp") {
    r = await withMcp(conn, secret, async (client) => {
      const tools = await mcpTools(client);
      let tool = tools.find((t) => t.name === req.skill);
      let args;
      if (!tool) {
        const pick = await mcpChoose(tools, req.text, req.history || [], plan);
        if (pick.reply && !pick.tool) return { state: "completed", text: [String(pick.reply)], data: [], files: [] };
        tool = tools.find((t) => t.name === pick.tool) || tools[0];
        args = pick.arguments;
      }
      // the router's guess is used only if it has every required field the tool asks for
      if (!fitsSchema(args, tool.inputSchema)) args = await mcpArgs(tool, req.text, plan);
      const res = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: Math.min(RUN_TIMEOUT_MS, req.timeoutMs || RUN_TIMEOUT_MS) });
      return { ...fromMcp(res), tool: tool.name };
    });
  } else throw new Error(`unknown agent kind ${conn.kind}`);
  const data = r.data.map((d) => (typeof d === "string" ? d : JSON.stringify(d, null, 2)));
  return { ...r, text: clip([...r.text, ...data].join("\n\n").trim()), files: r.files };
}

module.exports = { KINDS, discover, run, authHeaders, guessArgs, firstJson, fitsSchema, marketPaywall, MARKET_PAYWALL, schemaText, argLine, clipText, MAX_SCHEMA_PROMPT };
