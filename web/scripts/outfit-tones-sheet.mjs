// Every outfit and hat on every body colour, to spot a part that vanishes into a tone.
//   node web/scripts/outfit-tones-sheet.mjs <out.html>
import { writeFileSync } from "node:fs";
import { BODY, hats, onTone, outfits } from "../lib/game/glossyParts.ts";
import { LOOK_NAMES, PALETTE } from "../lib/game/look.ts";

const TONES = Object.keys(PALETTE).filter((t) => t !== "ghost");
const paths = (list) => list.map((z) => `<path d="${z.d}" fill="${z.f}" stroke="${z.s}" stroke-width="${z.w}" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
const mind = (tone, inner, id) => {
  const [l, b, d] = PALETTE[tone];
  return `<svg viewBox="-20 -30 240 250"><defs><clipPath id="c${id}"><path d="${BODY}"/></clipPath><radialGradient id="g${id}" cx="38%" cy="30%" r="75%"><stop offset="0%" stop-color="${l}"/><stop offset="55%" stop-color="${b}"/><stop offset="100%" stop-color="${d}"/></radialGradient></defs>
<ellipse cx="72" cy="186" rx="20" ry="12" fill="${d}"/><ellipse cx="128" cy="186" rx="20" ry="12" fill="${d}"/>
<path d="${BODY}" fill="url(#g${id})"/><ellipse cx="76" cy="112" rx="13" ry="14" fill="#2A1B2C"/><ellipse cx="124" cy="112" rx="13" ry="14" fill="#2A1B2C"/>${inner(id)}</svg>`;
};
let n = 0;
const grid = (title, names, draw) =>
  `<h2>${title}</h2><table><tr><th></th>${TONES.map((t) => `<th>${t}</th>`).join("")}</tr>` +
  names.map((name, i) => (i === 0 ? "" : `<tr><th>${name}</th>${TONES.map((t) => `<td>${mind(t, (id) => draw(i, id, TONES.indexOf(t)), n++)}</td>`).join("")}</tr>`)).join("") +
  `</table>`;
writeFileSync(
  process.argv[2],
  `<!doctype html><meta charset=utf-8><style>body{font:11px system-ui;margin:6px;background:#fff}table{border-collapse:collapse}th{font-weight:600;padding:2px 4px}td{padding:0}svg{width:64px;height:66px;display:block}</style>` +
    grid("Outfits × tones", LOOK_NAMES.outfit, (i, id, t) => `<g clip-path="url(#c${id})">${paths(onTone(outfits(i), t))}</g>`) +
    grid("Hats × tones", LOOK_NAMES.hat, (i, id, t) => paths(onTone(hats(i), t)))
);
console.log("written", process.argv[2]);
