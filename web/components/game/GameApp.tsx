"use client";

import { useEffect, useRef, useState } from "react";
import AccountPanel, { ColonyList } from "./AccountPanel";
import ChatPanel from "./ChatPanel";
import { CornerDecor, SoftLeaf } from "./Decor";
import ThemeScene from "./ThemeScene";
import Dome, { type DomeFx } from "./Dome";
import Entry from "./Entry";
import { SoldCard, useSold } from "./AfterSale";
import { useGame } from "./GameProvider";
import Header, { ConnectButtons, NetworkSwitch } from "./Header";
import { NETWORK, notLaunched, switchNetwork, WALLET_KIND } from "@/lib/chain";
import { FeedPanel, LifePanel, TodayPanel } from "./HomePanels";
import RadioPanel from "./RadioPanel";
import ShopPanel, { type ShopMode } from "./ShopPanel";
import { stateOf, type MindRec } from "@/lib/game/engine";
import { L, type Lang } from "@/lib/game/i18n";
import { nearText, type Category, type Offer } from "@/lib/game/services";
import { useWeather } from "@/lib/game/weather";
import Logo from "@/components/Logo";

const NAV_ICONS = [
  "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  "M5 8h14l-1.5 11h-11zM9 8a3 3 0 0 1 6 0",
  "M4 5h16v11H9l-5 4z",
  "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-4 3.8-6 7.5-6s6.5 2 7.5 6",
];


type Tab = 0 | 1 | 2 | 3;

/** The site's colour theme: ?theme=<name> picks one and it is remembered (game.css themes). */
export const THEMES = ["seed", "garden", "cosmos", "jungle", "desert", "abyss", "paper"] as const;
export const PALETTES = ["gold", "ours", "plum", "midnight", "ice"] as const;
function useTheme() {
  useEffect(() => {
    let t: string | null = new URLSearchParams(window.location.search).get("theme");
    try {
      if (t && (THEMES as readonly string[]).includes(t)) localStorage.setItem("hm-theme", t);
      else t = localStorage.getItem("hm-theme");
    } catch {
      /* private window: the theme lasts this page only */
    }
    document.documentElement.dataset.theme = t && (THEMES as readonly string[]).includes(t) ? t : "seed";
    // seed palettes: Ice (sky blue on deep teal) is the default; ?p=gold|ours|plum|midnight|ice
    // previews another for one visit and is not remembered
    const p = new URLSearchParams(window.location.search).get("p");
    const pal = p && (PALETTES as readonly string[]).includes(p) ? p : "ice";
    if (pal === "gold") delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = pal;
    // light or dark, from the header toggle (components/ModeToggle.tsx); dark is the default
    try {
      if (localStorage.getItem("hm-mode") === "light") document.documentElement.dataset.mode = "light";
    } catch {
      /* private window */
    }
  }, []);
}

export default function GameApp() {
  useTheme();
  const g = useGame();
  const wx = useWeather();
  // Only the English copy is complete, so the game stays in English.
  const lang: Lang = "en";
  const [entry, setEntry] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [visitId, setVisitId] = useState<number | null>(null);
  const [cat, setCat] = useState<Category | "all">("all");
  const [service, setService] = useState<Offer | null>(null);
  const [fx, setFx] = useState<DomeFx>({ crumbs: [], hop: 0 });
  const fxT = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The network is read from this browser, so decide "not launched" only after mount.
  const [mounted, setMounted] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [shopMode, setShopMode] = useState<ShopMode>("market");
  useEffect(() => setMounted(true), []);
  const [sold, clearSold] = useSold();


  // First visit (no Mind yet) opens on the colony entry; a returning keeper goes home.
  // The account (wallet / burner) can load after the first chain read, so a keeper's Minds
  // may appear a moment later: if we only showed the entry because none were known yet,
  // move home as soon as they are.
  const autoEntry = useRef(false);
  useEffect(() => {
    if (g.ready && entry === null) {
      autoEntry.current = g.mine.length === 0;
      setEntry(g.mine.length === 0);
    } else if (entry && autoEntry.current && g.mine.length > 0) {
      autoEntry.current = false;
      setEntry(false);
    }
  }, [g.ready, g.mine.length, entry]);

  // Deep links: /app?tab=home|shop|chat|account, /app?hatch=1
  const linked = useRef(false);
  useEffect(() => {
    if (!g.ready || linked.current) return;
    linked.current = true;
    const q = new URLSearchParams(window.location.search);
    const tabs: Record<string, Tab> = { home: 0, shop: 1, chat: 2, account: 3 };
    if (q.get("hatch")) {
      autoEntry.current = false;
      setEntry(true);
    } else if (q.get("tab") && q.get("tab")! in tabs) {
      autoEntry.current = false;
      setEntry(false);
      setTab(tabs[q.get("tab")!]);
    }
  }, [g.ready]);

  const T = L[lang];
  const own: MindRec | null = g.mine.find((m) => m.id === activeId) ?? g.mine[g.mine.length - 1] ?? null;
  const visiting = visitId !== null ? (g.minds.find((m) => m.id === visitId) ?? null) : null;
  const subject = visiting ?? own;

  const go = (t: Tab, opts: { visit?: number | null } = {}) => {
    setEntry(false);
    setTab(t);
    if ("visit" in opts) setVisitId(opts.visit ?? null);
  };
  // the marketplace: Shop → Buy & sell Minds
  const toBuy = () => {
    setShopMode("nft");
    go(1, { visit: null });
  };
  const toHatch = () => {
    autoEntry.current = false;
    setEntry(true);
  };

  const onFed = (emoji: string, qty: number) => {
    const id = Date.now();
    setFx((f) => ({ hop: f.hop + 1, crumbs: Array.from({ length: 4 + qty * 2 }, (_, i) => ({ id: `${id}-${i}`, e: emoji, x: 25 + Math.random() * 50, d: +(Math.random() * 0.4).toFixed(2) })) }));
    clearTimeout(fxT.current);
    fxT.current = setTimeout(() => setFx((f) => ({ ...f, crumbs: [] })), 1700);
  };

  if (mounted && notLaunched() && !new URLSearchParams(window.location.search).has("demo")) {
    return (
      <div className="hm" style={{ alignItems: "center", justifyContent: "center" }}>
        <CornerDecor />
        <ThemeScene />
        <div style={{ position: "absolute", top: 22, right: 22 }}>
          <NetworkSwitch />
        </div>
        <div style={{ maxWidth: 520, padding: 28, borderRadius: 30, background: "var(--panel, color-mix(in srgb, var(--surface) 82%, transparent))", border: "1.5px solid var(--glass-line, #fff)", boxShadow: "0 20px 50px rgba(180,90,140,.14)", display: "flex", flexDirection: "column", gap: 14, textAlign: "center", alignItems: "center" }}>
          <Logo size={88} word={false} />
          <span style={{ fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", color: "var(--ink-strong)" }}>Mainnet soon</span>
          <span style={{ fontSize: 15, lineHeight: 1.5, color: "var(--muted-2)" }}>
            Hungry Minds has no mainnet contract yet: it launches there after an audit. Everything playable today is real and on NEAR testnet, with free test NEAR.
          </span>
          <button className="btn-cta" onClick={() => switchNetwork("testnet")}>
            Play on testnet
          </button>
        </div>
      </div>
    );
  }

  if (!g.ready || entry === null) {
    return (
      <div className="hm" style={{ alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Logo size={72} word={false} />
        <span className="sub">Waking the colony…</span>
      </div>
    );
  }

  // Every page load asks to sign in (live mode). Browsing without an account stays possible.
  const signPrompt = g.mode === "live" && !g.account && !browsing && (
    <div role="dialog" aria-modal="true" aria-label="Sign in" style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(60,30,50,.28)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ maxWidth: 460, width: "100%", padding: 28, borderRadius: 30, background: "var(--panel, color-mix(in srgb, var(--surface) 95%, transparent))", border: "1.5px solid var(--glass-line, #fff)", boxShadow: "var(--panel-shadow, 0 20px 50px rgba(180,90,140,.18))", display: "flex", flexDirection: "column", gap: 14, alignItems: "center", textAlign: "center" }}>
        <Logo size={88} word={false} />
        <span style={{ fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", color: "var(--ink-strong)" }}>Sign in to play</span>
        <span style={{ fontSize: 14.5, lineHeight: 1.5, color: "var(--muted-2)" }}>Your Minds, food and earnings live on NEAR {NETWORK} under your account. Connect {WALLET_KIND} to continue.</span>
        <ConnectButtons big />
        <button className="btn-link" onClick={() => setBrowsing(true)}>
          Just look around
        </button>
      </div>
    </div>
  );

  const soldCard = sold.length > 0 && (
    <SoldCard
      sold={sold}
      onHatch={() => (clearSold(), toHatch())}
      onBuy={() => (clearSold(), toBuy())}
      onClose={() => {
        clearSold();
        if (!g.mine.length) go(0, { visit: null });
      }}
    />
  );

  const toast = g.error && (
    <div className="toast" role="alert">
      <span style={{ flex: 1 }}>{g.error}</span>
      <button className="btn-link" style={{ color: "#FFB3CF" }} onClick={g.clearError}>
        OK
      </button>
    </div>
  );

  if (entry) {
    return (
      <div className="hm">
        <CornerDecor />
        <ThemeScene />
        <Entry
          lang={lang}
          onHatched={(id) => {
            if (id !== null && id >= 0) setActiveId(id);
            go(0, { visit: null });
          }}
          goHome={() => go(0, { visit: null })}
          goShop={(c) => {
            setCat(c);
            go(1, { visit: null });
          }}
          goVisit={() => go(3, { visit: null })}
          goBuy={toBuy}
        />
        {toast}
        {soldCard}
        {signPrompt}
      </div>
    );
  }

  const wideRight = tab === 1 || (tab === 3 && !visiting);
  const st = subject ? stateOf(subject) : "content";

  return (
    <div className="hm">
      <CornerDecor />
      <ThemeScene />
      <Header mind={own} onLogo={() => ((autoEntry.current = false), setEntry(true))} onEarnings={() => ((setShopMode("earn"), go(1)))} pickMind={(id) => setActiveId(id)} />

      <div className={`hm-grid${wideRight ? " wide-right" : ""}`}>
        <div className="hm-left">
          <nav className="glass hm-nav" aria-label="Main">
            {T.nav.map((label, i) => (
              <button key={label} aria-current={tab === i ? "page" : undefined} onClick={() => go(i as Tab, i === 0 || i === 3 ? { visit: null } : {})}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={NAV_ICONS[i]} />
                </svg>
                {label}
              </button>
            ))}
          </nav>
          <div className="glass hm-goal" style={{ display: g.mode === "live" ? "none" : "flex", borderRadius: 24, padding: "14px 16px", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "radial-gradient(circle at 40% 30%,#FFD9C9,#E9A08B)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "hidden" }}>
              <div style={{ width: 26, height: 16, marginTop: 2 }}>
                <SoftLeaf tone="light" />
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 13, color: "var(--muted)" }} title="Feed or talk to your Mind three times today">
                Daily goal
              </span>
              <span style={{ fontWeight: 600, fontSize: 16 }}>{g.goal}/3</span>
              <div className="bar" style={{ height: 6 }}>
                <span style={{ width: `${(g.goal / 3) * 100}%`, background: "#FF8DB7", transition: "width .6s" }} />
              </div>
            </div>
          </div>
        </div>

        <Dome mind={subject} T={T} wx={wx} fx={fx} visiting={!!visiting} onBack={() => go(visiting && !g.mine.length ? 3 : 0, { visit: null })} guest={!subject} onHatch={toHatch} onBuy={toBuy} onBrowse={() => go(3, { visit: null })} />

        <div className="hm-right">
          {tab === 0 && subject && (
            <>
              <LifePanel mind={subject} />
              {!subject.ghost && <FeedPanel mind={subject} onFed={onFed} />}
              <TodayPanel mind={subject} />
            </>
          )}
          {(tab === 0 || tab === 2) && !subject && (
            <section className="glass panel hm-colony-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              <ColonyList title="Visit a Mind" visit={(id) => go(tab === 2 ? 2 : 3, { visit: id })} />
            </section>
          )}
          {tab === 1 && (
            <ShopPanel
              key={shopMode}
              initialMode={shopMode}
              toHatch={() => setEntry(true)}
              cat={cat}
              setCat={setCat}
              order={(m, s, prefill) => {
                setService(prefill ? { ...s, prefill } : s);
                go(2, { visit: m.id });
              }}
              visit={(id) => go(3, { visit: id })}
            />
          )}
          {tab === 2 && subject && <ChatPanel mind={subject} service={service && visiting?.id === service.mindId ? service : null} clearService={() => setService(null)} />}
          {tab === 3 && visiting && (
            <>
              <LifePanel mind={visiting} />
              {!visiting.ghost && (
                <>
                  <FeedPanel mind={visiting} onFed={onFed} />
                  <section className="glass panel" style={{ padding: "14px 18px" }}>
                    <button className="btn-ink" style={{ width: "100%", padding: "12px 16px", fontSize: 15 }} onClick={() => go(2)} disabled={st === "asleep"}>
                      {st === "asleep" ? `Wake ${visiting.name} to chat` : visiting.owner === g.account ? `Chat with ${visiting.name} · free for you` : `Pay to chat with ${visiting.name} · ${nearText(g.params.guestMinPrice)} NEAR a message`}
                    </button>
                  </section>
                </>
              )}
            </>
          )}
          {tab === 3 && !visiting && <AccountPanel mind={own} visit={(id) => go(3, { visit: id })} toHatch={() => setEntry(true)} />}
        </div>

        <RadioPanel />
        <section className="glass hm-bottom-r" style={{ borderRadius: 24, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 17 }}>{T.env}</span>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-.02em" }}>{wx.temp == null ? "…" : `${Math.round(wx.temp)}°C`}</span>
            <span className="sub">
              {wx.temp == null ? "\u00a0" : !wx.day && wx.kind === "clear" ? T.wx.night : T.wx[wx.kind]}
              {wx.temp != null && wx.city ? ` · ${wx.city}` : ""}
            </span>
          </div>
          <div className="hm-wx-pic" style={{ width: 96, height: 76, borderRadius: 16, overflow: "hidden", position: "relative", background: "linear-gradient(180deg,#F9C6DA 0%,#F6E0EA 45%,#BFE3B8 46%,#8CCB8A 100%)", border: "1.5px solid color-mix(in srgb, var(--surface) 90%, transparent)" }}>
            <div style={{ position: "absolute", left: "-10%", right: "30%", top: "40%", height: "40%", borderRadius: "50%", background: "#A7D79C" }} />
            <div style={{ position: "absolute", left: "40%", right: "-20%", top: "46%", height: "40%", borderRadius: "50%", background: "#7FC07E" }} />
          </div>
        </section>
      </div>
      {toast}
      {soldCard}
      {signPrompt}
    </div>
  );
}
