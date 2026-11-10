// Decor: moss-covered rocks and soft leaves.

import { useId } from "react";
import { Vine } from "../Greenery";

const ROCKS = {
  a: { rock: "M14 182 C 4 140, 30 92, 78 70 C 120 50, 170 46, 214 64 C 262 84, 292 128, 290 182 Z", moss: "M58 82 C 90 54, 150 44, 206 60 C 240 72, 262 92, 272 116 C 246 102, 214 100, 192 110 C 160 96, 120 98, 96 112 C 82 100, 66 96, 46 102 C 48 94, 52 88, 58 82 Z", crack: "M120 120 L 136 150 L 128 178 M210 130 L 222 160" },
  b: { rock: "M20 182 C 18 150, 40 118, 70 104 C 96 70, 140 54, 186 60 C 236 66, 280 110, 284 182 Z", moss: "M78 100 C 104 70, 146 56, 186 62 C 226 68, 258 96, 270 126 C 246 114, 222 114, 204 122 C 180 108, 150 108, 130 120 C 112 108, 96 106, 72 112 Z", crack: "M150 130 L 160 160 L 152 180" },
};

export function MossRock({ shape = "a" }: { shape?: "a" | "b" }) {
  const gid = "mr" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const P = ROCKS[shape];
  const seed = shape.charCodeAt(0);
  const dots = Array.from({ length: 22 }, (_, i) => ({ x: 70 + ((i * 47 + seed * 13) % 190), y: 70 + ((i * 29 + seed) % 34), r: 1.4 + (i % 3) * 0.6 }));
  const sprouts = Array.from({ length: 6 }, (_, i) => {
    const x = 90 + i * 30 + (seed % 7);
    const y = 76 + (i % 2) * 8;
    const h = 14 + (i % 3) * 6;
    return { d: `M${x} ${y} q 2 -${h / 2} ${i % 2 ? 4 : -4} -${h}`, lx: x + (i % 2 ? 7 : -7), ly: y - h + 2, r: i % 2 ? -30 : 30 };
  });
  return (
    <svg viewBox="0 0 300 190" style={{ width: "100%", height: "100%", display: "block", overflow: "visible", filter: "drop-shadow(0 18px 22px rgba(20,40,25,.28))" }}>
      <defs>
        <linearGradient id={`${gid}s`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#B9BFB3" />
          <stop offset="55%" stopColor="#8A938A" />
          <stop offset="100%" stopColor="#5C665E" />
        </linearGradient>
        <radialGradient id={`${gid}m`} cx="40%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#A8D88A" />
          <stop offset="50%" stopColor="#6DAF5A" />
          <stop offset="100%" stopColor="#3E7D3C" />
        </radialGradient>
      </defs>
      <path d={P.rock} fill={`url(#${gid}s)`} />
      <path d={P.rock} fill="none" stroke="#FFFFFF" strokeOpacity=".18" strokeWidth="3" transform="translate(0 2)" />
      <path d={P.crack} fill="none" stroke="#4E5850" strokeWidth="2" strokeLinecap="round" opacity=".55" />
      <path d={P.moss} fill={`url(#${gid}m)`} />
      <g fill="#C6EBA8" opacity=".9">
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} />
        ))}
      </g>
      <g stroke="#4F9447" strokeWidth="2.2" strokeLinecap="round" fill="none">
        {sprouts.map((s, i) => (
          <path key={i} d={s.d} />
        ))}
      </g>
      <g fill="#7BC46A">
        {sprouts.map((s, i) => (
          <ellipse key={i} cx={s.lx} cy={s.ly} rx="5" ry="2.6" transform={`rotate(${s.r} ${s.lx} ${s.ly})`} />
        ))}
      </g>
    </svg>
  );
}

const LEAF = { mid: ["#7DB86F", "#4E9A52", "#2F6E3A", "#A9D49A"], dark: ["#5E9C5A", "#3B7A45", "#21542D", "#86B97C"], light: ["#A7D58F", "#74B565", "#4A8A48", "#CDE8BE"] };

export function SoftLeaf({ tone = "mid" }: { tone?: keyof typeof LEAF }) {
  const gid = "sl" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [c1, c2, c3, rib] = LEAF[tone];
  return (
    <svg viewBox="0 0 220 120" style={{ width: "100%", height: "100%", display: "block", overflow: "visible", filter: "drop-shadow(0 10px 14px rgba(30,60,30,.22))" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c1} />
          <stop offset="50%" stopColor={c2} />
          <stop offset="100%" stopColor={c3} />
        </linearGradient>
        <linearGradient id={`${gid}h`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="55%" stopColor="#FFFFFF" stopOpacity=".22" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M4 62 C 50 2, 160 -6, 216 58 C 160 126, 50 120, 4 62 Z" fill={`url(#${gid})`} />
      <path d="M4 62 C 50 2, 160 -6, 216 58 C 160 40, 60 40, 4 62 Z" fill={`url(#${gid}h)`} />
      <path d="M6 62 Q 110 50 212 58" fill="none" stroke={rib} strokeWidth="2.6" strokeLinecap="round" />
      <g fill="none" stroke={rib} strokeWidth="1.4" strokeLinecap="round" opacity=".6">
        <path d="M44 58 Q 58 36 74 24" />
        <path d="M80 56 Q 96 30 114 18" />
        <path d="M118 55 Q 136 32 156 24" />
        <path d="M156 56 Q 172 42 188 38" />
        <path d="M44 62 Q 60 84 76 96" />
        <path d="M80 60 Q 98 88 116 102" />
        <path d="M118 60 Q 138 86 158 96" />
        <path d="M156 60 Q 174 78 190 82" />
      </g>
    </svg>
  );
}

/** The fixed corner decor every app screen sits on. */
export function CornerDecor() {
  return (
    <>
      <div aria-hidden className="hm-decor" style={{ left: -90, bottom: -70, width: "clamp(180px,20vw,320px)", aspectRatio: "300/190" }}>
        <MossRock shape="a" />
      </div>
      <div aria-hidden className="hm-decor" style={{ right: -80, bottom: -60, width: "clamp(160px,18vw,280px)", aspectRatio: "300/190", transform: "scaleX(-1)" }}>
        <MossRock shape="b" />
      </div>
      <div aria-hidden className="hm-decor" style={{ left: "clamp(2px,1.5vw,28px)", bottom: "clamp(44px,6vw,96px)", height: "clamp(170px,34vh,340px)" }}>
        <Vine shape="a" style={{ height: "100%" }} />
      </div>
      <div aria-hidden className="hm-decor" style={{ right: "clamp(2px,1.5vw,28px)", bottom: "clamp(40px,5vw,86px)", height: "clamp(150px,30vh,300px)" }}>
        <Vine shape="b" delay={0.5} style={{ height: "100%" }} />
      </div>
      <div aria-hidden className="hm-decor" style={{ left: -90, top: "46%", width: "clamp(110px,11vw,160px)", aspectRatio: "220/120", opacity: "calc(0.75 * var(--decor-opacity))", transform: "rotate(30deg)", transformOrigin: "0 50%" }}>
        <div className="hm-sway" style={{ width: "100%", height: "100%", animationDuration: "7s" }}>
          <SoftLeaf tone="mid" />
        </div>
      </div>
      <div aria-hidden className="hm-decor" style={{ right: -90, top: "38%", width: "clamp(100px,10vw,150px)", aspectRatio: "220/120", opacity: "calc(0.75 * var(--decor-opacity))", transform: "scaleX(-1) rotate(30deg)", transformOrigin: "0 50%" }}>
        <div className="hm-sway" style={{ width: "100%", height: "100%", animationDuration: "8s" }}>
          <SoftLeaf tone="light" />
        </div>
      </div>
    </>
  );
}
