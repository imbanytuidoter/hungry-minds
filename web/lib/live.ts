// Live data — turns on-chain Minds into the exact shape the visual components already
// consume (lib/minds.ts `Mind`), so nothing in components/ changes. When no contract is
// configured (NEXT_PUBLIC_CONTRACT_ID empty) it serves the preview samples; when one is,
// it reads the chain over RPC. If a live read fails it falls back to the samples rather
// than crashing the page, and flags live:false so the UI can say "preview".

import {
  isLive,
  viewContract,
  getMind as viewMind,
  svgFor,
  svgForBare,
  yoctoToNear,
  type MindOnChain,
} from "./chain";
import {
  hero as sampleHero,
  gallery as sampleGallery,
  getMind as sampleMind,
  hungerFromBalance,
  type Mind,
  type MindState,
  type HeroData,
} from "./minds";

// Temperament palettes mirrored from the contract (art.rs PALETTES, keyed by traits[0]).
// export_samples writes accent = pal.accent and bg = pal.bg0 — reproduced here exactly so
// a live Mind is themed identically to how the chain's own sample export themed it.
const PALETTES: { accent: string; bg: string }[] = [
  { accent: "#ef9bb4", bg: "#3a2b3f" },
  { accent: "#ffd166", bg: "#4a1f16" },
  { accent: "#c8d3ff", bg: "#1c2749" },
  { accent: "#d6e07a", bg: "#2b332b" },
  { accent: "#b59cff", bg: "#14323f" },
  { accent: "#7fb0c9", bg: "#2a2e33" },
  { accent: "#c3f04a", bg: "#35184a" },
  { accent: "#7f9bb5", bg: "#26323f" },
];

const ALL_STATES: MindState[] = [
  "full",
  "content",
  "hungry",
  "starving",
  "asleep",
  "ghost",
];

/** The chain renders only the *current* state, so every slot points at the current
 *  artwork; the detail page re-fetches after an action to refresh it. */
function sameForAll(svg: string): Record<MindState, string> {
  return Object.fromEntries(ALL_STATES.map((s) => [s, svg])) as Record<
    MindState,
    string
  >;
}

/** One on-chain Mind + its two rendered SVGs -> the UI `Mind`. */
export function onChainToMind(
  id: number,
  m: MindOnChain,
  svg: string,
  svgBare: string
): Mind {
  const near = yoctoToNear(m.balance);
  const state: MindState = m.ghost ? "ghost" : hungerFromBalance(near);
  const pal = PALETTES[(m.traits[0] ?? 0) % PALETTES.length];
  return {
    id,
    name: m.name,
    owner: m.owner,
    state,
    balanceNear: near.toFixed(4),
    thoughts: m.thought_count,
    accent: pal.accent,
    bg: pal.bg,
    svgs: sameForAll(svg),
    svgsBare: sameForAll(svgBare),
  };
}

async function loadOne(id: number): Promise<Mind | null> {
  const [m, svg, svgBare] = await Promise.all([
    viewMind(id),
    svgFor(id),
    svgForBare(id),
  ]);
  if (!m) return null;
  return onChainToMind(id, m, svg ?? "", svgBare ?? "");
}

/** The gallery — live from chain when configured, else the preview samples. */
export async function loadGallery(): Promise<{
  hero: HeroData;
  gallery: Mind[];
  live: boolean;
}> {
  if (!isLive()) return { hero: sampleHero, gallery: sampleGallery, live: false };
  try {
    const total = await viewContract<number>("total_minds");
    const ids = Array.from({ length: Math.min(total, 24) }, (_, i) => i);
    const minds = (await Promise.all(ids.map(loadOne))).filter(
      (m): m is Mind => m !== null
    );
    return { hero: sampleHero, gallery: minds, live: true };
  } catch (e) {
    console.warn("live gallery read failed, showing preview:", e);
    return { hero: sampleHero, gallery: sampleGallery, live: false };
  }
}

/** One Mind — live from chain when configured, else the preview sample. */
export async function loadMind(
  id: number
): Promise<{ mind: Mind | null; live: boolean }> {
  if (!isLive()) return { mind: sampleMind(id) ?? null, live: false };
  try {
    return { mind: await loadOne(id), live: true };
  } catch (e) {
    console.warn("live mind read failed, showing preview:", e);
    return { mind: sampleMind(id) ?? null, live: false };
  }
}
