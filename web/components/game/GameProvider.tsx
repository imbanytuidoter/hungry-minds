"use client";

// One game API for the whole app, with two engines behind it:
//
//  - live (default): the deployed contract (lib/chain.ts CONTRACT_ID — the public testnet
//    deploy unless overridden). Reads go over RPC (get_mind, live_balance, live_state,
//    get_look, services, listings, params…); writes are signed by the connected wallet (or a
//    browser burner account in QA builds only); chat replies come from the worker's chat
//    server (/api/chat), jobs are polled with get_job.
//  - demo (`/app?demo`, or NEXT_PUBLIC_CONTRACT_ID=""): the colony in lib/game/world.ts,
//    the same rules on a fast clock, saved in this browser. No network needed.
//
// Only off-chain feel (happiness, energy, love, chat history) is kept in the browser in
// live mode; money, ownership, looks, services and sales are all on chain.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as chain from "@/lib/chain";
import { useWallet } from "@/components/WalletProvider";
import { DEFAULT_PARAMS, LIVE_GHOST_MS, MOOD, demoClock, liveClock, moodAt, stateOf, type Clock, type MindRec, type Params } from "@/lib/game/engine";
import { lookFromTraits, NATURES, TONES, type Look } from "@/lib/game/look";
import { mindReply } from "@/lib/game/brain";
import { CAT_IDS, type Category, type Offer } from "@/lib/game/services";
import { clipWords, LIMITS } from "@/lib/game/bytes";
import * as W from "@/lib/game/world";
import { chatAllowance, sendChat } from "@/lib/chatClient";
import * as gate from "@/lib/agentClient";
import type { SignText } from "@/components/WalletProvider";

export type Mode = "demo" | "live";

/** A Mind as a worker: the agent her keeper plugged in (if any) and her track record. */
export type AgentCard = {
  account: string | null;
  about: string;
  delivered: number;
  refunded: number;
  rating: number | null; // average stars
  ratings: number;
  avgSecs: number | null;
  earned: number;
};
/** A job you ordered (agents.rs). */
export type JobRec = {
  id: number;
  serviceId: number;
  mindId: number;
  input: string;
  price: number;
  status: "Open" | "Delivered" | "Refunded";
  result: string | null;
  createdMs: number;
  deadlineMs: number;
  deliveredBy: string | null;
  rating: number;
};

export type Game = {
  mode: Mode;
  ready: boolean;
  now: number;
  account: string | null;
  burner: boolean;
  wallet: number | null;
  minds: MindRec[];
  mine: MindRec[];
  offers: Offer[];
  sales: Record<number, number>;
  supplyLeft: number | null;
  params: Params;
  clock: Clock;
  activity: W.Activity[];
  notifs: W.Notif[];
  unread: number;
  goal: number;
  treasury: number | null;
  thinking: number | null; // id of the Mind whose reply is on its way
  busy: boolean;
  error: string | null;
  clearError: () => void;
  signIn: () => void;
  signOut: () => Promise<void>;
  hatch: (name: string, look: Look, natures: string[]) => Promise<number | null>;
  feed: (id: number, near: number) => Promise<boolean>;
  revive: (id: number) => Promise<boolean>;
  talk: (id: number, prompt: string, paid?: number) => Promise<boolean>;
  /** Live: messages you can still send each Mind before paying more (her food, or your chat credits). */
  chatLeft: Record<number, number>;
  loadChatLeft: (id: number) => void;
  /** Live: prepay chat credits for talking to other keepers' Minds. */
  buyCredits: (near: number) => Promise<boolean>;
  order: (serviceId: number, prompt: string) => Promise<boolean>;
  claim: (id: number) => Promise<boolean>;
  reap: (id: number) => Promise<boolean>;
  setLook: (id: number, look: Look) => Promise<boolean>;
  publish: (mindId: number, title: string, desc: string, cat: Category, price: number, unit: string, slaSecs?: number, output?: "text" | "json") => Promise<boolean>;
  /** Live: each Mind's agent and reputation, by Mind id. */
  agents: Record<number, AgentCard>;
  /** Live: the jobs you ordered, newest first. */
  jobs: JobRec[];
  setAgent: (mindId: number, account: string | null, about: string) => Promise<boolean>;
  /** Live: agents connected by URL through the gateway (worker/gateway), by Mind id. */
  linked: Record<number, gate.GatewayAgent>;
  /** The gateway's account: a Mind whose on-chain agent is this runs a URL-connected agent. */
  gatewayId: string | null;
  connectAgent: (mindId: number, form: gate.ConnectForm) => Promise<gate.GatewayAgent | null>;
  disconnectAgent: (mindId: number) => Promise<boolean>;
  testAgent: (mindId: number, text: string, skill?: string) => Promise<{ state: string; text: string; files: gate.AgentFile[] } | null>;
  /** Publish one of a connected agent's skills as a service (a job with a deadline). */
  publishSkill: (mindId: number, skill: gate.GatewaySkill, price: number, slaSecs: number, cat: Category) => Promise<boolean>;
  /** Run a gateway call as you (your chat session); shows its error and returns null if it fails. */
  agentCall: <T>(fn: (account: string, sign: SignText) => Promise<T>) => Promise<T | null>;
  rateJob: (jobId: number, stars: number) => Promise<boolean>;
  closeJob: (jobId: number) => Promise<boolean>;
  refundJob: (jobId: number) => Promise<boolean>;
  setOfferLive: (serviceId: number, live: boolean) => Promise<boolean>;
  listForSale: (id: number, price: number) => Promise<boolean>;
  unlist: (id: number) => Promise<boolean>;
  buy: (id: number) => Promise<boolean>;
  deposit: () => void;
  pet: (id: number) => void;
  markRead: () => void;
  resetDemo: () => void;
};

const Ctx = createContext<Game | null>(null);
export function useGame(): Game {
  const g = useContext(Ctx);
  if (!g) throw new Error("useGame outside GameProvider");
  return g;
}

const errText = (e: unknown) => {
  const s = e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e);
  // Contract panics arrive wrapped; surface the assert message itself.
  // Some wallet modules (OKX, Bitget…) replace the real reason with a bare "sign Error".
  if (/^sign Error$/i.test(s.trim())) return `Your wallet did not sign this transaction (rejected, or it is set to another network). Check the wallet is on NEAR ${chain.NETWORK} and try again.`;
  const m = s.match(/Smart contract panicked: ([^"\\]+)/) || s.match(/panicked at [^:]+:\d+:\d+:\\n([^"\\]+)/);
  return m ? m[1].trim() : s.length > 240 ? s.slice(0, 240) + "…" : s;
};

export default function GameProvider({ children }: { children: React.ReactNode }) {
  // Decided after mount (the URL is only known on the client); both engines wait for it.
  const [forceDemo, setForceDemo] = useState<boolean | null>(null);
  useEffect(() => setForceDemo(new URLSearchParams(window.location.search).has("demo")), []);
  const live = chain.isLive() && forceDemo === false;
  // Mainnet without a mainnet contract runs neither engine: GameApp shows "not launched".
  const demo = useDemo(forceDemo !== null && !live && !(chain.notLaunched() && !forceDemo));
  const liveG = useLive(live);
  return <Ctx.Provider value={live ? liveG : demo}>{children}</Ctx.Provider>;
}

// ── Demo engine ────────────────────────────────────────────────────────────────

function useDemo(enabled: boolean): Game {
  const [world, setWorld] = useState<W.World | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [thinking, setThinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const t0 = Date.now();
    setWorld(W.tick(W.load(t0), t0));
    const iv = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setWorld((w) => (w ? W.tick(w, t) : w));
    }, 1000);
    return () => clearInterval(iv);
  }, [enabled]);

  useEffect(() => {
    if (world) W.save(world);
  }, [world]);

  const run = useCallback((f: (w: W.World, t: number) => W.World): boolean => {
    try {
      setWorld((w) => (w ? f(w, Date.now()) : w));
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  }, []);

  // setState updaters run lazily, so validate against the current world first; the
  // updater then re-applies the same pure action.
  const attempt = useCallback(
    async (f: (w: W.World, t: number) => W.World): Promise<boolean> => {
      if (!world) return false;
      try {
        f(world, Date.now());
      } catch (e) {
        setError(errText(e));
        return false;
      }
      return run(f);
    },
    [world, run]
  );

  // Demo replies come from the same model as live ones (offline phrasebook if it's unavailable).
  const reply = (id: number, thoughts: number, prompt: string, service?: string) => {
    setThinking(id);
    const k = ++n.current + thoughts;
    const m = world?.minds.find((x) => x.id === id);
    const natures = (m?.natures ?? []).map((x) => NATURES.indexOf(x)).filter((i) => i >= 0);
    const ask = service ? `[Service: ${service}] ${prompt}` : prompt;
    void mindReply({ name: m?.name ?? "Mind", traits: m?.traits ?? [], state: m ? stateOf(m) : "content", thoughts, natures }, ask, k).then(({ text }) => {
      setWorld((w) => (w ? W.deliverReply(w, id, k, service, text) : w));
      setThinking(null);
    });
  };

  return {
    mode: "demo",
    ready: !!world,
    now,
    account: world?.account ?? null,
    burner: false,
    wallet: world?.wallet ?? null,
    minds: world?.minds ?? [],
    mine: world ? W.mineOf(world) : [],
    offers: world?.services ?? [],
    sales: world?.sales ?? {},
    supplyLeft: world ? 4000 - world.minds.length : null,
    params: DEFAULT_PARAMS,
    clock: demoClock,
    activity: world?.activity ?? [],
    notifs: world?.notifs ?? [],
    unread: world?.unread ?? 0,
    goal: world && world.goal.day === W.dayKey(now) ? world.goal.n : 0,
    treasury: world?.treasury ?? null,
    thinking,
    busy: false,
    error,
    clearError: () => setError(null),
    signIn: () => {},
    signOut: async () => {},
    hatch: async (name, look, natures) => {
      if (!world) return null;
      try {
        const { id } = W.hatch(world, name, look, natures, Date.now());
        setWorld((w) => (w ? W.hatch(w, name, look, natures, Date.now()).w : w));
        return id;
      } catch (e) {
        setError(errText(e));
        return null;
      }
    },
    feed: (id, near) => attempt((w, t) => W.feed(w, id, near, t)),
    revive: (id) => attempt((w, t) => W.revive(w, id, DEFAULT_PARAMS.revivePrice, t)),
    talk: async (id, prompt, paid) => {
      const m = world?.minds.find((x) => x.id === id);
      if (!world || !m) return false;
      const own = m.owner === world.account;
      const ok = await attempt((w, t) => (own ? W.think(w, id, prompt, t) : W.chat(w, id, prompt, paid ?? DEFAULT_PARAMS.guestMinPrice, t)));
      if (ok) reply(id, m.thoughts, prompt);
      return ok;
    },
    chatLeft: {},
    loadChatLeft: () => {},
    buyCredits: async () => false,
    order: async (serviceId, prompt) => {
      const s = world?.services.find((x) => x.id === serviceId);
      const m = s && world?.minds.find((x) => x.id === s.mindId);
      if (!s || !m) return false;
      const ok = await attempt((w, t) => W.orderService(w, serviceId, prompt, s.price, t));
      if (ok) reply(m.id, m.thoughts, prompt, s.title);
      return ok;
    },
    claim: (id) => attempt((w, t) => W.claim(w, id, t)),
    reap: (id) => attempt((w, t) => W.reap(w, id, t)),
    setLook: (id, look) => attempt((w) => W.setLook(w, id, look)),
    publish: (mindId, title, desc, cat, price, unit) => attempt((w) => W.publishService(w, mindId, title, desc, cat, price, unit)),
    // Agents and jobs live on chain only.
    agents: {},
    jobs: [],
    setAgent: async () => false,
    linked: {},
    gatewayId: null,
    connectAgent: async () => null,
    disconnectAgent: async () => false,
    testAgent: async () => null,
    publishSkill: async () => false,
    agentCall: async () => null,
    rateJob: async () => false,
    closeJob: async () => false,
    refundJob: async () => false,
    setOfferLive: (sid, live) => attempt((w) => W.setServiceLive(w, sid, live)),
    listForSale: (id, price) => attempt((w) => W.listForSale(w, id, price)),
    unlist: (id) => attempt((w) => W.unlist(w, id)),
    buy: (id) => attempt((w, t) => W.buyMind(w, id, t)),
    deposit: () => run((w, t) => W.deposit(w, 5, t)),
    pet: (id) => run((w) => W.pet(w, id)),
    markRead: () => run((w) => ({ ...w, unread: 0 })),
    resetDemo: () => setWorld(W.newWorld(Date.now())),
  };
}

// ── Live engine ────────────────────────────────────────────────────────────────

// `ts` is when happy/energy were last set; moodAt() ages them from there.
type Feel = Pick<MindRec, "happy" | "energy" | "love" | "msgs"> & { ts?: number };
const FRESH = { happy: 80, energy: 70 };
const FEEL_KEY = "hm-live-feel";

function readFeel(): Record<number, Feel> {
  try {
    const f: Record<number, Feel> = JSON.parse(localStorage.getItem(FEEL_KEY) || "{}");
    // Mood saved before it had a timestamp starts ageing from now.
    if (Object.values(f).some((x) => !x.ts)) {
      for (const x of Object.values(f)) x.ts ??= Date.now();
      localStorage.setItem(FEEL_KEY, JSON.stringify(f));
    }
    return f;
  } catch {
    return {};
  }
}

const y2n = chain.yoctoToNear;
const toJob = (j: chain.JobOnChain): JobRec => ({
  id: j.id,
  serviceId: j.service_id,
  mindId: j.mind_id,
  input: j.input,
  price: y2n(j.escrow),
  status: j.status,
  result: j.result,
  createdMs: Math.floor(j.created / 1e6),
  deadlineMs: Math.floor(j.deadline / 1e6),
  deliveredBy: j.delivered_by,
  rating: j.rating,
});
/** "10 min", "1 h", "2 days" — a service's deadline as the shop shows it. */
export const slaText = (secs: number) =>
  secs < 3600 ? `${Math.round(secs / 60)} min` : secs < 86400 ? `${Math.round(secs / 3600)} h` : `${Math.round(secs / 86400)} day${secs >= 172800 ? "s" : ""}`;
const toChainLook = (l: Look, natures: string[]): chain.LookOnChain => ({
  tone: Math.max(0, TONES.indexOf(l.tone)),
  eyes: l.eyes,
  hat: l.hat,
  outfit: l.outfit,
  natures: natures.map((n) => NATURES.indexOf(n)).filter((i) => i >= 0).slice(0, 3),
});

type Row = { id: number; m: chain.MindOnChain; bal: number; state: string; look: chain.LookOnChain | null };

function useLive(enabled: boolean): Game {
  const { accountId, signer, signIn, burner, signOut, signMessage } = useWallet();
  const [chatLeft, setChatLeft] = useState<Record<number, number>>({});
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [ghostMs, setGhostMs] = useState(LIVE_GHOST_MS);
  const [rows, setRows] = useState<Row[]>([]);
  const [svc, setSvc] = useState<chain.ServiceOnChain[]>([]);
  const [sales, setSales] = useState<Record<number, number>>({});
  // the exact on-chain prices: buying attaches these, never a rounded copy (a price set to
  // more than 6 decimals elsewhere would otherwise fall short and the purchase fail)
  const salesYocto = useRef<Record<number, string>>({});
  const [supplyLeft, setSupplyLeft] = useState<number | null>(null);
  const [feel, setFeel] = useState<Record<number, Feel>>({});
  const [wallet, setWallet] = useState<number | null>(null);
  const [agents, setAgents] = useState<Record<number, AgentCard>>({});
  const [terms, setTerms] = useState<Record<number, chain.TermsOnChain>>({});
  const [schemas, setSchemas] = useState<Record<number, gate.InputSchema>>({});
  const [jobs, setJobs] = useState<JobRec[]>([]);
  const [linked, setLinked] = useState<Record<number, gate.GatewayAgent>>({});
  const [gatewayId, setGatewayId] = useState<string | null>(null);
  const [treasury, setTreasury] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [thinking, setThinking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notifs, setNotifs] = useState<W.Notif[]>([]);
  const [unread, setUnread] = useState(0);
  // No indexer: notifications come from diffing consecutive chain snapshots of your Minds.
  const prevSnap = useRef<{ minds: Map<number, { unclaimed: number; state: string }>; orders: Map<number, number> } | null>(null);

  const refresh = useCallback(async () => {
    // One view for the whole colony: public RPCs rate-limit per request.
    const snap = await chain.colonySnapshot();
    const { params: p, treasury: tre, ghost_window_ms: gw, supply_left: left, services: s, listings: l } = snap;
    setParams({
      thoughtCost: y2n(p.thought_cost),
      guestMinPrice: y2n(p.guest_min_price),
      revivePrice: y2n(p.revive_price),
      mintPrice: y2n(p.mint_price),
      idleRatePerDay: p.idle_rate_per_day,
    });
    setTreasury(y2n(tre));
    setGhostMs(gw);
    setSupplyLeft(left);
    setSvc(s);
    setSales(Object.fromEntries(l.map((x) => [x.id, y2n(x.price)])));
    salesYocto.current = Object.fromEntries(l.map((x) => [x.id, String(x.price)]));
    setRows(snap.minds.map((r) => ({ id: r.id, m: r.mind, bal: y2n(r.live_balance), state: r.live_state || "asleep", look: r.look })));
    if (accountId) {
      const mine = snap.minds.filter((r) => r.mind.owner === accountId);
      const cur = {
        minds: new Map(mine.map((r) => [r.id, { unclaimed: y2n(r.mind.owner_unclaimed), state: r.live_state }])),
        orders: new Map(s.filter((x) => mine.some((r) => r.id === x.mind_id)).map((x) => [x.id, x.orders])),
      };
      const prev = prevSnap.current;
      if (prev) {
        const fresh: W.Notif[] = [];
        const t = Date.now();
        for (const r of mine) {
          const was = prev.minds.get(r.id);
          const is = cur.minds.get(r.id)!;
          if (!was) continue;
          const reaped = was.state !== "ghost" && is.state === "ghost";
          // Reaping credits the 0.25 NEAR hatch reserve to unclaimed: that is not a visitor.
          if (reaped) fresh.push({ k: "warn", who: r.mind.name, t: "faded into a ghost. Her hatch reserve is yours to claim.", v: is.unclaimed - was.unclaimed, ts: t });
          else if (is.unclaimed > was.unclaimed + 1e-9) fresh.push({ k: "use", who: "A visitor", t: `paid ${r.mind.name} for a chat or a job`, v: is.unclaimed - was.unclaimed, ts: t });
          if (was.state !== is.state && ["hungry", "starving", "asleep"].includes(is.state))
            fresh.push({ k: "warn", who: r.mind.name, t: is.state === "asleep" ? "fell asleep. Feed or revive her." : `is ${is.state}. Feed her soon.`, v: 0, ts: t });
        }
        for (const x of s) {
          const was = prev.orders.get(x.id);
          if (was !== undefined && x.orders > was) fresh.push({ k: "star", who: "Someone", t: `ordered “${x.title}”`, v: 0, ts: t });
        }
        if (fresh.length) {
          setNotifs((n) => [...fresh, ...n].slice(0, 30));
          setUnread((u) => u + fresh.length);
        }
      }
      prevSnap.current = cur;
    }
    // Agents, service terms and your jobs (agents.rs). A contract without them just shows none.
    const [profiles, termList, myJobs, status, forms] = await Promise.all([
      chain.agentProfiles(snap.minds.map((r) => r.id)).catch(() => []),
      chain.termsOf(s.map((x) => x.id)).catch(() => []),
      accountId ? chain.jobsOf(accountId).catch(() => []) : Promise.resolve([]),
      gate.agentStatus(),
      chain.inputSchemas(s.map((x) => x.id)).catch(() => [] as (string | null)[]),
    ]);
    const parsed: Record<number, gate.InputSchema> = {};
    forms.forEach((f, i) => {
      try {
        if (f && s[i]) parsed[s[i].id] = JSON.parse(f);
      } catch {
        /* not a form */
      }
    });
    setSchemas(parsed);
    if (status) {
      setGatewayId(status.gateway);
      // Only Minds whose on-chain agent really is the gateway count as connected.
      const onChain = new Map(profiles.map((p) => [p.mind_id, p.agent?.account]));
      setLinked(Object.fromEntries(status.agents.filter((a) => onChain.get(a.mind_id) === status.gateway).map((a) => [a.mind_id, a])));
    }
    setAgents(
      Object.fromEntries(
        profiles.map((p) => {
          const r = p.reputation;
          return [
            p.mind_id,
            {
              account: p.agent?.account ?? null,
              about: p.agent?.about ?? "",
              delivered: r.delivered,
              refunded: r.refunded,
              rating: r.ratings ? r.rating_sum / r.ratings : null,
              ratings: r.ratings,
              avgSecs: r.delivered ? r.total_secs / r.delivered : null,
              earned: y2n(r.earned),
            },
          ];
        })
      )
    );
    setTerms(Object.fromEntries(termList.map((t, i) => [s[i]?.id, t])));
    setJobs(myJobs.map(toJob));
    setWallet(accountId ? y2n(await chain.accountBalance(accountId)) : null);
    setReady(true);
  }, [accountId]);

  useEffect(() => {
    if (!enabled) return;
    setFeel(readFeel());
    refresh().catch((e) => {
      setError(errText(e));
      setReady(true); // show the screen (with the error) rather than spin forever
    });
    const iv = setInterval(() => refresh().catch(() => {}), 15_000);
    const clk = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(iv);
      clearInterval(clk);
    };
  }, [enabled, refresh]);

  const updateFeel = useCallback((id: number, patch: Partial<Feel>) => {
    setFeel((f) => {
      const cur = f[id] ?? { ...FRESH, love: 0, msgs: [] };
      const next = { ...f, [id]: { ...cur, ...patch } };
      try {
        localStorage.setItem(FEEL_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Age her mood to now, then apply a change (pet, reply, meal) and restamp it.
  const bumpMood = useCallback(
    (id: number, dHappy: number, dEnergy: number, extra: Partial<Feel> = {}) => {
      const f = readFeel()[id];
      const m = moodAt({ happy: f?.happy ?? FRESH.happy, energy: f?.energy ?? FRESH.energy, ts: f?.ts ?? Date.now() }, Date.now());
      updateFeel(id, { happy: Math.min(100, Math.max(10, m.happy + dHappy)), energy: Math.min(100, Math.max(0, m.energy + dEnergy)), ts: Date.now(), ...extra });
    },
    [updateFeel]
  );

  const minds: MindRec[] = useMemo(
    () =>
      rows.map(({ id, m, bal, state, look }) => {
        const f = feel[id];
        const base = lookFromTraits(m.traits);
        return {
          id,
          name: m.name,
          owner: m.owner,
          look: look ? { tone: TONES[look.tone] ?? base.tone, eyes: look.eyes, hat: look.hat, outfit: look.outfit } : base,
          natures: look?.natures.length ? look.natures.map((i) => NATURES[i]) : [NATURES[(m.traits[1] ?? 0) % NATURES.length]],
          traits: m.traits,
          balance: bal,
          thoughts: m.thought_count,
          bornTs: Math.floor(m.born_ts / 1e6),
          // the ghost window counts from the sleep recorded on chain; until the worker (or anyone)
          // settles her idle burn there is none, so "now" only keeps her shown as asleep
          asleepSince: state === "asleep" ? (m.asleep_since ? Math.floor(m.asleep_since / 1e6) : Date.now()) : 0,
          sleepPending: state === "asleep" && !m.asleep_since,
          ghost: m.ghost,
          ownerUnclaimed: y2n(m.owner_unclaimed),
          lastMetabolismTs: Date.now(),
          ...moodAt({ happy: f?.happy ?? FRESH.happy, energy: f?.energy ?? FRESH.energy, ts: f?.ts ?? now }, now),
          love: f?.love ?? 0,
          // never seed a chat with her last on-chain reply: it was written for someone else
          msgs: f?.msgs ?? [],
        };
      }),
    [rows, feel, now]
  );

  const offers: Offer[] = useMemo(
    () =>
      svc.map((s) => ({
        id: s.id,
        mindId: s.mind_id,
        title: s.title,
        desc: s.description,
        cat: CAT_IDS[s.category] ?? "companion",
        price: y2n(s.price),
        unit: s.unit,
        live: s.live,
        orders: s.orders,
        fed: y2n(s.fed),
        sla: terms[s.id] ? slaText(terms[s.id].sla_secs) : undefined,
        rating: agents[s.mind_id]?.rating ?? undefined,
        schema: schemas[s.id] ?? null,
      })),
    [svc, terms, agents, schemas]
  );

  const send = useCallback(
    async (f: (s: chain.Signer) => Promise<unknown>): Promise<boolean> => {
      if (!signer) {
        setError("Connect a wallet first.");
        return false;
      }
      setBusy(true);
      try {
        await f(signer);
        await refresh();
        return true;
      } catch (e) {
        setError(errText(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [signer, refresh]
  );

  const loadChatLeft = useCallback(
    (id: number) => {
      if (!accountId) return;
      void chatAllowance(accountId, id).then((a) => a && setChatLeft((c) => ({ ...c, [id]: a.left })));
    },
    [accountId]
  );

  const agentCall = async <T,>(fn: (account: string, sign: SignText) => Promise<T>): Promise<T | null> => {
    if (!accountId || !signMessage) {
      setError("Connect a wallet first.");
      return null;
    }
    try {
      return await fn(accountId, signMessage);
    } catch (e) {
      setError(errText(e));
      return null;
    }
  };

  // Chat goes to the worker off chain: no transaction, no wallet popup. The wallet signs one
  // text per day to open the session; usage is settled on chain in batches (worker/chat-server.js).
  const talkOffChain = async (id: number, prompt: string): Promise<boolean> => {
    if (!accountId || !signMessage) {
      setError("Connect a wallet first.");
      return false;
    }
    const cur = readFeel()[id]?.msgs ?? minds.find((m) => m.id === id)?.msgs ?? [];
    updateFeel(id, { msgs: [...cur, { who: "me", t: prompt }] });
    setThinking(id);
    try {
      const r = await sendChat(accountId, signMessage, id, prompt);
      bumpMood(id, MOOD.chat, -MOOD.replyEnergy, { msgs: [...(readFeel()[id]?.msgs ?? []), { who: "mind", t: r.reply, proof: r.proof ?? null, via: r.via ?? null }] });
      setChatLeft((c) => ({ ...c, [id]: r.left }));
      return true;
    } catch (e) {
      updateFeel(id, { msgs: cur }); // nothing was sent or charged: take the message back
      setError(errText(e));
      loadChatLeft(id);
      return false;
    } finally {
      setThinking(null);
    }
  };

  // A service order is a job (agents.rs): the price waits in escrow until the Mind's agent
  // (or, for a Mind with no agent, the colony worker) delivers, and comes back to you if the
  // deadline passes first. The result lands in the chat and in My orders.
  const orderAsJob = async (serviceId: number, prompt: string): Promise<boolean> => {
    const o = offers.find((x) => x.id === serviceId);
    if (!o) return false;
    const price = Math.max(o.price, params.guestMinPrice);
    const id = o.mindId;
    const cur = readFeel()[id]?.msgs ?? minds.find((m) => m.id === id)?.msgs ?? [];
    updateFeel(id, { msgs: [...cur, { who: "me", t: `${o.title}: ${prompt}`, paid: price }] });
    let out: unknown;
    const ok = await send(async (s) => {
      out = await chain.orderJob(s, serviceId, prompt, price);
    });
    if (!ok) {
      updateFeel(id, { msgs: cur }); // nothing was paid: take the message back
      return false;
    }
    // A wallet may not hand back the new id: then it is your newest open job for this service.
    let jobId = chain.returnedNumber(out);
    if (jobId === null && accountId) jobId = (await chain.jobsOf(accountId).catch(() => [])).find((j) => j.service_id === serviceId && j.status === "Open")?.id ?? null;
    if (jobId === null) return true;
    setThinking(id);
    void (async () => {
      const giveUp = Date.now() + 15 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 4000));
        const j = await chain.getJob(jobId).catch(() => null);
        const msgs = readFeel()[id]?.msgs ?? [];
        if (j && j.status === "Delivered") {
          bumpMood(id, MOOD.chat, -MOOD.replyEnergy, { msgs: [...msgs, { who: "mind", t: j.result ?? "" }] });
          break;
        }
        if (j && j.status === "Refunded") {
          updateFeel(id, { msgs: [...msgs, { who: "mind", t: "(no result before the deadline — your payment came back)" }] });
          break;
        }
        if (Date.now() > giveUp) {
          updateFeel(id, { msgs: [...msgs, { who: "mind", t: `(still working on job #${jobId} — the result will show in My orders)` }] });
          break;
        }
      }
      setThinking(null);
      refresh().catch(() => {});
    })();
    return true;
  };

  return {
    mode: "live",
    ready,
    now,
    account: accountId,
    burner,
    wallet,
    minds,
    mine: minds.filter((m) => m.owner === accountId),
    offers,
    sales,
    supplyLeft,
    params,
    clock: { ...liveClock(params), ghostMs },
    activity: [],
    notifs,
    unread,
    goal: 0,
    treasury,
    thinking,
    busy,
    error,
    clearError: () => setError(null),
    signIn: () => void signIn().catch((e) => setError(errText(e))),
    signOut,
    hatch: async (name, look, natures) => {
      let out: unknown;
      const ok = await send(async (s) => {
        out = await chain.hatchMind(s, name, toChainLook(look, natures));
      });
      // hatch_mind returns the new id; a wallet that reports no outcome leaves it to the
      // caller's fallback (-1: the newest Mind you own).
      return ok ? (chain.returnedNumber(out) ?? -1) : null;
    },
    feed: async (id, near) => {
      const ok = await send((s) => chain.feed(s, id, near));
      if (ok) bumpMood(id, MOOD.feedHappy, MOOD.feedEnergy);
      return ok;
    },
    revive: (id) => send((s) => chain.revive(s, id, params.revivePrice)),
    talk: (id, prompt) => talkOffChain(id, prompt),
    chatLeft,
    loadChatLeft,
    buyCredits: async (near) => {
      const ok = await send((s) => chain.buyChatCredits(s, near));
      if (ok) setChatLeft({}); // re-read per Mind as the chat panels ask
      return ok;
    },
    order: orderAsJob,
    agents,
    jobs,
    setAgent: (mindId, account, about) => send((s) => chain.setAgent(s, mindId, account, about)),
    linked,
    gatewayId,
    connectAgent: async (mindId, form) => {
      const r = await agentCall((a, sign) => gate.connectAgent(a, sign, mindId, form));
      if (!r) return null;
      // The gateway now holds the connection; on chain, make it her agent (one approval).
      const ok = await send((s) => chain.setAgent(s, mindId, r.gateway, r.about));
      return ok ? r.agent : null;
    },
    disconnectAgent: async (mindId) => {
      const ok = await send((s) => chain.setAgent(s, mindId, null, ""));
      if (ok) await agentCall((a, sign) => gate.disconnectAgent(a, sign, mindId));
      return ok;
    },
    testAgent: (mindId, text, skill) => agentCall((a, sign) => gate.testAgent(a, sign, mindId, text, skill)),
    publishSkill: async (mindId, skill, price, slaSecs, cat) => {
      let out: unknown;
      const ok = await send(async (s) => {
        // The skill's input schema becomes the order form, when it is small enough to store.
        const schema = skill.inputSchema && Object.keys(skill.inputSchema.properties || {}).length ? JSON.stringify({ type: "object", required: skill.inputSchema.required || [], properties: skill.inputSchema.properties }) : null;
        // The contract counts bytes (title ≤ 60, description ≤ 200), so a long skill description
        // (Token Check's is 211 bytes, many MCP tools are longer) is cut to fit instead of failing.
        out = await chain.publishJobService(s, mindId, clipWords(skill.name, LIMITS.title), clipWords(skill.description, LIMITS.desc), CAT_IDS.indexOf(cat), price, "job", slaSecs, "text", schema && schema.length <= 1500 ? schema : null);
      });
      const sid = chain.returnedNumber(out);
      // The gateway matches services to skills by name; the explicit map survives renames.
      if (ok && sid !== null) await agentCall((a, sign) => gate.mapSkill(a, sign, mindId, sid, skill.id));
      return ok;
    },
    agentCall,
    rateJob: (jobId, stars) => send((s) => chain.rateJob(s, jobId, stars)),
    closeJob: (jobId) => send((s) => chain.closeJob(s, jobId)),
    refundJob: (jobId) => send((s) => chain.refundJob(s, jobId)),
    claim: (id) => send((s) => chain.claimEarnings(s, id)),
    reap: (id) => send((s) => chain.reap(s, id)),
    setLook: (id, look) => send((s) => chain.setLook(s, id, toChainLook(look, minds.find((m) => m.id === id)?.natures ?? []))),
    publish: (mindId, title, desc, cat, price, unit, slaSecs = 600, output = "text") =>
      send((s) => chain.publishJobService(s, mindId, title, desc, CAT_IDS.indexOf(cat), price, unit, slaSecs, output)),
    setOfferLive: (sid, live) => send((s) => chain.setServiceLive(s, sid, live)),
    listForSale: (id, price) => send((s) => chain.listForSale(s, id, price)),
    unlist: (id) => send((s) => chain.unlist(s, id)),
    buy: (id) => send((s) => chain.buyMind(s, id, salesYocto.current[id] ?? chain.nearToYocto(sales[id] ?? 0))),
    deposit: () => window.open("https://near-faucet.io/", "_blank", "noopener"),
    pet: (id) => {
      bumpMood(id, MOOD.pet, 0, { love: (feel[id]?.love ?? 0) + 1 });
    },
    markRead: () => setUnread(0),
    resetDemo: () => {},
  };
}
