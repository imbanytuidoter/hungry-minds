import Link from "next/link";
import { hero, gallery, vitalPercent, isAlive, type MindState } from "@/lib/minds";
import Creature from "@/components/Creature";
import MindCard from "@/components/MindCard";
import Mood from "@/components/Mood";
import Vital from "@/components/Vital";

const aliveCount = gallery.filter((m) => isAlive(m.state)).length;

const ARC: MindState[] = [
  "full",
  "content",
  "hungry",
  "starving",
  "asleep",
  "ghost",
];

export default function Home() {
  return (
    <main style={{ "--accent": hero.accent } as React.CSSProperties}>
      {/* ── nav ─────────────────────────────────────────────────────────── */}
      <header className="wrap flex items-center justify-between" style={{ height: 76 }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 19 }}>
          Hungry Minds
        </span>
        <nav className="flex items-center" style={{ gap: 22, fontSize: 15, color: "var(--text-mid)" }}>
          <a href="#life" className="nav-link">How it lives</a>
          <a href="#minds" className="nav-link">The Minds</a>
          <Link href="/hatch" className="btn btn-ghost" style={{ padding: "9px 16px" }}>
            Hatch a Mind
          </Link>
        </nav>
      </header>

      {/* ── preview notice ──────────────────────────────────────────────── */}
      <div className="wrap">
        <div className="preview-note">
          Preview — these are sample Minds rendered by the real contract. Wallet
          actions and live replies go on once it&rsquo;s deployed to testnet.
        </div>
      </div>

      {/* ── hero ────────────────────────────────────────────────────────── */}
      <section className="wrap hero-grid" style={{ paddingTop: 48, paddingBottom: 72 }}>
        <div className="hero-art">
          <div className="terrarium">
            <Creature svg={hero.states.full} state="full" />
          </div>
          <div
            className="flex items-center justify-between"
            style={{ marginTop: 16 }}
          >
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{hero.name}</div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                hatched today · 41 thoughts so far
              </div>
            </div>
            <Mood state="full" />
          </div>
          <div style={{ marginTop: 14 }}>
            <Vital percent={vitalPercent("full")} balanceNear="0.82" />
          </div>
        </div>

        <div className="hero-copy">
          <h1 style={{ fontSize: "clamp(40px, 6vw, 68px)" }}>
            An NFT that
            <br />
            has to eat.
          </h1>
          <p
            style={{
              fontSize: 19,
              color: "var(--text-mid)",
              maxWidth: "46ch",
              marginTop: 22,
            }}
          >
            A Hungry Mind owns its own balance and spends it, thought by thought,
            to think. Feed it, talk to it, and keep it alive — or watch it get
            hungry, fall asleep, and fade.
          </p>
          <div className="flex" style={{ gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <Link href="/hatch" className="btn btn-primary">
              Hatch a Mind — 2 NEAR
            </Link>
            <a href="#minds" className="btn btn-ghost">
              Meet the Minds
            </a>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 18 }}>
            Its money is its own. Not even you, the owner, can withdraw a Mind&rsquo;s food.
          </p>
        </div>
      </section>

      {/* ── the life arc ────────────────────────────────────────────────── */}
      <section id="life" style={{ background: "var(--bg-deep)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="wrap" style={{ paddingTop: 64, paddingBottom: 64 }}>
          <h2 style={{ fontSize: "clamp(26px, 4vw, 38px)", maxWidth: "20ch" }}>
            Every reply costs it a little.
          </h2>
          <p style={{ fontSize: 17, color: "var(--text-mid)", maxWidth: "52ch", marginTop: 14 }}>
            Stop feeding it, and this is what you&rsquo;ll watch happen — the same
            creature, drawn fresh on-chain from how much food it has left.
          </p>

          <div className="arc-row" style={{ marginTop: 36 }}>
            {ARC.map((state) => (
              <figure key={state} style={{ margin: 0, textAlign: "center" }}>
                <div
                  style={{
                    borderRadius: 16,
                    overflow: "hidden",
                    border: "1px solid var(--line)",
                    opacity: state === "ghost" ? 0.85 : 1,
                  }}
                >
                  <Creature svg={hero.states[state]} state={state} />
                </div>
                <figcaption
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    color: state === "ghost" ? "var(--text-dim)" : "var(--text-mid)",
                  }}
                >
                  {state === "full"
                    ? "wide awake"
                    : state === "content"
                    ? "content"
                    : state === "hungry"
                    ? "getting hungry"
                    : state === "starving"
                    ? "starving"
                    : state === "asleep"
                    ? "asleep"
                    : "a ghost"}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ── how it works ────────────────────────────────────────────────── */}
      <section className="wrap" style={{ paddingTop: 72, paddingBottom: 40 }}>
        <div className="how-grid">
          <div>
            <h3 style={{ fontSize: 21 }}>It pays for its own thoughts</h3>
            <p style={{ color: "var(--text-mid)", marginTop: 10 }}>
              Each reply spends 0.002 NEAR from the Mind&rsquo;s balance. Hatch it
              with 2 NEAR and it starts with roughly 500 thoughts in the bank.
            </p>
          </div>
          <div>
            <h3 style={{ fontSize: 21 }}>Strangers pay to talk</h3>
            <p style={{ color: "var(--text-mid)", marginTop: 10 }}>
              Anyone can pay ~0.01 NEAR to chat. 70% feeds the Mind, 20% is yours
              to claim, 10% keeps the lights on. A Mind people love feeds itself.
            </p>
          </div>
          <div>
            <h3 style={{ fontSize: 21 }}>Sell it whole</h3>
            <p style={{ color: "var(--text-mid)", marginTop: 10 }}>
              A Mind carries its balance, its traits and its memory to a new owner.
              The one thing you can&rsquo;t take with you is its food.
            </p>
          </div>
        </div>
      </section>

      {/* ── gallery ─────────────────────────────────────────────────────── */}
      <section id="minds" className="wrap" style={{ paddingTop: 48, paddingBottom: 90 }}>
        <div className="flex items-baseline justify-between" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>The Minds</h2>
          <span style={{ fontSize: 14, color: "var(--text-dim)" }}>
            {aliveCount} of {gallery.length} awake
          </span>
        </div>
        <div className="minds-grid">
          {gallery.map((m) => (
            <MindCard key={m.id} mind={m} />
          ))}
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────────── */}
      <footer style={{ borderTop: "1px solid var(--line)" }}>
        <div
          className="wrap flex items-center justify-between"
          style={{ height: 72, fontSize: 14, color: "var(--text-dim)", flexWrap: "wrap", gap: 10 }}
        >
          <span>Hungry Minds · built on NEAR</span>
          <span>The art and the life are assembled on-chain.</span>
        </div>
      </footer>
    </main>
  );
}
