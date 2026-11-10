// The Mind from the logo, drawn flat in SVG so it can move: cream body, sprout on top, blush, dot eyes.
import { useId } from "react";

const TINTS = {
  cream: ["#FFF8EE", "#F6E3CF", "#E9C9AE"],
  pink: ["#FFE9F1", "#FBC9DB", "#EFA3C0"],
  mint: ["#F0FFF7", "#CDEFDD", "#A6DCC0"],
};

export default function Sprout({ tint = "cream", wink = false }: { tint?: keyof typeof TINTS; wink?: boolean }) {
  const id = "sp" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [c1, c2, c3] = TINTS[tint];
  return (
    <svg viewBox="0 0 200 210" style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }} aria-hidden>
      <defs>
        <radialGradient id={id} cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor={c1} />
          <stop offset="60%" stopColor={c2} />
          <stop offset="100%" stopColor={c3} />
        </radialGradient>
      </defs>
      {/* sprout */}
      <path d="M100 62 C 100 48, 101 38, 103 28" fill="none" stroke="#4E9A52" strokeWidth="6" strokeLinecap="round" />
      <path d="M103 30 C 86 14, 64 18, 60 30 C 74 40, 92 40, 103 30 Z" fill="#7BC46A" />
      <path d="M103 30 C 118 12, 142 14, 146 28 C 132 40, 114 40, 103 30 Z" fill="#5FA556" />
      {/* body */}
      <ellipse cx="100" cy="196" rx="62" ry="10" fill="rgba(0,0,0,.18)" />
      <path d="M100 58 C 156 58, 184 100, 180 142 C 176 182, 140 196, 100 196 C 60 196, 24 182, 20 142 C 16 100, 44 58, 100 58 Z" fill={`url(#${id})`} />
      <ellipse cx="70" cy="92" rx="22" ry="12" fill="#fff" opacity=".55" transform="rotate(-24 70 92)" />
      {/* face */}
      <ellipse cx="56" cy="142" rx="15" ry="9" fill="#FF8DB5" opacity=".55" />
      <ellipse cx="144" cy="142" rx="15" ry="9" fill="#FF8DB5" opacity=".55" />
      <ellipse cx="74" cy="124" rx="11" ry="14" fill="#3A2436" />
      <circle cx="78" cy="118" r="4" fill="#fff" />
      {wink ? (
        <path d="M114 126 Q 126 116 138 126" fill="none" stroke="#3A2436" strokeWidth="6" strokeLinecap="round" />
      ) : (
        <>
          <ellipse cx="126" cy="124" rx="11" ry="14" fill="#3A2436" />
          <circle cx="130" cy="118" r="4" fill="#fff" />
        </>
      )}
      <path d="M90 150 Q 100 162 110 150" fill="none" stroke="#3A2436" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
