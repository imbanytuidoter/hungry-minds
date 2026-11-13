// Chain integration — the bridge between the web app and the deployed contract.
//
// Dependency-free on purpose: views are plain NEAR RPC calls, and writes take any
// object that can `signAndSendTransaction` (what @near-wallet-selector's wallet, or
// any signer, exposes). Visual components import these; the data shape matches the
// contract exactly (contract/src/contract.rs). It goes live the moment
// NEXT_PUBLIC_CONTRACT_ID points at a deployed account.

export type Network = "testnet" | "mainnet";
const ENV_NETWORK: Network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const NETWORK_KEY = "hm-net";

/** The network: the player's choice in this browser (the Testnet/Mainnet switch), else the
 *  build's NEXT_PUBLIC_NEAR_NETWORK, else testnet. Read once at load; switching reloads. */
export const NETWORK: Network = (() => {
  if (typeof window === "undefined") return ENV_NETWORK;
  try {
    const v = localStorage.getItem(NETWORK_KEY);
    return v === "mainnet" || v === "testnet" ? v : ENV_NETWORK;
  } catch {
    return ENV_NETWORK;
  }
})();

/** Persist the choice and reload, since every module reads NETWORK at load. */
export function switchNetwork(n: Network) {
  try {
    localStorage.setItem(NETWORK_KEY, n);
  } catch {
    /* storage blocked — the reload will land on the default */
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("demo");
  window.location.href = url.toString();
}

/** The public testnet deploy (demo-window build), so a clean clone plays on chain. */
export const TESTNET_DEPLOY = "hungry-minds-8250f6.testnet";
/** The mainnet deploy, once there is one (needs an audit first). Empty = not launched. */
export const MAINNET_DEPLOY = process.env.NEXT_PUBLIC_MAINNET_CONTRACT_ID || "";
// NEXT_PUBLIC_CONTRACT_ID overrides the build's own network (empty string -> offline demo).
export const CONTRACT_ID =
  NETWORK === ENV_NETWORK && process.env.NEXT_PUBLIC_CONTRACT_ID !== undefined
    ? process.env.NEXT_PUBLIC_CONTRACT_ID
    : NETWORK === "mainnet"
      ? MAINNET_DEPLOY
      : TESTNET_DEPLOY;
export const isLive = () => CONTRACT_ID.length > 0;
/** Mainnet picked but no mainnet contract exists yet: the UI says so instead of faking it. */
export const notLaunched = () => NETWORK === "mainnet" && !CONTRACT_ID;

// Public RPCs rate-limit hard (rpc.<network>.near.org is deprecated; FastNEAR's free tier
// returns 429 under load), so reads fail over down this list. A configured URL goes first.
export const RPC_URLS: string[] = [
  ...(process.env.NEXT_PUBLIC_NEAR_RPC && NETWORK === ENV_NETWORK ? [process.env.NEXT_PUBLIC_NEAR_RPC] : []),
  ...(NETWORK === "mainnet"
    ? ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"]
    : ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]),
];
/** What the sign-in modal offers on this network (EVM wallets are mainnet only, see wallets.ts). */
export const WALLET_KIND = NETWORK === "mainnet" ? "a NEAR or EVM wallet" : "a NEAR wallet";
/** For wallet libraries that take one node URL (or use the first of a list without our
 *  failover): the same endpoints with FastNEAR's rate-limited free tier moved last. */
export const WALLET_RPC_URLS: string[] = [...RPC_URLS.filter((u) => !u.includes("fastnear")), ...RPC_URLS.filter((u) => u.includes("fastnear"))];

let rpcPreferred = 0; // sticks to the last endpoint that answered

/** POST a JSON-RPC `query`, trying each endpoint until one answers without a transport/rate error. */
type RpcReply = { result: { result: number[]; amount: string }; error?: { code?: number; message?: string; data?: string } };
async function rpcQuery(params: object): Promise<RpcReply> {
  let last: unknown;
  for (let k = 0; k < RPC_URLS.length; k++) {
    const i = (rpcPreferred + k) % RPC_URLS.length;
    try {
      const res = await fetch(RPC_URLS[i], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "hm", method: "query", params }),
      });
      const json = await res.json();
      // -429 / 5xx-style errors mean "this endpoint", not "this query": try the next one.
      if (json.error && (json.error.code === -429 || res.status >= 500 || /rate limit|discontinued|deprecated/i.test(JSON.stringify(json.error)))) {
        last = json.error;
        continue;
      }
      rpcPreferred = i;
      return json;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`all RPC endpoints failed: ${typeof last === "object" ? JSON.stringify(last) : String(last)}`);
}

const GAS_DEFAULT = "100000000000000"; // 100 Tgas
const ONE_YOCTO = "1";

/** NEAR (decimal) -> yoctoNEAR string, to 6-decimal precision. */
export function nearToYocto(near: number): string {
  const micro = BigInt(Math.round(near * 1_000_000)); // NEAR -> microNEAR
  const microToYocto = BigInt(10) ** BigInt(18); // 1 microNEAR = 1e18 yocto
  return (micro * microToYocto).toString();
}

const YOCTO_PER_NEAR = BigInt(10) ** BigInt(24);

/** yoctoNEAR string -> NEAR (decimal). Lossy below ~1e-9, which is plenty for display. */
export function yoctoToNear(yocto: string): number {
  const y = BigInt(yocto || "0");
  const whole = y / YOCTO_PER_NEAR;
  const frac = y % YOCTO_PER_NEAR;
  return Number(whole) + Number(frac) / Number(YOCTO_PER_NEAR);
}

// ── Contract data shapes (mirror the contract) ─────────────────────────────

export type MindOnChain = {
  owner: string;
  name: string;
  traits: number[];
  balance: string; // yoctoNEAR
  born_ts: number;
  last_think_ts: number;
  /** ns: idle metabolism counts whole intervals from here (contract.rs settle_metabolism) */
  last_metabolism_ts: number;
  asleep_since: number;
  thought_count: number;
  ghost: boolean;
  owner_unclaimed: string;
  last_reply: string;
  last_reply_ts: number;
};


// ── Views (no wallet needed) ───────────────────────────────────────────────

export async function viewContract<T>(method: string, args: object = {}): Promise<T> {
  const json = await rpcQuery({
    request_type: "call_function",
    finality: "optimistic",
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (json.error) throw new Error(json.error.data || json.error.message || "RPC error");
  const bytes: number[] = json.result.result;
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return JSON.parse(text) as T;
}


/** Governable economy prices (contract.rs params). NearToken fields are yocto strings. */
export type EconomyParamsOnChain = {
  thought_cost: string;
  guest_min_price: string;
  revive_price: string;
  mint_price: string;
  idle_rate_per_day: number;
};

/** An account's spendable NEAR (yocto string) — plain RPC, not a contract view.
 *  The part locked for the account's own storage (1e19 yocto per byte) is not spendable. */
export async function accountBalance(account_id: string): Promise<string> {
  const json = await rpcQuery({ request_type: "view_account", finality: "optimistic", account_id });
  if (json.error) throw new Error(json.error.data || json.error.message || "RPC error");
  const r = json.result as unknown as { amount: string; storage_usage: number };
  const free = BigInt(r.amount) - BigInt(r.storage_usage) * BigInt("10000000000000000000");
  return (free > BigInt(0) ? free : BigInt(0)).toString();
}


// ── Writes (need a signer) ─────────────────────────────────────────────────

/** The minimal signer surface — @near-wallet-selector's `Wallet` satisfies this. */
export interface Signer {
  signAndSendTransaction(params: {
    receiverId?: string;
    actions: Array<{
      type: "FunctionCall";
      params: { methodName: string; args: object; gas: string; deposit: string };
    }>;
  }): Promise<unknown>;
}

export async function callContract(
  signer: Signer,
  methodName: string,
  args: object,
  deposit = "0",
  gas = GAS_DEFAULT
): Promise<unknown> {
  const out = await signer.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
  });
  // Some wallets resolve with a failed outcome instead of throwing: that is a failure too.
  const failure = txFailure(out);
  if (failure) throw new Error(failure);
  return out;
}

/** Why a FinalExecutionOutcome failed (the contract's panic text when there is one), or null
 *  when it succeeded or the wallet handed back no outcome. */
export function txFailure(out: unknown): string | null {
  const f = (out as { status?: { Failure?: unknown } } | null)?.status?.Failure;
  if (f === undefined || f === null) return null;
  const exec = (f as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: string } } } }).ActionError?.kind?.FunctionCallError?.ExecutionError;
  return exec || `The transaction failed: ${JSON.stringify(f).slice(0, 300)}`;
}

/** The number a contract call returned (e.g. hatch_mind's new id), whichever shape the signer
 *  hands back: the value itself (a key signer) or a wallet's FinalExecutionOutcome. Null when
 *  the wallet reports no outcome. */
export function returnedNumber(out: unknown): number | null {
  if (typeof out === "number") return out;
  const b64 = (out as { status?: { SuccessValue?: string } } | null)?.status?.SuccessValue;
  if (!b64) return null;
  try {
    const v = JSON.parse(atob(b64));
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Cosmetic look stored on chain (colony.rs Look): indices into the glossy parts. */
export type LookOnChain = { tone: number; eyes: number; hat: number; outfit: number; natures: number[] };

export const hatchMind = (s: Signer, name: string, look?: LookOnChain) =>
  callContract(s, "hatch_mind", { name, look: look ?? null }, nearToYocto(1));
/** Prepay chat credits for talking to other keepers' Minds (one approval for many messages). */
export const buyChatCredits = (s: Signer, yocto: string) =>
  callContract(s, "buy_chat_credits", {}, yocto);
/** Take back your own unspent chat credits (the worker settles usage every minute). */
export const withdrawChatCredits = (s: Signer) =>
  callContract(s, "withdraw_chat_credits", {}, ONE_YOCTO);
export const feed = (s: Signer, id: number, near = 0.05) =>
  callContract(s, "feed", { id }, nearToYocto(near));
export const claimEarnings = (s: Signer, id: number) =>
  callContract(s, "claim_earnings", { id });
export const reap = (s: Signer, id: number) => callContract(s, "reap", { id });
/** `yocto` is the exact on-chain revive price (params), never a rounded copy. */
export const revive = (s: Signer, id: number, yocto: string) =>
  callContract(s, "revive", { id }, yocto);

// ── Colony layer (contract/src/colony.rs) ──────────────────────────────────

export type ServiceOnChain = {
  id: number;
  mind_id: number;
  title: string;
  description: string;
  category: number;
  price: string; // yocto
  unit: string;
  live: boolean;
  orders: number;
  fed: string; // yocto
};
export type ListingOnChain = { id: number; name: string; owner: string; price: string };

export type SnapshotOnChain = {
  params: EconomyParamsOnChain;
  total_minds: number;
  supply_left: number;
  treasury: string;
  ghost_window_ms: number;
  minds: { id: number; mind: MindOnChain; live_balance: string; live_state: string; look: LookOnChain | null }[];
  services: ServiceOnChain[];
  listings: ListingOnChain[];
};
// The contract pages its views: colony_snapshot returns at most 60 Minds, services and
// listings at most 100 each (colony.rs).
const MINDS_PAGE = 60;
const LIST_PAGE = 100;

/** Given a full first page of a list view, read the following pages until a short one. */
async function allPages<T>(method: string, first: T[]): Promise<T[]> {
  const out = [...first];
  let last = first.length;
  while (last === LIST_PAGE) {
    const next = await viewContract<T[]>(method, { from_index: out.length, limit: LIST_PAGE });
    out.push(...next);
    last = next.length;
  }
  return out;
}

/** Everything the game shows (colony.rs colony_snapshot), with every page of Minds,
 *  services and listings — one view while the colony is small. */
export async function colonySnapshot(): Promise<SnapshotOnChain> {
  const snap = await viewContract<SnapshotOnChain>("colony_snapshot", {});
  const starts: number[] = [];
  for (let from = MINDS_PAGE; from < snap.total_minds; from += MINDS_PAGE) starts.push(from);
  // a few pages at a time: public RPCs rate-limit bursts
  for (let i = 0; i < starts.length; i += 3) {
    const pages = await Promise.all(
      starts.slice(i, i + 3).map((from) => viewContract<SnapshotOnChain>("colony_snapshot", { from_index: from, limit: MINDS_PAGE }))
    );
    for (const p of pages) snap.minds.push(...p.minds);
  }
  const [services, listings] = await Promise.all([allPages("services", snap.services), allPages("listings", snap.listings)]);
  return { ...snap, services, listings };
}

// ── Agents and jobs (contract/src/agents.rs) ───────────────────────────────

export type AgentInfoOnChain = { account: string; about: string; since: number };
export type ReputationOnChain = { delivered: number; refunded: number; rating_sum: number; ratings: number; earned: string; total_secs: number };
export type AgentProfileOnChain = { mind_id: number; agent: AgentInfoOnChain | null; reputation: ReputationOnChain };
export type TermsOnChain = { sla_secs: number; output: "text" | "json" };
export type JobOnChain = {
  id: number;
  service_id: number;
  mind_id: number;
  buyer: string;
  input: string;
  escrow: string;
  deposit: string;
  keeper: string;
  created: number; // ns
  deadline: number; // ns
  status: "Open" | "Delivered" | "Refunded";
  result: string | null;
  delivered_at: number;
  delivered_by: string | null;
  rating: number;
};
/** Storage deposit a job holds until its buyer closes it (agents.rs JOB_DEPOSIT). */
export const JOB_DEPOSIT_NEAR = 0.03;
const GAS_JOB = "100000000000000";

/** These views take at most 100 ids per call: ask in batches; answers keep the ids' order. */
async function inBatches<T>(method: string, ids: number[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += LIST_PAGE) out.push(...(await viewContract<T[]>(method, { ids: ids.slice(i, i + LIST_PAGE) })));
  return out;
}
export const agentProfiles = (ids: number[]) => inBatches<AgentProfileOnChain>("agent_profiles", ids);
export const termsOf = (ids: number[]) => inBatches<TermsOnChain>("terms_of", ids);
export const jobsOf = (account_id: string) => viewContract<JobOnChain[]>("jobs_of", { account_id });
export const getJob = (job_id: number) => viewContract<JobOnChain | null>("get_job", { job_id });
/** Plug an agent account into your Mind (null unplugs it). A little storage, excess refunded. */
export const setAgent = (s: Signer, mind_id: number, account_id: string | null, about: string) =>
  callContract(s, "set_agent", { mind_id, account_id, about }, nearToYocto(0.01));
export const publishJobService = (s: Signer, mind_id: number, title: string, description: string, category: number, priceNear: number, unit: string, sla_secs: number, output: "text" | "json", input_schema: string | null = null) =>
  callContract(s, "publish_job_service", { mind_id, title, description, category, price: nearToYocto(priceNear), unit, sla_secs, output, input_schema }, nearToYocto(input_schema ? 0.04 : 0.02));
/** Each service's input form (JSON Schema text), or null. */
export const inputSchemas = (ids: number[]) => inBatches<string | null>("input_schemas", ids);
/** Order a service as a job: its price plus the refundable storage deposit. Returns the job id. */
// priceNear is a rounded copy of the on-chain price: one microNEAR more covers the rounding
// (a price set elsewhere with more than 6 decimals), and the contract refunds any excess
export const orderJob = (s: Signer, service_id: number, input: string, priceNear: number) =>
  callContract(s, "order_job", { service_id, input }, nearToYocto(priceNear + JOB_DEPOSIT_NEAR + 0.000001), GAS_JOB);
export const rateJob = (s: Signer, job_id: number, stars: number) => callContract(s, "rate_job", { job_id, stars });
export const closeJob = (s: Signer, job_id: number) => callContract(s, "close_job", { job_id });
export const refundJob = (s: Signer, job_id: number) => callContract(s, "refund_job", { job_id });


/** First look costs a little storage (excess refunded). */
export const setLook = (s: Signer, id: number, look: LookOnChain) =>
  callContract(s, "set_look", { id, look }, nearToYocto(0.01));
export const setServiceLive = (s: Signer, service_id: number, live: boolean) =>
  callContract(s, "set_service_live", { service_id, live });
export const listForSale = (s: Signer, id: number, priceNear: number) =>
  callContract(s, "list_for_sale", { id, price: nearToYocto(priceNear) });
export const unlist = (s: Signer, id: number) => callContract(s, "unlist", { id });
/** `yocto` is the listing's exact on-chain price; it is also sent as the price the buyer saw, so
 *  a re-listing at another price between the look and the buy makes the contract refuse. */
export const buyMind = (s: Signer, id: number, yocto: string) =>
  callContract(s, "buy_mind", { id, expected_price: yocto }, yocto);

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  // Node / SSR fallback
  return Buffer.from(s, "utf-8").toString("base64");
}
