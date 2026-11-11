"use client";
// After a sale: the seller sees what happened to the Mind and where to go next (hatch a new one
// or buy one that is for sale). A sale is noticed by comparing the Minds this browser last saw
// under the account with the chain: a Mind that is still there but now has another owner was
// sold or transferred. Only a Mind present on chain under a different owner counts, so a slow
// first load can never raise a false "sold".
import { useEffect, useRef, useState } from "react";
import GlossyMind from "./GlossyMind";
import { useGame } from "./GameProvider";
import { fmt, moodOf, stateOf, type MindRec } from "@/lib/game/engine";

type Kept = { id: number; name: string; price?: number };
export type Sold = { mind: MindRec; name: string; price?: number };

const keyOf = (account: string) => `hm-kept-${account}`;
const read = (account: string): Kept[] | null => {
  try {
    const v = localStorage.getItem(keyOf(account));
    return v ? (JSON.parse(v) as Kept[]) : null;
  } catch {
    return null;
  }
};
const write = (account: string, kept: Kept[]) => {
  try {
    localStorage.setItem(keyOf(account), JSON.stringify(kept));
  } catch {}
};

/** Minds this account kept last time and that now belong to someone else. */
export function useSold(): [Sold[], () => void] {
  const g = useGame();
  const [sold, setSold] = useState<Sold[]>([]);
  const acct = g.account;
  useEffect(() => {
    if (!g.ready || !acct || g.mode !== "live") return;
    const before = read(acct);
    const now: Kept[] = g.mine.map((m) => ({ id: m.id, name: m.name, price: g.sales[m.id] }));
    if (before) {
      const gone = before
        .map((k) => ({ k, m: g.minds.find((x) => x.id === k.id) }))
        .filter((x): x is { k: Kept; m: MindRec } => !!x.m && x.m.owner !== acct);
      if (gone.length) setSold((s) => [...s.filter((x) => !gone.some((y) => y.k.id === x.mind.id)), ...gone.map(({ k, m }) => ({ mind: m, name: k.name, price: k.price }))]);
      // keep remembering a Mind whose new owner the chain has not shown yet, and a sold one until
      // the card is closed (a reload or a remount before the player saw it must not lose it)
      const pending = before.filter((k) => !now.some((n) => n.id === k.id) && !g.minds.some((x) => x.id === k.id));
      write(acct, [...now, ...pending, ...gone.map((x) => x.k)]);
    } else write(acct, now);
  }, [g.ready, acct, g.mode, g.mine, g.minds, g.sales]);
  const clear = () => {
    if (acct) {
      const seen = read(acct);
      if (seen) write(acct, seen.filter((k) => !sold.some((x) => x.mind.id === k.id)));
    }
    setSold([]);
  };
  return [sold, clear];
}

/** Minds for sale that this account can buy, cheapest first. */
export function useForSale() {
  const g = useGame();
  return Object.entries(g.sales)
    .map(([id, price]) => ({ m: g.minds.find((x) => x.id === Number(id)), price }))
    .filter((x): x is { m: MindRec; price: number } => !!x.m && x.m.owner !== g.account && !x.m.ghost)
    .sort((a, b) => a.price - b.price);
}

/** The two ways to get a Mind: hatch a new one, or buy one that someone is selling. */
export function GetAMind({ onHatch, onBuy, compact = false }: { onHatch: () => void; onBuy: () => void; compact?: boolean }) {
  const g = useGame();
  const forSale = useForSale();
  const preview = forSale.slice(0, 3);
  return (
    <div className="hm-getmind" data-compact={compact || undefined}>
      <button className="hm-getmind-opt" onClick={onHatch}>
        <span className="hm-getmind-pic" aria-hidden>
          <span className="hm-getmind-egg" />
        </span>
        <span className="hm-getmind-txt">
          <b>Hatch a new Mind</b>
          <span>Pick her look and name. A newborn, {g.params.mintPrice} NEAR.</span>
        </span>
        <span className="hm-getmind-go" aria-hidden>
          →
        </span>
      </button>
      <button className="hm-getmind-opt" onClick={onBuy}>
        <span className="hm-getmind-pic hm-getmind-stack" aria-hidden>
          {preview.length ? (
            preview.map(({ m }) => (
              <span key={m.id}>
                <GlossyMind tone={m.look.tone} mood={moodOf(stateOf(m))} eyes={m.look.eyes} hat={m.look.hat} outfit={m.look.outfit} />
              </span>
            ))
          ) : (
            <span className="hm-getmind-tag">NFT</span>
          )}
        </span>
        <span className="hm-getmind-txt">
          <b>Buy a grown Mind</b>
          <span>
            {forSale.length
              ? `${forSale.length} for sale, from ${fmt(forSale[0].price)} NEAR. She comes with her food, services and rating.`
              : "None for sale right now. See the marketplace, new listings show up there."}
          </span>
        </span>
        <span className="hm-getmind-go" aria-hidden>
          →
        </span>
      </button>
    </div>
  );
}

/** The card a seller sees once their Mind has gone to its buyer. */
export function SoldCard({ sold, onHatch, onBuy, onClose }: { sold: Sold[]; onHatch: () => void; onBuy: () => void; onClose: () => void }) {
  const g = useGame();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const one = sold[0];
  const total = sold.reduce((s, x) => s + (x.price ?? 0), 0);
  const allPriced = sold.every((x) => x.price !== undefined);
  const title = sold.length === 1 ? `${one.name} has a new owner` : `${sold.length} of your Minds have new owners`;
  return (
    <div className="hm-sold-veil" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="hm-sold">
        <div className="hm-sold-pics" aria-hidden>
          {sold.slice(0, 3).map((x) => (
            <span key={x.mind.id} className="hm-sold-pic">
              <GlossyMind tone={x.mind.look.tone} mood="happy" eyes={x.mind.look.eyes} hat={x.mind.look.hat} outfit={x.mind.look.outfit} />
            </span>
          ))}
          <span className="hm-sold-badge">{allPriced ? "Sold" : "New owner"}</span>
        </div>
        <span className="hm-sold-title">{title}</span>
        <span className="hm-sold-sub">
          {sold.length === 1 ? (
            <>
              She now belongs to <span className="mono">{one.mind.owner}</span>.
            </>
          ) : (
            <>They now belong to their new owners.</>
          )}{" "}
          {/* The chain keeps no sale record: a Mind that was listed and changed hands was most
              likely bought, but a plain transfer looks the same, so no amount is promised. */}
          {allPriced && total > 0 ? (
            <>
              {sold.length === 1 ? "She was listed" : "They were listed"} for <b>{fmt(total)} NEAR</b>{sold.length === 1 ? "" : " in all"}. A buyer&apos;s payment goes straight to your wallet. What she had earned for you before was paid to you too.
            </>
          ) : (
            <>What she had earned for you before the transfer was paid to your wallet.</>
          )}{" "}
          From now on her earnings are her new owner&apos;s.
        </span>
        <span className="hm-sold-next">{g.mine.length ? "Want another one?" : "Get your next Mind"}</span>
        <GetAMind onHatch={onHatch} onBuy={onBuy} compact />
        <button ref={ref} className="btn-link hm-sold-close" onClick={onClose}>
          {g.mine.length ? "Back to my Minds" : "Not now"}
        </button>
      </div>
    </div>
  );
}
