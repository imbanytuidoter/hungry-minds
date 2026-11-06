// The glossy Mind character, ported 1:1 from the design handoff (GlossyMind.dc.html):
// body gradient per tone, 11 eyes, 11 hats, 11 outfits, and the five moods.

import { useId } from "react";
import { PALETTE, TONES, type Mood, type Tone } from "@/lib/game/look";
import { BODY, D, eyes, hats, onTone, outfits, type Shape } from "@/lib/game/glossyParts";

const Shapes = ({ list }: { list: Shape[] }) => (
  <>
    {list.map((z, i) => (
      <path key={i} d={z.d} fill={z.f} stroke={z.s} strokeWidth={z.w} strokeLinecap="round" strokeLinejoin="round" />
    ))}
  </>
);

export type GlossyProps = {
  mood?: Mood;
  tone?: Tone;
  antenna?: boolean;
  sprout?: boolean;
  eyes?: number;
  hat?: number;
  outfit?: number;
};

export default function GlossyMind({ mood = "happy", tone = "pink", antenna = true, sprout = false, eyes: e = 0, hat = 0, outfit = 0 }: GlossyProps) {
  const gid = "gm" + useId().replace(/[^a-zA-Z0-9]/g, "");
  // Spread the blinks so a row of Minds never blinks in unison.
  const blink = { animationDelay: `${-((gid.length * 7 + gid.charCodeAt(gid.length - 1) * 13) % 55) / 10}s` };
  const [c1, c2, c3] = mood === "ghost" ? PALETTE.ghost : PALETTE[tone] ?? PALETTE.pink;
  const awake = mood === "happy" || mood === "flat" || mood === "sad";
  const on = (b: boolean) => (b ? 1 : 0);
  const eyeShapes = awake ? eyes(e | 0) : [];

  return (
    <svg viewBox="0 0 200 210" style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }} aria-hidden="true">
      <defs>
        <clipPath id={`${gid}c`}>
          <path d={BODY} />
        </clipPath>
        <radialGradient id={`${gid}b`} cx="38%" cy="30%" r="75%">
          <stop offset="0%" stopColor={c1} />
          <stop offset="55%" stopColor={c2} />
          <stop offset="100%" stopColor={c3} />
        </radialGradient>
        <radialGradient id={`${gid}f`} cx="40%" cy="30%" r="80%">
          <stop offset="0%" stopColor={c2} />
          <stop offset="100%" stopColor={c3} />
        </radialGradient>
        <radialGradient id={`${gid}s`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#3A2A1A" stopOpacity=".28" />
          <stop offset="100%" stopColor="#3A2A1A" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${gid}a`} cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#FFE3EE" />
          <stop offset="100%" stopColor={c2} />
        </radialGradient>
        <linearGradient id={`${gid}sp`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#F3E6EE" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="198" rx="62" ry="10" fill={`url(#${gid}s)`} />
      <g opacity={mood === "ghost" ? 0.7 : 1}>
        <g opacity={on(antenna && !sprout && !(hat > 0))}>
          <path d="M100 40 C 98 26, 104 16, 114 14" fill="none" stroke="#3A2436" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="116" cy="13" r="7" fill={`url(#${gid}a)`} stroke="#3A2436" strokeWidth="2.5" />
          <circle cx="114" cy="11" r="2" fill="#FFFFFF" opacity=".9" />
        </g>
        <g opacity={on(sprout && !(hat > 0))}>
          <path d="M98 44 C 70 20, 58 6, 72 2 C 90 0, 98 26, 100 42 Z" fill={`url(#${gid}sp)`} />
          <path d="M102 44 C 130 20, 142 6, 128 2 C 110 0, 102 26, 100 42 Z" fill={`url(#${gid}sp)`} />
          <path d="M100 44 C 96 26, 98 14, 100 8 C 102 14, 104 26, 100 44 Z" fill="#FFFFFF" />
        </g>
        <ellipse cx="30" cy="132" rx="15" ry="11" fill={`url(#${gid}f)`} transform="rotate(-30 30 132)" />
        <g className="gm-wave">
          <ellipse cx="172" cy="130" rx="15" ry="11" fill={`url(#${gid}f)`} transform="rotate(30 172 130)" />
        </g>
        <ellipse cx="72" cy="186" rx="20" ry="12" fill={`url(#${gid}f)`} />
        <ellipse cx="128" cy="186" rx="20" ry="12" fill={`url(#${gid}f)`} />
        <path d={BODY} fill={`url(#${gid}b)`} />
        <ellipse cx="68" cy="70" rx="24" ry="13" fill="#FFFFFF" opacity=".55" transform="rotate(-28 68 70)" />
        <ellipse cx="56" cy="92" rx="5" ry="4" fill="#FFFFFF" opacity=".5" />
        <path d="M150 70 l3 -8 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 z" fill="#FFFFFF" opacity=".75" />
        <path d="M40 150 C 60 176, 140 176, 160 150" fill="none" stroke="#FFFFFF" strokeOpacity=".18" strokeWidth="6" strokeLinecap="round" />
      </g>
      <g clipPath={`url(#${gid}c)`}>
        <Shapes list={mood === "ghost" ? outfits(outfit | 0) : onTone(outfits(outfit | 0), TONES.indexOf(tone))} />
      </g>
      <g opacity={on(awake && !((e | 0) > 0))} className="gm-blink" style={blink}>
        <g className="gm-look">
          <ellipse cx="76" cy="112" rx="13" ry="14" fill={D} />
          <ellipse cx="124" cy="112" rx="13" ry="14" fill={D} />
          <circle cx="80" cy="106" r="5" fill="#FFFFFF" />
          <circle cx="128" cy="106" r="5" fill="#FFFFFF" />
          <circle cx="72" cy="117" r="2" fill="#FFFFFF" opacity=".7" />
          <circle cx="120" cy="117" r="2" fill="#FFFFFF" opacity=".7" />
        </g>
      </g>
      <g opacity={on(mood === "asleep")} fill="none" stroke={D} strokeWidth="4" strokeLinecap="round">
        <path d="M64 112 Q 76 121 88 112" />
        <path d="M112 112 Q 124 121 136 112" />
      </g>
      <g opacity={on(mood === "ghost")}>
        <ellipse cx="76" cy="112" rx="11" ry="12" fill="none" stroke="#8E7FA8" strokeWidth="3" strokeDasharray="4 4" />
        <ellipse cx="124" cy="112" rx="11" ry="12" fill="none" stroke="#8E7FA8" strokeWidth="3" strokeDasharray="4 4" />
      </g>
      <g opacity={on(mood === "happy" || mood === "asleep")}>
        <ellipse cx="58" cy="134" rx="12" ry="7" fill="#FF5C93" opacity=".45" />
        <ellipse cx="142" cy="134" rx="12" ry="7" fill="#FF5C93" opacity=".45" />
      </g>
      <g fill="none" stroke={D} strokeWidth="4" strokeLinecap="round">
        <path opacity={on(mood === "happy")} d="M88 136 Q 100 148 112 136" />
        <path opacity={on(mood === "flat" || mood === "asleep")} d="M90 140 L 110 140" />
        <path opacity={on(mood === "sad")} d="M88 144 Q 100 134 112 144" />
      </g>
      <g className="gm-blink" style={blink}>
        <g className="gm-look">
          <Shapes list={eyeShapes} />
        </g>
      </g>
      <g>
        <Shapes list={mood === "ghost" ? hats(hat | 0) : onTone(hats(hat | 0), TONES.indexOf(tone))} />
      </g>
    </svg>
  );
}
