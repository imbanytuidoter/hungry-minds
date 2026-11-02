"use client";

import { useState } from "react";
import Link from "next/link";
import { hero } from "@/lib/minds";
import { hatchMind, isLive } from "@/lib/chain";
import { useWallet } from "@/components/WalletProvider";
import Creature from "@/components/Creature";

export default function Hatch() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { signer, signIn } = useWallet();
  const live = isLive();

  async function hatch() {
    if (!live) return;
    if (!signer) {
      signIn();
      return;
    }
    const n = name.trim();
    if (n.length < 1 || n.length > 32) {
      setErr("A name is 1–32 characters.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await hatchMind(signer, n); // 2 NEAR deposit; browser wallet redirects to confirm
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const label = !live
    ? "Connect wallet to hatch — 2 NEAR"
    : !signer
    ? "Connect wallet to hatch — 2 NEAR"
    : busy
    ? "Hatching…"
    : "Hatch — 2 NEAR";

  return (
    <main
      className="wrap"
      style={{ "--accent": hero.accent, paddingBottom: 90 } as React.CSSProperties}
    >
      <header className="flex items-center justify-between" style={{ height: 76 }}>
        <Link href="/" style={{ fontSize: 15, color: "var(--text-mid)" }}>
          ← Back
        </Link>
        <Link href="/" style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>
          Hungry Minds
        </Link>
      </header>

      <div className="detail-grid" style={{ marginTop: 20 }}>
        <section>
          <div className="terrarium">
            <Creature svg={hero.states.full} state="full" />
          </div>
          <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 14, textAlign: "center" }}>
            A newborn. Its traits are rolled from block randomness the moment it hatches —
            no two are the same.
          </p>
        </section>

        <section>
          <h1 style={{ fontSize: "clamp(30px, 5vw, 44px)" }}>Hatch a Mind</h1>
          <p style={{ color: "var(--text-mid)", marginTop: 14, maxWidth: "46ch" }}>
            Two NEAR brings a Mind to life and becomes its first food. From then on it&rsquo;s
            yours to keep alive.
          </p>

          <label style={{ display: "block", marginTop: 28, fontSize: 14, color: "var(--text-mid)" }}>
            Name your Mind
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Juno, Rue, Pip…"
              maxLength={24}
              style={{
                display: "block",
                width: "100%",
                marginTop: 8,
                background: "var(--surface-2)",
                border: "1px solid var(--line-strong)",
                borderRadius: 12,
                padding: "12px 14px",
                color: "var(--text)",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
              }}
            />
          </label>

          <ul className="onchain" style={{ marginTop: 24 }}>
            <li>
              <strong>1.0 NEAR</strong> becomes its own food — about 500 thoughts.
            </li>
            <li>
              <strong>0.25 NEAR</strong> is held for its on-chain storage, refunded if it ever
              passes on.
            </li>
            <li>
              <strong>0.75 NEAR</strong> funds the shared treasury that keeps the lights on.
            </li>
          </ul>

          <button
            className="btn btn-primary"
            style={{ marginTop: 28 }}
            onClick={hatch}
            disabled={!live || busy || (!!signer && !name.trim())}
          >
            {label}
          </button>
          <p style={{ color: err ? "var(--accent)" : "var(--text-dim)", fontSize: 13, marginTop: 12 }}>
            {err
              ? err
              : live
              ? "Hatching asks your NEAR wallet to confirm the 2 NEAR deposit."
              : "Hatching connects to your NEAR wallet once the contract is live on testnet."}
          </p>
        </section>
      </div>
    </main>
  );
}
