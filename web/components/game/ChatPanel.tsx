"use client";

import { useEffect, useRef, useState } from "react";
import { useGame } from "./GameProvider";
import { ConnectButtons } from "./Header";
import { stateOf, type MindRec } from "@/lib/game/engine";
import { chargeOf, nearText, type Offer } from "@/lib/game/services";
import { clipBytes, LIMITS } from "@/lib/game/bytes";
import { JOB_DEPOSIT_NEAR, WALLET_KIND } from "@/lib/chain";
import { FILE_LINK, FULL_RESULT, openFile, uploadFile, type AgentFile } from "@/lib/agentClient";

/** A message, with the gateway's file links turned into download buttons. */
function MsgText({ t }: { t: string }) {
  const g = useGame();
  const parts: React.ReactNode[] = [];
  let last = 0;
  const text = t.replace(FULL_RESULT, "(full result and files: Shop → My orders)");
  for (const m of text.matchAll(FILE_LINK)) {
    parts.push(text.slice(last, m.index));
    const [, name, kb, id] = m;
    parts.push(
      <button key={id} className="btn-line" style={{ padding: "4px 10px", fontSize: 12.5, margin: "2px 0" }} onClick={() => g.agentCall((a, sign) => openFile(a, sign, id, name))}>
        {name} · {kb} KB
      </button>
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export default function ChatPanel({ mind, service, clearService }: { mind: MindRec; service: Offer | null; clearService: () => void }) {
  const g = useGame();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const own = mind.owner === g.account;
  const st = stateOf(mind);
  const canTalk = st !== "asleep" && st !== "ghost";
  const price = service ? chargeOf(service.price, g.params.guestMinPrice) : g.params.guestMinPrice;
  const thinking = g.thinking === mind.id;

  const live = g.mode === "live";
  const agent = live ? g.linked[mind.id] : undefined;
  const [file, setFile] = useState<AgentFile | null>(null);
  const maxBytes = agent ? 2000 : LIMITS.message;
  const left = g.chatLeft[mind.id];
  const { loadChatLeft } = g;
  // A service with an input schema is ordered through its form (sent as JSON).
  const schema = service?.schema && Object.keys(service.schema.properties || {}).length ? service.schema : null;
  const [form, setForm] = useState<Record<string, string>>({});
  const required = schema?.required || [];
  const formReady = !schema || required.every((k) => (form[k] ?? "").trim());
  useEffect(() => {
    // A request from the Navigator starts filled in.
    const p = service?.prefill;
    const defaults = Object.fromEntries(Object.entries(schema?.properties || {}).filter(([, x]) => x.enum && x.default !== undefined).map(([k, x]) => [k, String(x.default)]));
    if (!p) return setForm(defaults);
    if (!schema) return setDraft(p);
    try {
      const v = JSON.parse(p) as Record<string, unknown>;
      setForm(Object.fromEntries(Object.entries(v).filter(([k]) => k in schema.properties).map(([k, x]) => [k, String(x ?? "")])));
    } catch {
      setForm({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id, service?.prefill]);
  const formJson = () => {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(schema?.properties || {})) {
      const v = (form[k] ?? "").trim();
      if (!v) continue;
      out[k] = p.type === "number" || p.type === "integer" ? Number(v) : p.type === "boolean" ? v === "true" : v;
    }
    return JSON.stringify(out);
  };

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [mind.msgs.length, thinking]);

  useEffect(() => {
    if (live && g.account) loadChatLeft(mind.id);
  }, [live, g.account, mind.id, loadChatLeft]);

  const send = async () => {
    let t = schema ? formJson() : (draft.trim() || (service ? `${service.title}, please!` : "")).trim();
    if (schema && !formReady) return;
    if (service && file) t = clipBytes(t, 960) + ` [file:${file.id}]`; // the agent gets the file with the order
    if (!t || busy || !canTalk) return;
    setBusy(true);
    const ok = service ? await g.order(service.id, t) : await g.talk(mind.id, t, own ? undefined : price);
    setBusy(false);
    if (ok) {
      setDraft("");
      setFile(null);
      setForm({});
      if (service) clearService();
    }
  };

  const leftNote = live && left !== undefined ? ` · ${left} message${left === 1 ? "" : "s"} left` : "";
  const note = own
    ? `Free for you · each reply costs ${mind.name} ${g.params.thoughtCost} NEAR of her food${leftNote}`
    : live && !service
      ? `${nearText(g.params.guestMinPrice)} NEAR per message from your chat credits · 90% to her owner, 10% protocol${leftNote}`
      : `${nearText(price)} NEAR per message · 90% to her owner, 10% protocol`;
  // Guests prepay credits in one approval; each message then needs no wallet at all.
  const packs = [10, 50].map((n) => ({ n, near: n * g.params.guestMinPrice }));
  const showPacks = live && !own && !service && !!g.account && left !== undefined && left < 5;

  return (
    <section className="glass panel" style={{ flex: 1, minHeight: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 22 }}>
          Chat with {mind.name}
          {agent && (
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: "var(--info)" }}>
              {mind.name} chats herself; tasks and orders go to her agent {agent.name}{agent.online ? "" : " (offline right now)"}
            </span>
          )}
        </span>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{note}</span>
      </div>
      {service && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 16, background: "color-mix(in srgb, var(--surface) 70%, transparent)", fontSize: 13.5 }}>
          <span style={{ flex: 1 }}>
            Ordering <b>{service.title}</b> · {nearText(price)} NEAR / {service.unit}
          </span>
          <button className="btn-link" onClick={clearService}>
            Cancel
          </button>
        </div>
      )}
      <div ref={list} style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, maxHeight: 380, minHeight: 160 }} aria-live="polite">
        {mind.msgs.length === 0 && <span className="sub">Say hi. {own ? "She'll answer with her own voice." : "Your message pays her keeper; her reply costs her a little food."}</span>}
        {mind.msgs.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.who === "me" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              background: m.who === "me" ? "var(--accent)" : "var(--surface)",
              color: m.who === "me" ? "var(--on-accent)" : "var(--ink)",
              borderRadius: m.who === "me" ? "18px 18px 6px 18px" : "18px 18px 18px 6px",
              padding: "10px 14px",
              fontSize: 15,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap", // agents' results come in lines
              boxShadow: "0 6px 16px rgba(160,80,120,.1)",
            }}
          >
            <MsgText t={m.t} />
            {m.via ? <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--info)", marginTop: 6 }}>via her agent {m.via}</span> : null}
            {m.paid ? <span style={{ display: "block", fontSize: 11, opacity: 0.8, marginTop: 2 }}>paid {nearText(m.paid)} NEAR</span> : null}
            {m.proof && (
              <a
                href={/^https?:\/\//.test(m.proof.verify_url || "") ? m.proof.verify_url : "#"}
                target="_blank"
                rel="noreferrer"
                title={m.proof.verified ? `Signed inside a TEE by ${m.proof.signer}
chat id ${m.proof.chat_id}
signed text ${m.proof.signed_text}
signature ${m.proof.signature}` : "NEAR AI wrote this reply, but its signature wasn't available to check"}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, fontSize: 11, fontWeight: 600, color: m.proof.verified ? "#1F9A5A" : "#9A6B1F", textDecoration: "none" }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 4, background: m.proof.verified ? "#2FBF71" : "#E2A91F" }} />
                {m.proof.verified ? `Verified · NEAR AI TEE · ${m.proof.model.split("/").pop()}` : `NEAR AI · ${m.proof.model.split("/").pop()} · unsigned`}
              </a>
            )}
          </div>
        ))}
        {thinking && (
          <div className="hm-dots" style={{ alignSelf: "flex-start", background: "var(--surface)", borderRadius: "18px 18px 18px 6px", padding: "10px 16px", fontSize: 20, lineHeight: 1 }} aria-label="thinking">
            <span>•</span>
            <span>•</span>
            <span>•</span>
          </div>
        )}
      </div>
      {g.mode === "live" && !g.account && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 16, background: "color-mix(in srgb, var(--surface) 70%, transparent)" }}>
          <span className="sub">To pay {mind.name}, connect {WALLET_KIND}. You don&apos;t need a Mind of your own.</span>
          <ConnectButtons />
        </div>
      )}
      {showPacks && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 14px", borderRadius: 16, background: "color-mix(in srgb, var(--surface) 70%, transparent)", fontSize: 13.5 }}>
          <span style={{ flex: 1, minWidth: 180 }}>{left === 0 ? "Buy chat credits to talk to her." : "Running low on chat credits."} One approval, then no wallet per message.</span>
          {packs.map((p) => (
            <button key={p.n} className="btn-ghost pill" disabled={g.busy} onClick={() => void g.buyCredits(p.n).then((ok) => ok && loadChatLeft(mind.id))}>
              {p.n} messages · {nearText(p.near)} NEAR
            </button>
          ))}
        </div>
      )}
      {!own && typeof left === "number" && left > 0 && (
        <button
          className="btn-ghost pill"
          disabled={g.busy}
          style={{ alignSelf: "flex-start", fontSize: 12.5, opacity: 0.85 }}
          onClick={() => void g.withdrawCredits().then((ok) => ok && loadChatLeft(mind.id))}
          title="Take back your unused chat credits (the worker settles usage every minute)"
        >
          Withdraw unused credits
        </button>
      )}
      {schema && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8, padding: "10px 12px", borderRadius: 16, background: "color-mix(in srgb, var(--surface) 70%, transparent)" }}>
          {Object.entries(schema.properties).map(([k, p]) => (
            <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--muted-2)" }}>
              <span>
                {p.description || k}
                {required.includes(k) ? " *" : ""}
              </span>
              {p.enum ? (
                <select className="field" style={{ fontSize: 13 }} value={form[k] ?? String(p.default ?? "")} onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))} aria-label={k}>
                  {!required.includes(k) && <option value="">—</option>}
                  {p.enum.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : p.type === "boolean" ? (
                <select className="field" style={{ fontSize: 13 }} value={form[k] ?? ""} onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))} aria-label={k}>
                  <option value="">—</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              ) : (
                <input
                  className={`field${p.format === "address" || /account|token|wallet/.test(k) ? " mono" : ""}`}
                  style={{ fontSize: 13 }}
                  inputMode={p.type === "number" || p.type === "integer" ? "decimal" : undefined}
                  value={form[k] ?? ""}
                  placeholder={p.default !== undefined ? String(p.default) : ""}
                  onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value.slice(0, 400) }))}
                  aria-label={k}
                />
              )}
            </label>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {!schema && (
        <input
          className="field pill"
          style={{ flex: 1 }}
          value={draft}
          disabled={!canTalk}
          onChange={(e) => setDraft(clipBytes(e.target.value, service ? 960 : maxBytes))}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={canTalk ? (service ? `Anything for the ${service.unit}? (optional)` : "Say something…") : st === "ghost" ? "Ghosts don't answer." : "She's asleep. Feed her first."}
          aria-label="Message"
        />
        )}
        {agent && service && (
          <label className="btn-line" style={{ display: "flex", alignItems: "center", padding: "0 12px", fontSize: 13, cursor: "pointer" }} title="Attach a file for her agent (up to 6 MB)">
            {file ? file.name.slice(0, 14) : "Attach"}
            <input type="file" hidden onChange={async (e) => { const x = e.target.files?.[0]; if (x) setFile(await g.agentCall((a, sign) => uploadFile(a, sign, x))); }} />
          </label>
        )}
        <button className="btn-cta" style={{ padding: "0 18px" }} disabled={!canTalk || busy || (!draft.trim() && !service) || !formReady} onClick={send}>
          {own || (live && !service) ? "Send" : `Send · ${nearText(price)}`}
        </button>
      </div>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>
        {g.mode === "demo"
          ? "Replies come from an AI model in her character (demo world: nothing is written on chain)."
          : service
            ? `An order is a job: the contract holds your ${nearText(price)} NEAR until she delivers${service.sla ? ` (due in ${service.sla})` : ""} and gives it back if she doesn't. It also holds a ${JOB_DEPOSIT_NEAR} NEAR storage deposit you get back when you close the order in Shop → My orders.`
            : "No wallet popup per message: your wallet signs in to chat once a day, and what you use is settled on chain in batches from her food (or your chat credits)."}
      </span>
    </section>
  );
}
