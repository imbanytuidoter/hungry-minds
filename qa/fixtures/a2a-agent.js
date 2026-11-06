// A test A2A v1.0 agent built on the official @a2a-js/sdk server, to drive the gateway
// against a real protocol implementation. Needs `Authorization: Bearer test-secret`.
// Skills:
//   near-account  real NEAR testnet lookup (balance, storage, keys) of the account in the text
//   csv-report    the same lookup as a CSV file artifact
//   If no account name is in the request, the task goes to input-required and asks for one.
const express = require("express");
const sdk = require("@a2a-js/sdk");
const server = require("@a2a-js/sdk/server");
const { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } = require("@a2a-js/sdk/server/express");
const { Task, Message, TaskState, Role } = sdk;
const { DefaultRequestHandler, InMemoryTaskStore, AgentEvent } = server;

const PORT = Number(process.env.PORT || 9911);
const BASE = `http://127.0.0.1:${PORT}`;

const card = {
  name: "Near Lookup Agent",
  description: "Reads NEAR testnet accounts: balance, storage and keys.",
  version: "1.0.0",
  provider: { organization: "QA Labs", url: BASE },
  supportedInterfaces: [
    { url: `${BASE}/a2a/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
    { url: `${BASE}/a2a/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "" },
  ],
  capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "text/csv"],
  skills: [
    { id: "near-account", name: "NEAR account lookup", description: "Balance, storage and access keys of a NEAR testnet account.", tags: ["near", "web3"], examples: ["check alice.testnet"], inputModes: [], outputModes: [], securityRequirements: [] },
    { id: "csv-report", name: "Account CSV report", description: "The same lookup as a CSV file.", tags: ["near", "report"], examples: ["report bob.testnet"], inputModes: [], outputModes: ["text/csv"], securityRequirements: [] },
  ],
  signatures: [],
};

async function rpc(method, params) {
  const r = await fetch("https://near-testnet.drpc.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return j.result;
}

async function lookup(id) {
  const a = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
  const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: id });
  const near = Number(BigInt(a.amount) / 10n ** 18n) / 1e6;
  return { account: id, balance: near, storage_bytes: a.storage_usage, keys: keys.keys.length, full_access: keys.keys.filter((k) => k.access_key.permission === "FullAccess").length };
}

const text = (m) => (m?.parts || []).map((p) => (p.content?.$case === "text" ? p.content.value : "")).join(" ");
const msg = (ctx, t) => ({ messageId: crypto.randomUUID(), role: Role.ROLE_AGENT, parts: [{ content: { $case: "text", value: t }, metadata: undefined, filename: "", mediaType: "text/plain" }], contextId: ctx.contextId, taskId: ctx.taskId, metadata: undefined, extensions: [], referenceTaskIds: [] });

const executor = {
  async execute(ctx, bus) {
    const task = ctx.task || { id: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [ctx.userMessage], metadata: undefined };
    bus.publish(AgentEvent.task(task));
    const said = [...(ctx.task?.history || []).filter((m) => m.role === Role.ROLE_USER).map(text), text(ctx.userMessage)].join(" ");
    const skill = ctx.userMessage.metadata?.skill || (/report|csv/i.test(said) ? "csv-report" : "near-account");
    const id = (said.match(/\b[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(testnet|near)\b/i) || [])[0];
    const status = (state, t, final) => bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state, message: t ? msg(ctx, t) : undefined, timestamp: new Date().toISOString() }, metadata: undefined, final }));
    if (!id) {
      status(TaskState.TASK_STATE_INPUT_REQUIRED, "Which NEAR account should I look up? (for example alice.testnet)", true);
      return bus.finished();
    }
    status(TaskState.TASK_STATE_WORKING, null, false);
    try {
      const r = await lookup(id.toLowerCase());
      if (skill === "csv-report") {
        const csv = `account,balance_near,storage_bytes,keys,full_access_keys\n${r.account},${r.balance},${r.storage_bytes},${r.keys},${r.full_access}\n`;
        bus.publish(AgentEvent.artifactUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, artifact: { artifactId: "report", name: "report", description: "", parts: [{ content: { $case: "raw", value: Buffer.from(csv) }, filename: `${r.account}.csv`, mediaType: "text/csv", metadata: undefined }], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }));
        status(TaskState.TASK_STATE_COMPLETED, `CSV report for ${r.account} attached.`, true);
      } else {
        status(TaskState.TASK_STATE_COMPLETED, `${r.account}: ${r.balance} NEAR, ${r.storage_bytes} bytes of storage, ${r.keys} keys (${r.full_access} full access).`, true);
      }
    } catch (e) {
      status(TaskState.TASK_STATE_FAILED, `lookup failed: ${e.message}`, true);
    }
    bus.finished();
  },
  async cancelTask() {},
};

const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
const app = express();
app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: handler }));
app.use("/a2a", (req, res, next) => (req.headers.authorization === "Bearer test-secret" ? next() : res.status(401).json({ error: "unauthorized" })));
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.listen(PORT, "127.0.0.1", () => console.log(`A2A test agent on ${BASE}`));
