// The glossy Mind's eyes, hats and outfits — the ONE source of truth for their shapes.
// The site draws them (components/game/GlossyMind.tsx) and web/scripts/gen-glossy-rs.mjs
// generates contract/src/glossy_parts.rs from this file, so a wallet's NFT image matches.
// Body: x 26..174, y 38..186 (viewBox 0 0 200 210); eyes centred at x 76/124, y 112.

export type Shape = { d: string; f: string; s: string; w: number };
const F = (d: string, f?: string, s?: string, w?: number): Shape => ({ d, f: f || "none", s: s || "none", w: w || 0 });
const C = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const El = (cx: number, cy: number, rx: number, ry: number) => `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;

export const D = "#2A1B2C";
const W = "#FFFFFF";

// The body outline. Outfits are drawn clipped to it, so a garment that wraps the body is
// simply drawn wider than the body and its edges land exactly on the silhouette.
export const BODY = "M100 38 C 148 38, 174 76, 174 120 C 174 162, 144 186, 100 186 C 56 186, 26 162, 26 120 C 26 76, 52 38, 100 38 Z";

type Pt = [number, number];
const r1 = (v: number) => Math.round(v * 10) / 10;
const pt = ([x, y]: Pt) => `${r1(x)} ${r1(y)}`;
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// Left half of the head's top: (26,120) up to the crown (100,38); the right half is its mirror.
const HEAD: Pt[] = [[26, 120], [26, 76], [52, 38], [100, 38]];
const bez = (p: Pt[], t: number): Pt => {
  const a = lerp(p[0], p[1], t), b = lerp(p[1], p[2], t), c = lerp(p[2], p[3], t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
};
// Parameter at which the left head curve reaches height y (y falls monotonically along it).
const headT = (y: number) => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bez(HEAD, m)[1] > y) lo = m;
    else hi = m;
  }
  return lo;
};
/** Half-width of the head at height y (y between 38 and 120). */
const half = (y: number) => 100 - bez(HEAD, headT(y))[0];
// Right half of the body's bottom: (174,120) down to (100,186); the left half is its mirror.
const LOW: Pt[] = [[174, 120], [174, 162], [144, 186], [100, 186]];
/** Half-width of the body at height y (y between 120 and 186). */
const lowHalf = (y: number) => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bez(LOW, m)[1] < y) lo = m;
    else hi = m;
  }
  return bez(LOW, lo)[0] - 100;
};
/**
 * The head's own outline from the left side at height y, over the crown, to the right side,
 * grown by g about the body's centre — the exact shape of a cap pulled over the head.
 */
const crown = (y: number, g: number) => {
  const t = headT(y);
  // de Casteljau: the part of HEAD from t to 1.
  const [p0, p1, p2, p3] = HEAD;
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const ab = lerp(a, b, t), bc = lerp(b, c, t);
  const L: Pt[] = [lerp(ab, bc, t), bc, c, p3];
  const R: Pt[] = [...L].reverse().map(([x, yy]) => [200 - x, yy]);
  const grow = ([x, yy]: Pt): Pt => [100 + (x - 100) * g, 120 + (yy - 120) * g];
  const [l0, l1, l2, l3] = L.map(grow), [, q1, q2, q3] = R.map(grow);
  return { d: `M${pt(l0)} C${pt(l1)} ${pt(l2)} ${pt(l3)} C${pt(q1)} ${pt(q2)} ${pt(q3)}`, l: l0, r: q3 };
};
/** A band across the head between heights y1 and y2, bowed down by `dip`, `out` wider than the head. */
const band = (y1: number, y2: number, dip: number, out: number) => {
  const a = half(y1) + out, b = half(y2) + out;
  return `M${pt([100 - a, y1])} Q100 ${r1(y1 + dip)} ${pt([100 + a, y1])} L${pt([100 + b, y2])} Q100 ${r1(y2 + dip)} ${pt([100 - b, y2])}Z`;
};

export function eyes(n: number): Shape[] {
  const X = [76, 124];
  const y = 112;
  const both = (fn: (cx: number) => Shape[]) => X.flatMap(fn);
  const star = (cx: number, r: number) => {
    let p = "";
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.45 : r;
      p += (i ? "L" : "M") + (cx + Math.cos(a) * rr).toFixed(1) + " " + (y + Math.sin(a) * rr).toFixed(1);
    }
    return p + "Z";
  };
  const V: (Shape[] | null)[] = [
    null,
    both((cx) => [F(star(cx, 15), D), F(C(cx - 3, y - 4, 2.5), W)]),
    both((cx) => [F(`M${cx} ${y + 12} C${cx - 18} ${y}, ${cx - 12} ${y - 14}, ${cx} ${y - 5} C${cx + 12} ${y - 14}, ${cx + 18} ${y}, ${cx} ${y + 12}Z`, "#E2508E"), F(C(cx - 5, y - 4, 2.5), W)]),
    both((cx) => [F(El(cx, y, 15, 16), D), F(C(cx - 5, y - 6, 5), W), F(C(cx + 5, y + 6, 2.5), W)]),
    [F("M64 114 Q76 103 88 114", "none", D, 4), F(El(124, y, 13, 14), D), F(C(120, y - 5, 4), W)],
    both((cx) => [F(`M${cx - 13} ${y - 2} a13 13 0 0 0 26 0Z`, D), F(`M${cx - 15} ${y - 3} h30`, "none", D, 4)]),
    both((cx) => [F(El(cx, y, 12, 14), "#FFD25E", D, 2.5), F(`M${cx} ${y - 11} Q${cx + 4} ${y} ${cx} ${y + 11} Q${cx - 4} ${y} ${cx} ${y - 11}Z`, D)]),
    both((cx) => [F(C(cx, y + 2, 6), D), F(C(cx - 2, y, 1.8), W)]),
    both((cx) => [F(El(cx, y, 12, 18), D), F(El(cx, y + 8, 9, 8), "#7A55C8"), F(El(cx - 4, y - 7, 5, 7), W), F(C(cx + 5, y + 9, 2), W)]),
    both((cx) => [F(`M${cx} ${y} m-2 0 a2 2 0 1 1 4 0 a5 5 0 1 1 -9 0 a8 8 0 1 1 15 0 a11 11 0 1 1 -21 0`, "none", D, 3)]),
    [
      ...both((cx) => [F(C(cx, y, 17), "rgba(255,255,255,.35)", D, 3.5), F(C(cx, y + 1, 6), D), F(C(cx - 2, y - 1, 2), W)]),
      F("M93 110 Q100 105 107 110", "none", D, 3.5),
      // temples run back to the sides of the head
      F("M59 108 L29 103 M141 108 L171 103", "none", D, 3.5),
    ],
  ];
  return V[n] || [];
}

// x where a quadratic curve (monotonic in y) reaches height y.
const quadX = (p0: Pt, p1: Pt, p2: Pt, y: number) => {
  const at = (t: number): Pt => lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
  const up = p0[1] > p2[1];
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (at(m)[1] > y === up) lo = m;
    else hi = m;
  }
  return at(lo)[0];
};

export function hats(n: number): Shape[] {
  // Beanie: the head's own outline grown 2 %, with the cuff hugging the sides.
  const beanie = crown(72, 1.02);
  // Cap: same idea, cut a little lower; the visor sticks out to the right like a real cap.
  const cap = crown(70, 1.03);
  // Party cone: base corners sit on the head; stripes are cut exactly to the cone's sides.
  const cone = (y: number) => (36 * (y + 12)) / 62;
  const stripe = (y1: number, y2: number) => `M${pt([100 - cone(y1), y1])} L${pt([100 + cone(y1), y1])} L${pt([100 + cone(y2), y2])} L${pt([100 - cone(y2), y2])}Z`;
  // Witch hat: the cone is wide enough at the base to cover the top of the head, and the band
  // follows the curved cone exactly.
  const wl: Pt[] = [[48, 60], [74, 30], [110, -16]];
  const wr: Pt[] = [[110, -16], [124, 22], [152, 60]];
  const wBand = (y1: number, y2: number) =>
    `M${pt([quadX(wl[0], wl[1], wl[2], y2), y2])} L${pt([quadX(wl[0], wl[1], wl[2], y1), y1])} L${pt([quadX(wr[0], wr[1], wr[2], y1), y1])} L${pt([quadX(wr[0], wr[1], wr[2], y2), y2])}Z`;
  const V: (Shape[] | null)[] = [
    null,
    [
      F(beanie.d + "Z", "#7FB8FF"),
      F("M78 66 Q82 52 88 42 M100 64 V38 M122 66 Q118 52 112 42", "none", "#5E9BE8", 3),
      F(band(64, 80, 10, 4), W, "#E8F1FF", 1.5),
      F(C(100, 30, 10), W),
    ],
    [F(`M64 50 L100 -12 L136 50 Q100 60 64 50Z`, "#FFD84D", "#E6A92A", 2), F(stripe(30, 36), "#FF6FA3"), F(stripe(8, 14), "#FF6FA3"), F(C(100, -14, 8), "#FF6FA3")],
    [
      F("M60 54 L62 16 L82 36 L100 8 L118 36 L138 16 L140 54 Q100 64 60 54Z", "#FFD25E", "#E6A92A", 2.5),
      F(C(100, 48, 5), "#FF5C93"),
      F(C(79, 46, 4), "#7FE0AE"),
      F(C(121, 46, 4), "#7FB8FF"),
    ],
    // Top hat: the brim sits where the head is as wide as the crown, so the head hides under it.
    [F("M68 -12 H132 V50 Q100 60 68 50Z", D), F("M68 26 H132 V36 H68Z", "#FF6FA3"), F("M46 45 Q100 59 154 45", "none", D, 10)],
    [
      F("M46 60 Q100 20 154 60", "none", "#3FB97C", 5),
      // colours mirror about the middle, so the wreath never looks lopsided
      ...([[49, 59, "#FF85B5"], [72, 45.4, "#FFD84D"], [100, 40, W], [128, 45.4, "#FFD84D"], [151, 59, "#FF85B5"]] as [number, number, string][]).flatMap(([x, y, c]) => [F(C(x, y, 9), c), F(C(x, y, 3.5), "#E6A92A")]),
    ],
    [
      // the crown's lower corners round back onto the head instead of poking past it
      F(`${cap.d} Q163.6 71.6 160 72 Q100 78.5 40 72 Q36.4 71.6 ${pt(cap.l)}Z`, "#FF6FA3"),
      // the visor grows out of the crown's edge (its root lies inside the crown, so no gap shows)
      // and ends in a rounded bill past the right side of the head
      F("M104 72.5 Q133 72 162 65.5 Q180 62 187 70 Q184 83 158 86 Q124 88 104 74Z", "#E2508E"),
      F("M100 36 V74", "none", "#E2508E", 2.5),
      F(C(100, 34, 5), "#E2508E"),
    ],
    [F("M100 40 L70 22 L72 58Z", "#FF5C93"), F("M100 40 L130 22 L128 58Z", "#FF5C93"), F(C(100, 40, 8), "#E2508E")],
    [
      F("M26 60 Q100 40 174 60 Q100 80 26 60Z", "#4A2E6B"),
      F("M48 60 Q74 30 110 -16 Q124 22 152 60 Q100 72 48 60Z", "#5B3A80"),
      F(wBand(44, 52), "#FFD84D"),
    ],
    // Cat ears: each base follows the head's own arc, so the ears grow out of the outline
    // instead of lying across the forehead.
    [
      F("M45.4 62 L56 18 L88 38.8 Q63.3 44 45.4 62Z", "#FF85B5"),
      F("M154.6 62 L144 18 L112 38.8 Q136.7 44 154.6 62Z", "#FF85B5"),
      F("M53 52 L58 28 L78 40Z", "#FFD0E3"),
      F("M147 52 L142 28 L122 40Z", "#FFD0E3"),
    ],
    [F(El(100, 14, 40, 10), "none", "#FFD84D", 6), F(El(100, 14, 40, 10), "none", "rgba(255,255,255,.6)", 2)],
  ];
  return V[n] || [];
}

/**
 * A hat or outfit colour too close to the body's own colour would vanish into it (a pink scarf
 * on a pink Mind). Such a colour is drawn in the tone's contrast colour instead. The same rule,
 * with the same numbers, is in contract/src/glossy.rs `contrast`, so the NFT matches the game.
 * Tones are in look.ts TONES order: pink, mint, yellow, peach, sky, lilac, coral, lime, teal,
 * berry, cream, midnight.
 */
export const TONE_BASE = ["#FF85B5", "#7FE0AE", "#FFD25E", "#FFA77A", "#7CC4FF", "#B79CFF", "#FF7A70", "#BCE65A", "#4FD1C1", "#D45AA8", "#F2DDB8", "#5F6BC2"];
export const TONE_DARK = ["#E2508E", "#3FB97C", "#E6A92A", "#E8774A", "#3A8FE0", "#8565E0", "#DE4E45", "#86B52A", "#1F9E90", "#A23380", "#CDAE7C", "#3A438F"];
export const TONE_CONTRAST = ["#3D5BA9", "#7A55C8", "#E2508E", "#3D5BA9", "#E2508E", "#F2A93B", "#3D5BA9", "#7A55C8", "#E2508E", "#FFD84D", "#E2508E", "#FFD84D"];
/** A part whose main colour is closer than this (straight RGB distance) to the body's base or
 *  dark colour would vanish into it; it is then recoloured, every one of its shades closer
 *  than SHADE_DISTANCE together, so it never comes out half one colour and half another. */
export const CLASH_DISTANCE = 50;
export const SHADE_DISTANCE = 75;
const HEX = /^#[0-9a-fA-F]{6}$/;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a: string, b: string) => {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
};
const toBody = (tone: number, c: string) => Math.min(dist(c, TONE_BASE[tone]), dist(c, TONE_DARK[tone]));
/** `colour` on this tone, given whether its part clashes. */
export function contrast(tone: number, colour: string, clashing = true): string {
  if (!clashing || !HEX.test(colour) || tone < 0 || tone >= TONE_BASE.length) return colour;
  return toBody(tone, colour) < SHADE_DISTANCE ? TONE_CONTRAST[tone] : colour;
}
/** Does this part's main colour (its first coloured shape) vanish into the tone? */
export function clashes(list: Shape[], tone: number): boolean {
  if (tone < 0 || tone >= TONE_BASE.length) return false;
  const main = list.map((z) => (HEX.test(z.f) ? z.f : z.s)).find((c) => HEX.test(c));
  return !!main && toBody(tone, main) < CLASH_DISTANCE;
}
/** A hat's or outfit's shapes recoloured for a tone (eyes are left as they are). */
export const onTone = (list: Shape[], tone: number): Shape[] => {
  const c = clashes(list, tone);
  return c ? list.map((z) => ({ ...z, f: contrast(tone, z.f), s: contrast(tone, z.s) })) : list;
};

/**
 * Outfits are drawn clipped to BODY (see GlossyMind.tsx and contract/src/glossy.rs): whatever
 * wraps around the body is drawn past its sides, and the clip trims it to the silhouette.
 */
export function outfits(n: number): Shape[] {
  // A necklace from one side of the body to the other, sagging across the chest. The end beads
  // sit just inside the silhouette (the clip would otherwise cut them into slivers at the sides).
  const arc = (k: number, r: number, cols: string[]) => {
    const reach = lowHalf(146) - r - 1;
    return Array.from({ length: k }, (_, i) => {
      const t = i / (k - 1);
      // colours mirror about the middle bead, so both ends of the string match
      return F(C(r1(100 - reach + t * 2 * reach), r1(146 + Math.sin(t * Math.PI) * 24), r), cols[Math.min(i, k - 1 - i) % cols.length], "rgba(0,0,0,.08)", 1);
    });
  };
  const V: (Shape[] | null)[] = [
    null,
    // Scarf: a knitted band round the neck (shade along its lower edge, a light rim on top),
    // tied at the front: a round knot and two separate tails with fringed ends.
    [
      F("M10 136 Q100 168 190 136 L190 152 Q100 184 10 152Z", "#FF6FA3"),
      F("M10 150 Q100 182 190 150", "none", "#E2508E", 4),
      F("M10 138 Q100 170 190 138", "none", "rgba(255,255,255,.35)", 2),
      F("M112 163 Q106 174 103 185 L116 186 Q118 175 121 165Z", "#E2508E"),
      F("M122 164 Q130 172 136 182 L147 175 Q140 166 129 160Z", "#FF6FA3", "#E2508E", 1.5),
      F("M105 182 l-1 4 M109 183 l0 4 M113 183 l1 4 M137 180 l-1 4 M141 178 l0 4 M145 175 l1 4", "none", "#E2508E", 1.6),
      F(El(120, 162, 9, 7), "#FF6FA3", "#E2508E", 2),
      F("M115 160 q5 -3 10 0", "none", "rgba(255,255,255,.4)", 1.6),
    ],
    [F("M100 162 L78 150 L78 174Z", D), F("M100 162 L122 150 L122 174Z", D), F(C(100, 162, 5), "#4A2E44")],
    [
      F("M10 136 Q100 170 190 136 L190 146 Q140 160 100 180 Q60 160 10 146Z", "#E2508E"),
      F(C(100, 165, 3), W),
      F(C(86, 158, 2.5), W),
      F(C(114, 158, 2.5), W),
      F(C(100, 174, 2.5), W),
    ],
    [
      // Overalls: the bib's top and the pocket seam bow down with the body like the waist does,
      // and the straps sag round the body and leave it above the arms, over the shoulders.
      F("M10 164 Q100 184 190 164 V200 H10Z", "#3F6AD8"),
      F("M76 182 V152 Q100 156 124 152 V182Z", "#3F6AD8"),
      F("M80 154 Q52 150 27 122 M120 154 Q148 150 173 122", "none", "#3F6AD8", 6),
      F("M88 161 Q100 163 112 161", "none", "#2F55B8", 2.5),
      F(C(80, 156, 3.5), "#FFD84D"),
      F(C(120, 156, 3.5), "#FFD84D"),
    ],
    [
      F("M10 140 Q100 178 190 140 V200 H10Z", "#A78BFA"),
      F("M10 138 Q100 176 190 138", "none", "#C4B2FF", 7),
      // the kangaroo pocket sits on the tummy, inside the outline; the strings hang from the collar
      F("M76 168 Q100 165 124 168 L127 180 Q100 184 73 180Z", "#9273EE"),
      F("M91 158 l-1 9 M109 158 l1 9", "none", W, 3),
    ],
    arc(15, 5, [W, "#FFF4E8"]),
    [F("M28 138 Q64 160 96 168 M172 138 Q136 160 104 168", "none", "#3F6AD8", 6), F(C(100, 173, 10), "#FFD25E", "#E6A92A", 2.5), F(C(100, 173, 4), "#FFF4C2")],
    // Stripes: both stripes lie on the body, each with yellow on either side so they read on any tone.
    [F("M10 136 Q100 172 190 136 V200 H10Z", "#FFD84D"), F("M10 146 Q100 182 190 146", "none", "#FF6FA3", 5), F("M10 158 Q100 194 190 158", "none", "#FF6FA3", 5)],
    [F("M94 148 h12 l-2 9 h-8Z", "#3F6AD8"), F("M96 157 h8 l6 18 l-10 8 l-10 -8Z", "#3F6AD8"), F("M97 167 l6 -4 M96 176 l8 -5", "none", "#7FB8FF", 2.5)],
    arc(11, 8, ["#FF85B5", "#FFD84D", "#7FE0AE", "#7FB8FF"]),
  ];
  return V[n] || [];
}
