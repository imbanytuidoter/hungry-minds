"use client";

// The world behind the colony, one per colour theme (game.css `html[data-theme=…]`). All scenes
// are rendered and CSS shows the active one, so switching themes needs no React state. Every
// layer is fixed, behind the app, ignores the pointer, and stops moving for reduced motion.

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);
// deterministic scatter (no Math.random: the server and the browser draw the same scene)
const at = (i: number, k: number) => ((i * k * 9301 + 49297) % 233280) / 233280;

function Cosmos() {
  return (
    <div className="scene scene-cosmos" aria-hidden>
      <div className="cos-nebula cos-nebula-a" />
      <div className="cos-nebula cos-nebula-b" />
      <div className="cos-stars cos-stars-1" />
      <div className="cos-stars cos-stars-2" />
      <div className="cos-stars cos-stars-3" />
      <svg className="cos-planet" viewBox="0 0 400 400">
        <defs>
          <radialGradient id="cosPl" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffd2a6" />
            <stop offset="45%" stopColor="#ff8f7a" />
            <stop offset="100%" stopColor="#7a2c5e" />
          </radialGradient>
          <linearGradient id="cosRing" x1="0" x2="1">
            <stop offset="0%" stopColor="#ffd9e8" stopOpacity="0" />
            <stop offset="50%" stopColor="#ffd9e8" stopOpacity=".9" />
            <stop offset="100%" stopColor="#ffd9e8" stopOpacity="0" />
          </linearGradient>
        </defs>
        <ellipse cx="200" cy="210" rx="190" ry="38" fill="none" stroke="url(#cosRing)" strokeWidth="10" opacity=".55" transform="rotate(-18 200 200)" />
        <circle cx="200" cy="200" r="120" fill="url(#cosPl)" />
        <path d="M110 170 q90 -30 180 0" stroke="#ffe2c6" strokeOpacity=".25" strokeWidth="10" fill="none" />
        <path d="M95 225 q105 30 210 0" stroke="#5c1f4a" strokeOpacity=".35" strokeWidth="14" fill="none" />
        <path d="M30 238 Q200 300 370 162" fill="none" stroke="url(#cosRing)" strokeWidth="10" opacity=".9" />
      </svg>
      <svg className="cos-moon" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="#cfd6ff" />
        <circle cx="36" cy="40" r="7" fill="#aab4ea" />
        <circle cx="60" cy="62" r="10" fill="#aab4ea" />
      </svg>
      <span className="cos-shoot" />
      <span className="cos-shoot cos-shoot-2" />
    </div>
  );
}

function Jungle() {
  const leaf = "M0 0 C 40 -30, 120 -20, 160 30 C 120 60, 40 60, 0 0 Z";
  return (
    <div className="scene scene-jungle" aria-hidden>
      <div className="jun-light" />
      <svg className="jun-vines" viewBox="0 0 1440 260" preserveAspectRatio="none">
        {[80, 260, 520, 900, 1180, 1360].map((x, i) => (
          <g key={x} className="jun-vine" style={{ animationDelay: `${-i * 1.3}s`, transformOrigin: `${x}px 0px` }}>
            <path d={`M${x} 0 C ${x + 20} 60, ${x - 20} 120, ${x + 6} ${150 + (i % 3) * 40}`} stroke="#1f5a37" strokeWidth="4" fill="none" />
            {seq(4).map((k) => (
              <path key={k} d={leaf} fill={k % 2 ? "#2f7a47" : "#245f39"} transform={`translate(${x + (k % 2 ? 2 : -2)} ${30 + k * 34}) rotate(${k % 2 ? 30 : 150}) scale(.16)`} />
            ))}
          </g>
        ))}
      </svg>
      <svg className="jun-leaves jun-leaves-l" viewBox="0 0 520 520">
        <path d="M-40 520 C 40 300, 200 200, 420 230 C 300 330, 200 420, 140 520 Z" fill="#0c2a1b" />
        <path d="M-60 520 C -10 360, 60 220, 210 120 C 200 280, 150 420, 120 520 Z" fill="#103520" />
        <path d="M0 520 C 120 420, 300 400, 470 460 C 320 470, 200 500, 160 520 Z" fill="#0a2216" />
        <path d="M60 470 C 150 360, 260 290, 400 260" stroke="#1e5a37" strokeWidth="3" fill="none" />
      </svg>
      <svg className="jun-leaves jun-leaves-r" viewBox="0 0 520 520">
        <path d="M-40 520 C 40 300, 200 200, 420 230 C 300 330, 200 420, 140 520 Z" fill="#0c2a1b" />
        <path d="M-60 520 C -10 360, 60 220, 210 120 C 200 280, 150 420, 120 520 Z" fill="#103520" />
        <path d="M60 470 C 150 360, 260 290, 400 260" stroke="#1e5a37" strokeWidth="3" fill="none" />
      </svg>
      {seq(16).map((i) => (
        <span key={i} className="jun-fly" style={{ left: `${at(i, 7) * 100}%`, top: `${20 + at(i, 13) * 75}%`, animationDelay: `${-at(i, 3) * 9}s`, animationDuration: `${7 + at(i, 5) * 6}s` }} />
      ))}
    </div>
  );
}

function Desert() {
  return (
    <div className="scene scene-desert" aria-hidden>
      <div className="des-sun" />
      <svg className="des-dunes" viewBox="0 0 1440 420" preserveAspectRatio="none">
        <path d="M0 180 C 240 120, 420 150, 640 170 C 900 195, 1120 110, 1440 150 L1440 420 L0 420 Z" fill="#e6c08b" />
        <path d="M980 160 l40 -70 l26 30 l30 -50 l44 90 Z" fill="#d7a874" opacity=".75" />
        <path d="M0 260 C 300 200, 520 260, 760 250 C 1000 240, 1200 190, 1440 230 L1440 420 L0 420 Z" fill="#d9a96f" />
        <path d="M0 340 C 260 300, 520 350, 820 330 C 1080 312, 1260 290, 1440 320 L1440 420 L0 420 Z" fill="#c98f57" />
        <g fill="#5c7a4e">
          <path d="M210 250 v-70 a12 12 0 0 1 24 0 v70 Z M196 222 v-22 a8 8 0 0 1 16 0 v22 Z M232 214 v-28 a8 8 0 0 1 16 0 v28 Z" />
          <path d="M1210 225 v-90 a14 14 0 0 1 28 0 v90 Z M1192 190 v-26 a9 9 0 0 1 18 0 v26 Z M1236 176 v-36 a9 9 0 0 1 18 0 v36 Z" />
        </g>
      </svg>
      {seq(18).map((i) => (
        <span key={i} className="des-grain" style={{ left: `${at(i, 11) * 100}%`, top: `${45 + at(i, 17) * 50}%`, animationDelay: `${-at(i, 7) * 12}s` }} />
      ))}
    </div>
  );
}

function Abyss() {
  return (
    <div className="scene scene-abyss" aria-hidden>
      <div className="aby-rays" />
      <svg className="aby-jelly" viewBox="0 0 120 200">
        <path d="M10 70 C 10 20, 110 20, 110 70 C 90 64, 30 64, 10 70 Z" fill="#7ff2dd" fillOpacity=".35" stroke="#a8fff0" strokeOpacity=".7" />
        {seq(5).map((k) => (
          <path key={k} className="aby-tent" d={`M${26 + k * 17} 68 C ${20 + k * 17} 110, ${34 + k * 17} 140, ${24 + k * 17} 190`} stroke="#7ff2dd" strokeOpacity=".5" strokeWidth="2" fill="none" />
        ))}
      </svg>
      <svg className="aby-weed" viewBox="0 0 1440 300" preserveAspectRatio="none">
        {[60, 140, 230, 1180, 1260, 1350].map((x, i) => (
          <path key={x} className="aby-strand" style={{ animationDelay: `${-i * 0.8}s`, transformOrigin: `${x}px 300px` }} d={`M${x} 300 C ${x - 30} 220, ${x + 30} 160, ${x - 10} ${60 + (i % 3) * 30}`} stroke={i % 2 ? "#0f5a52" : "#127066"} strokeWidth="14" strokeLinecap="round" fill="none" />
        ))}
        <path d="M0 290 C 300 260, 600 296, 900 280 C 1150 268, 1300 290, 1440 276 L1440 300 L0 300 Z" fill="#06303a" />
      </svg>
      {seq(22).map((i) => (
        <span key={i} className="aby-bubble" style={{ left: `${at(i, 19) * 100}%`, width: 6 + at(i, 23) * 14, height: 6 + at(i, 23) * 14, animationDelay: `${-at(i, 29) * 14}s`, animationDuration: `${9 + at(i, 31) * 9}s` }} />
      ))}
    </div>
  );
}

function Paper() {
  return (
    <div className="scene scene-paper" aria-hidden>
      <div className="pap-lines" />
      <svg className="pap-doodles" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <g fill="none" stroke="#1d1c21" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity=".55">
          <path d="M70 120 l14 30 l32 4 l-24 22 l7 32 l-29 -16 l-29 16 l7 -32 l-24 -22 l32 -4 Z" />
          <path d="M1330 110 c -40 -10 -40 50 0 40 c 30 -8 24 -48 -6 -44 c -40 6 -44 74 2 76 c 50 2 62 -84 6 -96" />
          <path d="M60 760 c 20 -40 60 -40 80 0 c 20 40 60 40 80 0" />
          <path d="M1300 780 l60 -40 m-60 40 l20 4 m-20 -4 l6 -18" />
          <path d="M1250 420 c 10 -24 40 -24 40 0 c 0 24 -40 40 -40 40 c 0 0 -40 -16 -40 -40 c 0 -24 30 -24 40 0" stroke="#ff4f87" opacity=".9" />
          <path d="M180 430 q 30 -60 60 0 t 60 0" />
        </g>
      </svg>
    </div>
  );
}

/** Seed: crushed velvet, one pool of light, ferns stitched in thread at the two lower corners. */
function Fern({ side }: { side: "l" | "r" }) {
  // a frond: one curved stem and paired leaflets that shorten toward the tip (deterministic)
  const fronds = [
    { x: 60, h: 330, lean: 40 },
    { x: 130, h: 250, lean: 70 },
    { x: 20, h: 200, lean: -10 },
  ];
  return (
    <svg className={`seed-ferns seed-ferns-${side}`} viewBox="0 0 300 400" aria-hidden>
      {fronds.map((f, fi) => {
        const pts = seq(14).map((i) => {
          const t = i / 13;
          return { x: f.x + f.lean * t * t, y: 400 - f.h * t, t };
        });
        const stem = "M" + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L");
        return (
          <g key={fi}>
            <path className="stem" d={stem} />
            {pts.slice(1, -1).map((p, i) => {
              const len = 46 * (1 - p.t) + 8;
              const dx = len * 0.9;
              return (
                <g key={i}>
                  <path className="leaf" d={`M${p.x} ${p.y} q ${-dx * 0.5} ${-len * 0.15} ${-dx} ${-len * 0.45}`} />
                  <path className="leaf" d={`M${p.x} ${p.y} q ${dx * 0.5} ${-len * 0.15} ${dx} ${-len * 0.45}`} />
                </g>
              );
            })}
            <circle className="knot" cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="2" />
          </g>
        );
      })}
    </svg>
  );
}
function Seed() {
  return (
    <div className="scene scene-seed" aria-hidden>
      <div className="seed-velvet" />
      <div className="seed-pile" />
      <div className="seed-pool" />
      <Fern side="l" />
      <Fern side="r" />
    </div>
  );
}

export default function ThemeScene() {
  return (
    <>
      <Seed />
      <Cosmos />
      <Jungle />
      <Desert />
      <Abyss />
      <Paper />
    </>
  );
}
