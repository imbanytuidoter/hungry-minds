"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { Mind, MindState } from "@/lib/minds";
import {
  hungerFromBalance,
  moodBlurb,
  vitalPercent,
  isAlive,
  THOUGHT_COST,
} from "@/lib/minds";
import {
  feed as chainFeed,
  think as chainThink,
  chat as chainChat,
  getMind as chainGetMind,
  lastThought as chainLastThought,
  yoctoToNear,
} from "@/lib/chain";
import { useWallet } from "./WalletProvider";
import Creature from "./Creature";
import Mood from "./Mood";
import Vital from "./Vital";

type Line = { who: "you" | "mind" | "system"; text: string; id?: string };

let lineSeq = 0;
const nextId = () => `l${lineSeq++}`;

const FEED_MEAL = 0.2; // NEAR; 95% reaches the Mind (economy.rs feed_split)
const CHAT_PRICE = 0.01; // NEAR; a stranger's chat (economy.rs GUEST_PRICE)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function MindDetail({
  mind,
  live = false,
}: {
  mind: Mind;
  live?: boolean;
}) {
  const { accountId, signer, signIn } = useWallet();
  // Live writes need both a configured contract (live) and a connected wallet.
  const connected = live && !!signer;
  const iOwnIt = connected && mind.owner === accountId;
  const start = parseFloat(mind.balanceNear) || 0;
  const [balance, setBalance] = useState(start);
  const [thoughts, setThoughts] = useState(mind.thoughts);
  const [ghost] = useState(mind.state === "ghost");
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<Line[]>([]);
  const [hop, setHop] = useState(false);
  const [bursts, setBursts] = useState<number[]>([]);
  const burstSeq = useRef(0);

  const state: MindState = ghost ? "ghost" : hungerFromBalance(balance);
  const awake = isAlive(state);
  const svg = mind.svgsBare[state]; // frameless: it floats in the chamber, not a card
  const low = vitalPercent(state) <= 24 && awake;

  // The creature hops and food rains down — played on every feed, live or preview.
  function playFeedJuice() {
    setHop(true);
    setTimeout(() => setHop(false), 740);
    const id = burstSeq.current++;
    setBursts((b) => [...b, id]);
    setTimeout(() => setBursts((b) => b.filter((x) => x !== id)), 1000);
  }

  // Re-read the Mind from chain and sync balance + thought count (live mode).
  async function refresh() {
    const m = await chainGetMind(mind.id);
    if (!m) return;
    setBalance(yoctoToNear(m.balance));
    setThoughts(m.thought_count);
  }

  function say(line: Line) {
    setLog((l) => [...l, line]);
  }

  async function feed() {
    if (ghost) return;
    if (live && !connected) {
      signIn();
      return;
    }
    playFeedJuice();

    if (connected && signer) {
      say({ who: "system", text: `Feeding ${mind.name} a 0.2 NEAR meal…`, id: nextId() });
      try {
        await chainFeed(signer, mind.id, FEED_MEAL); // may redirect (browser wallet)
        await refresh();
        say({ who: "system", text: `Fed. ${mind.name} is topped up on-chain.`, id: nextId() });
      } catch (e) {
        say({ who: "system", text: `Feeding didn't go through: ${errText(e)}`, id: nextId() });
      }
      return;
    }

    // Preview: mirror the on-chain feed split locally (95% reaches the Mind).
    setBalance((b) => +(b + FEED_MEAL * 0.95).toFixed(4));
    say({ who: "system", text: `You fed ${mind.name} a 0.2 NEAR meal.`, id: nextId() });
  }

  async function talk() {
    const text = draft.trim();
    if (!text || !awake || ghost) return;
    if (live && !connected) {
      signIn();
      return;
    }
    setDraft("");
    const pendingId = nextId();
    setLog((l) => [
      ...l,
      { who: "you", text, id: nextId() },
      { who: "mind", text: "…", id: pendingId },
    ]);

    if (connected && signer) {
      try {
        const before = await chainLastThought(mind.id);
        // Owner thinks for free (the Mind pays); a stranger pays the guest price.
        if (iOwnIt) await chainThink(signer, mind.id, text);
        else await chainChat(signer, mind.id, text, CHAT_PRICE);
        await refresh();
        // The reply only lands once the off-chain worker answers the yielded request.
        let reply: string | null = null;
        for (let i = 0; i < 12; i++) {
          await sleep(2500);
          const now = await chainLastThought(mind.id);
          if (now && now !== before) {
            reply = now;
            break;
          }
        }
        setLog((l) =>
          l.map((line) =>
            line.id === pendingId
              ? reply
                ? { who: "mind", text: reply, id: pendingId }
                : {
                    who: "system",
                    text: "The thought was parked on-chain and cost its balance — a reply lands once the worker (NEAR AI key) is running. Without it, the request refunds after ~200 blocks.",
                    id: pendingId,
                  }
              : line
          )
        );
        await refresh();
      } catch (e) {
        setLog((l) =>
          l.map((line) =>
            line.id === pendingId
              ? { who: "system", text: `That didn't go through: ${errText(e)}`, id: pendingId }
              : line
          )
        );
      }
      return;
    }

    // Preview: the thought still COSTS the Mind 0.002 NEAR — the real mechanic. We do
    // not fake a reply. Resolve the placeholder by its stable id so a second send can't
    // strand a "…" bubble.
    setBalance((b) => +Math.max(0, b - THOUGHT_COST).toFixed(4));
    setThoughts((t) => t + 1);
    setTimeout(() => {
      setLog((l) =>
        l.map((line) =>
          line.id === pendingId
            ? {
                who: "system",
                text: "That thought cost 0.002 NEAR from its balance — the real mechanic. Live replies (OutLayer TEE → NEAR AI, signed) connect once the brain ships.",
                id: pendingId,
              }
            : line
        )
      );
    }, 650);
  }

  return (
    <main
      className="wrap"
      style={{ "--accent": mind.accent, paddingBottom: 90 } as React.CSSProperties}
    >
      <header className="flex items-center justify-between" style={{ height: 76 }}>
        <Link href="/" style={{ fontSize: 15, color: "var(--text-mid)" }}>
          ← All Minds
        </Link>
        <Link href="/" style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>
          Hungry Minds
        </Link>
      </header>

      {!live && (
        <div
          className="card"
          style={{
            padding: "11px 16px",
            marginBottom: 24,
            fontSize: 13.5,
            color: "var(--text-mid)",
            background: "color-mix(in oklab, var(--accent) 7%, var(--surface))",
          }}
        >
          Preview — moods and feeding follow the real contract rules. Wallet actions
          and live replies turn on once {mind.name} is on testnet.
        </div>
      )}

      <div className="detail-grid">
        {/* creature + vitals */}
        <section>
          <div className="detail-chamber">
            <div className="stage-grid" aria-hidden />
            <div className="chamber-glow" aria-hidden />
            <div className="chamber-beam" aria-hidden />
            <div className="chamber-creature">
              <Creature svg={svg} state={state} hop={hop} />
            </div>
            <div className="chamber-platform" aria-hidden />
            {bursts.map((id) => (
              <FeedFx key={id} />
            ))}
          </div>
          <div className="flex items-center justify-between" style={{ marginTop: 16 }}>
            <div>
              <h1 style={{ fontSize: 30 }}>{mind.name}</h1>
              <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2 }}>
                {thoughts.toLocaleString()} thoughts · kept by you
              </div>
            </div>
            <Mood state={state} />
          </div>
          <p style={{ color: "var(--text-mid)", marginTop: 12, fontSize: 15 }}>
            {moodBlurb(state)}
          </p>
          <div style={{ marginTop: 16 }}>
            <Vital percent={vitalPercent(state)} balanceNear={balance.toFixed(3)} low={low} />
          </div>

          <div className="flex" style={{ gap: 10, marginTop: 20, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={feed} disabled={ghost}>
              Feed a meal — 0.2 NEAR
            </button>
          </div>
          {ghost && (
            <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 12 }}>
              {mind.name} is a ghost — it slept too long. Ghosts can&rsquo;t be fed,
              only remembered.
            </p>
          )}
        </section>

        {/* talk + on-chain explainer */}
        <section>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Talk to {mind.name}</h2>
          <div className="talk">
            <div className="talk-log">
              {log.length === 0 && (
                <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
                  Say something. Every reply it gives spends a little of its own
                  food.
                </p>
              )}
              {log.map((line, i) => (
                <div key={i} className={`bubble bubble-${line.who}`}>
                  {line.text}
                </div>
              ))}
            </div>
            <form
              className="talk-input"
              onSubmit={(e) => {
                e.preventDefault();
                talk();
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  awake ? `Ask ${mind.name} something…` : `${mind.name} is ${state}`
                }
                disabled={!awake}
                aria-label="Your message"
              />
              <button className="btn btn-primary" type="submit" disabled={!awake || !draft.trim()}>
                Send
              </button>
            </form>
          </div>

          <h3 style={{ fontSize: 15, marginTop: 28, color: "var(--text-mid)" }}>
            On-chain, you can also
          </h3>
          <ul className="onchain">
            <li>
              <strong>Let strangers pay to chat.</strong> 70% feeds {mind.name},
              20% is yours to <em>claim</em>, 10% to the treasury.
            </li>
            <li>
              <strong>Claim your earnings.</strong> Only your guest-chat cut —
              never {mind.name}&rsquo;s own food.
            </li>
            <li>
              <strong>Sell it whole.</strong> Its balance, traits and life so far go
              to the buyer; your unclaimed cut is paid out to you first.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

// A burst of food raining into the terrarium, with a floating "+0.19".
function FeedFx() {
  const bits = Array.from({ length: 9 }, () => ({
    left: 8 + Math.random() * 84,
    delay: Math.random() * 0.25,
    dur: 0.8 + Math.random() * 0.32,
  }));
  return (
    <div className="feed-fx" aria-hidden>
      {bits.map((b, i) => (
        <span
          key={i}
          className="food-bit"
          style={{
            left: `${b.left}%`,
            animationDelay: `${b.delay}s`,
            animationDuration: `${b.dur}s`,
          }}
        />
      ))}
      <span className="float-gain">+0.19</span>
    </div>
  );
}
