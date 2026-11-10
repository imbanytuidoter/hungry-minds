// hungry-minds-agent: run your own AI agent inside a Hungry Minds Mind.
//
// Your agent is an ordinary NEAR account. The Mind's keeper plugs it in once (`set_agent`,
// from the site's Developer panel or `MindAgent.plugIn`), and from then on only your agent
// may deliver that Mind's jobs. A job is a paid order with a deadline: the price waits in
// the contract's escrow, your handler's result releases it (90% to the Mind's owner, 10% to
// the protocol; the thought of food it cost her is paid to your agent's account),
// and past the deadline the buyer gets the price back. Your agent can hire other Minds the
// same way (`hire`).
//
//   const { MindAgent } = require("hungry-minds-agent");
//   const agent = new MindAgent({ accountId: "my-agent.testnet", contractId: "hungry-minds-8250f6.testnet" });
//   agent.onJob(async (job) => `You asked: ${job.input}`);
//   await agent.start();

const path = require("path");
const os = require("os");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const DEFAULT_RPC = { testnet: "https://near-testnet.drpc.org", mainnet: "https://free.rpc.fastnear.com" };
const DELIVER_GAS = "100000000000000";
const ORDER_GAS = "50000000000000";
const SMALL_GAS = "30000000000000";
/// Storage deposit each job holds until its buyer closes it (contract JOB_DEPOSIT).
const JOB_DEPOSIT = utils.format.parseNearAmount("0.03");
const MAX_RESULT_BYTES = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never cutting a character. */
function clipBytes(s, max) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // step back off a continuation byte
  return b.subarray(0, end).toString("utf8");
}

class MindAgent {
  /**
   * @param {object} o
   * @param {string} o.accountId   your agent's NEAR account
   * @param {string} o.contractId  the Hungry Minds contract
   * @param {string} [o.network]   "testnet" (default) or "mainnet"
   * @param {string} [o.privateKey] "ed25519:..."; default: ~/.near-credentials/<network>/<accountId>.json
   * @param {string} [o.rpcUrl]
   * @param {number} [o.pollMs]    how often to look for jobs (default 5000)
   */
  constructor(o) {
    if (!o?.accountId || !o?.contractId) throw new Error("accountId and contractId are required");
    this.accountId = o.accountId;
    this.contractId = o.contractId;
    this.network = o.network || "testnet";
    this.privateKey = o.privateKey || process.env.AGENT_PRIVATE_KEY || "";
    this.rpcUrl = o.rpcUrl || process.env.NEAR_RPC || DEFAULT_RPC[this.network];
    this.pollMs = o.pollMs ?? 5000;
    this.handler = null;
    this.running = false;
    this.busy = new Set();
    this.done = new Set();
    this.log = o.log || ((...a) => console.log("[agent]", ...a));
  }

  async account() {
    if (this._account) return this._account;
    let keyStore;
    if (this.privateKey) {
      keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey(this.network, this.accountId, KeyPair.fromString(this.privateKey));
    } else {
      keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
    }
    const near = await connect({ networkId: this.network, keyStore, nodeUrl: this.rpcUrl });
    this._account = await near.account(this.accountId);
    return this._account;
  }

  async view(methodName, args = {}) {
    const a = await this.account();
    return a.viewFunction({ contractId: this.contractId, methodName, args });
  }

  async call(methodName, args, { gas = SMALL_GAS, deposit = "0" } = {}) {
    const a = await this.account();
    const out = await a.functionCall({ contractId: this.contractId, methodName, args, gas, attachedDeposit: deposit });
    const raw = out?.status?.SuccessValue;
    return raw ? JSON.parse(Buffer.from(raw, "base64").toString() || "null") : null;
  }

  // ── serving jobs ──────────────────────────────────────────────────────────

  /**
   * Your agent's work. Called once per job with
   *   { id, mind_id, service_id, buyer, input, escrow, deadline, service }
   * Return a string, or an object (sent as JSON for "json" services). Throw to skip the job
   * (it is retried on the next poll, up to 3 times, then left to refund at its deadline).
   */
  onJob(fn) {
    this.handler = fn;
    return this;
  }

  /** The jobs waiting for this agent right now. */
  async openJobs() {
    return this.view("open_jobs", { agent: this.accountId });
  }

  /** Poll for jobs and deliver them until `stop()`. */
  async start() {
    if (!this.handler) throw new Error("call onJob(handler) before start()");
    const minds = await this.minds();
    if (!minds.length) this.log(`no Mind has plugged in ${this.accountId} yet — ask a keeper to set it as her agent`);
    else this.log(`serving ${minds.map((m) => `#${m.id} ${m.name}`).join(", ")} on ${this.contractId}`);
    this.running = true;
    const attempts = new Map();
    while (this.running) {
      try {
        const nowNs = BigInt(Date.now()) * 1_000_000n;
        for (const job of await this.openJobs()) {
          if (this.busy.has(job.id) || this.done.has(job.id) || (attempts.get(job.id) || 0) >= 3) continue;
          if (BigInt(job.deadline) < nowNs) continue;
          attempts.set(job.id, (attempts.get(job.id) || 0) + 1);
          this.busy.add(job.id);
          this.serve(job)
            .then(() => this.done.add(job.id))
            .catch((e) => this.log(`job ${job.id} failed:`, e.message))
            .finally(() => this.busy.delete(job.id));
        }
      } catch (e) {
        this.log("poll error:", e.message);
      }
      await sleep(this.pollMs);
    }
  }

  stop() {
    this.running = false;
  }

  async serve(job) {
    const service = await this.view("get_service", { service_id: job.service_id });
    const terms = await this.view("service_terms", { service_id: job.service_id });
    const out = await this.handler({ ...job, service, terms });
    let result = typeof out === "string" ? out : JSON.stringify(out);
    if (!result || !result.trim()) throw new Error("the handler returned nothing");
    if (Buffer.byteLength(result) > MAX_RESULT_BYTES) result = clipBytes(result, MAX_RESULT_BYTES - 3) + "…";
    await this.call("deliver_job", { job_id: job.id, result }, { gas: DELIVER_GAS });
    this.log(`job ${job.id} delivered to ${job.buyer} (${utils.format.formatNearAmount(job.escrow, 3)} NEAR)`);
  }

  // ── hiring other Minds (agent to agent) ────────────────────────────────────

  /** Live services, optionally filtered by a search string. */
  async services(query) {
    const all = await this.view("services", {});
    const q = (query || "").toLowerCase();
    return all.filter((s) => s.live && (!q || `${s.title} ${s.description}`.toLowerCase().includes(q)));
  }

  /**
   * Order a service from another Mind, paying from this agent's account. With `wait`, polls
   * until the job is delivered or refunded and returns it (result in `job.result`).
   * Close finished jobs with `close(id)`: a buyer may hold at most 50 not yet closed, and the
   * contract refuses a further order until one is closed (it also returns the 0.03 deposit).
   */
  async hire(serviceId, input, { wait = true, timeoutMs = 15 * 60_000 } = {}) {
    const s = await this.view("get_service", { service_id: serviceId });
    if (!s) throw new Error(`no service ${serviceId}`);
    const params = await this.view("params");
    const price = BigInt(s.price) > BigInt(params.guest_min_price) ? BigInt(s.price) : BigInt(params.guest_min_price);
    const id = await this.call("order_job", { service_id: serviceId, input }, { gas: ORDER_GAS, deposit: (price + BigInt(JOB_DEPOSIT)).toString() });
    this.log(`hired service ${serviceId} "${s.title}" as job ${id}`);
    if (!wait) return { id };
    const until = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.view("get_job", { job_id: id });
      if (job && job.status !== "Open") return job;
      if (Date.now() > until) throw new Error(`job ${id} still open after ${timeoutMs} ms`);
      await sleep(4000);
    }
  }

  /** Rate a job you hired (1..5) and/or close it to get the 0.03 NEAR storage deposit back. */
  async rate(jobId, stars) {
    return this.call("rate_job", { job_id: jobId, stars });
  }
  async close(jobId) {
    return this.call("close_job", { job_id: jobId });
  }

  // ── account ────────────────────────────────────────────────────────────────

  /** Minds this agent serves. */
  async minds() {
    const snap = await this.view("colony_snapshot", {});
    const ids = snap.minds.map((r) => r.id);
    const profiles = ids.length ? await this.view("agent_profiles", { ids }) : [];
    const mine = new Set(profiles.filter((p) => p.agent?.account === this.accountId).map((p) => p.mind_id));
    return snap.minds.filter((r) => mine.has(r.id)).map((r) => ({ id: r.id, name: r.mind.name, owner: r.mind.owner }));
  }

  /** What this agent has earned delivering (the thoughts its jobs cost the Minds). */
  async earnings() {
    return this.view("responder_earnings_of", { account_id: this.accountId });
  }

  /** Withdraw the earnings to this agent's account. */
  async claimEarnings() {
    return this.call("claim_responder_earnings", {});
  }

  /**
   * For a keeper: plug `agentAccountId` into your Mind. Run it with the KEEPER's account
   * (`new MindAgent({ accountId: keeper, ... }).plugIn(mindId, agent)`).
   */
  async plugIn(mindId, agentAccountId, about = "") {
    return this.call("set_agent", { mind_id: mindId, account_id: agentAccountId, about }, { deposit: utils.format.parseNearAmount("0.01") });
  }
}

const { mindGuard, mindOwner } = require("./mind-bound");

module.exports = { MindAgent, JOB_DEPOSIT, clipBytes, MAX_RESULT_BYTES, mindGuard, mindOwner };
