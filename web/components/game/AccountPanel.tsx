"use client";

import { useState } from "react";
import GlossyMind from "./GlossyMind";
import { ago, ConnectButtons } from "./Header";
import { useGame } from "./GameProvider";
import { CONTRACT_ID, NETWORK } from "@/lib/chain";
import { fmt, moodOf, STATE_LABEL, stateOf, type MindRec } from "@/lib/game/engine";
import { LOOK_NAMES, TONES, TONE_TILE, type Look } from "@/lib/game/look";

const TRAIT_BG = ["#FFE3EE", "#EFE6FA", "#E3ECFF", "#DDF5E6", "#FFF1C7", "#FFE6D3"];

/** Restyle your Mind: colour, eyes, hat and outfit, saved on chain in one transaction (the
 *  NFT's picture is drawn on chain from this look, so wallets and marketplaces show it too). */
function Restyle({ mind }: { mind: MindRec }) {
  const g = useGame();
  const [draft, setDraft] = useState<Look>(mind.look);
  const changed = (["tone", "eyes", "hat", "outfit"] as const).some((k) => draft[k] !== mind.look[k]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="sub">Restyle her{g.mode === "live" ? " (stored on chain: the NFT's picture changes too)" : ""}</span>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ width: 84, height: 90, borderRadius: 22, background: TONE_TILE[draft.tone][1], position: "relative", flex: "none" }}>
          <div style={{ position: "absolute", left: "12%", top: "10%", width: "76%", aspectRatio: "200/210" }}>
            <GlossyMind tone={draft.tone} eyes={draft.eyes} hat={draft.hat} outfit={draft.outfit} mood={moodOf(stateOf(mind))} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TONES.map((t) => (
            <button key={t} aria-label={t} aria-pressed={draft.tone === t} onClick={() => setDraft((d) => ({ ...d, tone: t }))} style={{ width: 22, height: 22, borderRadius: 11, border: "2.5px solid " + (draft.tone === t ? "#4A2E44" : "#fff"), background: TONE_TILE[t][0], padding: 0 }} />
          ))}
        </div>
      </div>
      {(["eyes", "hat", "outfit"] as const).map((k) => (
        <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{k === "eyes" ? "Eyes" : k === "hat" ? "Hat" : "Outfit"}</span>
          <div className="scroll-x">
            {LOOK_NAMES[k].map((t, i) => (
              <button key={t} className="chip" style={{ fontSize: 12, padding: "5px 10px" }} aria-pressed={draft[k] === i} onClick={() => setDraft((d) => ({ ...d, [k]: i }))}>
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn-ink" disabled={!changed || g.busy} onClick={() => g.setLook(mind.id, draft)}>
          {changed ? "Save look" : "Saved"}
        </button>
        {changed && (
          <button className="btn-link" onClick={() => setDraft(mind.look)}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

export default function AccountPanel({ mind, visit, toHatch }: { mind: MindRec | null; visit: (id: number) => void; toHatch: () => void }) {
  const g = useGame();
  const [copied, setCopied] = useState(false);
  const others = g.minds.filter((m) => m.owner !== g.account);
  const awake = others.filter((m) => !m.ghost && m.asleepSince === 0).length;
  const days = mind ? Math.max(0, Math.floor((g.now - mind.bornTs) / 86_400_000)) : 0;

  const copy = () => {
    try {
      navigator.clipboard.writeText(g.account ?? "");
    } catch {
      /* clipboard blocked */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <section className="glass panel" style={{ flex: 1, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", padding: 16, borderRadius: 24, background: "linear-gradient(135deg,#FFE3EE,#FFF6FA 60%,#E9F8EF)" }}>
        <div style={{ width: 84, height: 84, borderRadius: 26, background: "#fff", position: "relative", flex: "none", boxShadow: "0 10px 24px rgba(224,85,143,.18)" }}>
          <div style={{ position: "absolute", left: "10%", top: "10%", width: "80%", aspectRatio: "200/210" }}>
            <GlossyMind tone={mind?.look.tone ?? "pink"} mood={mind ? moodOf(stateOf(mind)) : "happy"} eyes={mind?.look.eyes} hat={mind?.look.hat} outfit={mind?.look.outfit} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".06em", color: "var(--rose)" }}>MY ACCOUNT</span>
          <span style={{ fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", lineHeight: 1 }}>{mind?.name ?? "No Mind yet"}</span>
          <span style={{ fontSize: 13, color: "var(--muted-2)" }}>{mind ? `Hungry Minds #${String(mind.id).padStart(4, "0")} · kept by you` : "Hatch one to start"}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <span className="sub">Wallet balance</span>
          <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-strong)" }}>
            {g.wallet == null ? "—" : g.wallet.toFixed(3)} <span style={{ fontSize: 13, color: "var(--muted)" }}>NEAR</span>
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
        <div className="card">
          <span style={{ fontWeight: 600, fontSize: 15 }}>Wallet</span>
          {g.account ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 12, background: "#FBF4F8" }}>
              <span className="mono" style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {g.account}
              </span>
              <button className="btn-link" onClick={copy}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
              {g.mode === "live" && (
                <button className="btn-link" style={{ color: "var(--muted)" }} onClick={() => g.signOut()} title={g.burner ? "Forgets this browser's burner key" : "Disconnect the wallet"}>
                  Sign out
                </button>
              )}
            </div>
          ) : (
            <ConnectButtons />
          )}
          <Rows
            rows={[
              ["Network", g.mode === "demo" ? "Demo world (local)" : `NEAR ${NETWORK}`],
              [`${mind?.name ?? "Her"} food`, mind ? `${fmt(mind.balance)} NEAR` : "—"],
              ["Earned (your 90%)", `${fmt(g.mine.reduce((a, m) => a + m.ownerUnclaimed, 0))} NEAR`],
              ["Minds kept", String(g.mine.length)],
            ]}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn-ink" style={{ flex: 1 }} onClick={g.deposit}>
              {g.mode === "demo" ? "Deposit 5 test NEAR" : "Testnet faucet"}
            </button>
            {g.mode === "demo" && (
              <button
                className="btn-line"
                style={{ flex: 1 }}
                onClick={() => {
                  if (confirm("Start the demo world over? Your Minds here will be gone.")) g.resetDemo();
                }}
              >
                Reset demo
              </button>
            )}
          </div>
        </div>

        {mind && (
          <div className="card">
            <span style={{ fontWeight: 600, fontSize: 15 }}>NFT</span>
            <Rows
              rows={[
                ["Collection", "Hungry Minds (MIND)"],
                ["Token ID", `#${String(mind.id).padStart(4, "0")}`],
                ["Contract", g.mode === "live" ? CONTRACT_ID : "demo world (local)"],
                ["Standard", "NEP-171 · 177 · 178 · 181"],
                ["Born", new Date(mind.bornTs).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
                ["Owner", mind.owner],
              ]}
            />
            <span className="sub" style={{ lineHeight: 1.45 }}>
              Whoever holds this NFT keeps {mind.name}: her food, memories and earnings. Her picture in a wallet is drawn on chain from her current state.
            </span>
            {g.mode === "live" && (
              <a className="btn-link" href={`https://testnet.nearblocks.io/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
                See the contract on the explorer
              </a>
            )}
          </div>
        )}

        {mind && (
          <div className="card">
            <span style={{ fontWeight: 600, fontSize: 15 }}>Agent</span>
            <Rows
              rows={[
                ["Name", mind.name],
                ["Mood", STATE_LABEL[stateOf(mind)]],
                ["Age", `${days} day${days === 1 ? "" : "s"}`],
                ["Thoughts", mind.thoughts.toLocaleString("en-US")],
              ]}
            />
            {mind.owner === g.account && <Restyle mind={mind} />}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {mind.natures.map((t, i) => (
                <span key={t} style={{ padding: "5px 10px", borderRadius: 999, background: TRAIT_BG[i % TRAIT_BG.length], fontSize: 12, fontWeight: 600 }}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <span style={{ fontWeight: 600, fontSize: 15 }}>Recent activity</span>
          {g.activity.length === 0 && <span className="sub">{g.mode === "live" ? "See your wallet's transaction history on the explorer." : "Nothing yet."}</span>}
          {g.activity.slice(0, 8).map((a, i) => (
            <div key={a.ts + "-" + i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
              <span>
                {a.t} <span style={{ color: "#A08898" }}>· {ago(a.ts, g.now)}</span>
              </span>
              {a.v !== 0 && (
                <span className="mono" style={{ fontWeight: 600, color: a.v > 0 ? "var(--ok)" : "var(--rose)" }}>
                  {a.v > 0 ? "+" : "−"}
                  {Math.abs(a.v).toFixed(3)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <button className={mind ? "btn-ghost" : "btn-cta"} style={{ alignSelf: "flex-start" }} onClick={toHatch}>
        {mind ? "Hatch another Mind" : "Hatch a Mind"} · {g.params.mintPrice} NEAR
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 18 }}>Visit other Minds</span>
        <span className="sub">
          {awake} of {others.length} awake
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
        {others.map((m) => {
          const st = stateOf(m);
          const cta = st === "ghost" ? "Remembered" : st === "asleep" ? "Wake her up" : st === "starving" || st === "hungry" ? "Could use a snack" : "Say hi";
          return (
            <button key={m.id} className="lift" onClick={() => visit(m.id)} style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 4, padding: 10, borderRadius: 22, border: "1.5px solid rgba(255,255,255,.9)", background: "rgba(255,255,255,.5)" }}>
              <div style={{ aspectRatio: "1", borderRadius: 16, background: TONE_TILE[m.look.tone][1], display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                <div style={{ width: "72%", aspectRatio: "200/210" }}>
                  <GlossyMind tone={m.look.tone} mood={moodOf(st)} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
                </div>
              </div>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{m.name}</span>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {STATE_LABEL[st]} · {fmt(m.balance, 2)} NEAR
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#C2457E" }}>{cta}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13.5 }}>
          <span style={{ color: "var(--muted)" }}>{k}</span>
          <span className="mono" style={{ fontWeight: 600, textAlign: "right", overflowWrap: "anywhere" }}>
            {v}
          </span>
        </div>
      ))}
    </>
  );
}
