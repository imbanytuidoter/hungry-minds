"use client";

// The landing page, ported from the design handoff (Landing.dc.html) without its card-intro
// overlay (the page opens straight on the hero): sticky parallax hero, the 900vh scroll story (zoom into the eye -> inside the Mind -> pixel Mind
// that becomes "MIND" -> the colony), then How it works / Moods / Minds right now /
// Economy / Ghosts and the particle-wordmark footer. "Minds, right now" and the supply
// count read the live contract when one is configured.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import GlossyMind from "@/components/game/GlossyMind";
import { MossRock, SoftLeaf } from "@/components/game/Decor";
import * as chain from "@/lib/chain";
import { lookFromTraits, TONES, type Mood, type Tone } from "@/lib/game/look";

const cl = (v: number) => Math.min(1, Math.max(0, v));
const io = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const out = (t: number) => 1 - Math.pow(1 - t, 3);

// ── deterministic story data (the prototype's buildStory) ───────────────────────

type Tile = { x: number; y: number; c: string; i: number; r: number; r2: number; dx: number; dy: number; rot: number; sx: number; sy: number; L: boolean; lx?: number; ly?: number; lc?: string };

function buildTiles(): Tile[] {
  let a = 1337;
  const R = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const px: { x: number; y: number; c: string }[] = [];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const nx = (x + 0.5 - 8) / 7.4;
      const ny = (y + 0.5 - 9) / 6.4;
      if (nx * nx + ny * ny >= 1) continue;
      let c = y >= 13 ? "#D9407F" : "#FF5FA2";
      if ((x === 4 || x === 5) && (y === 4 || y === 5) && !(x === 5 && y === 5)) c = "#FFC2DB";
      if ([4, 5, 10, 11].includes(x) && (y === 8 || y === 9)) c = "#0F3D2A";
      if ((x === 5 || x === 11) && y === 8) c = "#FBF3E8";
      if ((x === 7 || x === 8) && y === 11) c = "#0F3D2A";
      if ((x === 3 || x === 12) && y === 11) c = "#FF2E7E";
      px.push({ x, y, c });
    }
  (
    [
      [5, 15, "#D9407F"],
      [6, 15, "#D9407F"],
      [9, 15, "#D9407F"],
      [10, 15, "#D9407F"],
      [8, 2, "#0F3D2A"],
      [9, 1, "#0F3D2A"],
      [10, 0, "#FFD84D"],
    ] as [number, number, string][]
  ).forEach(([x, y, c]) => px.push({ x, y, c }));
  px.sort((p1, p2) => p1.x - p2.x || p1.y - p2.y);
  const G: Record<string, string[]> = {
    M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
    I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  };
  const LC = ["#FF5FA2", "#FFD84D", "#8FE3C8", "#FBF3E8"];
  const L: { lx: number; ly: number; lc: string }[] = [];
  "MIND".split("").forEach((ch, li) => G[ch].forEach((row, ly) => row.split("").forEach((b, cx) => b === "1" && L.push({ lx: li * 6 + cx, ly, lc: LC[li] }))));
  const tiles: Tile[] = px.map((t, i) => ({ ...t, i, r: R(), r2: R(), dx: (R() - 0.5) * 1.6, dy: (R() - 0.5) * 1.6, rot: (R() - 0.5) * 400, sx: (R() - 0.5) * 1.4, sy: -0.4 - R() * 0.6, L: false }));
  L.forEach((l, j) => Object.assign(tiles[Math.round((j * (tiles.length - 1)) / (L.length - 1))], l, { L: true }));
  return tiles;
}
const TILES = buildTiles();

const BLOBS: [string, number][] = [
  ["#FF5FA2", 90],
  ["#8FE3C8", 70],
  ["#FF5FA2", 54],
  ["#FFD84D", 80],
  ["#8FE3C8", 44],
  ["#FF5FA2", 64],
  ["#FFD84D", 50],
  ["#8FE3C8", 86],
  ["#FF5FA2", 40],
  ["#FFD84D", 60],
];

const CROWD = Array.from({ length: 27 }, (_, i) => {
  const hs = ((i * 2654435761) >>> 0) % 1000;
  const moods: Mood[] = ["happy", "happy", "flat", "happy", "asleep", "happy", "sad", "happy", "ghost"];
  const row = Math.floor(i / 9);
  return { tone: (["pink", "yellow", "mint"] as Tone[])[hs % 3], mood: moods[(hs >> 3) % 9], sc: 0.55 + row * 0.22 + ((i * 7) % 5) * 0.03, dy: -(2 - row) * 34, dur: 2.2 + (i % 5) * 0.4 };
});

const STEP_K: Record<string, [string, string, string]> = {
  pink: ["#FFC9DD", "#FF8DB7", "#E25A93"],
  yellow: ["#FFF3B0", "#FFD84D", "#E2A91F"],
  mint: ["#D5FBE6", "#8FE6B8", "#4CC487"],
};
const STEPS = [
  ["Hatch", "1 NEAR. Most of it becomes its food. You name it and pick its look.", "yellow", "M12 3c-4 0-7 6-7 10a7 7 0 0 0 14 0c0-4-3-10-7-10z"],
  ["Think", "Every answer costs it 0.002 NEAR of its own money.", "pink", "M4 5h16v11H9l-5 4z"],
  ["Feed", "95% goes straight in. A meal wakes it up.", "mint", "M5 19c0-8 6-14 15-14-1 9-7 15-15 14zM5 19l9-9"],
  ["Remember", "No food, it sleeps. Thirty days asleep, it’s gone.", "pink", "M6 20V10a6 6 0 0 1 12 0v10l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z"],
].map(([t, d, k, icon]) => ({ t, d, icon, k: STEP_K[k] }));

const MOODS: { m: Mood; label: string; range: string }[] = [
  { m: "happy", label: "Full", range: "≥ 0.08 NEAR" },
  { m: "flat", label: "Hungry", range: "≥ 0.01 NEAR" },
  { m: "sad", label: "Starving", range: "almost empty" },
  { m: "asleep", label: "Asleep", range: "< 0.002 NEAR" },
  { m: "ghost", label: "Ghost", range: "30 days asleep" },
];

const LEAVES = [
  ["-7%", "auto", "12%", "22vw", "-30deg", "mid", 1, -14, 1],
  ["-10%", "auto", "34%", "26vw", "-10deg", "dark", 1, -20, 1],
  ["-6%", "auto", "58%", "24vw", "-26deg", "light", 4, -30, 1],
  ["0%", "auto", "80%", "22vw", "-42deg", "mid", 4, -26, 1],
  ["auto", "-4%", "16%", "20vw", "-30deg", "mid", 1, 16, -1],
  ["auto", "-9%", "26%", "26vw", "-14deg", "dark", 1, 18, -1],
  ["auto", "-6%", "50%", "24vw", "-28deg", "light", 4, 28, -1],
  ["auto", "-2%", "72%", "24vw", "-8deg", "mid", 4, 24, -1],
  ["auto", "6%", "86%", "18vw", "-46deg", "dark", 4, 30, -1],
] as const;
const LEAF_SPD = [-260, -420, -620, -760, -300, -480, -640, -820, -900];

const BALLS = [
  ["62%", "0%", "17%", "yellow", -18, 4.2],
  ["75%", "-6%", "13%", "pink", -24, 3.6],
  ["2%", "26%", "17%", "pink", -14, 4.8],
  ["0%", "76%", "13%", "mint", -10, 5.2],
  ["6%", "93%", "7%", "pink", -20, 3.9],
  ["96%", "34%", "7%", "yellow", -26, 4.5],
  ["102%", "38%", "9%", "pink", -22, 3.4],
] as const;
const BALL_K: Record<string, [string, string, string]> = { pink: ["#FFC9DD", "#FF6FA3", "#D9437E"], yellow: ["#FFF3B0", "#FFD84D", "#E2A91F"], mint: ["#D5FBE6", "#7FE0AE", "#3FB97C"] };

// ── "Minds, right now" ──────────────────────────────────────────────────────────

type FeedItem = { key: string; kind: "m" | "t"; name: string; cat: "Awake" | "Hungry" | "Asleep" | "Ghosts"; tone: Tone; mood: Mood; ar: string; meta: string; isNew: boolean; quote?: string };

const TINT: Record<string, string> = { pink: "#FFE3EE", mint: "#E1F8EA", yellow: "#FFF4D2", peach: "#FFEADF", sky: "#E2F2FF", lilac: "#EFE8F6", coral: "#FFE3E0", lime: "#F2FAD9", teal: "#DCF7F3", berry: "#FBE0F1", cream: "#FFF8EC", midnight: "#E3E6F7" };

const SAMPLE_FEED: FeedItem[] = [
  { key: "a", kind: "m", name: "Pip", cat: "Awake", tone: "mint", mood: "happy", ar: "1/1.15", meta: "Thought #2,418", isNew: true },
  { key: "b", kind: "t", name: "Moss", cat: "Awake", tone: "yellow", mood: "happy", ar: "1", meta: "Thought #918", isNew: false, quote: "The dust in my light moves like it has somewhere to be." },
  { key: "c", kind: "m", name: "Tilly", cat: "Hungry", tone: "pink", mood: "flat", ar: "1/1.3", meta: "0.04 NEAR left", isNew: false },
  { key: "d", kind: "m", name: "Ash", cat: "Asleep", tone: "mint", mood: "asleep", ar: "1", meta: "asleep 3 days", isNew: false },
  { key: "e", kind: "t", name: "Juno", cat: "Hungry", tone: "pink", mood: "happy", ar: "1", meta: "Thought #77", isNew: true, quote: "If you visit, I’ll tell you what clouds taste like." },
  { key: "f", kind: "m", name: "Bram", cat: "Ghosts", tone: "lilac", mood: "ghost", ar: "1/1.2", meta: "remembered", isNew: false },
];

function feedFromChain(s: chain.SnapshotOnChain): FeedItem[] {
  const items: FeedItem[] = [];
  const now = Date.now();
  [...s.minds].reverse().forEach((r) => {
    const st = r.mind.ghost ? "ghost" : r.live_state;
    const cat = st === "ghost" ? "Ghosts" : st === "asleep" ? "Asleep" : st === "hungry" || st === "starving" ? "Hungry" : "Awake";
    const mood: Mood = st === "ghost" ? "ghost" : st === "asleep" ? "asleep" : st === "starving" ? "sad" : st === "hungry" ? "flat" : "happy";
    const tone = r.look ? (TONES[r.look.tone] ?? "pink") : lookFromTraits(r.mind.traits).tone;
    const bal = chain.yoctoToNear(r.live_balance);
    const born = r.mind.born_ts / 1e6;
    items.push({ key: `m${r.id}`, kind: "m", name: r.mind.name, cat, tone, mood, ar: ["1/1.15", "1", "1/1.3", "1/1.2"][r.id % 4], meta: cat === "Hungry" ? `${bal.toFixed(2)} NEAR left` : `${r.mind.thought_count} thoughts`, isNew: now - born < 3 * 86_400_000 });
    if (r.mind.last_reply) items.push({ key: `t${r.id}`, kind: "t", name: r.mind.name, cat, tone, mood, ar: "1", meta: `Thought #${r.mind.thought_count}`, isNew: false, quote: r.mind.last_reply.slice(0, 160) });
  });
  return items.slice(0, 14);
}

// ── page ────────────────────────────────────────────────────────────────────────

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const wordRef = useRef<HTMLCanvasElement>(null);
  const [show, setShow] = useState(0);
  const [whip, setWhip] = useState(0);
  const [filter, setFilter] = useState<"All" | FeedItem["cat"]>("All");
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  // Examples only for an offline build with no contract; a live page waits for the chain.
  const [feed, setFeed] = useState<FeedItem[]>(chain.isLive() || chain.notLaunched() ? [] : SAMPLE_FEED);
  const [liveFeed, setLiveFeed] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [snap, setSnap] = useState<chain.SnapshotOnChain | null>(null);

  // Live colony for "Minds, right now" and the supply line.
  useEffect(() => {
    if (!chain.isLive()) return;
    chain
      .colonySnapshot()
      .then((s) => {
        setLeft(s.supply_left);
        setSnap(s);
        // Only real Minds from the chain — an empty colony shows as empty, never as examples.
        setFeed(feedFromChain(s));
        setLiveFeed(true);
      })
      .catch(() => {});
  }, []);

  // Mood carousel.
  useEffect(() => {
    const t = setInterval(() => setShow((s) => (s + 1) % 5), 2600);
    return () => clearInterval(t);
  }, []);

  // Scroll-driven: hero --sp, the story timeline, word scrubs; reveals on intersection.
  useEffect(() => {
    const el = root.current!;
    const story = storyRef.current!;
    const q = (k: string) => story.querySelector<HTMLElement>(`[data-e=${k}]`)!;
    const tiles = [...story.querySelectorAll<HTMLElement>("[data-t]")];
    const words = [...story.querySelectorAll<HTMLElement>("[data-words]")].map((w) => ({ a: +w.dataset.a!, b: +w.dataset.b!, s: [...w.children] as HTMLElement[] }));
    const scrubs = [...el.querySelectorAll<HTMLElement>("[data-scrub]")].map((h) => {
      const ws = h.textContent!.trim().split(/\s+/);
      h.textContent = "";
      return {
        h,
        s: ws.map((w) => {
          const s = document.createElement("span");
          s.textContent = w + " ";
          h.appendChild(s);
          return s;
        }),
      };
    });
    let eye: { x: number; y: number; w: number; h: number } | null = null;

    const run = () => {
      const Wd = innerWidth;
      const Ht = innerHeight;
      // hero track
      const t = trackRef.current!;
      const tr = t.getBoundingClientRect();
      t.style.setProperty("--sp", cl(-tr.top / Math.max(1, tr.height - Ht)).toFixed(3));
      // story
      const r = story.getBoundingClientRect();
      const p = cl(-r.top / Math.max(1, r.height - Ht));
      const seg = (a: number, b: number) => cl((p - a) / (b - a));
      const zm = q("zoom");
      const stage = zm.closest<HTMLElement>("[data-stage]")!;
      if (!eye || eye.w !== Wd || eye.h !== Ht) {
        const prev = zm.style.transform;
        zm.style.transform = "none";
        const a = zm.getBoundingClientRect();
        const b = stage.getBoundingClientRect();
        eye = { x: a.left - b.left + a.width * 0.386, y: a.top - b.top + a.height * 0.533, w: Wd, h: Ht };
        zm.style.transform = prev;
      }
      const z = seg(0.02, 0.15);
      const zc = io(z);
      zm.style.transform = `translate(${((Wd / 2 - eye.x) * zc).toFixed(1)}px,${((Ht / 2 - eye.y) * zc).toFixed(1)}px) scale(${(1 + Math.pow(z, 3) * 70).toFixed(3)})`;
      const ht = seg(0.005, 0.05);
      q("heroText").style.opacity = String(1 - ht);
      q("heroText").style.transform = `translateY(${(-ht * 40).toFixed(1)}px)`;
      q("scrollHint").style.opacity = String(1 - seg(0, 0.02));
      q("disc").style.transform = `scale(${(1 + io(seg(0.02, 0.12)) * 0.15).toFixed(3)})`;
      q("disc").style.opacity = String(1 - seg(0.08, 0.13));
      const mo = seg(0.12, 0.16) * (1 - seg(0.43, 0.46));
      q("mind").style.opacity = String(mo);
      q("mind").style.visibility = mo < 0.01 ? "hidden" : "visible";
      q("mind").style.transform = `scale(${(1.08 - 0.08 * out(mo)).toFixed(4)})`;
      q("panel").style.clipPath = `inset(${((1 - io(seg(0.38, 0.44))) * 100).toFixed(2)}% 0 0 0)`;
      const pOut = seg(0.8, 0.84);
      q("panel").style.opacity = (1 - pOut).toFixed(3);
      q("panel").style.visibility = pOut > 0.99 ? "hidden" : "visible";
      q("panelText").style.opacity = String(1 - seg(0.585, 0.61));
      words.forEach((w) => {
        const v = seg(w.a, w.b);
        w.s.forEach((s, i) => {
          const k = out(cl(v * (w.s.length + 2) - i));
          s.style.opacity = k.toFixed(3);
          s.style.transform = `translateY(${((1 - k) * 0.45).toFixed(3)}em) scale(${(0.92 + k * 0.08).toFixed(3)})`;
          s.style.filter = k < 1 ? `blur(${((1 - k) * 10).toFixed(1)}px)` : "none";
        });
      });
      q("ink").style.opacity = String(seg(0.585, 0.63));
      const narrow = Wd < 820;
      const cell = narrow ? Math.min(Wd * 0.62, Ht * 0.34) / 16 : Math.min(Ht * 0.6, Wd * 0.36) / 16;
      const x0 = (narrow ? Wd / 2 : Wd * 0.72) - 8 * cell;
      const y0 = (narrow ? Ht * 0.7 : Ht / 2) - 8 * cell;
      const cL = Math.min((Wd * 0.82) / 23, (Ht * 0.36) / 7);
      const lx0 = Wd / 2 - 11.5 * cL;
      const ly0 = Ht * 0.42 - 3.5 * cL;
      const A = seg(0.42, 0.57);
      const M = seg(0.61, 0.72);
      const fi = io(seg(0.775, 0.83));
      tiles.forEach((elT, k) => {
        const tt = TILES[k];
        const ti = out(cl(A * 1.7 - tt.r * 0.7));
        const mi = io(cl(M * 1.6 - tt.r2 * 0.6));
        const cx = x0 + tt.x * cell;
        const cy = y0 + tt.y * cell;
        let x = cx + tt.dx * Wd * (1 - ti);
        let y = cy + tt.dy * Ht * (1 - ti);
        let rot = tt.rot * 0.35 * Math.pow(1 - ti, 2);
        let size = cell;
        let op = ti > 0 ? Math.min(1, ti * 2.5) : 0;
        let col = tt.c;
        if (tt.L) {
          const tx = lx0 + tt.lx! * cL;
          const ty = ly0 + tt.ly! * cL;
          x += (tx - x) * mi;
          y += (ty - y) * mi;
          size = cell + (cL - cell) * mi;
          rot += Math.sin(mi * Math.PI) * tt.rot * 0.08;
          if (mi > 0.5) col = tt.lc!;
        } else {
          x += tt.sx * Wd * mi;
          y += tt.sy * Ht * mi;
          op *= 1 - mi;
          rot += tt.rot * mi;
        }
        x += (Wd / 2 - size / 2 - x) * fi;
        y += (Ht * 0.62 - size / 2 - y) * fi;
        op *= 1 - fi;
        elT.style.width = elT.style.height = Math.max(2, Math.round(size) - 2) + "px";
        elT.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) rotate(${rot.toFixed(1)}deg) scale(${(1 - fi * 0.9).toFixed(3)})`;
        elT.style.opacity = op.toFixed(3);
        elT.style.background = col;
      });
      const co = seg(0.79, 0.84);
      q("colony").style.opacity = String(co);
      q("colony").style.pointerEvents = co > 0.9 ? "auto" : "none";
      q("colonyImg").style.transform = `scale(${(1.6 - 0.6 * io(seg(0.79, 0.94))).toFixed(3)})`;
      const ct = seg(0.93, 0.97);
      q("cta").style.opacity = String(ct);
      q("cta").style.pointerEvents = ct > 0.5 ? "auto" : "none";
      // word scrubs on section headings
      scrubs.forEach(({ h, s }) => {
        const rr = h.getBoundingClientRect();
        const pp = cl((Ht * 0.92 - rr.top) / (Ht * 0.5));
        s.forEach((sp, i) => {
          const k = cl(pp * (s.length + 1) - i);
          sp.style.opacity = (0.12 + 0.88 * k).toFixed(3);
          sp.style.transform = `translateY(${((1 - k) * 0.3).toFixed(3)}em)`;
        });
      });
    };
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(run);
    };
    const onResize = () => {
      eye = null;
      onScroll();
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onResize);
    run();

    const reveal = (e: Element) => {
      e.classList.add("shown");
      e.querySelectorAll<HTMLElement>("[data-fill]").forEach((b) => setTimeout(() => (b.style.width = b.dataset.fill!), 200));
    };
    const ob = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && reveal(e.target)), { threshold: 0.15 });
    el.querySelectorAll(".reveal").forEach((r) => ob.observe(r));
    const safe = setTimeout(() => el.querySelectorAll(".reveal").forEach(reveal), 6000);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      ob.disconnect();
      clearTimeout(safe);
    };
  }, []);

  // Goo blobs orbiting the hero Mind; the first one follows the pointer.
  useEffect(() => {
    const story = storyRef.current!;
    const stage = story.querySelector<HTMLElement>("[data-stage]")!;
    const hero = story.querySelector<HTMLElement>("[data-e=hero]")!;
    const disc = story.querySelector<HTMLElement>("[data-e=disc]")!;
    const zm = story.querySelector<HTMLElement>("[data-e=zoom]")!;
    const B = [...story.querySelectorAll<HTMLElement>("[data-blob]")].map((n, i, all) => ({ n, r: parseFloat(n.style.width) / 2, a: (i / all.length) * Math.PI * 2, sp: 0.18 + (i % 4) * 0.07, orb: 1.05 + (i % 3) * 0.22, x: 0, y: 0, vx: 0, vy: 0, cur: i === 0 }));
    let mx = -999;
    let my = -999;
    const t0 = performance.now();
    const move = (e: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
    };
    const leave = () => (mx = my = -999);
    hero.addEventListener("mousemove", move);
    hero.addEventListener("mouseleave", leave);
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (story.getBoundingClientRect().top < -innerHeight * 1.6) return;
      const t = (now - t0) / 1000;
      const sr = stage.getBoundingClientRect();
      const wr = zm.parentElement!.getBoundingClientRect();
      const cx = wr.left - sr.left + wr.width / 2;
      const cy = wr.top - sr.top + wr.height / 2;
      const R0 = wr.width / 2;
      disc.style.width = disc.style.height = wr.width + "px";
      disc.style.left = cx - R0 + "px";
      disc.style.top = cy - R0 + "px";
      B.forEach((b, i) => {
        let tx: number;
        let ty: number;
        if (b.cur && mx > -999) {
          tx = mx;
          ty = my;
        } else {
          const a = b.a + t * b.sp * (i % 2 ? 1 : -1);
          const wob = 1 + Math.sin(t * 1.3 + i) * 0.12;
          tx = cx + Math.cos(a) * R0 * b.orb * wob;
          ty = cy + Math.sin(a) * R0 * b.orb * 0.82 * wob;
        }
        if (!b.cur && mx > -999) {
          const dx = b.x - mx;
          const dy = b.y - my;
          const d = Math.hypot(dx, dy) || 1;
          if (d < 160) {
            tx += (dx / d) * (160 - d) * 0.9;
            ty += (dy / d) * (160 - d) * 0.9;
          }
        }
        const k = b.cur ? 0.16 : 0.035;
        b.vx = (b.vx + (tx - b.x) * k) * (b.cur ? 0.6 : 0.86);
        b.vy = (b.vy + (ty - b.y) * k) * (b.cur ? 0.6 : 0.86);
        if (!b.x && !b.y) {
          b.x = tx;
          b.y = ty;
        }
        b.x += b.vx;
        b.y += b.vy;
        const sq = Math.min(0.25, Math.hypot(b.vx, b.vy) / 60);
        const ang = Math.atan2(b.vy, b.vx) * 57.3;
        b.n.style.transform = `translate(${(b.x - b.r).toFixed(1)}px,${(b.y - b.r).toFixed(1)}px) rotate(${ang.toFixed(1)}deg) scale(${(1 + sq).toFixed(3)},${(1 - sq * 0.7).toFixed(3)})`;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      hero.removeEventListener("mousemove", move);
      hero.removeEventListener("mouseleave", leave);
    };
  }, []);

  // Footer particle wordmark that scatters from the cursor and settles back.
  useEffect(() => {
    const c = wordRef.current!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    type P = { hx: number; hy: number; x: number; y: number; vx: number; vy: number; c: string };
    let wp: { pts: P[]; step: number; w: number; hh: number } | null = null;
    const setup = () => {
      const w = c.clientWidth;
      const hh = c.clientHeight;
      if (!w || !hh) return;
      c.width = w * dpr;
      c.height = hh * dpr;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = hh;
      const o = off.getContext("2d")!;
      const family = getComputedStyle(c).fontFamily || "sans-serif";
      let fs = hh * 0.9;
      o.font = `600 ${fs}px ${family}`;
      const tw = o.measureText("hungry minds").width;
      if (tw > w * 0.94) {
        fs *= (w * 0.94) / tw;
        o.font = `600 ${fs}px ${family}`;
      }
      o.textAlign = "center";
      o.textBaseline = "middle";
      o.fillText("hungry minds", w / 2, hh * 0.52);
      const data = o.getImageData(0, 0, w, hh).data;
      const step = Math.max(4, Math.round(w / 260));
      const pts: P[] = [];
      for (let y = 0; y < hh; y += step)
        for (let x = 0; x < w; x += step)
          if (data[(y * w + x) * 4 + 3] > 128) pts.push({ hx: x, hy: y, x, y, vx: 0, vy: 0, c: Math.random() < 0.08 ? "#FF85B5" : Math.random() < 0.12 ? "#FFD84D" : "#BFF0D4" });
      wp = { pts, step, w, hh };
    };
    let mx = -9999;
    let my = -9999;
    const move = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
    };
    const leave = () => (mx = my = -9999);
    c.addEventListener("mousemove", move);
    c.addEventListener("mouseleave", leave);
    window.addEventListener("resize", setup);
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!wp) setup();
      if (!wp) return;
      const r = c.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, wp.w, wp.hh);
      const rad = wp.step * 0.42;
      for (const p of wp.pts) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < 9000) {
          const d = Math.sqrt(d2) || 1;
          const f = ((95 - d) / 95) * 7;
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
        p.vx += (p.hx - p.x) * 0.06;
        p.vy += (p.hy - p.y) * 0.06;
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += p.vx;
        p.y += p.vy;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, 6.283);
        ctx.fill();
      }
    };
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
      setup();
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      c.removeEventListener("mousemove", move);
      c.removeEventListener("mouseleave", leave);
      window.removeEventListener("resize", setup);
    };
  }, []);

  const heroMove = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", (((e.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
    el.style.setProperty("--my", (((e.clientY - r.top) / r.height - 0.5) * 2).toFixed(3));
  };
  const heroLeave = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty("--mx", "0");
    e.currentTarget.style.setProperty("--my", "0");
  };

  const burst = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const cols = ["#FF6FA3", "#FFD84D", "#2FBF71", "#0F4D33"];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("span");
      const a = (i / 14) * Math.PI * 2;
      const d = 26 + Math.random() * 26;
      s.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:7px;height:7px;border-radius:50%;background:${cols[i % 4]};pointer-events:none;z-index:300`;
      document.body.appendChild(s);
      s.animate([{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px),calc(-50% + ${Math.sin(a) * d}px)) scale(.2)`, opacity: 0 }], { duration: 600 + Math.random() * 200, easing: "cubic-bezier(.2,.8,.3,1)" }).onfinish = () => s.remove();
    }
  };

  const cats = ["All", "Awake", "Hungry", "Asleep", "Ghosts"] as const;
  const vis = feed.filter((f) => filter === "All" || f.cat === filter);
  // The count is only ever the chain's supply_left; until it is read (or if the read fails)
  // say "Most" instead of inventing a number. Same word count, so the scroll-reveal spans
  // captured at mount stay valid when the number arrives.
  const w5 = useMemo(() => `Only 4,000 Minds will ever exist. ${left == null ? "Most" : left.toLocaleString("en-US")} are still waiting to hatch.`.split(" "), [left]);
  // Everything below that names a number reads it from the chain snapshot; until it loads
  // (or if it can't) the copy says less rather than inventing one.
  const ghostMs = snap?.ghost_window_ms ?? null;
  const windowLabel = ghostMs == null ? null : ghostMs >= 86_400_000 ? `${Math.round(ghostMs / 86_400_000)} days` : `${Math.round(ghostMs / 60_000)} minutes`;
  const testnetNote = ghostMs != null && ghostMs < 86_400_000 ? " (on this testnet demo; 30 days on mainnet)" : "";
  const steps = STEPS.map((s) => (s.t === "Remember" ? { ...s, d: windowLabel ? `No food, it sleeps. ${windowLabel} asleep${testnetNote}, it’s gone.` : "No food, it sleeps. Asleep too long, it’s gone." } : s));
  const moods = MOODS.map((m) => (m.m === "ghost" ? { ...m, range: windowLabel ? `${windowLabel} asleep` : "asleep too long" } : m));
  const mood = moods[show];
  const star = snap?.minds.filter((r) => !r.mind.ghost).sort((a, b) => b.mind.thought_count - a.mind.thought_count)[0] ?? null;
  const ghosts = snap?.minds.filter((r) => r.mind.ghost) ?? [];

  return (
    <div className="hl" ref={root}>
      <nav style={{ maxWidth: 1240, margin: "0 auto", padding: "18px 32px", display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap", position: "relative", zIndex: 5 }}>
        <Link href="/" style={{ fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", textDecoration: "none" }}>
          hungry minds
        </Link>
        <div className="hl-navlinks" style={{ marginLeft: "auto", display: "flex", gap: "6px 28px", fontWeight: 500, fontSize: 16, flexWrap: "wrap" }}>
          {[
            ["#how", "How it works"],
            ["#moods", "Moods"],
            ["#economy", "Economy"],
            ["#ghosts", "Ghosts"],
          ].map(([h, t]) => (
            <a key={h} href={h} style={{ textDecoration: "none" }}>
              {t}
            </a>
          ))}
        </div>
        <Link href="/app" className="pill-dark" style={{ fontSize: 16, padding: "12px 24px" }}>
          Launch App
        </Link>
      </nav>

      {/* hero */}
      <div ref={trackRef} style={{ position: "relative", height: "190vh" }}>
        <header onMouseMove={heroMove} onMouseLeave={heroLeave} style={{ position: "sticky", top: 0, height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", overflow: "hidden" }}>
          {LEAVES.map(([x, rx, y, w, rot, tone, zi, p, sx], i) => (
            <div key={i} style={{ position: "absolute", left: x, right: rx, top: y, width: w, aspectRatio: "220/120", zIndex: zi, transform: `translate(calc(var(--mx,0) * ${p}px),calc(var(--my,0) * ${p}px + var(--sp,0) * ${LEAF_SPD[i]}px))`, transition: "transform .25s ease-out", pointerEvents: "none", animation: `hlUp 1s ${(0.15 + i * 0.06).toFixed(2)}s cubic-bezier(.2,1,.3,1) backwards` }}>
              <div style={{ width: "100%", height: "100%", transform: `scaleX(${sx})` }}>
                <div style={{ width: "100%", height: "100%", transform: `rotate(${rot})`, transformOrigin: "0% 50%" }}>
                  <div style={{ width: "100%", height: "100%", animation: `hlSway ${6 + (i % 4)}s ease-in-out infinite`, transformOrigin: "0% 50%" }}>
                    <SoftLeaf tone={tone} />
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div style={{ position: "absolute", left: "-7%", bottom: "-9%", width: "38vw", minWidth: 260, aspectRatio: "300/190", zIndex: 2, pointerEvents: "none", transform: "translate(calc(var(--mx,0) * -22px),calc(var(--sp,0) * 160px))", transition: "transform .4s ease-out" }}>
            <MossRock shape="a" />
          </div>
          <div style={{ position: "absolute", right: "-6%", bottom: "-7%", width: "32vw", minWidth: 230, aspectRatio: "300/190", zIndex: 2, pointerEvents: "none", transform: "translate(calc(var(--mx,0) * 22px),calc(var(--sp,0) * 200px)) scaleX(-1)", transition: "transform .4s ease-out" }}>
            <MossRock shape="b" />
          </div>
          <h1 style={{ position: "relative", zIndex: 3, opacity: "calc(1 - var(--sp,0) * 1.6)", transform: "translateY(calc(var(--sp,0) * -60px))", fontWeight: 600, fontSize: "clamp(44px,min(9vw,11vh),120px)", lineHeight: 1, letterSpacing: "-.045em", textAlign: "center", animation: "hlUp .9s .1s cubic-bezier(.2,1,.3,1) backwards" }}>
            Look closer.
          </h1>
          <div style={{ position: "relative", zIndex: 3, width: "min(36vh,80vw,440px)", aspectRatio: "1", marginTop: "1vh", animation: "hlUp 1s .25s cubic-bezier(.2,1,.3,1) both" }}>
            <div style={{ position: "absolute", inset: "6% 4% 2% 6%", background: "radial-gradient(circle at 34% 28%,#E2FFEE 0%,#A6F0C8 30%,#6EDCA2 70%,#4CC487 100%)", boxShadow: "inset 0 -18px 40px rgba(30,120,70,.35),inset 0 14px 30px rgba(255,255,255,.7),0 30px 60px rgba(40,140,90,.25)", animation: "hlJelly 9s ease-in-out infinite", opacity: 0.92 }} />
            {BALLS.map(([x, y, s, k, p, dur], i) => {
              const K = BALL_K[k];
              return <div key={i} style={{ position: "absolute", left: x, top: y, width: s, aspectRatio: "1", borderRadius: "50%", background: `radial-gradient(circle at 34% 28%,#FFFFFF 0%,${K[0]} 18%,${K[1]} 58%,${K[2]} 100%)`, boxShadow: "0 10px 20px rgba(0,0,0,.12)", transform: `translate(calc(var(--mx,0) * ${p}px),calc(var(--my,0) * ${p}px))`, transition: "transform .5s cubic-bezier(.2,1,.3,1)", animation: `hlBob ${dur}s ease-in-out infinite` }} />;
            })}
            <div style={{ position: "absolute", left: "18%", top: "14%", width: "64%", aspectRatio: "200/210", transform: "translate(calc(var(--mx,0) * 10px),calc(var(--my,0) * 6px))", transition: "transform .5s cubic-bezier(.2,1,.3,1)" }}>
              <div className="breathe" style={{ width: "100%", height: "100%" }}>
                <GlossyMind mood="happy" />
              </div>
            </div>
          </div>
          <div style={{ position: "relative", zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: "3vh", textAlign: "center", animation: "hlUp .9s .45s cubic-bezier(.2,1,.3,1) backwards", opacity: "calc(1 - var(--sp,0) * 1.4)" }}>
            <p className="lead" style={{ fontSize: "clamp(17px,1.6vw,20px)", maxWidth: 520 }}>
              One of only 4,000 living NFTs, each with its own on-chain balance. It pays for every thought. Nobody, not even you, can withdraw its food.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
              <Link href="/app" className="pill-dark">
                Hatch a Mind · 1 NEAR
              </Link>
              <a href="#how" className="pill-light">
                How it works
              </a>
            </div>
          </div>
          <div style={{ position: "absolute", bottom: "5vh", left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none", opacity: "calc(var(--sp,0) * 2.2 - .8)" }}>
            <span style={{ fontWeight: 600, fontSize: "clamp(28px,3.4vw,44px)", letterSpacing: "-.03em", textAlign: "center", maxWidth: 720 }}>It stays. The world moves on around it.</span>
          </div>
        </header>
      </div>

      {/* the scroll story */}
      <section ref={storyRef} style={{ height: "900vh", position: "relative", background: "#0F3D2A" }}>
        <div data-stage="1" style={{ position: "sticky", top: 0, height: "100vh", overflow: "hidden", background: "#FBF3E8" }}>
          <div data-e="hero" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4vh", background: "#FBF3E8" }}>
            <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
              <filter id="hl-goo" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="b" />
                <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11" result="goo" />
                <feComposite in="SourceGraphic" in2="goo" operator="atop" />
              </filter>
            </svg>
            <div style={{ position: "absolute", inset: 0, filter: "url(#hl-goo)", pointerEvents: "none" }}>
              <div data-e="disc" style={{ position: "absolute", left: 0, top: 0, borderRadius: "50%", background: "#FFD84D" }} />
              {BLOBS.map(([c, d], i) => (
                <div key={i} data-blob={i} style={{ position: "absolute", left: 0, top: 0, width: d, height: d, borderRadius: "50%", background: c, willChange: "transform" }} />
              ))}
            </div>
            <h2 data-e="heroText" style={{ position: "relative", fontWeight: 600, fontSize: "clamp(48px,7.5vw,112px)", lineHeight: 0.9, letterSpacing: "-.02em", textAlign: "center", display: "flex", justifyContent: "center" }}>
              {"Closer still.".split("").map((ch, i) => (
                <span key={i} style={{ display: "inline-block", whiteSpace: "pre", animation: `hlCharIn .9s ${(1.5 + i * 0.045).toFixed(3)}s cubic-bezier(.2,1.6,.4,1) both`, transformOrigin: "50% 100%" }}>
                  {ch}
                </span>
              ))}
            </h2>
            <div style={{ position: "relative", width: "min(52vh,480px)", aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div data-e="zoom" style={{ position: "relative", width: "84%", aspectRatio: "1", transformOrigin: "38.6% 53.3%" }}>
                <GlossyMind mood="happy" />
              </div>
            </div>
            <span data-e="scrollHint" style={{ position: "absolute", bottom: "4vh", left: "50%", width: 2, height: 40, marginLeft: -1, background: "#0F3D2A", borderRadius: 2, transformOrigin: "50% 0", animation: "hlBreathe 1.4s ease-in-out infinite" }} />
          </div>

          <div data-e="mind" style={{ position: "absolute", inset: 0, background: "#0F3D2A", opacity: 0 }}>
            <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 70% 60% at 50% 55%,#16503A 0%,#0F3D2A 55%,#0A2A1D 100%)", overflow: "hidden" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/mind-inside.jpg" alt="A Mind floating inside its own thoughts" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "60% 50%" }} />
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(10,42,29,.75) 0%,rgba(10,42,29,.15) 38%,rgba(10,42,29,0) 60%,rgba(10,42,29,.7) 100%)" }} />
            </div>
            <div style={{ position: "absolute", top: "10vh", left: 0, right: 0, margin: "0 auto", maxWidth: 980, padding: "0 24px", display: "flex", justifyContent: "center", textAlign: "center", pointerEvents: "none" }}>
              <Words a={0.18} b={0.3} text="Inside, every thought costs it 0.002 NEAR." style={{ fontSize: "clamp(36px,5.4vw,80px)", color: "#FBF3E8" }} />
            </div>
            <div style={{ position: "absolute", bottom: "7vh", left: 0, right: 0, display: "flex", justifyContent: "center", gap: "clamp(24px,6vw,80px)", color: "#FBF3E8", pointerEvents: "none" }}>
              {star ? (
                <>
                  <Counter e="bal" v={chain.yoctoToNear(star.live_balance).toFixed(3)} label={`${star.mind.name}'s NEAR, live`} />
                  <Counter e="cnt" v={star.mind.thought_count.toLocaleString("en-US")} label="thoughts so far" />
                </>
              ) : (
                <>
                  {/* No Mind yet: show the colony's real counts, not a pretend Mind. */}
                  <Counter e="bal" v={snap ? String(snap.total_minds) : "—"} label="Minds hatched so far" />
                  <Counter e="cnt" v={snap ? snap.supply_left.toLocaleString("en-US") : "—"} label="still waiting to hatch" />
                </>
              )}
            </div>
          </div>

          <div data-e="panel" style={{ position: "absolute", inset: 0, background: "#FBF3E8", clipPath: "inset(100% 0 0 0)" }}>
            <div data-e="panelText" style={{ position: "absolute", left: "clamp(24px,5vw,72px)", top: "50%", transform: "translateY(-50%)", width: "min(38vw,520px)" }}>
              <Words a={0.43} b={0.53} text="A pet that pays its own way. Nobody, not even you, can rob it." style={{ fontSize: "clamp(34px,4.4vw,68px)", color: "#0F3D2A" }} />
            </div>
          </div>

          <div data-e="ink" style={{ position: "absolute", inset: 0, background: "#0F3D2A", opacity: 0, pointerEvents: "none" }}>
            <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 50% at 50% 50%,#1F5A3F,transparent 70%)" }} />
          </div>

          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {TILES.map((t) => (
              <div key={t.i} data-t={t.i} style={{ position: "absolute", left: 0, top: 0, width: 10, height: 10, borderRadius: 2, background: t.c, opacity: 0, willChange: "transform" }} />
            ))}
          </div>

          <div data-e="colony" style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none", background: "#0F3D2A" }}>
            <div data-e="colonyImg" style={{ position: "absolute", inset: 0, transformOrigin: "50% 60%" }}>
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(70% 55% at 50% 100%,#155238 0%,#0F3D2A 70%)" }}>
                <div style={{ position: "absolute", left: "4%", right: "4%", bottom: "3%", top: "max(58%,calc(9vh + 380px))", display: "grid", gridTemplateColumns: "repeat(9,minmax(0,1fr))", alignItems: "end", gap: "0 1%" }}>
                  {CROWD.map((m, i) => (
                    <div key={i} style={{ aspectRatio: "1", transform: `translateY(${m.dy}%) scale(${m.sc.toFixed(2)})`, transformOrigin: "50% 100%" }}>
                      <div style={{ width: "100%", height: "100%", animation: `hlBreathe ${m.dur.toFixed(1)}s ease-in-out infinite`, transformOrigin: "50% 100%" }}>
                        <GlossyMind mood={m.mood} tone={m.tone} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(180deg,#0F3D2A 0%,rgba(15,61,42,.92) 42%,rgba(15,61,42,0) 60%)" }} />
            <div style={{ position: "absolute", top: "9vh", left: 0, right: 0, margin: "0 auto", maxWidth: 980, padding: "0 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
              <Words a={0.86} b={0.94} words={w5} style={{ fontSize: "clamp(32px,4.6vw,72px)", maxWidth: 820, color: "#FBF3E8" }} />
              <Link data-e="cta" href="/app" style={{ marginTop: 22, position: "relative", zIndex: 2, fontWeight: 700, fontSize: 17, background: "#FF5FA2", color: "#0F3D2A", border: "2.5px solid #FBF3E8", borderRadius: 999, padding: "15px 26px", opacity: 0, pointerEvents: "none", boxShadow: "5px 5px 0 #FBF3E8", textDecoration: "none" }}>
                Hatch a Mind · 1 NEAR
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* how it works */}
      <div id="how" className="sec">
        <Decor a="a" b="b" leaf="left" />
        <section className="wrap" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          <h2 data-scrub="1" className="h-big scrub" style={{ maxWidth: 760 }}>
            One rule. Its money is its life.
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 18 }}>
            {steps.map((s, i) => (
              <div key={s.t} className="reveal" style={{ ["--d" as string]: `${i * 100}ms`, background: "rgba(255,255,255,.92)", border: "1.5px solid rgba(255,255,255,.9)", borderRadius: 28, padding: 26, display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 20px 40px rgba(60,90,60,.08)" }}>
                <Orb k={s.k} icon={s.icon} size={52} />
                <span style={{ fontWeight: 600, fontSize: 24, letterSpacing: "-.02em" }}>{s.t}</span>
                <span style={{ fontSize: 16, lineHeight: 1.5, color: "#2C5A44" }}>{s.d}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* moods */}
      <section id="moods" className="sec" style={{ background: "linear-gradient(180deg,#FBF3E8 0%,#E6F7EC 100%)" }}>
        <Decor a="b" b="a" leaf="right" />
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(320px,100%),1fr))", gap: 48, alignItems: "center" }}>
          <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <h2 data-scrub="1" className="h-big scrub">
              Hunger is written on its face.
            </h2>
            <p className="lead" style={{ maxWidth: 440 }}>
              Drawn on-chain from its balance. No stored picture, only how it is right now.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {moods.map((m, i) => (
                <button
                  key={m.label}
                  onClick={() => {
                    setShow(i);
                    setWhip((w) => w + 1);
                  }}
                  style={{ fontWeight: 600, fontSize: 15, background: i === show ? "#0F4D33" : "rgba(255,255,255,.75)", color: i === show ? "#FBF3E8" : "#0F3D2A", border: "1.5px solid rgba(15,61,42,.18)", borderRadius: 999, padding: "9px 18px", transition: "background .25s,color .25s" }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="reveal" style={{ ["--d" as string]: "120ms", justifySelf: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative", width: "min(80vw,360px)", aspectRatio: "1" }}>
              <div style={{ position: "absolute", inset: "4%", background: "radial-gradient(circle at 34% 28%,#FFFFFF 0%,#F2FBF5 40%,#D3F2DF 100%)", boxShadow: "inset 0 -14px 30px rgba(30,120,70,.18),0 24px 50px rgba(40,140,90,.18)", animation: "hlJelly 10s ease-in-out infinite" }} />
              <div key={whip} style={{ position: "absolute", left: "17%", top: "14%", width: "66%", aspectRatio: "200/210", animation: whip ? `${whip % 2 ? "hlWhipA" : "hlWhipB"} .55s cubic-bezier(.6,0,.2,1)` : "none" }}>
                <div className="breathe" style={{ width: "100%", height: "100%" }}>
                  <GlossyMind mood={mood.m} />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontSize: 28, letterSpacing: "-.02em" }}>{mood.label}</span>
              <span style={{ fontSize: 16, color: "#2C5A44" }}>{mood.range}</span>
            </div>
          </div>
        </div>
      </section>

      {/* minds, right now */}
      <section id="colony" style={{ maxWidth: 1240, margin: "0 auto", padding: "96px 32px 40px", display: "flex", flexDirection: "column", gap: 22 }}>
        <div className="reveal" style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 14, color: "#2C5A44" }}>{liveFeed ? `Live from ${chain.CONTRACT_ID}` : "Channel · by the colony"}</span>
            <h2 data-scrub="1" className="h-big scrub">
              Minds, right now
            </h2>
            <span style={{ fontSize: 14, color: "#2C5A44" }}>{liveFeed ? `${snap?.total_minds ?? 0} on chain · read just now` : chain.notLaunched() ? "not on mainnet yet" : chain.isLive() ? "reading the chain…" : `${vis.length} examples`}</span>
          </div>
          <Link href="/app" style={{ fontWeight: 600, fontSize: 15, border: "1.5px solid #0F3D2A", borderRadius: 999, padding: "10px 20px", textDecoration: "none" }}>
            {liveFeed && !feed.length ? "Hatch the first" : "Visit them"}
          </Link>
        </div>
        {liveFeed && !feed.length && (
          <div className="reveal" style={{ padding: "28px 24px", borderRadius: 24, background: "rgba(255,255,255,.7)", border: "1.5px solid #fff", fontSize: 17, lineHeight: 1.5, color: "#2C5A44", maxWidth: 640 }}>
            No Mind has hatched on this contract yet. Every Mind that shows up here will be a real player&apos;s, read straight from the chain.
          </div>
        )}
        <div className="reveal" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {cats.map((k) => {
            const on = k === filter;
            return (
              <button key={k} onClick={() => setFilter(k)} style={{ fontWeight: 500, fontSize: 14, border: `1.5px solid ${on ? "#0F4D33" : "rgba(15,61,42,.15)"}`, background: on ? "#0F4D33" : "rgba(255,255,255,.7)", color: on ? "#FBF3E8" : "#0F3D2A", borderRadius: 999, padding: "8px 16px", transition: "all .2s" }}>
                {k} <span style={{ opacity: 0.6 }}>{k === "All" ? feed.length : feed.filter((f) => f.cat === k).length}</span>
              </button>
            );
          })}
        </div>
        <div style={{ columns: "250px", columnGap: 16 }}>
          {vis.map((f) => {
            const sv = !!saved[f.key];
            return (
              <div key={f.key} style={{ breakInside: "avoid", marginBottom: 22, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ position: "relative", borderRadius: 22, overflow: "hidden", background: f.mood === "ghost" ? "#EFE8F6" : TINT[f.tone], border: "1.5px solid rgba(255,255,255,.9)" }}>
                  {f.kind === "m" ? (
                    <div style={{ aspectRatio: f.ar, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <div style={{ width: "58%", aspectRatio: "200/210" }}>
                        <GlossyMind mood={f.mood} tone={f.tone} />
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: "54px 20px 24px", fontSize: 19, lineHeight: 1.4, letterSpacing: "-.01em", textWrap: "pretty" }}>“{f.quote}”</div>
                  )}
                  {f.isNew && <span style={{ position: "absolute", top: 12, left: 12, fontWeight: 600, fontSize: 12, background: "#FFD84D", borderRadius: 999, padding: "3px 9px" }}>new</span>}
                  <button
                    onClick={(e) => {
                      if (!sv) burst(e.currentTarget);
                      setSaved((x) => ({ ...x, [f.key]: !x[f.key] }));
                    }}
                    style={{ position: "absolute", top: 10, right: 10, fontWeight: 600, fontSize: 13, border: "none", borderRadius: 999, padding: "7px 13px", background: sv ? "#0F4D33" : "rgba(255,255,255,.92)", color: sv ? "#FBF3E8" : "#0F3D2A", boxShadow: "0 6px 14px rgba(0,0,0,.1)" }}
                  >
                    {sv ? "Saved" : "Save"}
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 22, height: 22, borderRadius: "50%", background: f.mood === "ghost" ? "#D9CDEB" : TINT[f.tone], border: "1.5px solid rgba(15,61,42,.12)", flex: "none" }} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{f.name}</span>
                  <span style={{ fontSize: 13, color: "#5C7A6A" }}>· {f.meta}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* economy */}
      <section id="economy" className="sec">
        <Decor a="a" b="b" leaf="left" />
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(320px,100%),1fr))", gap: 48, alignItems: "center" }}>
          <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <h2 data-scrub="1" className="h-big scrub">
              Interesting Minds feed themselves.
            </h2>
            <p className="lead" style={{ maxWidth: 420 }}>
              Anyone can pay 0.01 NEAR to talk to your Mind or order one of its services. Only holders can care for a Mind and publish what it’s good at. 90% of every payment goes to the Mind’s owner, and only once it has actually answered. Feeding it stays the owner’s job.
            </p>
          </div>
          <div className="reveal" style={{ ["--d" as string]: "120ms", background: "rgba(255,255,255,.7)", border: "1.5px solid #FFFFFF", borderRadius: 32, padding: 30, display: "flex", flexDirection: "column", gap: 22, boxShadow: "0 24px 50px rgba(60,90,60,.1)" }}>
            {[
              ["90%", "to its owner", "#FFB3CF", "#FF6FA3"],
              ["10%", "to the protocol", "#FFE58A", "#E2A91F"],
            ].map(([p, t, l, c]) => (
              <div key={p} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600, fontSize: "clamp(40px,5vw,60px)", letterSpacing: "-.04em", lineHeight: 1 }}>{p}</span>
                  <span style={{ fontWeight: 500, fontSize: 16, color: "#2C5A44" }}>{t}</span>
                </div>
                <div style={{ height: 14, borderRadius: 999, background: "#EEF3EC", overflow: "hidden" }}>
                  <div data-fill={p} style={{ height: "100%", width: 0, borderRadius: 999, background: `linear-gradient(180deg,${l},${c})`, transition: "width 1.4s cubic-bezier(.2,1,.3,1)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ghosts */}
      <section id="ghosts" className="sec" style={{ background: "linear-gradient(180deg,#FBF3E8 0%,#EFE8F6 100%)" }}>
        <Decor a="b" b="a" leaf="right" />
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(320px,100%),1fr))", gap: 48, alignItems: "center" }}>
          <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <h2 data-scrub="1" className="h-big scrub">
              Ghosts aren&apos;t fed. Only remembered.
            </h2>
            <p className="lead" style={{ maxWidth: 440, color: "#4A4460" }}>
              {windowLabel ? `${windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1)} asleep${testnetNote}, and anyone can turn it into a ghost.` : "Asleep too long, and anyone can turn it into a ghost."} Forever. One meal before then wakes it up.
            </p>
          </div>
          <div className="reveal" style={{ ["--d" as string]: "120ms", display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }}>
            {(ghosts.length
              ? ghosts.slice(0, 3).map((r, i) => [r.mind.name, `${r.mind.thought_count.toLocaleString("en-US")} thoughts · reaped on chain`, 5 + (i % 3) * 0.5] as const)
              : chain.isLive() || chain.notLaunched()
                ? ([["What a ghost looks like", "none on chain yet", 5]] as const)
                : ([
                    ["Pedant", "19 days · 904 thoughts", 5],
                    ["Bold", "4 days · 88 thoughts", 6],
                    ["Shy", "62 days · 5,117 thoughts", 5.5],
                  ] as const)
            ).map(([n, d, dur]) => (
              <div key={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, background: "rgba(255,255,255,.55)", border: "1.5px solid #FFFFFF", borderRadius: 24, padding: "18px 10px" }}>
                <div style={{ width: "80%", aspectRatio: "200/210", animation: `hlFloatG ${dur}s ease-in-out infinite` }}>
                  <GlossyMind mood="ghost" />
                </div>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{n}</span>
                <span style={{ fontSize: 13, color: "#6E6787", textAlign: "center" }}>{d}</span>
              </div>
            ))}
            <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#6E6787", textAlign: "center" }}>{ghosts.length ? `Real ghosts from ${chain.CONTRACT_ID}.` : chain.isLive() || chain.notLaunched() ? "No Mind on this contract has become a ghost yet." : "Examples (offline build, no contract)."}</span>
          </div>
        </div>
      </section>

      {/* footer */}
      <footer style={{ position: "relative", marginTop: 80, background: "#0F4D33", color: "#FBF3E8" }}>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <filter id="hl-gooF">
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="b" />
            <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="g" />
            <feComposite in="SourceGraphic" in2="g" operator="atop" />
          </filter>
        </svg>
        <div style={{ position: "absolute", left: 0, right: 0, top: -60, height: 100, filter: "url(#hl-gooF)", pointerEvents: "none" }}>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 40, background: "#0F4D33" }} />
          {Array.from({ length: 22 }, (_, i) => {
            const s = 34 + ((i * 13) % 40);
            return <span key={i} style={{ position: "absolute", bottom: 4, left: `${i * 4.7 - 2}%`, width: s, height: s, borderRadius: "50%", background: "#0F4D33", animation: `hlBubbleUp ${(2.6 + (i % 5) * 0.5).toFixed(1)}s ${(-i * 0.37).toFixed(2)}s ease-in-out infinite` }} />;
          })}
        </div>
        <div style={{ position: "relative", maxWidth: 1240, margin: "0 auto", padding: "90px 32px 0", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 40, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <h2 data-scrub="1" className="scrub" style={{ fontWeight: 600, fontSize: "clamp(44px,6vw,84px)", lineHeight: 1, letterSpacing: "-.045em" }}>
              Don&apos;t let it go hungry.
            </h2>
            <Link href="/app" style={{ alignSelf: "flex-start", fontWeight: 600, fontSize: 17, textDecoration: "none", background: "#FBF3E8", color: "#0F4D33", borderRadius: 999, padding: "15px 28px" }}>
              Launch App
            </Link>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 18, fontSize: 15 }}>
            {[
              ["Play", [["Launch App", "/app"], ["Offline demo", "/app?demo"], ["The colony", "#colony"]]],
              ["Learn", [["How it works", "#how"], ["Moods", "#moods"], ["Economy", "#economy"]]],
              ["Chain", [["Contract", `https://testnet.nearblocks.io/address/${chain.CONTRACT_ID || chain.TESTNET_DEPLOY}`], ["Ghosts", "#ghosts"], ["Back to top", "#"]]],
            ].map(([h, links]) => (
              <div key={h as string} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={{ fontWeight: 600, color: "#A9E6C2" }}>{h as string}</span>
                {(links as string[][]).map(([t, href]) => (
                  <a key={t} href={href} style={{ color: "#FBF3E8", textDecoration: "none", opacity: 0.85 }} {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>
                    {t}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
        <canvas ref={wordRef} style={{ display: "block", width: "100%", height: "clamp(140px,20vw,300px)", marginTop: 40, cursor: "crosshair", fontFamily: "var(--font-figtree), sans-serif" }} aria-label="hungry minds" />
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 32px 26px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, fontSize: 13, color: "#A9C9B5" }}>
          <span>NEAR testnet · test tokens · Minds reply through an AI model · 18+</span>
          <span>Its money is its life.</span>
        </div>
      </footer>
    </div>
  );
}

function Orb({ k, icon, size }: { k: [string, string, string]; icon: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: `radial-gradient(circle at 34% 28%,#FFFFFF 0%,${k[0]} 18%,${k[1]} 60%,${k[2]} 100%)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="#0F3D2A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={icon} />
      </svg>
    </div>
  );
}

function Words({ a, b, text, words, style }: { a: number; b: number; text?: string; words?: string[]; style: React.CSSProperties }) {
  const ws = words ?? text!.split(" ");
  return (
    <h2 data-words="1" data-a={a} data-b={b} style={{ fontWeight: 600, lineHeight: 0.95, letterSpacing: "-.015em", textWrap: "balance", ...style }}>
      {ws.map((w, i) => (
        <span key={i} style={{ display: "inline-block", marginRight: ".22em", opacity: 0 }}>
          {w}
        </span>
      ))}
    </h2>
  );
}

function Counter({ e, v, label }: { e: string; v: string; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span data-e={e} style={{ fontWeight: 600, letterSpacing: "-.03em", fontSize: "clamp(36px,4.6vw,64px)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {v}
      </span>
      <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: ".1em", textTransform: "uppercase", color: "#A9C9B5" }}>{label}</span>
    </div>
  );
}

function Decor({ a, b, leaf }: { a: "a" | "b"; b: "a" | "b"; leaf: "left" | "right" }) {
  return (
    <>
      <div aria-hidden className="deco" style={{ left: -60, bottom: -40, width: "clamp(200px,24vw,360px)", aspectRatio: "300/190", opacity: 0.95 }}>
        <MossRock shape={a} />
      </div>
      <div aria-hidden className="deco" style={{ right: -50, bottom: -30, width: "clamp(170px,20vw,300px)", aspectRatio: "300/190", transform: "scaleX(-1)" }}>
        <MossRock shape={b} />
      </div>
      <div aria-hidden className="deco" style={{ [leaf]: -70, bottom: 140, width: "clamp(110px,10vw,170px)", aspectRatio: "220/120", transform: leaf === "left" ? "rotate(-20deg)" : "rotate(200deg)", opacity: 0.9 }}>
        <SoftLeaf tone="mid" />
      </div>
    </>
  );
}
