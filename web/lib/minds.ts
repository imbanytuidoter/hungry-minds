// Data layer. Today it serves the preview samples that were exported straight from
// the contract's own renderer (so the site shows exactly what the chain draws). The
// same shapes will be filled from RPC (`nft_token`, `svg_for`, `get_mind`) once the
// contract is deployed to testnet — see lib/chain.ts (added at deploy time).

import samples from "./sample-minds.json";

export type MindState =
  | "full"
  | "content"
  | "hungry"
  | "starving"
  | "asleep"
  | "ghost";

export type Mind = {
  id: number;
  name: string;
  state: MindState;
  balanceNear: string;
  thoughts: number;
  accent: string;
  bg: string;
  /** Every state's art for this exact creature (real renderer output). */
  svgs: Record<MindState, string>;
};

/** The art for a Mind's current state. */
export function currentSvg(m: Mind): string {
  return m.svgs[m.state];
}

export type HeroData = {
  name: string;
  accent: string;
  bg: string;
  states: Record<MindState, string>;
};

export const hero = samples.hero as HeroData;
export const gallery = samples.gallery as Mind[];

export function getMind(id: number): Mind | undefined {
  return gallery.find((m) => m.id === id);
}

export function isAlive(state: MindState): boolean {
  return state !== "asleep" && state !== "ghost";
}

/** Mirrors the contract's hunger thresholds (state.rs): a Mind that can no longer
 *  afford a thought (< 0.002 NEAR) is asleep. Preview-only; the chain is the truth. */
export function hungerFromBalance(near: number): MindState {
  if (near < 0.002) return "asleep";
  if (near < 0.02) return "starving";
  if (near < 0.1) return "hungry";
  if (near < 0.5) return "content";
  return "full";
}

/** Cost of one thought, in NEAR (economy.rs: THOUGHT_COMPUTE_COST). */
export const THOUGHT_COST = 0.002;

/** How the life bar reads — how full the Mind is right now. */
export function vitalPercent(state: MindState): number {
  return { full: 92, content: 58, hungry: 24, starving: 8, asleep: 0, ghost: 0 }[
    state
  ];
}

/** Plain-language mood — what a person would say looking at it. */
export function moodLabel(state: MindState): string {
  return {
    full: "wide awake",
    content: "content",
    hungry: "getting hungry",
    starving: "starving",
    asleep: "asleep",
    ghost: "a ghost",
  }[state];
}

export function moodBlurb(state: MindState): string {
  return {
    full: "Well-fed and thinking fast.",
    content: "Doing just fine on its own.",
    hungry: "Could use a meal soon.",
    starving: "Almost out of food — it needs you.",
    asleep: "Ran out of food and dozed off. Feed it to wake it.",
    ghost: "It slept too long. Only its memory remains.",
  }[state];
}
