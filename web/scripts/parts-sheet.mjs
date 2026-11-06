// Contact sheet of every eye / hat / outfit on the glossy body, with the body's outline
// drawn on top in cyan so a part that overhangs or falls short of the contour is obvious.
//   node web/scripts/parts-sheet.mjs <out.html>
import { writeFileSync } from "node:fs";
import { BODY, eyes, hats, outfits } from "../lib/game/glossyParts.ts";

const NAMES = {
  eyes: ["Classic", "Stars", "Hearts", "Sparkly", "Wink", "Sleepy", "Cat", "Dots", "Anime", "Dizzy", "Glasses"],
  hat: ["None", "Beanie", "Party", "Crown", "Top hat", "Flowers", "Cap", "Bow", "Witch", "Cat ears", "Halo"],
  outfit: ["None", "Scarf", "Bow tie", "Bandana", "Overalls", "Hoodie", "Pearls", "Medal", "Sweater", "Tie", "Lei"],
};
const paths = (list) => list.map((z) => `<path d="${z.d}" fill="${z.f}" stroke="${z.s}" stroke-width="${z.w}" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
const body = (inner, outline) => `<svg viewBox="-20 -30 240 250" width="230" height="240">
<defs><clipPath id="c"><path d="${BODY}"/></clipPath><radialGradient id="b" cx="38%" cy="30%" r="75%"><stop offset="0%" stop-color="#DDF0FF"/><stop offset="55%" stop-color="#7CC4FF"/><stop offset="100%" stop-color="#3A8FE0"/></radialGradient></defs>
<rect x="-20" y="-30" width="240" height="250" fill="#f6f6f6"/>
<ellipse cx="30" cy="132" rx="15" ry="11" fill="#3A8FE0" transform="rotate(-30 30 132)"/><ellipse cx="172" cy="130" rx="15" ry="11" fill="#3A8FE0" transform="rotate(30 172 130)"/>
<ellipse cx="72" cy="186" rx="20" ry="12" fill="#3A8FE0"/><ellipse cx="128" cy="186" rx="20" ry="12" fill="#3A8FE0"/>
<path d="${BODY}" fill="url(#b)"/>${inner}
${outline ? `<path d="${BODY}" fill="none" stroke="#00e5ff" stroke-width="1" stroke-dasharray="3 2"/>` : ""}
</svg>`;
const openEyes = `<ellipse cx="76" cy="112" rx="13" ry="14" fill="#2A1B2C"/><ellipse cx="124" cy="112" rx="13" ry="14" fill="#2A1B2C"/>`;
const smile = `<path d="M88 136 Q 100 148 112 136" fill="none" stroke="#2A1B2C" stroke-width="4" stroke-linecap="round"/>`;
const row = (title, kind, fn, withFace) =>
  `<h2>${title}</h2><div class=row>` +
  Array.from({ length: 11 }, (_, i) => `<figure>${body((withFace ? (kind === "eyes" && i ? "" : openEyes) + smile : "") + (kind === "outfit" ? `<g clip-path="url(#c)">${paths(fn(i))}</g>` : paths(fn(i))), true)}<figcaption>${i} · ${NAMES[kind][i]}</figcaption></figure>`).join("") +
  `</div>`;
writeFileSync(
  process.argv[2],
  `<!doctype html><meta charset=utf-8><style>body{font:12px system-ui;margin:8px;background:#fff}.row{display:grid;grid-template-columns:repeat(var(--cols,6),1fr);gap:4px}figure{margin:0;text-align:center}svg{width:100%;height:auto}h2{margin:6px 0 2px;font-size:14px}</style>` +
    row("Outfits", "outfit", outfits, true) +
    row("Hats", "hat", hats, true) +
    row("Eyes", "eyes", eyes, true)
);
console.log("wrote", process.argv[2]);
