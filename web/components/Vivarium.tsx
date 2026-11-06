"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Creature from "./Creature";
import Mood from "./Mood";
import { hero, vitalPercent } from "@/lib/minds";

// The hero: a Mind materialised in a containment beam of its own colour — depth,
// light, rising motes, a creature that breathes and hops. Not a card; a habitat.
export default function Vivarium() {
  const [hop, setHop] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Ambient life: an occasional hop.
  useEffect(() => {
    const id = setInterval(() => {
      setHop(true);
      setTimeout(() => setHop(false), 720);
    }, 4600);
    return () => clearInterval(id);
  }, []);

  // Rising motes inside the beam.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const N = 34;
    type Mote = { x: number; y: number; r: number; s: number; a: number; drift: number };
    const rnd = () => Math.random();
    const spawn = (fromBottom = false): Mote => ({
      x: rnd(),
      y: fromBottom ? 1.05 + rnd() * 0.2 : rnd(),
      r: 0.8 + rnd() * 2.4,
      s: 0.0008 + rnd() * 0.0016,
      a: 0.12 + rnd() * 0.5,
      drift: (rnd() - 0.5) * 0.0006,
    });
    const motes = Array.from({ length: N }, () => spawn());

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, w * dpr);
      canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const accent =
      getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#b59cff";

    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.y -= m.s;
        m.x += m.drift;
        if (m.y < -0.08) Object.assign(m, spawn(true));
        ctx.globalAlpha = m.a * Math.max(0, Math.sin(m.y * Math.PI));
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const onMove = (e: React.MouseEvent) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--px", px.toFixed(3));
    el.style.setProperty("--py", py.toFixed(3));
  };

  return (
    <section
      ref={stageRef}
      className="stage"
      style={{ "--accent": hero.accent, "--px": 0, "--py": 0 } as React.CSSProperties}
      onMouseMove={onMove}
    >
      <div className="stage-grid" aria-hidden />
      <div className="stage-vignette" aria-hidden />

      <div className="stage-inner wrap">
        <div className="chamber">
          <div className="chamber-glow" aria-hidden />
          <div className="chamber-beam" aria-hidden />
          <canvas ref={canvasRef} className="chamber-motes" aria-hidden />
          <div className="chamber-creature">
            <Creature svg={hero.statesBare.full} state="full" hop={hop} />
          </div>
          <div className="chamber-platform" aria-hidden />

          <div className="hud hud-mood">
            <Mood state="full" />
          </div>
          <div className="hud hud-vital">
            <div className="hud-vital-row">
              <span>{hero.name}</span>
              <span className="hud-dim">0.82 NEAR left</span>
            </div>
            <div className="vital">
              <span style={{ width: `${vitalPercent("full")}%` }} />
            </div>
          </div>
        </div>

        <div className="pitch">
          <div className="eyebrow">A living on-chain creature</div>
          <h1 style={{ fontSize: "clamp(42px, 6.4vw, 76px)" }}>
            An NFT that
            <br />
            has to eat.
          </h1>
          <p className="pitch-lead">
            Every Mind owns its own balance and spends it, thought by thought, to
            think. Feed it, talk to it, keep it alive — or watch it get hungry, fall
            asleep, and fade for good.
          </p>
          <div className="pitch-cta">
            <Link href="/app" className="btn btn-primary btn-lg">
              Play — hatch a Mind
            </Link>
            <a href="#minds" className="btn btn-ghost btn-lg">
              Meet the Minds
            </a>
          </div>
          <p className="pitch-fine">
            Its money is its own. Not even you, the owner, can withdraw a Mind&rsquo;s food.
          </p>
        </div>
      </div>
    </section>
  );
}
