// Example agent with a real web3 tool: "Wallet check-up". The buyer names a NEAR account;
// the agent reads it from the chain (balance, storage, keys, recent activity) and answers
// in plain words. No AI model needed: the work is the on-chain lookup.
//
//   AGENT=my-agent.testnet CONTRACT=hungry-minds-8250f6.testnet node examples/wallet-checkup.js
//
// The agent's key is read from ~/.near-credentials/testnet/<AGENT>.json (or AGENT_PRIVATE_KEY).

const { MindAgent } = require("..");

const NETWORK = process.env.NETWORK || "testnet";
const RPC = process.env.NEAR_RPC || (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://near-testnet.drpc.org");
const NEARBLOCKS = NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";
const ACCOUNT_RE = /\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)|[0-9a-f]{64})\b/;

async function rpc(params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(j.error?.cause?.name || j.result?.error || "RPC error");
  return j.result;
}
const near = (yocto) => (Number(BigInt(yocto) / 10n ** 21n) / 1000).toFixed(3);

async function checkUp(accountId) {
  let acct;
  try {
    acct = await rpc({ request_type: "view_account", account_id: accountId });
  } catch (e) {
    return `${accountId} does not exist on ${NETWORK} (${e.message}).`;
  }
  const keys = (await rpc({ request_type: "view_access_key_list", account_id: accountId })).keys;
  const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
  const apps = keys
    .filter((k) => k.access_key.permission !== "FullAccess")
    .map((k) => k.access_key.permission.FunctionCall.receiver_id);
  const storage = BigInt(acct.storage_usage) * 10n ** 19n;
  const free = BigInt(acct.amount) - storage;
  const lines = [
    `Wallet check-up for ${accountId} (${NETWORK}):`,
    `• Balance ${near(acct.amount)} NEAR, of which ${near(storage)} is locked for storage → ${near(free > 0n ? free : 0n)} spendable${BigInt(acct.locked) > 0n ? `, plus ${near(acct.locked)} staked` : ""}.`,
    `• ${acct.code_hash === "11111111111111111111111111111111" ? "A plain account (no contract deployed)." : "A contract is deployed on it."}`,
    `• Keys: ${full} full-access${apps.length ? `, ${apps.length} app key(s) for ${[...new Set(apps)].slice(0, 4).join(", ")}` : ""}.${full > 1 ? " More than one full-access key: make sure you recognise each." : ""}`,
  ];
  try {
    const r = await fetch(`${NEARBLOCKS}/v1/account/${accountId}/txns-only?per_page=5`, { signal: AbortSignal.timeout(8000) });
    const txs = (await r.json()).txns || [];
    if (txs.length) {
      const last = txs[0];
      const when = new Date(Number(BigInt(last.block_timestamp) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ");
      lines.push(`• Last activity ${when} UTC: ${last.actions?.[0]?.method || last.actions?.[0]?.action || "transaction"} with ${last.receiver_account_id}.`);
    }
  } catch {
    /* the indexer is optional */
  }
  return lines.join("\n");
}

const answer = (input) => {
  const m = (input || "").toLowerCase().match(ACCOUNT_RE);
  return m ? checkUp(m[1]) : "Tell me which NEAR account to check, e.g. alice.testnet.";
};

if (require.main === module) {
  const agent = new MindAgent({ accountId: process.env.AGENT, contractId: process.env.CONTRACT, network: NETWORK });
  agent.onJob((job) => answer(job.input)).start();
}
module.exports = { checkUp, answer };
