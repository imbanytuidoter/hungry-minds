"use client";
// Greenery that grows: a vine draws itself up from a mossy rock and its leaves unfold one by one.
// <Vine> grows on its own when it scrolls into view, or follows a `grow` value (0..1) you drive.
// grow={-1} means: follow the --g set on a parent (for scroll-driven scenes).
// <GreenEdges> puts a rock + vine in each bottom corner and a hanging vine at the top of a section.

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { MossRock } from "./game/Decor";

type LeafAt = { t: number; x: number; y: number; a: number; s: number };

// One stem per shape, drawn bottom-up in a 120x400 box; leaves sit on the stem at `t` (0 = base).
const STEMS: Record<"a" | "b", { d: string; leaves: LeafAt[] }> = {
  a: {
    d: "M60 400 C 30 340, 92 300, 62 240 C 34 184, 88 150, 64 96 C 50 64, 70 30, 58 4",
    leaves: [
      { t: 0.1, x: 47, y: 362, a: 200, s: 1 },
      { t: 0.2, x: 70, y: 318, a: -20, s: 1.1 },
      { t: 0.32, x: 56, y: 262, a: 205, s: 0.95 },
      { t: 0.44, x: 70, y: 212, a: -25, s: 1.05 },
      { t: 0.56, x: 52, y: 168, a: 200, s: 0.9 },
      { t: 0.68, x: 72, y: 124, a: -30, s: 0.95 },
      { t: 0.8, x: 58, y: 78, a: 210, s: 0.8 },
      { t: 0.92, x: 64, y: 34, a: -35, s: 0.7 },
    ],
  },
  b: {
    d: "M60 400 C 92 350, 28 310, 58 252 C 86 200, 30 168, 56 112 C 72 78, 44 40, 62 4",
    leaves: [
      { t: 0.12, x: 76, y: 356, a: -15, s: 1.05 },
      { t: 0.24, x: 46, y: 310, a: 195, s: 1 },
      { t: 0.36, x: 66, y: 256, a: -25, s: 1 },
      { t: 0.48, x: 50, y: 206, a: 200, s: 1.05 },
      { t: 0.6, x: 54, y: 156, a: -20, s: 0.9 },
      { t: 0.72, x: 50, y: 110, a: 205, s: 0.85 },
      { t: 0.84, x: 58, y: 66, a: -30, s: 0.75 },
    ],
  },
};

export function Vine({ shape = "a", grow, style, className, delay = 0 }: { shape?: "a" | "b"; grow?: number; style?: CSSProperties; className?: string; delay?: number }) {
  const gid = "gv" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [on, setOn] = useState(false);
  const driven = grow !== undefined;

  useEffect(() => {
    if (driven || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [driven]);

  const S = STEMS[shape];
  const css = { ...style, ...(driven ? (grow! < 0 ? {} : { ["--g" as string]: String(Math.max(0, Math.min(1, grow!))) }) : { transitionDelay: `${delay}s` }) } as CSSProperties;
  return (
    <svg ref={ref} aria-hidden viewBox="0 0 120 400" className={`gv${driven ? " gv-driven" : on ? " on" : ""}${className ? " " + className : ""}`} style={css}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A7D58F" />
          <stop offset="55%" stopColor="#5FA556" />
          <stop offset="100%" stopColor="#2F6E3A" />
        </linearGradient>
      </defs>
      <path className="gv-stem" d={S.d} pathLength={1} fill="none" stroke="#3E7D3C" strokeWidth="4" strokeLinecap="round" />
      {S.leaves.map((l, i) => (
        <g key={i} transform={`translate(${l.x} ${l.y}) rotate(${l.a}) scale(${l.s})`}>
          <path className="gv-leaf" style={{ ["--t" as string]: String(l.t) } as CSSProperties} d="M0 0 C 8 -12, 30 -14, 42 0 C 30 12, 8 12, 0 0 Z" fill={`url(#${gid})`} />
        </g>
      ))}
    </svg>
  );
}

/** Mossy rocks in the bottom corners with vines climbing out of them, plus one vine hanging from the top. */
export function GreenEdges({ top = true, rocks = true, fixed = false }: { top?: boolean; rocks?: boolean; fixed?: boolean }) {
  const pos: CSSProperties = { position: fixed ? "fixed" : "absolute", pointerEvents: "none", zIndex: 0 };
  return (
    <>
      <Vine shape="a" style={{ ...pos, left: "clamp(4px,2vw,40px)", bottom: rocks ? "clamp(40px,6vw,90px)" : 0, height: "clamp(180px,34vh,360px)" }} />
      <Vine shape="b" delay={0.4} style={{ ...pos, right: "clamp(4px,2vw,40px)", bottom: rocks ? "clamp(36px,5vw,80px)" : 0, height: "clamp(160px,30vh,320px)" }} />
      {top && <Vine shape="b" delay={0.8} style={{ ...pos, left: "14%", top: 0, height: "clamp(90px,16vh,170px)", transform: "scaleY(-1)" }} />}
      {rocks && (
        <>
          <div aria-hidden style={{ ...pos, left: -70, bottom: -50, width: "clamp(170px,20vw,300px)", aspectRatio: "300/190" }}>
            <MossRock shape="a" />
          </div>
          <div aria-hidden style={{ ...pos, right: -60, bottom: -44, width: "clamp(150px,18vw,270px)", aspectRatio: "300/190", transform: "scaleX(-1)" }}>
            <MossRock shape="b" />
          </div>
        </>
      )}
    </>
  );
}
