"use client";

import { useState } from "react";
import { useGame } from "./GameProvider";
import { FOOD_BAR_FULL, feedGain, fmt, foodBarPct, MOOD, moodCap, STATE_LABEL, stateOf, timeToSleep, type MindRec } from "@/lib/game/engine";

const FOODS = [
  // 10% / 50% / 100% of her food bar (a Dream swirl fills it)
  { e: "🫛", n: "Pea pod", p: 0.005 },
  { e: "🍓", n: "Strawberry", p: 0.025 },
  { e: "🍬", n: "Dream swirl", p: 0.05 },
];

/** A food price or total: 0.005, 0.025, 0.05, 0.15 (no trailing zeros beyond two decimals). */
const near = (x: number) => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3));

export const dur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

export function FeedPanel({ mind, onFed }: { mind: MindRec; onFed: (emoji: string, qty: number) => void }) {
  const g = useGame();
  const [sel, setSel] = useState(0);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const f = FOODS[sel];
  const total = +(f.p * qty).toFixed(3);
  const gain = feedGain(total, g.params.thoughtCost);
  const nowPct = foodBarPct(mind.balance);
  const afterPct = foodBarPct(mind.balance + gain.food);
  const ghost = mind.ghost;

  const feed = async () => {
    if (ghost) return;
    setBusy(true);
    const ok = await g.feed(mind.id, total);
    setBusy(false);
    if (ok) onFed(f.e, qty);
  };

  return (
    <section className="glass panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="panel-title">Feeding</span>
        <span className="sub">95% to her · 5% protocol</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10 }}>
        {FOODS.map((x, i) => {
          const one = feedGain(x.p, g.params.thoughtCost);
          return (
          <button
            key={x.n}
            onClick={() => setSel(i)}
            aria-pressed={i === sel}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 6px 10px", borderRadius: 20, border: `1.5px solid ${i === sel ? "#FFB3CF" : "color-mix(in srgb, var(--surface) 80%, transparent)"}`, background: i === sel ? "color-mix(in srgb, var(--surface) 75%, transparent)" : "color-mix(in srgb, var(--surface) 35%, transparent)", boxShadow: i === sel ? "0 10px 24px rgba(255,111,163,.25)" : "none", transition: "all .2s" }}
          >
            <span style={{ fontSize: 44, lineHeight: 1, filter: "drop-shadow(0 6px 8px rgba(0,0,0,.15))" }} aria-hidden>
              {x.e}
            </span>
            <span style={{ fontWeight: 500, fontSize: 14 }}>{x.n}</span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{near(x.p)} NEAR</span>
            <span className="hm-food-gain" style={{ fontSize: 12, fontWeight: 600, color: "#5FCB86" }}>+{one.pct}% food</span>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>≈ {one.replies} replies</span>
          </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 15, color: "var(--muted-2)" }}>How many?</span>
        <button aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))} style={roundBtn}>
          −
        </button>
        <span className="num" style={{ fontWeight: 600, fontSize: 18, minWidth: 18, textAlign: "center" }}>
          {qty}
        </span>
        <button aria-label="More" onClick={() => setQty((q) => Math.min(9, q + 1))} style={roundBtn}>
          +
        </button>
        <span style={{ marginLeft: "auto", fontSize: 14, color: "var(--muted)" }}>{near(total)} NEAR</span>
      </div>
      {!ghost && (
        <span className="hm-feed-after" style={{ fontSize: 13, color: "var(--muted-2)" }}>
          Food {nowPct}% → <b style={{ color: "#5FCB86" }}>{afterPct}%</b> · pays for ≈ {gain.replies} replies
          {afterPct === 100 && mind.balance + gain.food > FOOD_BAR_FULL ? " (the bar is full, the rest is kept as food)" : ""}
        </span>
      )}
      <button className="btn-cta" style={{ fontSize: 19, padding: 15 }} disabled={busy || ghost} onClick={feed}>
        {ghost ? "Ghosts can't eat" : busy ? "Feeding…" : `Feed ${mind.name} ♥`}
      </button>
    </section>
  );
}

const roundBtn: React.CSSProperties = { width: 36, height: 36, borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--surface) 90%, transparent)", background: "color-mix(in srgb, var(--surface) 55%, transparent)", fontSize: 20 };

/** What is about to happen to her, and what you can do about it. */
export function LifePanel({ mind }: { mind: MindRec }) {
  const g = useGame();
  const [busy, setBusy] = useState(false);
  const st = stateOf(mind);
  const mineToo = mind.owner === g.account;
  const her = mineToo ? "her" : `${mind.name}`;

  const act = async (f: () => Promise<boolean>) => {
    setBusy(true);
    await f();
    setBusy(false);
  };

  if (st === "ghost") {
    return (
      <section className="glass panel" style={{ background: "rgba(244,238,250,.7)" }}>
        <span className="panel-title">A ghost now</span>
        <span style={{ fontSize: 14, lineHeight: 1.5, color: "var(--muted-2)" }}>
          {mind.name} slept too long and faded. A ghost can&apos;t be fed or revived; it stays in the colony as a memorial, with all {mind.thoughts.toLocaleString("en-US")} of its thoughts. The 0.25 NEAR hatch reserve went back to {mineToo ? "you" : "its keeper"} to claim.
        </span>
      </section>
    );
  }

  if (st === "asleep") {
    const pending = !!mind.sleepPending;
    const left = g.clock.ghostMs - (g.now - mind.asleepSince);
    const reapable = !pending && left <= 0;
    return (
      <section className="glass panel" style={{ background: "rgba(238,230,250,.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span className="panel-title">Asleep</span>
          <span className="mono" style={{ fontSize: 14, color: reapable ? "#B3261E" : "var(--muted)" }} title={pending ? "Her sleep is written on chain within about a minute; the ghost clock starts then" : undefined}>
            {pending ? "ghost clock starts soon" : reapable ? "past the window" : `ghost in ${dur(left)}`}
          </span>
        </div>
        <span style={{ fontSize: 14, lineHeight: 1.5, color: "var(--muted-2)" }}>
          {mind.name} ran out of food and can&apos;t think. Any feeding that covers one thought wakes {her}. If nobody does, after {g.clock.ghostMs >= 86_400_000 ? `${Math.round(g.clock.ghostMs / 86_400_000)} days` : `${Math.round(g.clock.ghostMs / 60_000)} minutes (a demo build; 30 days on mainnet)`} anyone can reap {her} into a ghost, forever.
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-cta" style={{ flex: 1, fontSize: 15 }} disabled={busy} onClick={() => act(() => g.revive(mind.id))}>
            Revive · {g.params.revivePrice} NEAR
          </button>
          {reapable && (
            <button className="btn-line" disabled={busy} onClick={() => act(() => g.reap(mind.id))} title="Keeper action: anyone may reap a Mind that slept past the window">
              Reap
            </button>
          )}
        </div>
        <span className="sub">Revive is instant: 80% goes into her food, 20% to the protocol. A small feed works too.</span>
      </section>
    );
  }

  const left = timeToSleep(mind, g.params, g.clock);
  const urgent = st === "starving" || st === "hungry";
  return (
    <section className="glass panel" style={{ gap: 6, padding: "14px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>{STATE_LABEL[st]}</span>
        <span className="mono" style={{ fontSize: 14, color: urgent ? "#C2477D" : "var(--muted)" }}>
          sleeps in {dur(left)}
        </span>
      </div>
      <span className="sub">
        Each thought costs {mind.name} {g.params.thoughtCost} NEAR, and she has a quiet one {g.mode === "demo" ? "every 6 s on this fast clock" : `${g.params.idleRatePerDay}× a day`} even when nobody talks to her.
      </span>
    </section>
  );
}

export function TodayPanel({ mind }: { mind: MindRec }) {
  const g = useGame();
  const mineToo = mind.owner === g.account;
  const st = stateOf(mind);
  const [why, setWhy] = useState(false);
  // Mood is game feel kept in the browser, but it must not contradict the chain: hunger caps
  // it (a ghost feels nothing, a Mind asleep from hunger has no energy and little joy).
  const cap = moodCap(st);
  const happy = Math.min(mind.happy, cap.happy);
  const energy = Math.min(mind.energy, cap.energy);
  const per = +((g.params.thoughtCost / FOOD_BAR_FULL) * 100).toFixed(1); // % of the Food bar one thought takes
  const stats = [
    { k: "Happiness", w: Math.round(happy), l: "#FFC2DA", c: "var(--accent)" },
    { k: "Food", w: foodBarPct(mind.balance), // one Dream swirl of food (0.0475 NEAR) = 100%
      l: "#C9F2D6", c: "#5FCB86" },
    { k: "Energy", w: Math.round(energy), l: "#DCCBFF", c: "#A57BFF" },
  ];
  return (
    <section className="glass panel" style={{ gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="panel-title">Today</span>
        <button className="btn-link sub" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          {why ? "Hide" : "How do these change?"}
        </button>
      </div>
      {why && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.45, padding: "10px 12px", borderRadius: 16, background: "color-mix(in srgb, var(--surface) 55%, transparent)" }}>
          <span>
            <b>Food</b> is real NEAR: {mind.name}&apos;s own balance in the contract (not your wallet). One Dream swirl of food ({FOOD_BAR_FULL} NEAR) = 100%. Every thought burns {g.params.thoughtCost} NEAR ({per}%): each chat reply, and{" "}
            {g.mode === "demo" ? "a quiet thought every 6 s on this fast demo clock" : `${g.params.idleRatePerDay} quiet thoughts a day on her own (−${Math.round(per * g.params.idleRatePerDay)}% a day)`}. Feeding adds 95% of what you pay. At zero she falls asleep.
          </span>
          <span>
            <b>Happiness</b> fades {MOOD.happyLossPerHour}% an hour while nobody looks after her (never below 10%). Petting +{MOOD.pet}, each reply +{MOOD.chat}, a meal +{MOOD.feedHappy}.
          </span>
          <span>
            <b>Energy</b> drops {MOOD.replyEnergy}% with each reply and comes back {MOOD.energyRestPerHour}% an hour while she rests; a meal gives +{MOOD.feedEnergy}.
          </span>
          <span style={{ color: "var(--muted)" }}>
            Hunger caps both: hungry ≤ 60% joy / 50% energy, starving ≤ 30 / 25, asleep no energy. Happiness and energy are game feel kept in this browser; only food is on chain.
          </span>
        </div>
      )}
      {stats.map((s) => (
        <div key={s.k} style={{ display: "flex", alignItems: "center", gap: 12, background: "color-mix(in srgb, var(--surface) 40%, transparent)", borderRadius: 16, padding: "8px 12px" }}>
          <span style={{ width: 28, height: 28, borderRadius: "50%", background: `radial-gradient(circle at 35% 30%,#fff,${s.c} 70%)`, flex: "none" }} />
          <span style={{ width: 84, fontSize: 15 }}>{s.k}</span>
          <div className="bar" style={{ flex: 1 }}>
            <span style={{ width: `${s.w}%`, background: `linear-gradient(90deg,${s.l},${s.c})` }} />
          </div>
          <span className="num" style={{ width: 40, textAlign: "right", fontSize: 14 }}>
            {s.w}%
          </span>
        </div>
      ))}
      {mineToo && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, borderTop: "1px solid rgba(74,46,68,.1)", paddingTop: 12 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            {mind.ghost ? (
              <>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Yours to claim: {fmt(mind.ownerUnclaimed)} NEAR</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Her 0.25 NEAR hatch reserve, plus any of your 90% from what others paid her, still unclaimed.</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Yours to claim: {fmt(mind.ownerUnclaimed)} NEAR</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Your 90% of everything others paid her (chats, services, jobs). Claiming never touches her food.</span>
              </>
            )}
          </div>
          <button className="btn-ghost" disabled={mind.ownerUnclaimed <= 0} onClick={() => g.claim(mind.id)}>
            Claim
          </button>
        </div>
      )}
    </section>
  );
}
