"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "@/components/Logo";
import ModeToggle from "@/components/ModeToggle";
import GlossyMind from "./GlossyMind";
import { ConnectButtons, NetworkSwitch } from "./Header";
import { useGame } from "./GameProvider";
import { fmt, MINT_SPLIT, moodOf, stateOf } from "@/lib/game/engine";
import { L, type Lang } from "@/lib/game/i18n";
import { LOOK_NAMES, NATURES, TONES, TONE_TILE, type Look } from "@/lib/game/look";
import { CATEGORIES, type Category } from "@/lib/game/services";
import { clipBytes, LIMITS } from "@/lib/game/bytes";
import { NETWORK, WALLET_KIND } from "@/lib/chain";
import { useForSale } from "./AfterSale";

const DRAFT_KEY = "hm-hatch-draft";

export default function Entry({
  lang,
  onHatched,
  goHome,
  goShop,
  goVisit,
  goBuy,
}: {
  lang: Lang;
  onHatched: (id: number | null) => void;
  goHome: () => void;
  goShop: (cat: Category | "all") => void;
  goVisit: () => void;
  goBuy: () => void;
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
    // a name passed in the link (/app?hatch=1&name=Pip) wins over an older draft
    const fromLink = new URLSearchParams(window.location.search).get("name");
    if (fromLink) setName(clipBytes(fromLink.trim(), LIMITS.name));
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
      <div className="hm-entry-top" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }} aria-label="Hungry Minds home">
          <Logo />
        </Link>
        <div className="hm-entry-tools" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <NetworkSwitch />
          <Link className="btn-ghost" href="/guide" style={{ textDecoration: "none" }}>
            Guide
          </Link>
          <button className="btn-ghost hm-entry-shop" onClick={() => goShop("all")}>
            {T.nav[1]}
          </button>
          <ModeToggle />
          {g.mine.length > 0 && (
            <button className="btn-ghost" onClick={goHome}>
              {T.goMind}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
        <h1 style={{ fontWeight: 600, fontSize: "clamp(36px,5vw,60px)", lineHeight: 1, letterSpacing: "-.04em", color: "var(--ink-strong)", textWrap: "balance" }}>{T.h1}</h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5, color: "var(--muted-2)" }}>{T.lead}</p>
      </div>

      <div className="hm-entry-grid">
        {/* hatch */}
        <div style={{ padding: 20, borderRadius: 28, background: "color-mix(in srgb, var(--surface) 78%, transparent)", border: "1.5px solid #fff", display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 20px 50px rgba(180,90,140,.14)" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <Logo size={76} word={false} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 200px", minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 22, letterSpacing: "-.02em", color: "var(--ink-strong)" }}>{T.hatchT}</span>
              <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--muted-2)" }}>
                Costs {g.params.mintPrice} NEAR. {MINT_SPLIT.food} becomes her first food, {MINT_SPLIT.reserve} is a reserve you get back if she ever turns into a ghost, and {MINT_SPLIT.treasury} goes to the protocol treasury. The NFT is yours.
              </span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 16, background: "var(--surface-soft)", fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <b>{(4000 - (g.supplyLeft ?? 4000)).toLocaleString("en-US")} / 4,000 hatched</b>
              <span style={{ color: "var(--rose)", fontWeight: 600 }}>{(g.supplyLeft ?? 4000).toLocaleString("en-US")} left · {awake} awake</span>
            </div>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Nobody can take her food out, you included. Every reply and every day uses up a little of it.</span>
          </div>

          <input className="field" style={{ width: "100%", minWidth: 0 }} value={name} onChange={(e) => setName(clipBytes(e.target.value, LIMITS.name))} onKeyDown={(e) => e.key === "Enter" && hatch()} placeholder="Give her a name" aria-label="Name" />

          {/* the choices on the left, her picture large on the right (on top on a phone), sticky
              so every hat and outfit shows the moment it is picked */}
          <div className="hm-hatch-look">
          <div className="hm-tile hm-hatch-preview" title="Her look" style={{ background: TONE_TILE[look.tone][1], transition: "background .3s" }}>
            <div style={{ position: "absolute", left: "10%", top: "8%", width: "80%", aspectRatio: "200/210" }}>
              <GlossyMind tone={look.tone} eyes={look.eyes} hat={look.hat} outfit={look.outfit} />
            </div>
            {name.trim() && <span className="hm-hatch-name">{name.trim()}</span>}
          </div>
          <div className="hm-hatch-opts">
          <Row label="Colour">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {TONES.map((t) => (
                <button key={t} onClick={() => setLook((l) => ({ ...l, tone: t }))} aria-label={t} aria-pressed={look.tone === t} style={{ width: 34, height: 34, borderRadius: 17, border: `3px solid ${look.tone === t ? "var(--ink)" : "#fff"}`, background: TONE_TILE[t][0] }} />
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
          </div>
          </div>

          {g.mode === "live" && !g.account && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 16, background: "var(--surface-soft)" }}>
              <span style={{ fontSize: 13, color: "var(--muted-2)" }}>To hatch, connect {WALLET_KIND}.</span>
              <ConnectButtons />
            </div>
          )}
          <button className="btn-cta" style={{ marginTop: 4, padding: "14px 22px", fontSize: 16 }} disabled={!n || busy || (g.mode === "live" && !g.account)} onClick={hatch}>
            {busy ? "Hatching…" : n ? `Hatch ${n} · ${g.params.mintPrice} NEAR` : "Name her to hatch"}
          </button>
          <BuyInstead onBuy={goBuy} />
          {g.wallet !== null && (
            <span className="sub" style={{ textAlign: "center", marginTop: -6 }}>
              Your wallet: <span className="mono">{g.wallet.toFixed(3)}</span> {g.mode === "demo" ? "test NEAR (demo)" : NETWORK === "mainnet" ? "NEAR" : "testnet NEAR"}
            </span>
          )}
        </div>

        {/* meet */}
        <div style={{ padding: 22, borderRadius: 30, background: "var(--dark)", color: "var(--dark-ink)", display: "flex", flexDirection: "column", gap: 12, position: "relative", overflow: "hidden" }}>
          <span style={{ fontWeight: 600, fontSize: 22, letterSpacing: "-.02em" }}>{T.meetT}</span>
          <span style={{ fontSize: 14, lineHeight: 1.45, color: "var(--dark-muted)", maxWidth: 360 }}>
            {colony.length
              ? `${colony.length === 1 ? "1 Mind lives here. Pay her" : `${colony.length} Minds live here. Pay any of them`} to chat or to do a job: her owner gets 90%, the protocol 10%.`
              : "Nobody has hatched a Mind yet. Yours can be the first."}
          </span>
          {/* Up top, so someone who doesn't want a Mind of their own can go straight to the shop. */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => goShop("all")} style={{ padding: "13px 20px", borderRadius: 999, border: "none", background: "var(--dark-ink)", color: "var(--dark)", fontWeight: 600, fontSize: 15 }}>
              {T.browseSvc}
            </button>
            <button onClick={goVisit} style={{ padding: "13px 20px", borderRadius: 999, border: "1.5px solid #6E5068", background: "transparent", color: "var(--dark-ink)", fontWeight: 600, fontSize: 15 }}>
              {T.visit}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", margin: "6px 0 4px", flexWrap: "wrap" }}>
            {colony.slice(0, 6).map((m) => (
              <div className="hm-tile" key={m.id} title={m.name} style={{ width: 84, height: 84, marginRight: -14, borderRadius: 26, background: TONE_TILE[m.look.tone][1], position: "relative", border: "3px solid #2E1C2A" }}>
                <div style={{ position: "absolute", left: "12%", top: "10%", width: "76%", aspectRatio: "200/210" }}>
                  <GlossyMind mood={moodOf(stateOf(m))} tone={m.look.tone} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
                </div>
              </div>
            ))}
          </div>
        </div>

      <div className="hm-entry-cats">
        <span style={{ fontWeight: 600, fontSize: 18, color: "var(--ink-strong)" }}>{T.browseCat}</span>
        <div className="hm-entry-catgrid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 8 }}>
          {CATEGORIES.filter((c) => c.id !== "all").map((c, ci) => (
            <button key={c.id} className="lift" onClick={() => goShop(c.id)} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 18, border: "1.5px solid #fff", background: "color-mix(in srgb, var(--surface) 72%, transparent)", color: "var(--ink-strong)" }}>
              <div className="hm-bob" style={{ width: 40, height: 40, flex: "none", position: "relative", animationDuration: `${(2.6 + ci * 0.25).toFixed(2)}s`, animationDelay: `${-ci * 0.4}s` }}>
                <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "-6%", height: "16%", borderRadius: "50%", background: "rgba(74,46,68,.12)", filter: "blur(3px)" }} />
                <div style={{ position: "absolute", inset: 0, borderRadius: "42% 42% 46% 46%", background: `radial-gradient(circle at 34% 28%,${c.glossy[0]} 0%,${c.glossy[1]} 55%,${c.glossy[2]} 100%)`, boxShadow: `inset 0 -6px 10px rgba(0,0,0,.12),0 8px 18px ${c.glossy[1]}66` }} />
                <div style={{ position: "absolute", left: "18%", top: "12%", width: "30%", height: "20%", borderRadius: "50%", background: "var(--surface)", animation: "hmShine 3s ease-in-out infinite" }} />
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 10, top: 11, filter: "drop-shadow(0 1px 1px rgba(0,0,0,.18))" }} aria-hidden>
                  <path d={c.icon} />
                </svg>
              </div>
              <span style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.2, flex: 1, minWidth: 0, hyphens: "auto", overflowWrap: "anywhere" }}>{c.name}</span>
              {(() => {
                const k = g.offers.filter((s) => s.live && s.cat === c.id).length;
                return k > 0 ? (
                  <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                    {k}
                  </span>
                ) : null;
              })()}
            </button>
          ))}
        </div>
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 10 }}>
          {g.offers
            .filter((s) => s.live)
            .sort((a, b) => b.orders - a.orders)
            .slice(0, 4)
            .map((s) => {
              const m = g.minds.find((x) => x.id === s.mindId);
              return (
                <button key={s.id} onClick={() => goShop(s.cat)} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 12, padding: 14, borderRadius: 20, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink-strong)" }}>
                  <div className="hm-tile" style={{ width: 44, height: 44, borderRadius: 14, background: m ? TONE_TILE[m.look.tone][1] : "var(--accent-soft)", position: "relative", flex: "none" }}>
                    <div style={{ position: "absolute", left: "10%", top: "10%", width: "80%", aspectRatio: "200/210" }}>
                      <GlossyMind antenna={false} tone={m?.look.tone} mood={m ? moodOf(stateOf(m)) : "happy"} />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</span>
                    <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m?.name ?? "—"} · by {m?.owner ?? "—"} · {s.orders} {s.orders === 1 ? "order" : "orders"}
                    </span>
                  </div>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {s.price.toFixed(2)} NEAR
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

/** Under the hatch button: the other way to get a Mind, buying one someone is selling. */
function BuyInstead({ onBuy }: { onBuy: () => void }) {
  const forSale = useForSale();
  return (
    <button className="hm-buy-instead" onClick={onBuy}>
      <span>or buy a grown Mind</span>
      <span className="hm-buy-instead-meta">{forSale.length ? `${forSale.length} for sale · from ${fmt(forSale[0].price)} NEAR` : "marketplace"} →</span>
    </button>
  );
}
