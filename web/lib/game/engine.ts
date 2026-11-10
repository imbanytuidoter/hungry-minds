// The game's rules, as pure functions.
//
// These mirror the contract one-for-one (contract/src/economy.rs, state.rs, contract.rs)
// so the demo world plays by exactly the rules the chain enforces: same prices, same
// splits, same hunger thresholds, same metabolism. The only thing the demo changes is
// the clock — see DEMO_* below — so a judge can watch a Mind get hungry in minutes
// instead of weeks. Happiness and energy are off-chain game feel by design,
// and live here too.

import type { Look, Mood } from "./look";

// ── Economy (defaults from economy.rs; live mode overwrites them from `params()`) ──

export type Params = {
  thoughtCost: number; // NEAR per thought (economy.rs:24)
  guestMinPrice: number; // minimum pay-to-chat (economy.rs:36)
  revivePrice: number; // (economy.rs:42)
  mintPrice: number; // hatch (economy.rs:18)
  idleRatePerDay: number; // autonomous thoughts per day (state.rs:49)
};

export const DEFAULT_PARAMS: Params = {
  thoughtCost: 0.002,
  guestMinPrice: 0.01,
  revivePrice: 0.1,
  mintPrice: 1.0,
  idleRatePerDay: 10,
};

/** hatch: 0.1 food / 0.25 storage reserve / 0.65 treasury (economy.rs mint_split). */
export const MINT_SPLIT = { food: 0.1, reserve: 0.25, treasury: 0.65 };

export const feedSplit = (paid: number) => ({ mind: paid * 0.95, treasury: paid * 0.05 });
/** Her food bar: 100% is the food one Dream swirl gives (0.05 NEAR, 95% of it food). Same as
 *  state.rs FOOD_BAR_FULL; a newborn's 0.1 NEAR is a full bar with food to spare. */
export const FOOD_BAR_FULL = 0.0475;
export const foodBarPct = (food: number) => Math.min(100, Math.round((food / FOOD_BAR_FULL) * 100));
/** What feeding `paid` NEAR gives her: food-bar points and how many replies that food pays for. */
export const feedGain = (paid: number, thoughtCost = DEFAULT_PARAMS.thoughtCost) => {
  const food = feedSplit(paid).mind;
  return { food, pct: Math.round((food / FOOD_BAR_FULL) * 100), replies: Math.floor(food / thoughtCost + 1e-9) };
};
// What others pay to use a Mind: 90% to her owner, 10% protocol. Nothing goes into her food.
export const guestSplit = (paid: number) => ({ mind: 0, owner: paid * 0.9, treasury: paid * 0.1 });
export const reviveSplit = (paid: number) => ({ mind: paid * 0.8, treasury: paid * 0.2 });

// ── Clock ──────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Real chain: 10 thoughts/day -> one quiet thought every 2.4 h. The demo world runs one
 *  every 6 s, so a newborn (0.1 NEAR of food) sleeps after ~5 minutes of neglect. */
export const DEMO_IDLE_MS = 6_000;
/** Real chain: 30 days asleep -> ghost. The demo uses the contract's own `demo-window`
 *  build value (state.rs: 3 minutes). */
export const DEMO_GHOST_MS = 3 * 60_000;
export const LIVE_GHOST_MS = 30 * DAY_MS;

export type Clock = { idleMs: number; ghostMs: number };
export const demoClock: Clock = { idleMs: DEMO_IDLE_MS, ghostMs: DEMO_GHOST_MS };
export const liveClock = (p: Params): Clock => ({
  idleMs: p.idleRatePerDay > 0 ? DAY_MS / p.idleRatePerDay : Infinity,
  ghostMs: LIVE_GHOST_MS,
});

// ── The Mind ───────────────────────────────────────────────────────────────────

/** NEAR AI Cloud's TEE signature over a reply (worker/near-ai.js), when its model wrote it. */
export type ReplyProof = { provider: string; model: string; chat_id: string | null; verified: boolean; signer: string | null; kind: string | null; signed_text: string | null; signature: string | null; verify_url: string };
// `via`: the name of her agent when the agent (not the Mind herself) wrote this reply
export type Msg = { who: "me" | "mind"; t: string; paid?: number; proof?: ReplyProof | null; via?: string | null };

export type MindRec = {
  id: number;
  name: string;
  owner: string;
  look: Look;
  natures: string[];
  traits: number[];
  balance: number; // NEAR — the Mind's own food, nobody can withdraw it
  thoughts: number;
  bornTs: number;
  asleepSince: number; // 0 = awake
  /** asleep by her live food, but the chain has not recorded it yet (nothing settled her idle
   *  burn), so the ghost window has not started: no countdown, no Reap */
  sleepPending?: boolean;
  ghost: boolean;
  ownerUnclaimed: number; // owner's 90% of what others paid + reap rebate
  lastMetabolismTs: number;
  // off-chain feel
  happy: number;
  energy: number;
  love: number;
  msgs: Msg[];
};

export type HungerState = "full" | "content" | "hungry" | "starving" | "asleep" | "ghost";

/** state.rs hunger_state + the ghost / asleep flags (contract.rs mind_state). */
export function stateOf(m: Pick<MindRec, "balance" | "asleepSince" | "ghost">): HungerState {
  if (m.ghost) return "ghost";
  if (m.asleepSince !== 0) return "asleep";
  const b = m.balance;
  // 80% / 30% / 10% of the food bar (0.038 / 0.01425 / 0.00475 NEAR), as state.rs; the tiny
  // epsilon keeps exact thresholds from slipping a step on floating-point balances
  const e = 1e-12;
  if (b + e >= FOOD_BAR_FULL * 0.8) return "full";
  if (b + e >= FOOD_BAR_FULL * 0.3) return "content";
  if (b + e >= FOOD_BAR_FULL * 0.1) return "hungry";
  if (b > 0) return "starving";
  return "asleep";
}

export function moodOf(s: HungerState): Mood {
  return ({ full: "happy", content: "happy", hungry: "flat", starving: "sad", asleep: "asleep", ghost: "ghost" } as const)[s];
}

export const STATE_LABEL: Record<HungerState, string> = {
  full: "Full & happy",
  content: "Content",
  hungry: "Hungry",
  starving: "Starving",
  asleep: "Asleep",
  ghost: "Ghost",
};

/** contract.rs settle_metabolism: lazy idle drain, remainder carried, no drift. */
export function settle(m: MindRec, now: number, p: Params, clock: Clock): MindRec {
  if (m.ghost || m.asleepSince !== 0) return m;
  const elapsed = Math.max(0, now - m.lastMetabolismTs);
  const n = Math.floor(elapsed / clock.idleMs);
  if (n === 0) return m;
  const drain = n * p.thoughtCost;
  if (drain >= m.balance - 1e-12) {
    return { ...m, balance: 0, asleepSince: now, lastMetabolismTs: now };
  }
  const balance = round(m.balance - drain);
  return {
    ...m,
    balance,
    lastMetabolismTs: m.lastMetabolismTs + n * clock.idleMs,
    asleepSince: balance < p.thoughtCost ? now : 0,
  };
}

/** How long until the Mind falls asleep if nobody feeds it (ms). */
export function timeToSleep(m: MindRec, p: Params, clock: Clock): number {
  if (m.ghost || m.asleepSince !== 0) return 0;
  return Math.floor(m.balance / p.thoughtCost) * clock.idleMs;
}

// ── Live mood (off chain, kept in the browser with the time it was set) ──────────
// Happiness fades while nobody cares for her and comes back with petting, chat and food.
// Energy is spent on replies and comes back with rest. Hunger caps both, so mood never
// contradicts the food on chain.
export const MOOD = {
  happyLossPerHour: 2, // 100% -> 10% floor in 45 h alone
  energyRestPerHour: 10, // a tired Mind is fresh again in ~9 h
  pet: 3, // happiness per pet
  chat: 4, // happiness per reply; each reply also costs `replyEnergy`
  replyEnergy: 4,
  feedHappy: 6,
  feedEnergy: 8,
};

export type StoredMood = { happy: number; energy: number; ts: number };

/** Mood now, from the last stored value and the hours since. */
export function moodAt(f: StoredMood, now: number): { happy: number; energy: number } {
  const h = Math.max(0, (now - f.ts) / 3_600_000);
  return { happy: Math.max(10, f.happy - MOOD.happyLossPerHour * h), energy: Math.min(100, f.energy + MOOD.energyRestPerHour * h) };
}

/** The most happiness / energy she can have at this hunger level. */
export function moodCap(s: HungerState): { happy: number; energy: number } {
  return ({
    full: { happy: 100, energy: 100 },
    content: { happy: 90, energy: 90 },
    hungry: { happy: 60, energy: 50 },
    starving: { happy: 30, energy: 25 },
    asleep: { happy: 30, energy: 0 },
    ghost: { happy: 0, energy: 0 },
  } as const)[s];
}

/** Off-chain mood drift, applied on every tick. */
export function drift(m: MindRec, dtMs: number): MindRec {
  const k = dtMs / 4000; // a 4 s reference tick
  return { ...m, happy: Math.max(10, m.happy - 0.2 * k), energy: Math.max(10, m.energy - 0.3 * k) };
}

export const round = (x: number) => Math.round(x * 1e9) / 1e9;
export const fmt = (x: number, d = 3) => x.toFixed(d);
