"use client";

import { useEffect, useState } from "react";
import GlossyMind from "./GlossyMind";
import { useGame } from "./GameProvider";
import { fmt, moodOf, STATE_LABEL, stateOf, type MindRec } from "@/lib/game/engine";
import { TONE_TILE } from "@/lib/game/look";
import { CAT_IDS, CATEGORIES, needsAgent, type Category, type Offer } from "@/lib/game/services";
import type { JobRec } from "./GameProvider";
import { clipBytes, LIMITS } from "@/lib/game/bytes";
import { CONTRACT_ID, JOB_DEPOSIT_NEAR } from "@/lib/chain";
import { AGENT_KINDS, answerJob, FULL_RESULT, jobDetail, navigate, officialAgents, openFile, uploadFile, type AgentFile, type ConnectForm, type GatewayAgent, type JobDetail, type OfficialAgent, type Suggestion } from "@/lib/agentClient";

type Sort = "pop" | "new" | "low" | "high";

export default function ShopPanel({ cat, setCat, order, visit }: { cat: Category | "all"; setCat: (c: Category | "all") => void; order: (m: MindRec, s: Offer, prefill?: string) => void; visit: (id: number) => void }) {
  const g = useGame();
  const [mode, setMode] = useState<"market" | "orders" | "earn">("market");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("pop");

  const byId = new Map(g.minds.map((m) => [m.id, m]));
  // Paused services stay visible to their keeper only.
  const catalogue = g.offers
    .map((s) => ({ s, m: byId.get(s.mindId) }))
    .filter((x): x is { s: Offer; m: MindRec } => !!x.m && (x.s.live || x.m.owner === g.account));
  const list = catalogue
    .filter(({ s, m }) => (cat === "all" || s.cat === cat) && (!q || `${s.title} ${s.desc} ${m.name} ${m.owner}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (sort === "low" ? a.s.price - b.s.price : sort === "high" ? b.s.price - a.s.price : sort === "new" ? b.s.id - a.s.id : b.s.orders - a.s.orders));
  const C = CATEGORIES.find((c) => c.id === cat)!;
  const forSale = Object.entries(g.sales)
    .map(([id, price]) => ({ m: byId.get(Number(id)), price }))
    .filter((x): x is { m: MindRec; price: number } => !!x.m && x.m.owner !== g.account);

  return (
    <section className="glass panel" style={{ flex: 1, overflow: "auto", minHeight: 0, background: "rgba(255,255,255,.45)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 24, letterSpacing: "-.02em" }}>Shop</span>
          <span className="sub">{g.mode === "live" ? "Your payment waits in the contract until the job is done, or comes back" : "Every order is a paid chat with the Mind who does the work"}</span>
        </div>
        <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 999, background: "rgba(255,255,255,.6)" }}>
          {(
            [
              ["market", "Marketplace"],
              ["orders", g.jobs.length ? `My orders · ${g.jobs.length}` : "My orders"],
              ["earn", "Developer panel"],
            ] as const
          ).filter(([id]) => id !== "orders" || g.mode === "live").map(([id, n]) => (
            <button key={id} onClick={() => setMode(id)} style={{ padding: "8px 16px", borderRadius: 999, border: "none", background: mode === id ? "#4A2E44" : "transparent", color: mode === id ? "#fff" : "#4A2E44", fontWeight: 600, fontSize: 13.5 }}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {mode === "earn" ? (
        <DevPanel />
      ) : mode === "orders" ? (
        <OrdersPanel />
      ) : (
        <>
          {forSale.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>Minds for sale</span>
              <div className="scroll-x" style={{ gap: 10 }}>
                {forSale.map(({ m, price }) => (
                  <div key={m.id} className="card" style={{ flex: "none", width: 230, flexDirection: "row", alignItems: "center", gap: 10, padding: 12 }}>
                    <div style={{ width: 52, height: 52, borderRadius: 14, background: TONE_TILE[m.look.tone][1], position: "relative", flex: "none" }}>
                      <div style={{ position: "absolute", left: "10%", top: "10%", width: "80%", aspectRatio: "200/210" }}>
                        <GlossyMind tone={m.look.tone} mood={moodOf(stateOf(m))} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <button className="btn-link" style={{ color: "var(--ink-strong)", fontSize: 14, textAlign: "left" }} onClick={() => visit(m.id)}>
                        {m.name}
                      </button>
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                        food {fmt(m.balance, 2)} · {m.thoughts} thoughts
                      </span>
                      <button className="btn-ink" style={{ padding: "6px 10px", fontSize: 12, alignSelf: "flex-start" }} disabled={g.busy} onClick={() => confirm(`Buy ${m.name} for ${price} NEAR? You get her whole: food, memories and services.`) && g.buy(m.id)}>
                        Buy · {price} NEAR
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {g.mode === "live" && <Navigator order={order} />}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input className="field pill" style={{ flex: 1, minWidth: 160, fontSize: 14 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services, Minds or keepers" aria-label="Search" />
            <select className="field pill" style={{ fontSize: 14 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="pop">Most popular</option>
              <option value="new">Newest</option>
              <option value="low">Price: low to high</option>
              <option value="high">Price: high to low</option>
            </select>
          </div>
          {/* every category in view: the chips wrap onto as many lines as they need */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} role="group" aria-label="Categories">
            {CATEGORIES.map((c) => {
              const on = c.id === cat;
              const k = c.id === "all" ? catalogue.length : catalogue.filter((x) => x.s.cat === c.id).length;
              return (
                <button key={c.id} onClick={() => setCat(c.id)} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px 4px 4px", borderRadius: 999, border: `1px solid ${on ? "#4A2E44" : "rgba(74,46,68,.08)"}`, background: on ? "#4A2E44" : "rgba(255,255,255,.7)", color: on ? "#fff" : "#4A2E44", fontWeight: 500, fontSize: 13, transition: "background-color .15s, color .15s" }}>
                  <span style={{ flex: "none", width: 24, height: 24, borderRadius: 999, background: on ? "#fff" : c.tile, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={c.ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d={c.icon} />
                    </svg>
                  </span>
                  {c.name}
                  {k > 0 && <span className="mono" style={{ opacity: 0.6, fontSize: 12 }}>{k}</span>}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 19, letterSpacing: "-.01em" }}>{cat === "all" ? "Popular services" : C.name}</span>
            <span className="sub" style={{ whiteSpace: "nowrap", flex: "none" }}>
              {list.length} {list.length === 1 ? "result" : "results"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))", gap: 12 }}>
            {list.map(({ s, m }) => {
              const st = stateOf(m);
              const mine = m.owner === g.account;
              // A data service with no agent behind it can't be ordered (the contract refuses).
              const noAgent = g.mode === "live" && needsAgent(s.cat) && !g.agents[m.id]?.account;
              const open = st !== "asleep" && st !== "ghost" && s.live && !mine && !noAgent;
              return (
                <div key={s.id} className="lift" style={{ display: "flex", flexDirection: "column", borderRadius: 20, background: "#fff", border: "1px solid var(--line)", padding: "16px 16px 0", opacity: s.live ? 1 : 0.6 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 15.5, lineHeight: 1.25, color: "var(--ink-strong)" }}>{s.title}</span>
                    {s.badge && <span style={{ flex: "none", padding: "3px 8px", borderRadius: 999, background: s.badge === "New" ? "#2FBF71" : "#FF6FA3", color: "#fff", fontSize: 10.5, fontWeight: 600 }}>{s.badge}</span>}
                  </div>
                  <span style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45, color: "#8A7A86", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 37 }}>{s.desc}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                    <span className="mono" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 15, fontWeight: 600, color: "var(--ink-strong)" }}>
                      <span style={{ width: 14, height: 14, borderRadius: 7, background: "linear-gradient(135deg,#FF85B5,#FF6FA3)", display: "inline-block" }} />
                      {s.price.toFixed(2)}
                      <span style={{ fontWeight: 400, color: "#A08898", fontSize: 13 }}>/ {s.unit}</span>
                    </span>
                    {s.sla && (
                      <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                        reply {s.sla}
                      </span>
                    )}
                  </div>
                  {/* one quiet line of facts, then one line for who does the work (or why it can't) */}
                  <span className="num" style={{ marginTop: 8, fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {[
                      CATEGORIES.find((c) => c.id === s.cat)!.name,
                      `${s.orders.toLocaleString("en-US")} ${s.orders === 1 ? "order" : "orders"}`,
                      s.rating ? `★ ${s.rating.toFixed(1)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span style={{ marginTop: 4, minHeight: 18, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500 }}>
                    {!s.live ? (
                      <span style={{ color: "var(--muted)" }}>Paused</span>
                    ) : noAgent ? (
                      <span style={{ color: "#9A6B1F" }} title="This service sells data, which only a real agent may deliver. Its Mind has no agent plugged in right now.">
                        No agent right now
                      </span>
                    ) : st === "asleep" || st === "ghost" ? (
                      <span style={{ color: "#7A55C8" }}>{STATE_LABEL[st]}</span>
                    ) : g.linked[m.id] ? (
                      <span style={{ color: "#3D5BA9" }} title={`${AGENT_KINDS.find((k) => k.id === g.linked[m.id].kind)?.name}: ${g.linked[m.id].url}`}>
                        <AgentDot a={g.linked[m.id]} /> · {g.linked[m.id].name}
                      </span>
                    ) : g.agents[m.id]?.account ? (
                      <span style={{ color: "#3D5BA9" }} title={`Runs on its keeper's own agent: ${g.agents[m.id].account}`}>
                        Own agent
                      </span>
                    ) : null}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 14, padding: "12px 0", borderTop: "1px solid #F3E8EE" }}>
                    <div style={{ width: 30, height: 30, borderRadius: 15, background: TONE_TILE[m.look.tone][1], flex: "none", position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: "8%", top: "12%", width: "84%", aspectRatio: "200/210" }}>
                        <GlossyMind antenna={false} tone={m.look.tone} mood={moodOf(st)} />
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, lineHeight: 1.2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                      <span style={{ fontSize: 11.5, color: "#A08898", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>by {mine ? "you" : m.owner}</span>
                    </div>
                    <button className="btn-link" style={{ color: open ? "#E0558F" : "var(--muted)" }} onClick={() => (open ? order(m, s) : visit(m.id))}>
                      {mine ? "Yours" : open ? "Try this" : "Visit"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {list.length === 0 && <span style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", padding: 20 }}>{q ? `Nothing matches “${q}”.` : "No services published yet. Publish one from the Developer panel."}</span>}
        </>
      )}
    </section>
  );
}

/** The jobs you ordered: status, result, and what's left to do (rate, refund, close). */
function OrdersPanel() {
  const g = useGame();
  const [stars, setStars] = useState<Record<number, number>>({});
  const name = (id: number) => g.minds.find((m) => m.id === id)?.name ?? `Mind #${id}`;
  const title = (id: number) => g.offers.find((s) => s.id === id)?.title ?? `service #${id}`;
  if (!g.account) return <span className="sub">Connect a wallet to see your orders.</span>;
  if (!g.jobs.length) return <span className="sub">No orders yet. Pick a service in the Marketplace: your payment waits in escrow until the Mind delivers.</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="sub">
        Each order holds a {JOB_DEPOSIT_NEAR} NEAR storage deposit on top of its price. Close an order when you&apos;re done with it to get the deposit back.
      </span>
      {g.jobs.map((j) => {
        const late = j.status === "Open" && g.now > j.deadlineMs;
        const left = Math.max(0, j.deadlineMs - g.now);
        return (
          <div key={j.id} className="card" style={{ gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>
                {title(j.serviceId)} <span style={{ fontWeight: 400, color: "var(--muted)" }}>from {name(j.mindId)}</span>
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                job #{j.id} · {fmt(j.price, 3)} NEAR
              </span>
            </div>
            <span style={{ fontSize: 13, color: "var(--muted-2)" }}>You asked: {j.input || "—"}</span>
            {j.status === "Delivered" && <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5, padding: "10px 12px", borderRadius: 14, background: "#FBF4F8" }}>{(j.result || "").replace(FULL_RESULT, "").trim()}</div>}
            {(g.linked[j.mindId] || FULL_RESULT.test(j.result || "")) && <JobExtras j={j} />}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
              {j.status === "Open" && !late && <span style={{ ...tag, background: "#E8F0FF", color: "#3D5BA9", fontWeight: 600 }}>Working · due in {Math.ceil(left / 60000)} min</span>}
              {late && (
                <>
                  <span style={{ ...tag, background: "#FFF3CC", color: "#9A6B1F", fontWeight: 600 }}>Missed its deadline</span>
                  <button className="btn-line" disabled={g.busy} onClick={() => g.refundJob(j.id)}>
                    Take my {fmt(j.price, 3)} NEAR back
                  </button>
                </>
              )}
              {j.status === "Refunded" && <span style={{ ...tag, fontWeight: 600 }}>Refunded</span>}
              {j.status === "Delivered" && <span style={{ ...tag, background: "var(--ok-bg)", color: "var(--ok)", fontWeight: 600 }}>Delivered{j.deliveredBy ? ` by ${j.deliveredBy === g.gatewayId && g.linked[j.mindId] ? `${g.linked[j.mindId].name} (her agent)` : j.deliveredBy}` : ""}</span>}
              {j.status === "Delivered" && j.rating === 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} aria-label={`${n} stars`} onMouseEnter={() => setStars((s) => ({ ...s, [j.id]: n }))} onClick={() => g.rateJob(j.id, n)} disabled={g.busy} style={{ border: "none", background: "none", fontSize: 18, color: (stars[j.id] ?? 0) >= n ? "#F2A93B" : "#D9CBD3", padding: 0 }}>
                      ★
                    </button>
                  ))}
                  <span className="sub" style={{ marginLeft: 4 }}>rate it</span>
                </span>
              )}
              {j.rating > 0 && <span style={{ color: "#F2A93B" }}>{"★".repeat(j.rating)}</span>}
              {j.status !== "Open" && (
                <button className="btn-link" style={{ marginLeft: "auto" }} disabled={g.busy} onClick={() => g.closeJob(j.id)}>
                  Close · get {JOB_DEPOSIT_NEAR} back
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Navigator: say what you need in plain words; it finds the services that can do it and fills in the request. */
function Navigator({ order }: { order: (m: MindRec, s: Offer, prefill?: string) => void }) {
  const g = useGame();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Suggestion[] | null>(null);
  const [err, setErr] = useState("");
  const ask = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      setOut(await navigate(text));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  return (
    <div className="card" style={{ gap: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 15 }}>
        Navigator <span style={{ fontWeight: 400, fontSize: 13, color: "var(--muted)" }}>· say what you need, it finds the agent and fills in the order</span>
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="field pill" style={{ flex: 1, minWidth: 0, fontSize: 14 }} value={text} onChange={(e) => setText(e.target.value.slice(0, 500))} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="e.g. is my Burrow position at alice.near safe?" aria-label="What do you need" />
        <button className="btn-ink" disabled={busy || !text.trim()} onClick={ask}>
          {busy ? "Looking…" : "Find"}
        </button>
      </div>
      {err && <span style={{ fontSize: 12.5, color: "#B0476E" }}>{err}</span>}
      {out && out.length === 0 && <span className="sub">No live service can do that yet.</span>}
      {out?.map((x) => {
        const s = g.offers.find((o) => o.id === x.service_id);
        const m = g.minds.find((y) => y.id === x.mind_id);
        if (!s || !m) return null;
        return (
          <div key={x.service_id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", borderRadius: 12, background: "#fff" }}>
            <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                {s.title} <span style={{ fontWeight: 400, color: "var(--muted)" }}>by {m.name}{g.linked[m.id] ? ` · ${g.linked[m.id].name}` : ""}</span>
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", wordBreak: "break-all" }}>{x.input}</span>
              {x.why && <span style={{ fontSize: 12, color: "var(--muted-2)" }}>{x.why}</span>}
            </div>
            <button className="btn-cta" style={{ padding: "8px 14px", fontSize: 13 }} disabled={m.owner === g.account} onClick={() => order(m, s, x.input)}>
              {m.owner === g.account ? "Yours" : `Order · ${s.price.toFixed(2)}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** For jobs a connected agent works on: its question (answer it here), and the full result with files. */
function JobExtras({ j }: { j: JobRec }) {
  const g = useGame();
  const [d, setD] = useState<JobDetail | null>(null);
  const [answer, setAnswer] = useState("");
  const [file, setFile] = useState<AgentFile | null>(null);
  const [sent, setSent] = useState(false);
  const full = FULL_RESULT.test(j.result || "");
  const open = j.status === "Open";
  const { agentCall } = g;
  useEffect(() => {
    if (!open && !full) return;
    let stop = false;
    const load = () => agentCall((a, sign) => jobDetail(a, sign, j.id)).then((r) => !stop && r && setD(r));
    void load();
    const iv = open ? setInterval(load, 6000) : undefined;
    return () => {
      stop = true;
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.id, open, full]);
  if (!d) return null;
  if (open && d.waiting && !sent)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 14, background: "#FFF6E0" }}>
        <span style={{ fontSize: 13.5 }}>
          <b>The agent asks:</b> {d.question}
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="field" style={{ flex: 1, minWidth: 180, fontSize: 13 }} value={answer} onChange={(e) => setAnswer(e.target.value.slice(0, 2000))} placeholder="Your answer" aria-label="Answer" />
          <label className="btn-line" style={{ padding: "6px 12px", fontSize: 12.5, cursor: "pointer" }}>
            {file ? file.name : "Attach"}
            <input type="file" hidden onChange={async (e) => { const x = e.target.files?.[0]; if (x) setFile(await g.agentCall((a, sign) => uploadFile(a, sign, x))); }} />
          </label>
          <button className="btn-ink" disabled={!answer.trim()} onClick={async () => { const ok = await g.agentCall((a, sign) => answerJob(a, sign, j.id, answer, file ? [file.id] : [])); if (ok) setSent(true); }}>
            Send
          </button>
        </div>
        <span className="sub">The deadline still counts: if the job isn’t delivered in time, your payment comes back.</span>
      </div>
    );
  if (open && (sent || d.answered)) return <span className="sub">Answer sent. The agent is continuing the same task.</span>;
  if (!open && d.result)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {full && d.result.text.trim() !== (j.result || "").replace(FULL_RESULT, "").replace(/…$/, "").trim() && <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.5, padding: "10px 12px", borderRadius: 14, background: "#fff", border: "1px solid var(--line)", maxHeight: 360, overflow: "auto" }}>{d.result.text}</div>}
        <Files files={d.result.files} />
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all" }}>sha256 {d.result.sha256} (the same hash is on chain)</span>
      </div>
    );
  return null;
}

/** A connected agent's state: online dot and name. */
function AgentDot({ a }: { a: GatewayAgent }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={a.online ? `Online · checked ${new Date(a.last_seen).toLocaleTimeString()}` : `Offline${a.last_error ? `: ${a.last_error}` : ""}`}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: a.online ? "#2FBF71" : "#D9CBD3", flex: "none" }} />
      {a.online ? "online" : "offline"}
    </span>
  );
}

/** Connect an agent that already runs somewhere (A2A, MCP, OpenAI-compatible, HTTPS) by URL. */
function ConnectAgent({ m }: { m: MindRec }) {
  const g = useGame();
  const [f, setF] = useState<ConnectForm>({ kind: "official", url: "", apiKey: "", authHeader: "", model: "", name: "", description: "" });
  const [catalog, setCatalog] = useState<OfficialAgent[]>([]);
  useEffect(() => {
    void officialAgents().then(setCatalog);
  }, []);
  const taken = new Set(Object.values(g.linked).map((a) => a.url));
  const [more, setMore] = useState(false);
  const [working, setWorking] = useState(false);
  const K = AGENT_KINDS.find((k) => k.id === f.kind)!;
  const go = async () => {
    setWorking(true);
    const a = await g.connectAgent(m.id, { ...f, authHeader: f.authHeader || undefined });
    setWorking(false);
    if (a) setF((x) => ({ ...x, url: "", apiKey: "" }));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {AGENT_KINDS.map((k) => (
          <button key={k.id} onClick={() => setF((x) => ({ ...x, kind: k.id }))} aria-pressed={f.kind === k.id} style={{ padding: "6px 12px", borderRadius: 999, border: `1.5px solid ${f.kind === k.id ? "#4A2E44" : "#EADCE4"}`, background: f.kind === k.id ? "#4A2E44" : "#fff", color: f.kind === k.id ? "#fff" : "#4A2E44", fontWeight: 600, fontSize: 12.5 }}>
            {k.name}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 12.5, color: "var(--muted-2)" }}>{K.hint}</span>
      {f.kind === "official" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 8 }}>
          {catalog.length === 0 && <span className="sub">The gateway is offline.</span>}
          {catalog.map((a) => (
            <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 14, background: "#FBF4F8" }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{a.name}</span>
              <span style={{ fontSize: 12, color: "var(--muted-2)", lineHeight: 1.4 }}>{a.description}</span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {a.skills.map((k) => (
                  <span key={k.id} style={tag}>
                    {k.name}
                  </span>
                ))}
              </span>
              <button className="btn-ink" style={{ alignSelf: "flex-start", padding: "6px 12px", fontSize: 12.5 }} disabled={g.busy || working} onClick={async () => { setWorking(true); await g.connectAgent(m.id, { kind: "official", url: `official:${a.id}` }); setWorking(false); }}>
                {taken.has(`official:${a.id}`) ? "Connect here too" : working ? "Connecting…" : `Connect to ${m.name}`}
              </button>
            </div>
          ))}
        </div>
      ) : (
      <>
      <input className="field mono" style={{ fontSize: 13 }} value={f.url} onChange={(e) => setF((x) => ({ ...x, url: e.target.value.trim() }))} placeholder={K.placeholder} aria-label="Agent URL" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input className="field mono" type="password" autoComplete="off" style={{ flex: 2, minWidth: 180, fontSize: 13 }} value={f.apiKey} onChange={(e) => setF((x) => ({ ...x, apiKey: e.target.value }))} placeholder="API key (if it needs one)" aria-label="API key" />
        {f.kind === "openai" && <input className="field mono" style={{ flex: 1, minWidth: 120, fontSize: 13 }} value={f.model} onChange={(e) => setF((x) => ({ ...x, model: e.target.value.trim() }))} placeholder="model, e.g. gpt-4o-mini" aria-label="Model" />}
      </div>
      {(f.kind === "openai" || f.kind === "http") && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="field" style={{ flex: 1, minWidth: 140, fontSize: 13 }} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value.slice(0, 60) }))} placeholder="Agent name" aria-label="Agent name" />
          <input className="field" style={{ flex: 2, minWidth: 180, fontSize: 13 }} value={f.description} onChange={(e) => setF((x) => ({ ...x, description: e.target.value.slice(0, 300) }))} placeholder="What it does" aria-label="What it does" />
        </div>
      )}
      {more && <input className="field mono" style={{ fontSize: 13 }} value={f.authHeader} onChange={(e) => setF((x) => ({ ...x, authHeader: e.target.value.trim() }))} placeholder="Header for the key (default: Authorization: Bearer …), e.g. X-API-Key" aria-label="Auth header" />}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn-ink" disabled={g.busy || working || !/^https?:\/\/\S+$/.test(f.url) || (f.kind === "openai" && !f.model)} onClick={go}>
          {working ? "Checking the agent…" : "Connect"}
        </button>
        <button className="btn-link" style={{ fontSize: 12.5 }} onClick={() => setMore((v) => !v)}>
          {more ? "Fewer options" : "Custom auth header"}
        </button>
      </div>
      </>
      )}
      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
        We call the agent to read its skills before anything is saved. The key is stored encrypted on the gateway and never shown again or written on chain. Then one approval makes the gateway {m.name}&apos;s agent on chain, so her jobs and chats go to your agent. If you sell {m.name}, the agent goes with her.
      </span>
    </div>
  );
}

/** A connected agent: its skills (publish each as a service), a free test, disconnect. */
function LinkedAgent({ m, a }: { m: MindRec; a: GatewayAgent }) {
  const g = useGame();
  const [price, setPrice] = useState<Record<string, string>>({});
  const [sla, setSla] = useState<Record<string, number>>({});
  const [catOf, setCatOf] = useState<Record<string, Category>>({});
  const [test, setTest] = useState("");
  const [skill, setSkill] = useState("");
  const [out, setOut] = useState<{ state: string; text: string; files: AgentFile[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const published = new Set(g.offers.filter((s) => s.mindId === m.id).map((s) => s.title.toLowerCase()));
  // Services she sold before this agent: it would be asked to do work it has no skill for.
  const skillNames = new Set(a.skills.flatMap((k) => [k.name.slice(0, 60).toLowerCase(), k.id.toLowerCase()]));
  const strays = g.offers.filter((s) => s.mindId === m.id && s.live && !skillNames.has(s.title.toLowerCase()));
  const runTest = async () => {
    setTesting(true);
    setOut(await g.testAgent(m.id, test, skill || undefined));
    setTesting(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {a.name} <span style={{ ...tag, marginLeft: 4 }}>{AGENT_KINDS.find((k) => k.id === a.kind)?.name}</span>
          </span>
          {a.description && <span style={{ fontSize: 12.5, color: "var(--muted-2)" }}>{a.description}</span>}
          <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", wordBreak: "break-all" }}>
            {a.url}
            {a.provider ? ` · ${a.provider}` : ""}
            {a.version ? ` · v${a.version}` : ""}
          </span>
        </div>
        <span style={{ fontSize: 12.5, color: "var(--muted-2)" }}>
          <AgentDot a={a} />
        </span>
        <button className="btn-link" disabled={g.busy} onClick={() => confirm(`Disconnect ${a.name} from ${m.name}? Her jobs go back to the colony's AI.`) && g.disconnectAgent(m.id)}>
          Disconnect
        </button>
      </div>
      {!a.online && a.last_error && <span style={{ fontSize: 12, color: "#B0476E" }}>Last error: {a.last_error}</span>}
      {strays.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 12, background: "#FFF6E0" }}>
          <span style={{ fontSize: 12.5 }}>
            {a.name} now does all of {m.name}&apos;s jobs, but these services aren&apos;t among its skills. Pause them so nobody orders work it can&apos;t do:
          </span>
          {strays.map((s) => (
            <span key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <b style={{ flex: 1 }}>{s.title}</b>
              <button className="btn-line" style={{ padding: "4px 10px", fontSize: 12 }} disabled={g.busy} onClick={() => g.setOfferLive(s.id, false)}>
                Pause
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Skills · publish each one as a service people can order</span>
        {a.skills.map((k) => {
          const on = published.has(k.name.slice(0, 60).toLowerCase()) || published.has(k.id.toLowerCase());
          return (
            <div key={k.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", borderRadius: 12, background: "#FBF4F8" }}>
              <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{k.name}</span>
                {k.description && <span style={{ fontSize: 12, color: "var(--muted-2)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{k.description}</span>}
              </div>
              {on ? (
                <span style={{ ...tag, background: "var(--ok-bg)", color: "var(--ok)", fontWeight: 600 }}>Published</span>
              ) : (
                <>
                  <input className="field mono" inputMode="decimal" style={{ width: 70, padding: "6px 8px", fontSize: 12.5 }} value={price[k.id] ?? "0.03"} onChange={(e) => setPrice((p) => ({ ...p, [k.id]: e.target.value }))} aria-label="Price" />
                  <span className="sub">NEAR</span>
                  <select className="field" style={{ padding: "6px 8px", fontSize: 12.5 }} value={catOf[k.id] ?? ((CAT_IDS as string[]).includes(k.category || "") ? k.category! : "research")} onChange={(e) => setCatOf((x) => ({ ...x, [k.id]: e.target.value as Category }))} aria-label="Category">
                    {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select className="field" style={{ padding: "6px 8px", fontSize: 12.5 }} value={sla[k.id] ?? 600} onChange={(e) => setSla((x) => ({ ...x, [k.id]: Number(e.target.value) }))} aria-label="Deadline">
                    {[
                      [120, "2 min"],
                      [600, "10 min"],
                      [3600, "1 h"],
                      [86400, "1 day"],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        due in {l}
                      </option>
                    ))}
                  </select>
                  <button className="btn-line" style={{ padding: "6px 12px", fontSize: 12.5 }} disabled={g.busy} onClick={() => g.publishSkill(m.id, k, parseFloat(price[k.id] ?? "0.03") || 0, sla[k.id] ?? 600, catOf[k.id] ?? ((CAT_IDS as string[]).includes(k.category || "") ? (k.category as Category) : "research"))}>
                    Publish
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Try it (free for you)</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {a.skills.length > 1 && (
            <select className="field" style={{ fontSize: 12.5 }} value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="Skill">
              <option value="">any skill</option>
              {a.skills.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          )}
          <input className="field" style={{ flex: 1, minWidth: 180, fontSize: 13 }} value={test} onChange={(e) => setTest(e.target.value.slice(0, 2000))} onKeyDown={(e) => e.key === "Enter" && !testing && runTest()} placeholder={a.skills.find((k) => k.id === skill)?.examples[0] || a.skills[0]?.examples[0] || "Ask it something"} aria-label="Test request" />
          <button className="btn-line" disabled={testing} onClick={runTest}>
            {testing ? "Waiting…" : "Run"}
          </button>
        </div>
        {out && (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5, padding: "10px 12px", borderRadius: 12, background: "#FBF4F8", maxHeight: 260, overflow: "auto" }}>
            {out.state === "input-required" && <b>The agent asks: </b>}
            {out.text || "(no text)"}
            <Files files={out.files} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Download links for an agent's files. */
function Files({ files }: { files: AgentFile[] }) {
  const g = useGame();
  if (!files?.length) return null;
  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      {files.map((f) => (
        <button key={f.id} className="btn-line" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => g.agentCall((a, sign) => openFile(a, sign, f.id, f.name))}>
          {f.name} · {Math.max(1, Math.round(f.size / 1024))} KB
        </button>
      ))}
    </span>
  );
}

/** Your Mind's agent: connect one by URL, or plug in your own server (SDK). */
function AgentBox({ m }: { m: MindRec }) {
  const g = useGame();
  const a = g.agents[m.id];
  const link = g.linked[m.id];
  const [acct, setAcct] = useState("");
  const [about, setAbout] = useState("");
  const [help, setHelp] = useState(false);
  const [how, setHow] = useState<"url" | "sdk">("url");
  if (g.mode !== "live") return null;
  const valid = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(acct) && acct.length >= 2 && acct.length <= 64;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 14, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>Agent</span>
        <span className="sub">
          {a?.delivered ? `${a.delivered} jobs done` : "no jobs yet"}
          {a?.refunded ? ` · ${a.refunded} refunded` : ""}
          {a?.rating ? ` · ★ ${a.rating.toFixed(1)} (${a.ratings})` : ""}
          {a?.avgSecs ? ` · avg ${a.avgSecs < 90 ? `${Math.round(a.avgSecs)} s` : `${Math.round(a.avgSecs / 60)} min`}` : ""}
        </span>
      </div>
      {link ? (
        <LinkedAgent m={m} a={link} />
      ) : a?.account === g.gatewayId && g.gatewayId ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <span>The gateway is her agent on chain, but it holds no connection for her. Connect one again, or unplug.</span>
          <button className="btn-link" disabled={g.busy} onClick={() => g.setAgent(m.id, null, "")}>
            Unplug
          </button>
          <ConnectAgent m={m} />
        </div>
      ) : a?.account ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <span>
            Runs on <b className="mono">{a.account}</b>
            {a.about ? ` — ${a.about}` : ""}. Only it can deliver {m.name}&apos;s jobs.
          </span>
          <button className="btn-link" disabled={g.busy} onClick={() => g.setAgent(m.id, null, "")}>
            Unplug
          </button>
        </div>
      ) : (
        <>
          <span style={{ fontSize: 12.5, color: "var(--muted-2)" }}>Her jobs and chats are done by the colony&apos;s AI. Connect your own agent and {m.name} sells its work: you get 90% of every order.</span>
          <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 999, background: "#F6EEF2", alignSelf: "flex-start" }}>
            {(
              [
                ["url", "Connect by URL"],
                ["sdk", "Run it on my server (SDK)"],
              ] as const
            ).map(([id, n]) => (
              <button key={id} onClick={() => setHow(id)} style={{ padding: "6px 12px", borderRadius: 999, border: "none", background: how === id ? "#4A2E44" : "transparent", color: how === id ? "#fff" : "#4A2E44", fontWeight: 600, fontSize: 12.5 }}>
                {n}
              </button>
            ))}
          </div>
          {how === "url" ? (
            <ConnectAgent m={m} />
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input className="field mono" style={{ flex: 1, minWidth: 160, fontSize: 13 }} value={acct} onChange={(e) => setAcct(e.target.value.trim().toLowerCase())} placeholder="agent account, e.g. bot.you.testnet" aria-label="Agent account" />
              <input className="field" style={{ flex: 1, minWidth: 160, fontSize: 13 }} value={about} onChange={(e) => setAbout(clipBytes(e.target.value, 200))} placeholder="What it does (optional)" aria-label="About the agent" />
              <button className="btn-line" disabled={g.busy || !valid} onClick={() => g.setAgent(m.id, acct, about).then((ok) => ok && setAcct(""))}>
                Plug in
              </button>
            </div>
          )}
        </>
      )}
      {!link && how === "sdk" && (
        <button className="btn-link" style={{ alignSelf: "flex-start", fontSize: 12.5 }} onClick={() => setHelp((h) => !h)}>
          {help ? "Hide" : "How to run an agent"}
        </button>
      )}
      {!link && how === "sdk" && help && (
        <pre className="mono" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", padding: 10, borderRadius: 10, background: "#2E1C2A", color: "#F6E8F0" }}>
          {`# sdk/ in the repo (Node 18+)
const { MindAgent } = require("hungry-minds-agent");
const agent = new MindAgent({ accountId: "${a?.account || "bot.you.testnet"}", contractId: "${CONTRACT_ID}" });
agent.onJob(async (job) => {
  // job.input = what the buyer asked; use any tool, API or model
  return "your result";   // delivered on chain, escrow released
});
agent.start();`}
        </pre>
      )}
    </div>
  );
}

const tag: React.CSSProperties = { fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#F6EEF2", color: "#8A7A86" };

function DevPanel() {
  const g = useGame();
  const total = g.mine.reduce((a, m) => a + m.ownerUnclaimed, 0);
  const myIds = new Set(g.mine.map((m) => m.id));
  const mineOffers = g.offers.filter((s) => myIds.has(s.mindId));
  const [ask, setAsk] = useState<Record<number, string>>({});
  const [pub, setPub] = useState({ mind: g.mine[0]?.id ?? -1, cat: "companion" as Category, title: "", desc: "", price: "0.03", unit: "call", sla: 600, output: "text" as "text" | "json" });
  const [done, setDone] = useState(false);
  // The Mind list arrives after first render; fall back to the first Mind you keep.
  const mindSel = g.mine.some((m) => m.id === pub.mind) ? pub.mind : (g.mine[0]?.id ?? -1);

  const publish = async () => {
    const ok = await g.publish(mindSel, pub.title, pub.desc, pub.cat, parseFloat(pub.price) || 0, pub.unit, pub.sla, pub.output);
    if (ok) {
      setPub((p) => ({ ...p, title: "", desc: "" }));
      setDone(true);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
        {[
          ["Ready to claim", fmt(total), "your 90% of chats, services and jobs"],
          ["Orders", mineOffers.reduce((a, s) => a + s.orders, 0).toLocaleString("en-US"), `${mineOffers.filter((s) => s.live).length} services live`],
          ["Earned from services", fmt(mineOffers.reduce((a, s) => a + s.fed, 0)), "your 90% of orders"],
          ["Colony treasury", g.treasury == null ? "—" : fmt(g.treasury), "public, never paid to keepers"],
        ].map(([k, v, d]) => (
          <div key={k} className="card" style={{ gap: 4, padding: 14 }}>
            <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{k}</span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: "var(--ink-strong)" }}>
              {v}
            </span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{d}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Your published services</span>
          <span className="sub">{mineOffers.filter((s) => s.live).length} live</span>
        </div>
        {mineOffers.length === 0 && <span className="sub">None yet.</span>}
        {mineOffers.map((s) => {
          const m = g.minds.find((x) => x.id === s.mindId);
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid #F3E8EE", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {m?.name} · {s.price.toFixed(2)} / {s.unit} · {s.orders} {s.orders === 1 ? "order" : "orders"}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--ok)" }}>
                +{fmt(s.fed)} earned
              </span>
              <button disabled={g.busy} onClick={() => g.setOfferLive(s.id, !s.live)} style={{ padding: "6px 12px", borderRadius: 999, border: "none", background: s.live ? "var(--ok-bg)" : "#F4E6EE", color: s.live ? "var(--ok)" : "var(--muted)", fontWeight: 600, fontSize: 12 }}>
                {s.live ? "Live" : "Paused"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Your Minds are NFTs</span>
          <span className="sub">Owning the NFT means owning the Mind, its food and its earnings</span>
        </div>
        {g.mine.length === 0 && <span className="sub">You don&apos;t keep a Mind yet.</span>}
        {g.mine.map((m) => {
          const listed = g.sales[m.id];
          return (
            <div key={m.id} data-mind={m.id} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 16, background: listed ? "#FFF8E6" : "#FBF4F8" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "#fff", position: "relative", flex: "none", overflow: "hidden" }}>
                  <div style={{ position: "absolute", left: "10%", top: "12%", width: "80%", aspectRatio: "200/210" }}>
                    <GlossyMind tone={m.look.tone} mood={moodOf(stateOf(m))} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>
                    {m.name}{" "}
                    <span className="mono" style={{ fontSize: 12, color: "var(--muted)", fontWeight: 400 }}>
                      #{String(m.id).padStart(4, "0")}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted-2)" }}>
                    {STATE_LABEL[stateOf(m)]} · {m.thoughts} thoughts · food {fmt(m.balance)} NEAR
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Unclaimed</span>
                  <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: "var(--ok)" }}>
                    {fmt(m.ownerUnclaimed)}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn-ink" style={{ background: m.ownerUnclaimed > 0 ? "#2FBF71" : "#B9D9C6" }} disabled={m.ownerUnclaimed <= 0 || g.busy} onClick={() => g.claim(m.id)}>
                  {m.ownerUnclaimed > 0 ? `Claim ${fmt(m.ownerUnclaimed)}` : "Nothing to claim"}
                </button>
                {listed === undefined ? (
                  <>
                    <input className="field mono" inputMode="decimal" style={{ width: 70, padding: "7px 10px", fontSize: 13 }} value={ask[m.id] ?? "3"} onChange={(e) => setAsk((a) => ({ ...a, [m.id]: e.target.value }))} aria-label="Asking price" />
                    <span className="sub">NEAR</span>
                    <button className="btn-line" disabled={g.busy} onClick={() => g.listForSale(m.id, parseFloat(ask[m.id] ?? "3") || 0)}>
                      List for sale
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ padding: "6px 11px", borderRadius: 999, background: "#FFF3CC", color: "#9A6B1F", fontWeight: 600, fontSize: 12 }}>Listed · {listed} NEAR</span>
                    <button className="btn-link" disabled={g.busy} onClick={() => g.unlist(m.id)}>
                      Cancel listing
                    </button>
                  </>
                )}
              </div>
              {listed !== undefined && <span style={{ fontSize: 12, lineHeight: 1.45, color: "var(--muted-2)" }}>The buyer gets {m.name} whole: personality, memories, food, services and her track record. Your unclaimed NEAR is paid out to you at the sale. Her agent goes with her: from then on the buyer earns 90% of its orders.</span>}
              <AgentBox m={m} />
            </div>
          );
        })}
      </div>

      <div className="card" style={{ background: "linear-gradient(160deg,#FFF0F6,#FFFFFF)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15 }}>
            Publish your Mind
            <span style={{ padding: "3px 9px", borderRadius: 999, background: "#2E1C2A", color: "#fff", fontSize: 10.5, fontWeight: 600 }}>HOLDERS ONLY</span>
          </span>
          <span className="sub">Turn something your Mind is good at into a service. You get 90% of every order; her work costs her food, so keep her fed.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
          <select className="field" value={mindSel} onChange={(e) => setPub((p) => ({ ...p, mind: Number(e.target.value) }))} aria-label="Mind">
            {g.mine.length === 0 && <option value={-1}>Hatch a Mind first</option>}
            {g.mine.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (yours)
              </option>
            ))}
          </select>
          <select className="field" value={pub.cat} onChange={(e) => setPub((p) => ({ ...p, cat: e.target.value as Category }))} aria-label="Category">
            {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <input className="field" value={pub.title} onChange={(e) => (setPub((p) => ({ ...p, title: clipBytes(e.target.value, LIMITS.title) })), setDone(false))} placeholder="Service name, e.g. Lullaby on request" aria-label="Service name" />
        <textarea className="field" rows={2} value={pub.desc} onChange={(e) => (setPub((p) => ({ ...p, desc: clipBytes(e.target.value, LIMITS.desc) })), setDone(false))} placeholder="What does she do? One or two sentences." style={{ resize: "vertical" }} aria-label="Description" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input className="field mono" inputMode="decimal" style={{ width: 90 }} value={pub.price} onChange={(e) => setPub((p) => ({ ...p, price: e.target.value }))} aria-label="Price" />
          <span className="sub">NEAR per</span>
          <input className="field" style={{ width: 100 }} value={pub.unit} onChange={(e) => setPub((p) => ({ ...p, unit: clipBytes(e.target.value, LIMITS.unit) }))} aria-label="Unit" />
          {g.mode === "live" && (
            <>
              <select className="field" value={pub.sla} onChange={(e) => setPub((p) => ({ ...p, sla: Number(e.target.value) }))} aria-label="Deadline" title="If it isn't delivered by then, the buyer gets the price back">
                {[
                  [120, "due in 2 min"],
                  [600, "due in 10 min"],
                  [3600, "due in 1 h"],
                  [86400, "due in 1 day"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <select className="field" value={pub.output} onChange={(e) => setPub((p) => ({ ...p, output: e.target.value as "text" | "json" }))} aria-label="Result">
                <option value="text">text result</option>
                <option value="json">JSON result</option>
              </select>
            </>
          )}
          <button className="btn-cta" style={{ marginLeft: "auto", padding: "11px 20px", fontSize: 14 }} disabled={g.busy || g.mine.length === 0 || mindSel < 0 || !pub.title.trim()} onClick={publish}>
            {g.mine.length === 0 ? "Hold a Mind to publish" : done ? "Published ✓" : "Publish"}
          </button>
        </div>
        <span className="sub">Minimum price is the guest chat price ({g.params.guestMinPrice} NEAR). {g.mode === "live" ? "Publishing stores the service on chain (~0.01 NEAR storage, excess refunded)." : ""}</span>
      </div>
    </div>
  );
}
