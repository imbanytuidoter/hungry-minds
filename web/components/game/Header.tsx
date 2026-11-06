"use client";

import { useState } from "react";
import GlossyMind from "./GlossyMind";
import { useGame } from "./GameProvider";
import { MAINNET_DEPLOY, NETWORK, notLaunched, switchNetwork, TESTNET_DEPLOY, type Network } from "@/lib/chain";
import { fmt, type MindRec } from "@/lib/game/engine";
import { L, LANGS, type Lang } from "@/lib/game/i18n";
import type { NotifKind } from "@/lib/game/world";

const NK: Record<NotifKind, [string, string, string]> = {
  use: ["M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z", "#FFE3EE", "#E0558F"],
  fed: ["M12 8c-3.8-2-8 .5-7 5.5.8 4 3.8 7 7 6 3.2 1 6.2-2 7-6 1-5-3.2-7.5-7-5.5zM12 8c0-2 1-3.6 3-4.5", "#FFF1C7", "#C08A12"],
  warn: ["M12 4l9 16H3zM12 10v4M12 17h.01", "#FFE6D3", "#D9702A"],
  star: ["M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z", "#EFE6FA", "#7A55C8"],
};

export const ago = (ts: number, now: number) => {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/** Testnet | Mainnet. Switching reloads the page on the other network (lib/chain NETWORK). */
export function NetworkSwitch() {
  const g = useGame();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div role="group" aria-label="Network" style={{ display: "flex", padding: 3, borderRadius: 999, background: "rgba(255,255,255,.6)", border: "1.5px solid rgba(255,255,255,.95)" }}>
        {(["testnet", "mainnet"] as Network[]).map((n) => {
          const on = NETWORK === n;
          return (
            <button
              key={n}
              aria-pressed={on}
              onClick={() => !on && switchNetwork(n)}
              title={n === "mainnet" ? (MAINNET_DEPLOY ? `Contract ${MAINNET_DEPLOY}` : "Not launched on mainnet yet") : `Contract ${TESTNET_DEPLOY}`}
              style={{ border: "none", borderRadius: 999, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, background: on ? (n === "testnet" ? "#DCF5E4" : "#2E1C2A") : "transparent", color: on ? (n === "testnet" ? "var(--ok)" : "#fff") : "var(--muted-2)" }}
            >
              {n === "testnet" ? "Testnet" : "Mainnet"}
            </button>
          );
        })}
      </div>
      {g.mode === "demo" && !notLaunched() && (
        <span style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 999, background: "rgba(255,255,255,.55)", color: "var(--muted-2)" }} title="The contract's rules on a fast clock, test NEAR only, nothing on chain">
          offline demo
        </span>
      )}
    </div>
  );
}

/** Live mode: connect a NEAR wallet (or an EVM one on mainnet). */
export function ConnectButtons({ big = false }: { big?: boolean }) {
  const g = useGame();
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button className={big ? "btn-cta" : "btn-ink"} onClick={g.signIn} title={NETWORK === "mainnet" ? "NEAR wallets (Meteor, Intear, HOT, Ledger…) and EVM wallets (MetaMask, OKX…)" : "NEAR wallets (Meteor, Intear, HOT, Ledger…)"}>
        Connect wallet
      </button>
    </div>
  );
}

export function LangSelect({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <select className="field pill" style={{ padding: "9px 12px", fontWeight: 600, fontSize: 14 }} value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="Language">
      {LANGS.map((l) => (
        <option key={l} value={l}>
          {L[l].n}
        </option>
      ))}
    </select>
  );
}

export default function Header({
  mind,
  lang,
  setLang,
  onLogo,
  onEarnings,
  pickMind,
}: {
  mind: MindRec | null;
  lang: Lang;
  setLang: (l: Lang) => void;
  onLogo: () => void;
  onEarnings: () => void;
  pickMind: (id: number) => void;
}) {
  const g = useGame();
  const [open, setOpen] = useState(false);

  return (
    <header className="hm-head" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <button onClick={onLogo} style={{ display: "flex", alignItems: "center", gap: 14, border: "none", background: "none", padding: 0, textAlign: "left" }} aria-label="Back to the colony">
        <div className="hm-mark" style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(255,255,255,.55)", border: "1.5px solid rgba(255,255,255,.9)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 24px rgba(226,90,147,.18)" }}>
          <div style={{ width: 44, height: 46 }}>
            <GlossyMind sprout tone={mind?.look.tone ?? "pink"} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="serif" style={{ fontSize: 38, lineHeight: 1, color: "var(--ink)" }}>
            {mind?.name ?? "hungry minds"}
          </span>
          <span className="hm-tagline" style={{ fontSize: 14, color: "var(--muted)" }}>{mind ? "my virtual companion" : "a colony of living NFTs"}</span>
        </div>
      </button>

      {g.mine.length > 1 && (
        <select className="field pill" style={{ padding: "8px 12px", fontSize: 13.5, fontWeight: 600 }} value={mind?.id ?? ""} onChange={(e) => pickMind(Number(e.target.value))} aria-label="Switch Mind">
          {g.mine.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} #{String(m.id).padStart(4, "0")}
            </option>
          ))}
        </select>
      )}

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <NetworkSwitch />
        {mind && (
          <div className="glass num" style={{ display: "flex", alignItems: "center", gap: 14, borderRadius: 999, padding: "10px 20px", fontWeight: 600, fontSize: 17 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }} title="Love">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z" fill="#FF6FA3" />
              </svg>
              {mind.love.toLocaleString("en-US")}
            </span>
            <span style={{ width: 1, height: 22, background: "rgba(74,46,68,.18)" }} />
            <span style={{ display: "flex", alignItems: "center", gap: 8 }} title={`${mind.name}'s food — her own balance`}>
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path d="M5 19c0-8 6-14 15-14-1 9-7 15-15 14z" fill="#6CC487" />
                <path d="M5 19L14 10" stroke="#3F9A5E" strokeWidth="1.6" />
              </svg>
              {fmt(mind.balance)} NEAR
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}>{mind.name}&apos;s food</span>
            </span>
          </div>
        )}
        {g.mode === "live" && !g.account && <ConnectButtons />}
        {g.mode === "live" && g.account && (
          <a className="mono" href={`https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/address/${g.account}`} target="_blank" rel="noreferrer" style={{ display: "flex", flexDirection: "column", fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 999, background: "rgba(255,255,255,.6)", textDecoration: "none", lineHeight: 1.25 }} title="Your wallet — open in the explorer">
            {g.account.length > 26 ? g.account.slice(0, 24) + "…" : g.account}
            {g.wallet !== null && <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--muted)" }}>wallet {g.wallet.toFixed(3)} NEAR</span>}
          </a>
        )}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setOpen((o) => !o)}
            aria-label="Notifications"
            style={{ width: 52, height: 52, borderRadius: 18, background: "rgba(255,255,255,.45)", border: "1.5px solid rgba(255,255,255,.85)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4A2E44" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
              <path d="M10 20a2 2 0 0 0 4 0" />
            </svg>
            {g.unread > 0 && (
              <span style={{ position: "absolute", top: 8, right: 8, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#FF6FA3", color: "#fff", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {g.unread > 9 ? "9+" : g.unread}
              </span>
            )}
          </button>
          {open && (
            <div style={{ position: "absolute", right: 0, top: 62, width: "min(360px,88vw)", zIndex: 60, background: "#fff", borderRadius: 22, boxShadow: "0 24px 60px rgba(120,50,90,.22)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #F3E8EE" }}>
                <span style={{ fontWeight: 600, fontSize: 16 }}>Notifications</span>
                <button className="btn-link" onClick={g.markRead}>
                  Mark all read
                </button>
              </div>
              <div style={{ maxHeight: 380, overflow: "auto" }}>
                {g.notifs.length === 0 && <div style={{ padding: 16, fontSize: 13.5, color: "var(--muted)" }}>{g.mode === "live" ? "Quiet so far. While this tab is open, paid chats, orders and hunger warnings for your Minds show up here." : "Quiet so far. Visitors who pay to chat with your Mind show up here."}</div>}
                {g.notifs.map((n, i) => {
                  const K = NK[n.k];
                  return (
                    <div key={n.ts + "-" + i} style={{ display: "flex", gap: 11, padding: "12px 16px", background: i < g.unread ? "#FFF6FA" : "#fff", borderBottom: "1px solid #F8F0F4" }}>
                      <div style={{ width: 36, height: 36, borderRadius: 12, background: K[1], flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={K[2]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d={K[0]} />
                        </svg>
                      </div>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 13.5, lineHeight: 1.35, color: "var(--ink-strong)" }}>
                          <b>{n.who}</b> {n.t}
                        </span>
                        <span style={{ fontSize: 11.5, color: "#A08898" }}>{ago(n.ts, g.now)}</span>
                      </div>
                      {n.v > 0 && (
                        <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ok)", whiteSpace: "nowrap" }}>
                          +{fmt(n.v)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  onEarnings();
                }}
                style={{ padding: 12, border: "none", background: "#FBF4F8", fontWeight: 600, fontSize: 13 }}
              >
                See earnings
              </button>
            </div>
          )}
        </div>
        <LangSelect lang={lang} setLang={setLang} />
      </div>
    </header>
  );
}
