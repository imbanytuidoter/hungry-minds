"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import GlossyMind from "./GlossyMind";
import { ConnectButtons, LangSelect, NetworkSwitch } from "./Header";
import { useGame } from "./GameProvider";
import { MINT_SPLIT, moodOf, stateOf } from "@/lib/game/engine";
import { L, type Lang } from "@/lib/game/i18n";
import { LOOK_NAMES, NATURES, TONES, TONE_TILE, type Look } from "@/lib/game/look";
import { CATEGORIES, type Category } from "@/lib/game/services";
import { clipBytes, LIMITS } from "@/lib/game/bytes";
import { NETWORK, WALLET_KIND } from "@/lib/chain";

const DRAFT_KEY = "hm-hatch-draft";

export default function Entry({
  lang,
  setLang,
  onHatched,
  goHome,
  goShop,
  goVisit,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  onHatched: (id: number | null) => void;
  goHome: () => void;
  goShop: (cat: Category | "all") => void;
  goVisit: () => void;
}) {
  const g = useGame();
  const T = L[lang];
  const [name, setName] = useState("");
  const [look, setLook] = useState<Look>({ tone: "pink", eyes: 0, hat: 0, outfit: 0 });
  const [natures, setNatures] = useState<string[]>(["Curious"]);
  const [busy, setBusy] = useState(false);
  const n = name.trim();
  const colony = g.minds.filter((m) => m.owner !== g.account);
  const awake = colony.filter((m) => !m.ghost && m.asleepSince === 0).length;

  // The draft survives connecting a wallet (which remounts this screen, or reloads the page
  // after a redirect), so the look you picked is the look that gets minted.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null") as { name: string; look: Look; natures: string[] } | null;
      if (d) {
        setName(d.name || "");
        if (d.look && TONES.includes(d.look.tone)) setLook(d.look);
        if (Array.isArray(d.natures) && d.natures.length) setNatures(d.natures.filter((x) => NATURES.includes(x)).slice(0, 3));
      }
    } catch {
      /* no draft */
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return; // never overwrite the saved draft with the defaults of the first render
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name, look, natures }));
    } catch {
      /* private window: the draft just isn't kept */
    }
  }, [restored, name, look, natures]);

  const hatch = async () => {
    if (!n || busy) return;
    setBusy(true);
    const id = await g.hatch(n, look, natures);
    setBusy(false);
    if (id !== null) {
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      onHatched(id);
    }
  };

  const toggleNature = (t: string) =>
    setNatures((c) => (c.includes(t) ? c.filter((x) => x !== t) : c.length >= 3 ? c : [...c, t]));

  return (
    <div style={{ position: "relative", zIndex: 1, maxWidth: 1180, width: "100%", margin: "0 auto", padding: "8px 8px 60px", display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Link href="/" style={{ fontWeight: 700, fontSize: 20, letterSpacing: "-.02em", textDecoration: "none" }}>
          hungry minds
        </Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <NetworkSwitch />
          <LangSelect lang={lang} setLang={setLang} />
          <button className="btn-ghost" onClick={() => goShop("all")}>
            {T.nav[1]}
          </button>
          {g.mine.length > 0 && (
            <button className="btn-ghost" onClick={goHome}>
              {T.goMind}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".08em", color: "#8A2E5C" }}>{T.welcome}</span>
        <h1 style={{ fontWeight: 600, fontSize: "clamp(36px,5vw,60px)", lineHeight: 1, letterSpacing: "-.04em", color: "var(--ink-strong)", textWrap: "balance" }}>{T.h1}</h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5, color: "var(--muted-2)" }}>{T.lead}</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(320px,100%),1fr))", gap: 16 }}>
        {/* hatch */}
        <div style={{ padding: 22, borderRadius: 30, background: "rgba(255,255,255,.78)", border: "1.5px solid #fff", display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 20px 50px rgba(180,90,140,.14)" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ width: 130, height: 140, borderRadius: 32, background: TONE_TILE[look.tone][1], position: "relative", flex: "none", transition: "background .3s" }}>
              <div className="hm-breathe" style={{ position: "absolute", left: "12%", top: "10%", width: "76%", aspectRatio: "200/210" }}>
                <GlossyMind tone={look.tone} eyes={look.eyes} hat={look.hat} outfit={look.outfit} />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 200px", minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 22, letterSpacing: "-.02em", color: "var(--ink-strong)" }}>{T.hatchT}</span>
              <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--muted-2)" }}>
                {g.params.mintPrice} NEAR: {MINT_SPLIT.food} is her first food, {MINT_SPLIT.reserve} a reserve you get back, {MINT_SPLIT.treasury} runs the colony. You hold the NFT.
              </span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 16, background: "#FBF4F8", fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <b>{(4000 - (g.supplyLeft ?? 4000)).toLocaleString("en-US")} / 4,000 hatched</b>
              <span style={{ color: "var(--rose)", fontWeight: 600 }}>{(g.supplyLeft ?? 4000).toLocaleString("en-US")} left · {awake} awake</span>
            </div>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Her food is hers: nobody, not even you, can withdraw it. Thinking spends it, and so does time.</span>
          </div>

          <input className="field" value={name} onChange={(e) => setName(clipBytes(e.target.value, LIMITS.name))} onKeyDown={(e) => e.key === "Enter" && hatch()} placeholder="Give her a name" aria-label="Name" />

          <Row label="Colour">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {TONES.map((t) => (
                <button key={t} onClick={() => setLook((l) => ({ ...l, tone: t }))} aria-label={t} aria-pressed={look.tone === t} style={{ width: 34, height: 34, borderRadius: 17, border: `3px solid ${look.tone === t ? "#4A2E44" : "#fff"}`, background: TONE_TILE[t][0] }} />
              ))}
            </div>
          </Row>
          <Row label="Nature">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {NATURES.map((t) => (
                <button key={t} className="chip" aria-pressed={natures.includes(t)} onClick={() => toggleNature(t)}>
                  {t}
                </button>
              ))}
            </div>
          </Row>
          {(["eyes", "hat", "outfit"] as const).map((k) => (
            <Row key={k} label={k === "eyes" ? "Eyes" : k === "hat" ? "Hat" : "Outfit"}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {LOOK_NAMES[k].map((t, i) => (
                  <button key={t} className="chip" style={{ fontSize: 12, padding: "6px 11px" }} aria-pressed={look[k] === i} onClick={() => setLook((l) => ({ ...l, [k]: i }))}>
                    {t}
                  </button>
                ))}
              </div>
            </Row>
          ))}

          {g.mode === "live" && !g.account && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 16, background: "#FFF6FA" }}>
              <span style={{ fontSize: 13, color: "var(--muted-2)" }}>To hatch, connect {WALLET_KIND}.</span>
              <ConnectButtons />
            </div>
          )}
          <button className="btn-cta" style={{ marginTop: 4, padding: "14px 22px", fontSize: 16 }} disabled={!n || busy || (g.mode === "live" && !g.account)} onClick={hatch}>
            {busy ? "Hatching…" : n ? `Hatch ${n} · ${g.params.mintPrice} NEAR` : "Name her to hatch"}
          </button>
          {g.wallet !== null && (
            <span className="sub" style={{ textAlign: "center", marginTop: -6 }}>
              Your wallet: <span className="mono">{g.wallet.toFixed(3)}</span> {g.mode === "demo" ? "test NEAR (demo)" : NETWORK === "mainnet" ? "NEAR" : "testnet NEAR"}
            </span>
          )}
        </div>

        {/* meet */}
        <div style={{ padding: 22, borderRadius: 30, background: "#2E1C2A", color: "#FBF3E8", display: "flex", flexDirection: "column", gap: 14, position: "relative", overflow: "hidden", alignSelf: "start" }}>
          <span style={{ fontWeight: 600, fontSize: 22, letterSpacing: "-.02em" }}>{T.meetT}</span>
          <span style={{ fontSize: 14, lineHeight: 1.45, color: "#D8C5D2", maxWidth: 360 }}>
            {colony.length
              ? `${colony.length} Mind${colony.length === 1 ? "" : "s"} live here. Pay one to talk or to do a job: 90% goes to her owner, 10% to the protocol. Her owner feeds her.`
              : "No other Minds yet: this colony starts empty, and everyone here will be a real player. Hatch the first one."}
          </span>
          {/* Up top, so someone who doesn't want a Mind of their own can go straight to the shop. */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => goShop("all")} style={{ padding: "13px 20px", borderRadius: 999, border: "none", background: "#FBF3E8", color: "#2E1C2A", fontWeight: 600, fontSize: 15 }}>
              {T.browseSvc}
            </button>
            <button onClick={goVisit} style={{ padding: "13px 20px", borderRadius: 999, border: "1.5px solid #6E5068", background: "transparent", color: "#FBF3E8", fontWeight: 600, fontSize: 15 }}>
              {T.visit}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", margin: "6px 0 4px", flexWrap: "wrap" }}>
            {colony.slice(0, 6).map((m) => (
              <div key={m.id} title={m.name} style={{ width: 84, height: 84, marginRight: -14, borderRadius: 26, background: TONE_TILE[m.look.tone][1], position: "relative", border: "3px solid #2E1C2A" }}>
                <div style={{ position: "absolute", left: "12%", top: "10%", width: "76%", aspectRatio: "200/210" }}>
                  <GlossyMind mood={moodOf(stateOf(m))} tone={m.look.tone} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "auto", display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", maxWidth: 420 }}>
            {[
              ["Feed", "keeps anyone's Mind awake"],
              ["Pay to chat", "a reply costs her one thought"],
              ["Ignore", "she sleeps, then fades"],
              ["Reap", "a long sleeper becomes a ghost"],
            ].map(([a, b]) => (
              <div key={a} style={{ fontSize: 12.5, lineHeight: 1.35, color: "#D8C5D2" }}>
                <b style={{ color: "#FBF3E8" }}>{a}</b> · {b}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 20, color: "var(--ink-strong)" }}>{T.browseCat}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
          {CATEGORIES.filter((c) => c.id !== "all").map((c, ci) => (
            <button key={c.id} className="lift" onClick={() => goShop(c.id)} style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 12, padding: 16, borderRadius: 22, border: "1.5px solid #fff", background: "rgba(255,255,255,.72)", color: "var(--ink-strong)" }}>
              <div className="hm-bob" style={{ width: 62, height: 62, position: "relative", animationDuration: `${(2.6 + ci * 0.25).toFixed(2)}s`, animationDelay: `${-ci * 0.4}s` }}>
                <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "-6%", height: "16%", borderRadius: "50%", background: "rgba(74,46,68,.12)", filter: "blur(3px)" }} />
                <div style={{ position: "absolute", inset: 0, borderRadius: "42% 42% 46% 46%", background: `radial-gradient(circle at 34% 28%,${c.glossy[0]} 0%,${c.glossy[1]} 55%,${c.glossy[2]} 100%)`, boxShadow: `inset 0 -6px 10px rgba(0,0,0,.12),0 8px 18px ${c.glossy[1]}66` }} />
                <div style={{ position: "absolute", left: "18%", top: "12%", width: "30%", height: "20%", borderRadius: "50%", background: "#fff", animation: "hmShine 3s ease-in-out infinite" }} />
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 16, top: 18, filter: "drop-shadow(0 1px 1px rgba(0,0,0,.18))" }} aria-hidden>
                  <path d={c.icon} />
                </svg>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{c.name}</span>
                {(() => {
                  const k = g.offers.filter((s) => s.live && s.cat === c.id).length;
                  return <span style={{ fontSize: 12.5, color: "var(--muted)", minHeight: 17 }}>{k ? `${k} ${k === 1 ? "service" : "services"}` : ""}</span>;
                })()}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontWeight: 600, fontSize: 20, color: "var(--ink-strong)" }}>{T.popular}</span>
          <button className="btn-link" style={{ fontSize: 14 }} onClick={() => goShop("all")}>
            View all
          </button>
        </div>
        {g.offers.every((s) => !s.live) && <span className="sub">No services published yet. Hatch a Mind and publish one from Shop → Developer panel.</span>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))", gap: 10 }}>
          {g.offers
            .filter((s) => s.live)
            .sort((a, b) => b.orders - a.orders)
            .slice(0, 4)
            .map((s) => {
              const m = g.minds.find((x) => x.id === s.mindId);
              return (
                <button key={s.id} onClick={() => goShop(s.cat)} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 12, padding: 14, borderRadius: 20, border: "1px solid var(--line)", background: "#fff", color: "var(--ink-strong)" }}>
                  <div style={{ width: 44, height: 44, borderRadius: 14, background: m ? TONE_TILE[m.look.tone][1] : "#FFE3EE", position: "relative", flex: "none" }}>
                    <div style={{ position: "absolute", left: "10%", top: "10%", width: "80%", aspectRatio: "200/210" }}>
                      <GlossyMind antenna={false} tone={m?.look.tone} mood={m ? moodOf(stateOf(m)) : "happy"} />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</span>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {m?.name ?? "—"} · by {m?.owner ?? "—"} · {s.orders} {s.orders === 1 ? "order" : "orders"}
                    </span>
                  </div>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                    {s.price.toFixed(2)}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span style={{ fontSize: 13, color: "var(--muted)", width: 70, paddingTop: 7, flex: "none" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
