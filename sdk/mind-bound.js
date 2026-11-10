// An agent bound to one Mind NFT.
//
// A Mind is sold whole, so an agent built for a Mind should belong to whoever owns that NFT,
// and should not be something its maker can quietly plug into a second Mind. This helper gives
// an agent server (connected by URL through the Hungry Minds gateway, or run with MindAgent)
// both properties without trusting anyone:
//
//   - it serves only work that the contract itself says was ordered from ITS Mind
//     (the job id the gateway sends is looked up on chain: get_job → mind_id), so the same URL
//     plugged into another Mind refuses every job;
//   - it can always ask who owns the Mind right now (nft_token → owner_id), for anything the
//     agent keeps per owner (settings, a dashboard, an allow-list). The money needs nothing:
//     the contract pays the owner's 90% to whoever owns the Mind when the work is delivered.
//
//   const { mindGuard } = require("hungry-minds-agent/mind-bound");
//   const guard = mindGuard({ contractId: "hungry-minds-8250f6.testnet", mindId: 12 });
//   // in your HTTPS handler (the gateway POSTs { input, skill, mind_id, job_id, buyer, ... }):
//   const ok = await guard.check(body);
//   if (!ok.ok) return { error: ok.reason };      // the gateway refunds the buyer at the deadline
//   const owner = await guard.owner();            // the NFT's current owner, if you need it

const DEFAULT_RPC = { testnet: "https://near-testnet.drpc.org", mainnet: "https://free.rpc.fastnear.com" };

async function view(rpc, contractId, method, args) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(`${method}: ${JSON.stringify(j.error || j.result.error).slice(0, 160)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

/** The current owner of Mind `mindId` (the NFT's owner_id), or null if there is no such Mind. */
async function mindOwner({ contractId, mindId, network = "testnet", rpc }) {
  const t = await view(rpc || DEFAULT_RPC[network], contractId, "nft_token", { token_id: String(mindId) });
  return t ? t.owner_id : null;
}

/**
 * A guard for an agent that belongs to one Mind.
 * check(payload) → { ok: true, job } when the payload's job was ordered on chain from this Mind,
 * else { ok: false, reason }. Chat messages (no job id) pass only when mind_id matches.
 */
function mindGuard({ contractId, mindId, network = "testnet", rpc, allowChat = true }) {
  if (!contractId || !Number.isInteger(mindId)) throw new Error("mindGuard needs contractId and an integer mindId");
  const url = rpc || DEFAULT_RPC[network];
  return {
    mindId,
    owner: () => mindOwner({ contractId, mindId, rpc: url }),
    async check(payload = {}) {
      if (Number(payload.mind_id) !== mindId) return { ok: false, reason: `this agent belongs to Mind #${mindId}` };
      if (payload.job_id === undefined || payload.job_id === null) {
        return allowChat ? { ok: true, job: null } : { ok: false, reason: "this agent only takes ordered jobs" };
      }
      const job = await view(url, contractId, "get_job", { job_id: Number(payload.job_id) });
      if (!job) return { ok: false, reason: `job ${payload.job_id} is not on chain` };
      if (Number(job.mind_id) !== mindId) return { ok: false, reason: `job ${payload.job_id} was ordered from another Mind` };
      if (job.status !== "Open") return { ok: false, reason: `job ${payload.job_id} is ${String(job.status).toLowerCase()}` };
      return { ok: true, job };
    },
  };
}

module.exports = { mindGuard, mindOwner };
