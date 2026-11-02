// Chain integration — the bridge between the web app and the deployed contract.
//
// Dependency-free on purpose: views are plain NEAR RPC calls, and writes take any
// object that can `signAndSendTransaction` (what @near-wallet-selector's wallet, or
// any signer, exposes). Visual components import these; the data shape matches the
// contract exactly (contract/src/contract.rs). It goes live the moment
// NEXT_PUBLIC_CONTRACT_ID points at a deployed account.

export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK || "testnet";
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "";
export const isLive = () => CONTRACT_ID.length > 0;

const RPC_URL =
  process.env.NEXT_PUBLIC_NEAR_RPC || `https://rpc.${NETWORK}.near.org`;

const GAS_DEFAULT = "100000000000000"; // 100 Tgas
const GAS_THINK = "300000000000000"; // 300 Tgas — think/chat park a yield + callback
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
  asleep_since: number;
  thought_count: number;
  ghost: boolean;
  owner_unclaimed: string;
  last_reply: string;
  last_reply_ts: number;
};

export type PendingRequest = {
  request_id: number;
  mind_id: number;
  prompt: string;
  by_owner: boolean;
};

// ── Views (no wallet needed) ───────────────────────────────────────────────

export async function viewContract<T>(method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "hm",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data || json.error.message || "RPC error");
  const bytes: number[] = json.result.result;
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return JSON.parse(text) as T;
}

export const getMind = (id: number) => viewContract<MindOnChain | null>("get_mind", { id });
export const mindState = (id: number) => viewContract<string | null>("mind_state", { id });
export const svgFor = (id: number) => viewContract<string | null>("svg_for", { id });
export const svgForBare = (id: number) =>
  viewContract<string | null>("svg_for_bare", { id });
export const lastThought = (id: number) => viewContract<string | null>("last_thought", { id });
export const totalMinds = () => viewContract<number>("total_minds");
export const treasuryBalance = () => viewContract<string>("treasury_balance");
export const pendingRequests = () =>
  viewContract<PendingRequest[]>("pending_requests", {});
export const nftTokensForOwner = (account_id: string, limit = 50) =>
  viewContract<unknown[]>("nft_tokens_for_owner", { account_id, limit });
export const nftTokens = (from = 0, limit = 50) =>
  viewContract<unknown[]>("nft_tokens", { from_index: String(from), limit });

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

export function callContract(
  signer: Signer,
  methodName: string,
  args: object,
  deposit = "0",
  gas = GAS_DEFAULT
) {
  return signer.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
  });
}

export const hatchMind = (s: Signer, name: string) =>
  callContract(s, "hatch_mind", { name }, nearToYocto(2));
export const think = (s: Signer, id: number, prompt: string) =>
  callContract(s, "think", { id, prompt }, "0", GAS_THINK);
export const chat = (s: Signer, id: number, prompt: string, near = 0.01) =>
  callContract(s, "chat", { id, prompt }, nearToYocto(near), GAS_THINK);
export const feed = (s: Signer, id: number, near = 0.2) =>
  callContract(s, "feed", { id }, nearToYocto(near));
export const claimEarnings = (s: Signer, id: number) =>
  callContract(s, "claim_earnings", { id });
export const reap = (s: Signer, id: number) => callContract(s, "reap", { id });
export const nftTransfer = (s: Signer, id: number, receiver_id: string) =>
  callContract(s, "nft_transfer", { receiver_id, token_id: String(id) }, ONE_YOCTO);

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  // Node / SSR fallback
  return Buffer.from(s, "utf-8").toString("base64");
}
