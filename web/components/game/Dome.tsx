"use client";

import { useEffect, useRef, useState } from "react";
import GlossyMind from "./GlossyMind";
import Logo from "@/components/Logo";
import { SoftLeaf } from "./Decor";
import { useGame } from "./GameProvider";
import { GetAMind } from "./AfterSale";
import { moodOf, STATE_LABEL, stateOf, type MindRec } from "@/lib/game/engine";
import type { Strings } from "@/lib/game/i18n";
import type { Weather } from "@/lib/game/weather";

const PLANTS: [string, string, string, string, "mid" | "light" | "dark", string][] = [
  ["-6%", "6%", "46%", "-60deg", "mid", "7s"],
  ["-4%", "24%", "38%", "-35deg", "light", "8s"],
  ["70%", "8%", "44%", "-130deg", "mid", "7.5s"],
  ["74%", "28%", "36%", "-150deg", "light", "9s"],
  ["10%", "-4%", "30%", "-80deg", "dark", "6s"],
];
const SPARKLES = Array.from({ length: 10 }, (_, i) => ({ x: 14 + ((i * 31) % 72), y: 12 + ((i * 23) % 60), dur: 2 + (i % 3), del: -i * 0.4 }));
const HEART_COLS = ["var(--accent)", "#FF9CC2", "#FFD84D", "#7FDDA8"];

export type DomeFx = { crumbs: { id: string; e: string; x: number; d: number }[]; hop: number };

export default function Dome({
  mind,
  T,
  wx,
  fx,
  visiting,
  onBack,
  guest,
  onHatch,
  onBuy,
  onBrowse,
}: {
  mind: MindRec | null;
  T: Strings;
  wx: Weather;
  fx: DomeFx;
  visiting: boolean;
  onBack: () => void;
  guest: boolean;
  onHatch: () => void;
  onBuy: () => void;
  onBrowse: () => void;
}) {
  const g = useGame();
  const [pet, setPet] = useState<{ until: number; n: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const uid = useRef(0);
  const st = mind ? stateOf(mind) : "content";
  const petting = !!pet && pet.until > g.now;
  const awake = st !== "asleep" && st !== "ghost";
  const mood = petting && awake ? "happy" : moodOf(st);

  // Eyes follow the pointer (the GlossyMind reads --mx/--my).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const mx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
      const my = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
      el.style.setProperty("--mx", mx.toFixed(2));
      el.style.setProperty("--my", my.toFixed(2));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const doPet = () => {
    if (!mind || !awake) return;
    const n = ++uid.current;
    setPet({ until: Date.now() + 2200, n });
    g.pet(mind.id);
  };

  const isRain = wx.kind === "rain" || wx.kind === "storm";
  const isSnow = wx.kind === "snow";
  const drops = isRain
    ? Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 100, w: 2, h: 16, r: "2px", c: "rgba(120,160,220,.55)", a: "hmRain", dur: 0.7 + (i % 5) * 0.08, del: -(i * 0.13) }))
    : isSnow
      ? Array.from({ length: 36 }, (_, i) => ({ x: (i * 41) % 100, w: 5 + (i % 3) * 2, h: 5 + (i % 3) * 2, r: "50%", c: "color-mix(in srgb, var(--surface) 95%, transparent)", a: "hmSnow", dur: 4 + (i % 5) * 0.7, del: -(i * 0.37) }))
      : [];
  const clouds = wx.kind !== "clear" ? ([["8%", "8%", 110], ["52%", "4%", 140], ["30%", "16%", 90]] as const) : [];
  const accUmb = isRain;
  const accHat = isSnow || (wx.temp != null && wx.temp < 3 && !isRain);
  const accScarf = isSnow || (wx.temp != null && wx.temp < 8 && !isRain);
  const accShades = wx.day && wx.kind === "clear" && (wx.temp == null || wx.temp >= 16);
  // Weather accessories only when she isn't already wearing her own.
  const ownHat = (mind?.look.hat ?? 0) > 0;
  const ownOutfit = (mind?.look.outfit ?? 0) > 0;
  const ownEyes = (mind?.look.eyes ?? 0) > 0;

  return (
    <main ref={ref} className="hm-dome">
      <div className="hm-dome-plants" style={{ position: "absolute", inset: 0, filter: "blur(7px)", opacity: 0.75, pointerEvents: "none" }}>
        {PLANTS.map(([x, y, w, r, t, dur], i) => (
          <div key={i} style={{ position: "absolute", left: x, bottom: y, width: w, aspectRatio: "220/120", transform: `rotate(${r})`, transformOrigin: "0 50%" }}>
            <div className="hm-sway" style={{ width: "100%", height: "100%", animationDuration: dur }}>
              <SoftLeaf tone={t} />
            </div>
          </div>
        ))}
      </div>
      <div className="hm-glare" style={{ position: "absolute", left: "10%", right: "10%", top: "8%", height: "30%", borderRadius: "50%", background: "radial-gradient(ellipse at 50% 0%,color-mix(in srgb, var(--surface) 70%, transparent),transparent 70%)", pointerEvents: "none" }} />
      {SPARKLES.map((s, i) => (
        <span key={i} className="hm-sparkle" style={{ position: "absolute", left: `${s.x}%`, top: `${s.y}%`, width: 6, height: 6, borderRadius: "50%", background: "var(--surface)", boxShadow: "0 0 10px #fff", animation: `hmSparkle ${s.dur}s ${s.del}s ease-in-out infinite` }} />
      ))}

      <div className="hm-weather" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1, overflow: "hidden" }}>
        {wx.day && wx.kind === "clear" && (
          <div style={{ position: "absolute", right: "8%", top: "6%", width: 120, height: 120 }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "repeating-conic-gradient(rgba(255,214,107,.45) 0 8deg,transparent 8deg 24deg)", animation: "hmSun 30s linear infinite" }} />
            <div style={{ position: "absolute", inset: "26%", borderRadius: "50%", background: "radial-gradient(circle at 40% 35%,#FFF4C2,#FFC94D)", boxShadow: "0 0 40px rgba(255,201,77,.7)" }} />
          </div>
        )}
        {!wx.day && (wx.kind === "clear" || wx.kind === "cloudy") && <div style={{ position: "absolute", right: "10%", top: "8%", width: 70, height: 70, borderRadius: "50%", boxShadow: "-14px 8px 0 0 #FFF4D2", filter: "drop-shadow(0 0 16px rgba(255,244,210,.8))" }} />}
        {clouds.map(([x, y, w], i) => {
          const c = isRain ? "rgba(190,200,215,.85)" : "rgba(255,255,255,.85)";
          return <div key={i} className="hm-cloud" style={{ position: "absolute", left: x, top: y, width: w, height: w * 0.34, borderRadius: 999, background: c, filter: "blur(1px)", boxShadow: `30px -14px 0 4px ${c},-24px -8px 0 0 ${c}` }} />;
        })}
        {drops.map((d, i) => (
          <span key={i} style={{ position: "absolute", left: `${d.x}%`, top: -20, width: d.w, height: d.h, borderRadius: d.r, background: d.c, animation: `${d.a} ${d.dur.toFixed(2)}s ${d.del.toFixed(2)}s linear infinite` }} />
        ))}
      </div>

      {guest && (
        <div className="hm-veil" style={{ position: "absolute", inset: 0, zIndex: 8, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "rgba(255,240,246,.55)", backdropFilter: "blur(6px)" }}>
          <div style={{ maxWidth: 380, width: "100%", padding: 22, borderRadius: 26, background: "var(--surface)", boxShadow: "0 20px 50px rgba(180,90,140,.2)", display: "flex", flexDirection: "column", gap: 10, textAlign: "center", alignItems: "center" }}>
            <Logo size={64} word={false} />
            <span style={{ fontWeight: 600, fontSize: 19, color: "var(--ink-strong)" }}>No Mind yet</span>
            <span style={{ fontSize: 13.5, lineHeight: 1.45, color: "var(--muted-2)" }}>Hatch a new one or buy one that is already grown. You can still visit and feed anyone else&apos;s Mind.</span>
            <GetAMind onHatch={onHatch} onBuy={onBuy} compact />
            <button className="btn-link" style={{ color: "var(--ink)" }} onClick={onBrowse}>
              Visit the colony
            </button>
          </div>
        </div>
      )}

      {fx.crumbs.map((c) => (
        <span key={c.id} style={{ position: "absolute", top: "18%", left: `${c.x}%`, fontSize: 28, animation: `hmFall 1.2s ${c.d}s ease-in both`, zIndex: 3 }}>
          {c.e}
        </span>
      ))}

      {mind && (
        <>
          <div
            onClick={doPet}
            title={awake ? T.pet : STATE_LABEL[st]}
            style={{ position: "relative", width: "min(70%,340px)", aspectRatio: "200/210", zIndex: 2, animation: fx.hop ? `${fx.hop % 2 ? "hmHopA" : "hmHopB"} .75s cubic-bezier(.3,1.3,.5,1)` : "none", transformOrigin: "50% 100%", cursor: awake ? "pointer" : "default", opacity: st === "ghost" ? 0.85 : 1 }}
          >
            <div className="hm-breathe" style={{ width: "100%", height: "100%", animationDuration: st === "asleep" ? "6s" : "4s" }}>
              <div key={pet?.n ?? 0} style={{ width: "100%", height: "100%", animation: petting ? "hmSquish .6s ease-out" : "none", transformOrigin: "50% 92%", position: "relative" }}>
                {/* exactly the Mind her owner built at hatch (same parts, no extra sprout) */}
                {/* Weather wear REPLACES, never stacks: on a cold day she wears the wardrobe's own
                    scarf / beanie (clipped to her body, on-tone colour, antenna tucked in) only when
                    she has no outfit / hat of her own. */}
                <GlossyMind
                  mood={mood}
                  tone={mind.look.tone}
                  eyes={mind.look.eyes}
                  hat={ownHat ? mind.look.hat : accHat && st !== "ghost" ? 1 : 0}
                  outfit={ownOutfit ? mind.look.outfit : accScarf && st !== "ghost" ? 1 : 0}
                />
                <svg viewBox="0 0 200 210" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }} aria-hidden>
                  {accUmb && awake && (
                    // with a hat of her own the canopy rides higher, so a tall hat never pokes through it
                    <g>
                      <path d={`M160 ${ownHat ? -18 : 28} L160 150 q0 10 -9 10`} fill="none" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
                      <g transform={ownHat ? "translate(0 -46)" : undefined}>
                        <path d="M96 34 Q160 -14 224 34 Q208 26 192 34 Q176 24 160 34 Q144 24 128 34 Q112 26 96 34 Z" fill="#FFD84D" stroke="#E0A81F" strokeWidth="2" />
                        <path d="M128 34 Q160 4 192 34" fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="3" />
                      </g>
                    </g>
                  )}
                  {accShades && awake && !ownEyes && (
                    <g>
                      <rect x="56" y="98" width="38" height="26" rx="12" fill="var(--ink-strong)" />
                      <rect x="106" y="98" width="38" height="26" rx="12" fill="var(--ink-strong)" />
                      <path d="M94 108 h12" stroke="var(--ink-strong)" strokeWidth="4" />
                      <path d="M62 104 l10 0" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
                      <path d="M112 104 l10 0" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
                    </g>
                  )}
                </svg>
              </div>
            </div>
            {st === "asleep" &&
              [0, 1, 2].map((i) => (
                <span key={i} className="serif" style={{ position: "absolute", right: "8%", top: "16%", fontSize: 34 + i * 8, color: "#7A55C8", opacity: 0, animation: `hmZ 3s ${i * 1}s ease-out infinite`, pointerEvents: "none" }}>
                  z
                </span>
              ))}
            {petting &&
              Array.from({ length: 7 }, (_, i) => (
                <span key={`${pet!.n}-${i}`} style={{ position: "absolute", left: "50%", top: "22%", fontSize: 18 + (i % 3) * 8, color: HEART_COLS[i % 4], ["--dx" as string]: `${(i - 3) * 26}px`, animation: `hmHeart 1.3s ${(i * 0.06).toFixed(2)}s ease-out both`, pointerEvents: "none" }}>
                  ♥
                </span>
              ))}
          </div>
          <div className="hm-stage" style={{ position: "relative", width: "min(78%,380px)", height: 46, marginTop: -30, borderRadius: "50%", background: "radial-gradient(ellipse at 50% 30%,#FFE6F0,#F6C2D7 70%)", boxShadow: "inset 0 -6px 14px rgba(200,90,140,.25),0 10px 30px rgba(226,90,147,.2)" }} />
          <div style={{ position: "relative", marginTop: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, textAlign: "center" }}>
            <span className="serif" style={{ fontSize: 34, lineHeight: 1.1 }}>
              {mind.name}
            </span>
            <span style={{ fontSize: 16, color: "var(--accent-strong)" }}>
              {STATE_LABEL[st]} · {mind.thoughts.toLocaleString("en-US")} thought{mind.thoughts === 1 ? "" : "s"}
            </span>
            {visiting && (
              <button className="btn-ghost" style={{ marginTop: 8 }} onClick={onBack}>
                {g.mine.length ? "Back home" : "Back to the colony"}
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
