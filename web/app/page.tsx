import Link from "next/link";
import { hero, gallery, isAlive, type MindState } from "@/lib/minds";
import Creature from "@/components/Creature";
import MindCard from "@/components/MindCard";
import Vivarium from "@/components/Vivarium";

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

      {/* ── hero: the Vivarium ──────────────────────────────────────────── */}
      <Vivarium />

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
