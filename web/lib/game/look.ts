// How a Mind looks in the game UI (the glossy design-handoff character).
//
// The chain rolls seven trait dials at birth (contract/src/art.rs). The game renders the
// glossy character instead of the on-chain SVG, so this file maps those dials onto the
// glossy character's colour / eyes / hat / outfit. A keeper may also pick a cosmetic look
// at hatch time; that choice lives in this browser only and never touches the chain.

export type Tone =
  | "pink"
  | "mint"
  | "yellow"
  | "peach"
  | "sky"
  | "lilac"
  | "coral"
  | "lime"
  | "teal"
  | "berry"
  | "cream"
  | "midnight";

export type Mood = "happy" | "flat" | "sad" | "asleep" | "ghost";

export type Look = { tone: Tone; eyes: number; hat: number; outfit: number };

/** light / base / dark body gradient per tone. */
export const PALETTE: Record<Tone | "ghost", [string, string, string]> = {
  pink: ["#FFD0E3", "#FF85B5", "#E2508E"],
  mint: ["#D8FBE8", "#7FE0AE", "#3FB97C"],
  yellow: ["#FFF4C2", "#FFD25E", "#E6A92A"],
  peach: ["#FFE2D1", "#FFA77A", "#E8774A"],
  sky: ["#DDF0FF", "#7CC4FF", "#3A8FE0"],
  lilac: ["#EEE4FF", "#B79CFF", "#8565E0"],
  coral: ["#FFD9D6", "#FF7A70", "#DE4E45"],
  lime: ["#EFFBCF", "#BCE65A", "#86B52A"],
  teal: ["#D4F6F2", "#4FD1C1", "#1F9E90"],
  berry: ["#FBD3EC", "#D45AA8", "#A23380"],
  cream: ["#FFF8EC", "#F2DDB8", "#CDAE7C"],
  midnight: ["#D9DDF5", "#5F6BC2", "#3A438F"],
  ghost: ["#F4EEFA", "#D9CDEB", "#B3A3CF"],
};

/** Swatch colour + soft tile background per tone (hatch picker, avatars). */
export const TONE_TILE: Record<Tone, [string, string]> = {
  pink: ["#FF85B5", "#FFE3EE"],
  mint: ["#7FE0AE", "#DDF5E6"],
  yellow: ["#FFD25E", "#FFF3CC"],
  peach: ["#FFA77A", "#FFEADF"],
  sky: ["#7CC4FF", "#E2F2FF"],
  lilac: ["#B79CFF", "#F0E9FF"],
  coral: ["#FF7A70", "#FFE3E0"],
  lime: ["#BCE65A", "#F2FAD9"],
  teal: ["#4FD1C1", "#DCF7F3"],
  berry: ["#D45AA8", "#FBE0F1"],
  cream: ["#F2DDB8", "#FFF8EC"],
  midnight: ["#5F6BC2", "#E3E6F7"],
};

export const TONES = Object.keys(TONE_TILE) as Tone[];

export const LOOK_NAMES = {
  eyes: ["Classic", "Stars", "Hearts", "Sparkly", "Wink", "Sleepy", "Cat", "Dots", "Anime", "Dizzy", "Glasses"],
  hat: ["None", "Beanie", "Party", "Crown", "Top hat", "Flowers", "Cap", "Bow", "Witch", "Cat ears", "Halo"],
  outfit: ["None", "Scarf", "Bow tie", "Bandana", "Overalls", "Hoodie", "Pearls", "Medal", "Sweater", "Tie", "Lei"],
} as const;

export const NATURES = ["Curious", "Poetic", "Funny", "Gentle", "Night owl", "Brainy", "Chatty", "Calm"];

// The contract's 8 temperaments (traits[0]) mapped to the 8 tones that read closest to
// the on-chain palettes in lib/live.ts (rose, amber, periwinkle, olive, violet, steel,
// acid lime, slate).
const TEMPERAMENT_TONE: Tone[] = ["pink", "yellow", "sky", "lime", "lilac", "teal", "mint", "midnight"];

/** The look a Mind gets from its on-chain trait dials alone. */
export function lookFromTraits(traits: number[]): Look {
  const t = (i: number) => traits[i] ?? 0;
  return {
    tone: TEMPERAMENT_TONE[t(0) % TEMPERAMENT_TONE.length],
    eyes: t(4) % 8, // 8 eye dials -> the first 8 glossy eyes
    hat: t(5) % 11, // 10 accessories + none
    outfit: t(6) % 4, // 4 patterns -> none / scarf / bow tie / bandana
  };
}
