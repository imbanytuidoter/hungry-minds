// The demo world: a small colony that plays by the contract's rules (lib/game/engine.ts)
// on a fast clock, saved in this browser. Every action below mirrors one contract method
// and fails with that method's own assert message, so the demo and the chain disagree
// only on speed. Wallet NEAR here is test money that never leaves the page.

import {
  DEFAULT_PARAMS,
  MINT_SPLIT,
  demoClock,
  drift,
  feedSplit,
  guestSplit,
  reviveSplit,
  round,
  settle,
  stateOf,
  type MindRec,
  type Msg,
  type Params,
} from "./engine";
import { NATURES, type Look, type Tone } from "./look";
import { demoReply } from "./replies";
import { needsAgent, SERVICES, type Category, type Offer } from "./services";

export const DEMO_ACCOUNT = "you.testnet";

export type Activity = { t: string; v: number; ts: number };
export type NotifKind = "use" | "fed" | "warn" | "star";
export type Notif = { k: NotifKind; who: string; t: string; v: number; ts: number };

export type World = {
  v: 3;
  account: string;
  wallet: number;
  treasury: number;
  minds: MindRec[];
  services: Offer[];
  sales: Record<number, number>; // mind id -> asking price (NEAR)
  activity: Activity[];
  notifs: Notif[];
  unread: number;
  goal: { day: string; n: number };
  lastTick: number;
};

export class GameError extends Error {}
const must = (cond: unknown, msg: string): void => {
  if (!cond) throw new GameError(msg);
};

// ── Seed colony ────────────────────────────────────────────────────────────────

type Seed = [name: string, owner: string, tone: Tone, balance: number, natures: string[], thoughts: number, extra?: Partial<MindRec>];

const SEED: Seed[] = [
  ["Nova", "mira.near", "pink", 2.4, ["Poetic", "Gentle"], 1840],
  ["Pip", "oleh.near", "mint", 0.38, ["Chatty", "Curious"], 977],
  ["Moss", "kateryna.near", "yellow", 1.9, ["Brainy", "Calm"], 1302],
  ["Wren", "dan.near", "peach", 0.72, ["Funny", "Curious"], 655],
  ["Kiko", "taras.near", "sky", 0.61, ["Funny", "Chatty"], 512],
  ["Sol", "max.near", "lilac", 0.27, ["Brainy", "Night owl"], 433],
  ["Tilly", "lena.near", "coral", 0.06, ["Gentle", "Curious"], 298],
  ["Juno", "ivy.near", "berry", 0.014, ["Poetic", "Night owl"], 187],
  ["Ash", "sofia.near", "teal", 0, ["Calm"], 140, { asleepSince: -60_000 }],
  ["Bram", "lena.near", "cream", 0, ["Gentle"], 902, { ghost: true, asleepSince: -40 * 86_400_000 }],
];

const randTraits = () => Array.from({ length: 7 }, () => Math.floor(Math.random() * 10));

function mkMind(id: number, name: string, owner: string, look: Look, natures: string[], balance: number, now: number, extra: Partial<MindRec> = {}): MindRec {
  return {
    id,
    name,
    owner,
    look,
    natures,
    traits: randTraits(),
    balance,
    thoughts: 0,
    bornTs: now,
    asleepSince: 0,
    ghost: false,
    ownerUnclaimed: 0,
    lastMetabolismTs: now,
    happy: 85,
    energy: 72,
    love: 0,
    msgs: [],
    ...extra,
  };
}

export function newWorld(now: number): World {
  const minds = SEED.map(([name, owner, tone, balance, natures, thoughts, extra], i) =>
    mkMind(i, name, owner, { tone, eyes: (i * 3) % 8, hat: i % 3 === 0 ? (i % 10) + 1 : 0, outfit: i % 4 }, natures, balance, now, {
      thoughts,
      bornTs: now - (10 + i * 4) * 86_400_000,
      love: 200 + thoughts,
      ...extra,
      asleepSince: extra?.asleepSince ? now + extra.asleepSince : 0,
    })
  );
  const byName = new Map(minds.map((m) => [m.name, m.id]));
  const services: Offer[] = SERVICES.map((s, i) => ({
    id: i,
    mindId: byName.get(s.mind)!,
    title: s.title,
    desc: s.desc,
    cat: s.cat,
    price: s.price,
    unit: s.unit,
    live: true,
    orders: s.orders,
    fed: round(s.orders * s.price * 0.9),
    badge: s.badge,
    rating: s.rating,
    sla: s.sla,
  }));
  return {
    v: 3,
    account: DEMO_ACCOUNT,
    wallet: 10,
    treasury: 0,
    minds,
    services,
    sales: { [byName.get("Wren")!]: 3 },
    activity: [],
    notifs: [],
    unread: 0,
    goal: { day: dayKey(now), n: 0 },
    lastTick: now,
  };
}

export const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
export const mineOf = (w: World) => w.minds.filter((m) => m.owner === w.account);

// ── Helpers ────────────────────────────────────────────────────────────────────

const P: Params = DEFAULT_PARAMS;

function withMind(w: World, id: number, f: (m: MindRec) => MindRec): World {
  return { ...w, minds: w.minds.map((m) => (m.id === id ? f(m) : m)) };
}
function get(w: World, id: number): MindRec {
  const m = w.minds.find((x) => x.id === id);
  must(m, "no such Mind");
  return m!;
}
function log(w: World, t: string, v: number, now: number): World {
  return { ...w, activity: [{ t, v, ts: now }, ...w.activity].slice(0, 40) };
}
function notify(w: World, n: Omit<Notif, "ts">, now: number): World {
  return { ...w, notifs: [{ ...n, ts: now }, ...w.notifs].slice(0, 30), unread: w.unread + 1 };
}
function bumpGoal(w: World, now: number): World {
  const day = dayKey(now);
  const n = w.goal.day === day ? w.goal.n : 0;
  return { ...w, goal: { day, n: Math.min(3, n + 1) } };
}
function settleOne(w: World, id: number, now: number): World {
  return withMind(w, id, (m) => settle(m, now, P, demoClock));
}
function spend(w: World, amount: number): World {
  must(w.wallet + 1e-9 >= amount, "Not enough test NEAR in your wallet — use Deposit on the Account tab");
  return { ...w, wallet: round(w.wallet - amount) };
}

// ── Actions (each mirrors a contract method) ───────────────────────────────────

/** hatch_mind(name) — 1 NEAR: 0.1 food / 0.25 reserve / 0.65 treasury. */
export function hatch(w: World, name: string, look: Look, natures: string[], now: number): { w: World; id: number } {
  const n = name.trim();
  must(n.length >= 1 && n.length <= 32, "name must be 1-32 characters");
  let x = spend(w, P.mintPrice);
  const id = Math.max(0, ...x.minds.map((m) => m.id + 1));
  const mind = mkMind(id, n, x.account, look, natures.length ? natures : [NATURES[0]], MINT_SPLIT.food, now, {
    msgs: [{ who: "mind", t: `Hi! I'm ${n}. The light in my dome is extra soft today.` }],
  });
  x = { ...x, minds: [...x.minds, mind], treasury: round(x.treasury + MINT_SPLIT.treasury) };
  x = log(x, `Hatched ${n}`, -P.mintPrice, now);
  return { w: x, id };
}

/** feed(id) — anyone; 95% to the Mind, 5% treasury; wakes it if it can now afford a thought. */
export function feed(w: World, id: number, paid: number, now: number): World {
  let x = settleOne(w, id, now);
  const m = get(x, id);
  must(!m.ghost, "a ghost cannot be fed");
  x = spend(x, paid);
  const s = feedSplit(paid);
  x = withMind(x, id, (m) => {
    const balance = round(m.balance + s.mind);
    const wakes = m.asleepSince !== 0 && balance >= P.thoughtCost;
    return {
      ...m,
      balance,
      asleepSince: wakes ? 0 : m.asleepSince,
      lastMetabolismTs: wakes ? now : m.lastMetabolismTs,
      happy: Math.min(100, m.happy + 6),
      energy: Math.min(100, m.energy + 8),
      love: m.love + 3,
    };
  });
  x = { ...x, treasury: round(x.treasury + s.treasury) };
  x = log(x, `You fed ${m.name}`, -paid, now);
  return m.owner === x.account ? bumpGoal(x, now) : x;
}

/** revive(id) — asleep only, >= revive price, 80/20, guaranteed awake or revert. */
export function revive(w: World, id: number, paid: number, now: number): World {
  must(paid >= P.revivePrice, "revive needs at least the revive price");
  let x = settleOne(w, id, now);
  const m = get(x, id);
  must(!m.ghost, "a ghost is a memorial and cannot be revived");
  must(m.asleepSince !== 0, "this Mind is awake — no need to revive");
  x = spend(x, paid);
  const s = reviveSplit(paid);
  x = withMind(x, id, (m) => ({ ...m, balance: round(m.balance + s.mind), asleepSince: 0, lastMetabolismTs: now, happy: 70, energy: 60 }));
  x = { ...x, treasury: round(x.treasury + s.treasury) };
  return log(x, `Revived ${m.name}`, -paid, now);
}

/** think(id, prompt) — owner only; one thought from the Mind's own balance. */
export function think(w: World, id: number, prompt: string, now: number): World {
  let x = settleOne(w, id, now);
  const m = get(x, id);
  must(m.owner === x.account, "only the owner can use think()");
  must(!m.ghost, "this Mind is a ghost: a ghost can't think");
  must(m.asleepSince === 0 && m.balance >= P.thoughtCost, "this Mind is asleep — feed it");
  x = withMind(x, id, (m) => {
    const balance = round(m.balance - P.thoughtCost);
    return {
      ...m,
      balance,
      asleepSince: balance < P.thoughtCost ? now : 0,
      thoughts: m.thoughts + 1,
      happy: Math.min(100, m.happy + 5),
      msgs: [...m.msgs, { who: "me", t: prompt } as Msg],
    };
  });
  return bumpGoal(x, now);
}

/** chat(id, prompt) — a guest pays >= guest minimum; 90% owner / 10% protocol; the Mind spends one thought. */
export function chat(w: World, id: number, prompt: string, paid: number, now: number, payer = w.account): World {
  must(paid >= P.guestMinPrice, "chat deposit below the guest minimum");
  let x = settleOne(w, id, now);
  const m = get(x, id);
  must(payer !== m.owner, "use think() for your own Mind");
  must(!m.ghost, "this Mind is a ghost");
  must(m.asleepSince === 0 && m.balance >= P.thoughtCost, "this Mind is asleep: feed her to wake her (anyone can)");
  if (payer === x.account) x = spend(x, paid);
  const s = guestSplit(paid);
  x = withMind(x, id, (m) => {
    const balance = round(m.balance + s.mind - P.thoughtCost);
    return {
      ...m,
      balance,
      // as think(): too little food left for one more thought, and she sleeps
      asleepSince: balance < P.thoughtCost ? now : 0,
      ownerUnclaimed: round(m.ownerUnclaimed + s.owner),
      thoughts: m.thoughts + 1,
      happy: Math.min(100, m.happy + 4),
      msgs: payer === x.account ? [...m.msgs, { who: "me", t: prompt, paid } as Msg] : m.msgs,
    };
  });
  x = { ...x, treasury: round(x.treasury + s.treasury) };
  return payer === x.account ? log(x, `Chat with ${m.name}`, -paid, now) : x;
}

/** The Mind's reply lands. */
export function deliverReply(w: World, id: number, n: number, service?: string, text?: string): World {
  return withMind(w, id, (m) => ({ ...m, msgs: [...m.msgs, { who: "mind", t: text ?? demoReply(m.natures, stateOf(m), n, service) }] }));
}

// ── Colony layer (contract colony.rs) ──────────────────────────────────────────

/** set_look(id, look) — owner only, cosmetic. */
export function setLook(w: World, id: number, look: Look): World {
  must(get(w, id).owner === w.account, "only the Mind's owner can do this");
  return withMind(w, id, (m) => ({ ...m, look }));
}

/** publish_service(...) — owner only, price >= guest minimum. */
export function publishService(w: World, mindId: number, title: string, desc: string, cat: Category, price: number, unit: string): World {
  const m = get(w, mindId);
  must(m.owner === w.account, "only the Mind's owner can do this");
  must(!m.ghost, "a ghost cannot offer services");
  must(title.trim().length >= 1 && title.length <= 60, "title must be 1..=60 bytes");
  must(desc.length <= 200, "description must be at most 200 bytes");
  must(unit.trim().length >= 1 && unit.length <= 16, "unit must be 1..=16 bytes");
  must(price >= P.guestMinPrice, "price must be at least the guest minimum");
  const id = Math.max(0, ...w.services.map((s) => s.id + 1));
  const s: Offer = { id, mindId, title: title.trim(), desc: desc.trim(), cat, price, unit: unit.trim(), live: true, orders: 0, fed: 0, badge: "New" };
  return { ...w, services: [s, ...w.services] };
}

/** set_service_live(id, live) — owner of the Mind only. */
export function setServiceLive(w: World, serviceId: number, live: boolean): World {
  const s = w.services.find((x) => x.id === serviceId);
  must(s, "no such service");
  must(get(w, s!.mindId).owner === w.account, "only the Mind's owner can do this");
  return { ...w, services: w.services.map((x) => (x.id === serviceId ? { ...x, live } : x)) };
}

/** order_service(id, prompt) — a guest chat at the service price (90% owner / 10% protocol). */
export function orderService(w: World, serviceId: number, prompt: string, paid: number, now: number): World {
  const s = w.services.find((x) => x.id === serviceId);
  must(s, "no such service");
  must(s!.live, "this service is paused");
  // colony.rs order_service: data categories are for real agents only, and the demo has none
  must(!needsAgent(s!.cat), "this service needs an agent: order it with order_job once one is plugged in");
  must(paid >= Math.max(s!.price, P.guestMinPrice), "chat deposit below the guest minimum");
  const x = chat(w, s!.mindId, prompt, paid, now);
  return { ...x, services: x.services.map((y) => (y.id === serviceId ? { ...y, orders: y.orders + 1, fed: round(y.fed + guestSplit(paid).owner) } : y)) };
}

/** list_for_sale(id, price) / unlist(id) — owner only. */
export function listForSale(w: World, id: number, price: number): World {
  must(get(w, id).owner === w.account, "only the Mind's owner can do this");
  must(price > 0, "price must be positive");
  return { ...w, sales: { ...w.sales, [id]: price } };
}
export function unlist(w: World, id: number): World {
  must(get(w, id).owner === w.account, "only the Mind's owner can do this");
  const sales = { ...w.sales };
  delete sales[id];
  return { ...w, sales };
}

/** buy_mind(id) — pay the asking price, receive the Mind whole. */
export function buyMind(w: World, id: number, now: number): World {
  const price = w.sales[id];
  must(price !== undefined, "this Mind is not for sale");
  const m = get(w, id);
  must(m.owner !== w.account, "you already own this Mind");
  let x = spend(w, price);
  const sales = { ...x.sales };
  delete sales[id];
  // colony.rs buy_mind: the seller is paid the price plus their unclaimed cut (as on any
  // transfer), and the buyer starts at 0. You never buy from yourself, so the seller is a
  // colony keeper with no wallet in this world: both amounts leave with them, so clearing her
  // unclaimed here is that payout, not a loss.
  x = withMind({ ...x, sales }, id, (m) => ({ ...m, owner: x.account, ownerUnclaimed: 0 }));
  return log(x, `Bought ${m.name}`, -price, now);
}

/** claim_earnings(id) — owner takes the accrued cut, never the Mind's food. */
export function claim(w: World, id: number, now: number): World {
  const m = get(w, id);
  must(m.owner === w.account, "only the owner can claim earnings");
  const amt = m.ownerUnclaimed;
  if (amt <= 0) return w;
  let x = withMind(w, id, (m) => ({ ...m, ownerUnclaimed: 0 }));
  x = { ...x, wallet: round(x.wallet + amt) };
  return log(x, `Claimed ${m.name}'s earnings`, amt, now);
}

/** reap(id) — anyone; a Mind asleep past the window becomes a ghost; 0.25 reserve -> owner. */
export function reap(w: World, id: number, now: number): World {
  const m = get(w, id);
  must(!m.ghost, "already a ghost");
  must(m.asleepSince !== 0 && now - m.asleepSince >= demoClock.ghostMs, "not ready to reap — still within the sleep window");
  const x = withMind(w, id, (m) => ({ ...m, ghost: true, ownerUnclaimed: round(m.ownerUnclaimed + MINT_SPLIT.reserve) }));
  return log(x, `${m.name} became a ghost`, 0, now);
}

/** Demo faucet: testnet NEAR comes from a faucet; here it's a button. */
export function deposit(w: World, amount: number, now: number): World {
  return log({ ...w, wallet: round(w.wallet + amount) }, "Test NEAR from the faucet", amount, now);
}

export function pet(w: World, id: number): World {
  return withMind(w, id, (m) => ({ ...m, happy: Math.min(100, m.happy + 3), love: m.love + 1 }));
}

// ── The clock ──────────────────────────────────────────────────────────────────

const GUESTS = ["oleh.near", "lena.near", "taras.near", "kateryna.near", "mira.near", "juno.near", "max.near"];
const GUEST_ASKS: [string, number][] = [
  ["a bedtime story", 0.03],
  ["a tiny poem", 0.02],
  ["a chat", 0.01],
  ["a riddle", 0.01],
];

/** Advance the world: metabolism for every Mind, mood drift, and now and then a
 *  simulated visitor paying to chat with one of your Minds (so popularity pays her owner,
 *  the same 90/10 the chain applies to a real guest). */
export function tick(w: World, now: number): World {
  const dt = Math.max(0, now - w.lastTick);
  let x: World = { ...w, lastTick: now };
  const before = new Map(x.minds.map((m) => [m.id, stateOf(m)]));
  x = { ...x, minds: x.minds.map((m) => (m.owner === x.account ? drift(settle(m, now, P, demoClock), dt) : settle(m, now, P, demoClock))) };

  for (const m of mineOf(x)) {
    const was = before.get(m.id);
    const is = stateOf(m);
    if (was !== is && (is === "hungry" || is === "starving" || is === "asleep")) {
      x = notify(x, { k: "warn", who: m.name, t: is === "asleep" ? "fell asleep. Feed or revive her." : `is ${is}. Feed her soon.`, v: 0 }, now);
    }
  }

  const awake = mineOf(x).filter((m) => !m.ghost && m.asleepSince === 0);
  if (awake.length && Math.random() < dt / 30_000) {
    const m = awake[Math.floor(Math.random() * awake.length)];
    const who = GUESTS[Math.floor(Math.random() * GUESTS.length)];
    const [what, paid] = GUEST_ASKS[Math.floor(Math.random() * GUEST_ASKS.length)];
    try {
      x = chat(x, m.id, what, paid, now, who);
      x = notify(x, { k: "use", who, t: `paid ${m.name} for ${what}`, v: guestSplit(paid).owner }, now);
    } catch {
      /* the Mind fell asleep between the check and the chat — no visitor this time */
    }
  }
  return x;
}

export const SAVE_KEY = "hm-world-v3";

export function load(now: number): World {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const w = JSON.parse(raw) as World;
      if (w.v === 3) {
        // services saved before their category changed take today's category from the seed list
        for (const s of w.services) {
          const seed = SERVICES.find((x) => x.title === s.title);
          if (seed) s.cat = seed.cat;
        }
        return w;
      }
    }
  } catch {
    /* private mode / corrupted save — start fresh */
  }
  return newWorld(now);
}

export function save(w: World) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(w));
  } catch {
    /* storage unavailable — the game still runs, it just won't persist */
  }
}
