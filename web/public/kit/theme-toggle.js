/* <hm-mode-toggle>: light/dark switch. A squircle knob slides along a recessed pill,
   the pixel-art sun scatters into dust and re-forms as the moon (and back), and an arc
   of light sweeps counter-clockwise around the knob, coming to rest as a lit edge.
   No dependencies, no modules. Safe to load more than once.

   State lives on <html data-mode="light|dark"> (missing = dark). The host page restores a
   saved choice (localStorage "hm-mode") onto <html> before first paint; this file only writes it.
   API: window.HMMode.get() / .set("light"|"dark") / .toggle()
   Theme it with inherited custom properties:
     --tg-h            track height (34px); width is 1.9x
     --tg-sun          rim + glow in light mode      --tg-moon   rim + glow in dark mode
     --tg-ink          sun pixels                    --tg-cream  moon pixels
     --tg-track-light / --tg-track-dark              --tg-knob-light / --tg-knob-dark
     --tg-focus        focus ring (defaults to the rim colour)                          */
(() => {
  "use strict";
  if (typeof window === "undefined" || !window.customElements || customElements.get("hm-mode-toggle")) return;

  const G = 13; // icon grid
  const DIM = -1; // marker for the moon's dithered dark side

  // Sun: 5x5 core with clipped corners, 4 straight rays of 2 pixels, 4 diagonal pixels.
  const SUN = [];
  for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) if (!((x === 4 || x === 8) && (y === 4 || y === 8))) SUN.push([x, y, 1]);
  [[6, 1], [6, 2], [6, 10], [6, 11], [1, 6], [2, 6], [10, 6], [11, 6], [2, 2], [10, 2], [2, 10], [10, 10]].forEach(([x, y]) => SUN.push([x, y, 1]));

  // Moon: crescent opening to the upper right, a dithered dark side, a plus star and a dot star.
  const MOON = [];
  const lit = { 2: [4, 4], 3: [3, 4], 4: [2, 4], 5: [1, 4], 6: [1, 4], 7: [1, 5], 8: [1, 6], 9: [2, 9], 10: [3, 8], 11: [4, 7] };
  const dark = { 2: [5, 7], 3: [5, 8], 4: [5, 9], 5: [5, 10], 6: [5, 10], 7: [6, 10], 8: [7, 9] };
  for (const y in lit) for (let x = lit[y][0]; x <= lit[y][1]; x++) MOON.push([x, +y, 1]);
  for (const y in dark) for (let x = dark[y][0]; x <= dark[y][1]; x++) if ((x + +y) % 2 === 0) MOON.push([x, +y, DIM]);
  [[10, 0], [9, 1], [10, 1], [11, 1], [10, 2], [12, 4]].forEach(([x, y]) => MOON.push([x, y, 1]));

  const N = Math.max(SUN.length, MOON.length);

  // deterministic pseudo-random in [0,1)
  const rnd = (n) => {
    let t = (n * 2654435761 + 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const perm = (seed) => {
    const a = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rnd(seed * 977 + i) * (i + 1));
      const k = a[i]; a[i] = a[j]; a[j] = k;
    }
    return a;
  };
  const PERM = { light: perm(3), dark: perm(11) };

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const outCubic = (t) => 1 - (1 - t) ** 3;
  const outQuart = (t) => 1 - (1 - t) ** 4;
  const inOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
  const smooth = (t) => t * t * (3 - 2 * t);
  const snap = (n, d) => Math.round(n * d) / d; // to whole device pixels

  // rest pose per mode: p = knob position (1 = right), a = arc centre angle (0 = top, clockwise),
  // k = colour state (0 = light palette, 1 = dark palette; rim, knob face, track and icon all follow it)
  const REST = { light: { p: 1, a: 40, k: 0 }, dark: { p: 0, a: 180, k: 1 } };
  const S_REST = 78, S_PEAK = 118, RI_REST = 1, GI_REST = 0.72;
  const T_KNOB = 200, T_ARC = 720, T_FLY = 290, T_STAGGER = 100, T_END = 760;
  const T_COL0 = 35, T_COL = 110; // the palette holds for 35 ms, then crosses over in 110 ms, all parts together

  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const RING = "-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)";
  const arc = (stops) => `conic-gradient(from calc((var(--a,0) - 180) * 1deg),${stops})`;
  const s = (k) => `calc((180 ${k < 0 ? "-" : "+"} var(--s,64) * ${Math.abs(k)}) * 1deg)`;
  const H = (k) => `calc(var(--_h) * ${k})`;

  const CSS = `
:host{--_h:var(--tg-h,34px);--_sun:var(--tg-sun,#F5B041);--_moon:var(--tg-moon,#ff6fa3);--_ink:var(--tg-ink,#13261c);--_cream:var(--tg-cream,#fbf3e8);
--_tl:var(--tg-track-light,#e9e2d4);--_td:var(--tg-track-dark,#06140e);--_kl:var(--tg-knob-light,#fffaf1);--_kd:var(--tg-knob-dark,rgba(255,255,255,.07));
--_w:calc(var(--_h) * 1.9);
display:inline-block;position:relative;vertical-align:middle;flex:none;box-sizing:border-box;width:var(--_w);height:var(--_h);
cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;touch-action:manipulation}
:host([hidden]){display:none}
*,*::before,*::after{box-sizing:border-box}
.t{--k:0;--cm:0%;--pm:0%;
--_kh:var(--kh,${H(0.82)});--_kw:var(--kw,${H(0.93)});--_in:calc((var(--_h) - var(--_kh)) / 2);
--_tr:calc(var(--_w) - var(--_kw) - var(--_in) * 2);--_r:calc(var(--_kh) * .32);
--_gap:var(--gp,${H(0.028)});--_th:var(--th,max(1.5px,${H(0.024)}));--_lift:var(--lift,${H(-0.035)});
--c:var(--_sun);--hot:var(--c);--line:var(--c);
--s1:rgba(80,55,20,.17);--s2:rgba(255,255,255,.5);--s3:rgba(255,255,255,.65);--ks1:rgba(80,55,15,.24);--ks2:rgba(80,55,15,.2);
position:absolute;inset:0;border-radius:999px;background:var(--_tl);
box-shadow:inset 0 ${H(0.055)} ${H(0.11)} var(--s1),inset 0 ${H(-0.03)} ${H(0.05)} var(--s2),0 max(1px,${H(0.02)}) 0 var(--s3)}
.t.dk{--k:1;--cm:100%;--pm:100%;--c:var(--_moon);background:var(--_td);
--s1:rgba(0,0,0,.6);--s2:rgba(255,255,255,.03);--s3:rgba(255,255,255,.05);--ks1:rgba(0,0,0,.55);--ks2:rgba(0,0,0,.45)}
:host(:focus-visible) .t{outline:max(2px,${H(0.05)}) solid var(--tg-focus,var(--c));outline-offset:max(3px,${H(0.08)})}
.sl{position:absolute;left:0;top:0;width:var(--_kw);height:var(--_kh);
transform:translate(var(--x,calc(var(--_in) + var(--_tr) * var(--p,0))),var(--y,var(--_in))) scale(var(--sx,1),var(--sy,1))}
.lf{position:absolute;inset:0;transition:transform .22s cubic-bezier(.3,.7,.2,1);
--arc:${arc(`transparent ${s(-1)},var(--c) ${s(-0.55)},var(--c) ${s(0.55)},transparent ${s(1)}`)};
--arch:${arc(`transparent ${s(-1)},var(--line) ${s(-0.72)},var(--hot) ${s(-0.3)},var(--hot) ${s(0.3)},var(--line) ${s(0.72)},transparent ${s(1)}`)}}
:host(:active) .lf{transform:translateY(calc(var(--_lift) * .3)) scale(.97)}
.amb,.glow,.ring,.spill,.sd{position:absolute;pointer-events:none}
.amb i,.glow i,.spill i{position:absolute;display:block}
.amb{inset:${H(-0.5)};filter:blur(${H(0.2)});opacity:calc(var(--gi,.7) * .75)}
.amb i{inset:${H(0.34)};border-radius:calc(var(--_r) + ${H(0.16)});padding:${H(0.2)};background:var(--arc);${RING}}
.glow{inset:calc(-1 * (var(--_gap) + var(--_th) * 3.5));filter:blur(${H(0.032)});opacity:calc(var(--gi,.7) * (.3 + .7 * var(--k)))}
.glow i{inset:0;border-radius:calc(var(--_r) + var(--_gap) + var(--_th) * 3.5);padding:calc(var(--_th) * 3.6);background:var(--arc);${RING}}
.ring{inset:calc(-1 * (var(--_gap) + var(--_th)));border-radius:calc(var(--_r) + var(--_gap) + var(--_th));padding:var(--_th);background:var(--arch);opacity:var(--ri,1);${RING}}
.sd{inset:0;border-radius:var(--_r);box-shadow:0 ${H(0.1)} ${H(0.2)} var(--ks1);opacity:0;transition:opacity .22s ease}
.kb{position:absolute;inset:0;border-radius:var(--_r);overflow:hidden;isolation:isolate;
box-shadow:0 ${H(0.065)} ${H(0.15)} var(--ks1),0 ${H(0.015)} ${H(0.03)} var(--ks2)}
@media (hover:hover){:host(:hover) .lf{transform:translateY(var(--_lift))}:host(:hover) .sd{opacity:1}}
.face{position:absolute;inset:0;border-radius:inherit}
.fl{opacity:calc(1 - var(--k));background:radial-gradient(120% 90% at 30% 0%,rgba(255,255,255,.95),rgba(255,255,255,0) 60%),linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0) 50%,rgba(110,80,30,.08)),var(--_kl);
box-shadow:inset 0 0 0 1px rgba(255,255,255,.6),inset 0 -1px 1px rgba(110,80,30,.12)}
.fd{opacity:var(--k);background:linear-gradient(165deg,rgba(255,255,255,.16),rgba(255,255,255,.035) 55%,rgba(255,255,255,.02)),var(--_kd);
box-shadow:inset 0 1px 0 rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.08)}
.spill{inset:0;filter:blur(${H(0.07)});opacity:calc(var(--gi,.7) * (.5 - .05 * var(--k)))}
.spill i{inset:${H(-0.06)};border-radius:calc(var(--_r) + ${H(0.06)});padding:calc(var(--_kh) * .2);background:var(--arc);${RING}}
.ic{position:absolute;left:0;top:0;display:block;overflow:visible;fill:var(--_ink)}
.dk .ic{fill:var(--_cream)}
@supports (color:color-mix(in oklch,red 50%,blue)){
.t,.t.dk{--c:color-mix(in oklch,var(--_moon) var(--cm),var(--_sun));
--line:color-mix(in oklch,var(--_moon) var(--cm),color-mix(in srgb,var(--_sun) 88%,#e07a00));
--hot:color-mix(in oklch,color-mix(in srgb,var(--_moon) 45%,#fff) var(--cm),color-mix(in srgb,var(--_sun) 72%,#fff1b0));
background:color-mix(in srgb,var(--_td) var(--cm),var(--_tl));
--s1:color-mix(in srgb,rgba(0,0,0,.6) var(--cm),rgba(80,55,20,.17));--s2:color-mix(in srgb,rgba(255,255,255,.03) var(--cm),rgba(255,255,255,.5));
--s3:color-mix(in srgb,rgba(255,255,255,.05) var(--cm),rgba(255,255,255,.65));
--ks1:color-mix(in srgb,rgba(0,0,0,.55) var(--cm),rgba(80,55,15,.24));--ks2:color-mix(in srgb,rgba(0,0,0,.45) var(--cm),rgba(80,55,15,.2))}
.t .ic,.t.dk .ic{fill:color-mix(in srgb,var(--_cream) var(--pm),var(--_ink))}}
@media (prefers-reduced-motion:reduce){.lf,.sd{transition:none}}`;

  const HTML = `<style>${CSS}</style><div class="t" part="track"><div class="sl"><div class="lf">` +
    `<div class="amb"><i></i></div><div class="glow"><i></i></div><div class="sd"></div>` +
    `<div class="kb" part="knob"><div class="face fl"></div><div class="face fd"></div><div class="spill"><i></i></div>` +
    `<svg class="ic" aria-hidden="true" focusable="false" shape-rendering="crispEdges"></svg></div>` +
    `<div class="ring"></div></div></div></div>`;

  // ---- global mode state ----
  const root = document.documentElement;
  const instances = new Set();
  let animTimer = 0;
  const getMode = () => (root.getAttribute("data-mode") === "light" ? "light" : "dark");
  const setMode = (mode) => {
    if (mode !== "light" && mode !== "dark") return getMode();
    if (root.getAttribute("data-mode") === mode) return mode;
    root.setAttribute("data-mode", mode);
    try { localStorage.setItem("hm-mode", mode); } catch (e) { /* storage blocked */ }
    root.classList.add("hm-mode-anim");
    clearTimeout(animTimer);
    animTimer = setTimeout(() => root.classList.remove("hm-mode-anim"), 600);
    window.dispatchEvent(new CustomEvent("hm-mode", { detail: { mode } }));
    window.dispatchEvent(new Event("palette"));
    return mode;
  };
  const toggleMode = () => setMode(getMode() === "dark" ? "light" : "dark");
  if (!window.HMMode) window.HMMode = { get: getMode, set: setMode, toggle: toggleMode };
  new MutationObserver(() => instances.forEach((el) => el._sync(true))).observe(root, { attributes: true, attributeFilter: ["data-mode"] });

  // The knob is placed on whole device pixels, so re-place it whenever the layout or the pixel ratio may have moved it.
  const remeasure = () => instances.forEach((el) => el._measure());
  window.addEventListener("resize", remeasure);
  window.addEventListener("load", remeasure);
  try { document.fonts.ready.then(remeasure, () => {}); } catch (e) { /* no font loading API */ }
  const watchDpr = () => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on); else mq.removeListener(on);
      remeasure();
      watchDpr();
    };
    if (mq.addEventListener) mq.addEventListener("change", on); else mq.addListener(on);
  };
  watchDpr();

  const NS = "http://www.w3.org/2000/svg";

  class HMModeToggle extends HTMLElement {
    constructor() {
      super();
      const sr = this.attachShadow({ mode: "open" });
      sr.innerHTML = HTML;
      this._t = sr.querySelector(".t");
      this._svg = sr.querySelector(".ic");
      this._rects = [];
      for (let i = 0; i < N; i++) {
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("opacity", "0");
        this._svg.appendChild(r);
        this._rects.push(r);
      }
      this._parts = Array.from({ length: N }, () => ({ x: 6, y: 6, o: 0, z: 1 }));
      this._v = { p: 0, a: 180, s: S_REST, ri: RI_REST, gi: GI_REST, k: 1, sx: 1, sy: 1 };
      this._g = null; // measured geometry, in CSS px
      this._ox = 0; // host position in the viewport, so the knob can land on whole device pixels
      this._oy = 0;
      this._mode = null;
      this._raf = 0;
      this._onClick = () => toggleMode();
      this._onKey = (e) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        e.preventDefault();
        if (!e.repeat) toggleMode();
      };
      this._onEnter = () => { if (!this._raf && this._g) { this._origin(); this._apply(); } };
    }

    connectedCallback() {
      if (!this.hasAttribute("role")) this.setAttribute("role", "switch");
      if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
      if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "Dark mode");
      this.addEventListener("click", this._onClick);
      this.addEventListener("keydown", this._onKey);
      this.addEventListener("pointerenter", this._onEnter);
      instances.add(this);
      if (!this._ro && window.ResizeObserver) this._ro = new ResizeObserver(() => this._measure());
      if (this._ro) this._ro.observe(this);
      this._mode = null;
      this._sync(false);
      this._measure();
    }

    disconnectedCallback() {
      this.removeEventListener("click", this._onClick);
      this.removeEventListener("keydown", this._onKey);
      this.removeEventListener("pointerenter", this._onEnter);
      instances.delete(this);
      if (this._ro) this._ro.disconnect();
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }

    _sync(animate) {
      const m = getMode();
      if (m === this._mode) return;
      const first = this._mode === null;
      this._mode = m;
      this.setAttribute("aria-checked", m === "dark" ? "true" : "false");
      this._t.classList.toggle("dk", m === "dark");
      if (!animate || first || reduced() || !this.isConnected) this._rest(m);
      else this._animate(m);
    }

    // where particle i sits in mode m
    _target(i, m) {
      const list = m === "light" ? SUN : MOON;
      const k = PERM[m][i];
      if (k >= list.length) return null;
      const c = list[k];
      const dimOk = this._g && this._g.cellD >= 3;
      return { x: c[0], y: c[1], o: c[2] === DIM ? (dimOk ? 0.22 : 0) : 1 };
    }

    _origin() {
      const r = this.getBoundingClientRect();
      this._ox = r.left;
      this._oy = r.top;
    }

    _rest(m) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      const R = REST[m];
      Object.assign(this._v, { p: R.p, a: R.a, k: R.k, s: S_REST, ri: RI_REST, gi: GI_REST, sx: 1, sy: 1 });
      for (let i = 0; i < N; i++) {
        const T = this._target(i, m);
        const P = this._parts[i];
        if (T) { P.x = T.x; P.y = T.y; P.o = T.o; } else P.o = 0;
        P.z = 1;
      }
      if (this._g && this.isConnected) this._origin();
      this._apply();
      this._draw();
    }

    _animate(m) {
      cancelAnimationFrame(this._raf);
      if (this._g) this._origin();
      const v = this._v;
      const from = Object.assign({}, v);
      const to = REST[m];
      const a1 = from.a - ((((from.a - to.a) % 360) + 360) % 360); // always counter-clockwise
      const dp = Math.abs(to.p - from.p);
      const seed = m === "dark" ? 1 : 2;
      const plan = this._parts.map((P, i) => {
        const S = { x: P.x, y: P.y, o: P.o };
        const T = this._target(i, m) || { x: S.x, y: S.y, o: 0 };
        const bx = S.o > 0 ? S.x : T.x, by = S.o > 0 ? S.y : T.y;
        const ang = rnd(i * 31 + seed * 7) * Math.PI * 2;
        const rad = 1.4 + rnd(i * 53 + seed * 13 + 5) * 3.6;
        const mx = Math.max(-4, Math.min(16, 6 + ((bx + T.x) / 2 - 6) * 1.4 + Math.cos(ang) * rad));
        const my = Math.max(-4, Math.min(16, 6 + ((by + T.y) / 2 - 6) * 1.4 + Math.sin(ang) * rad));
        return { S, T, mx, my, d: rnd(i * 17 + seed * 3) * T_STAGGER };
      });
      let t0 = -1;
      const step = (now) => {
        if (t0 < 0) t0 = now;
        const t = now - t0;
        // knob: fast ease-out slide with a little stretch in the middle
        const tk = clamp01(t / T_KNOB);
        v.p = lerp(from.p, to.p, outCubic(tk));
        const st = Math.sin(Math.PI * tk) * dp;
        v.sx = 1 + 0.1 * st;
        v.sy = 1 - 0.06 * st;
        // arc of light: sweeps counter-clockwise, swelling while it moves
        const ta = clamp01(t / T_ARC);
        const bump = Math.sin(Math.PI * clamp01(t / (T_ARC * 0.85)));
        v.a = lerp(from.a, a1, outQuart(ta));
        v.s = lerp(from.s, S_REST, ta) + (S_PEAK - S_REST) * bump;
        v.ri = lerp(from.ri, RI_REST, ta) + (1 - RI_REST) * bump;
        v.gi = lerp(from.gi, GI_REST, ta) + (1 - GI_REST) * bump;
        // palette: rim, glow, knob face, track and icon cross over together
        v.k = lerp(from.k, to.k, smooth(clamp01((t - T_COL0) / T_COL)));
        // pixels: scatter out and fly back together as the other icon
        for (let i = 0; i < N; i++) {
          const q = plan[i], P = this._parts[i], S = q.S, T = q.T;
          const ti = clamp01((t - q.d) / T_FLY);
          if (S.o > 0 && T.o > 0) {
            const e = inOutSine(ti), u = 1 - e;
            const cx = 2 * q.mx - (S.x + T.x) / 2, cy = 2 * q.my - (S.y + T.y) / 2;
            P.x = u * u * S.x + 2 * u * e * cx + e * e * T.x;
            P.y = u * u * S.y + 2 * u * e * cy + e * e * T.y;
            P.o = lerp(S.o, T.o, ti);
          } else if (T.o > 0) {
            const e = outCubic(ti);
            P.x = lerp(q.mx, T.x, e); P.y = lerp(q.my, T.y, e);
            P.o = T.o * smooth(clamp01(ti * 1.6));
          } else if (S.o > 0) {
            const e = outCubic(ti);
            P.x = lerp(S.x, q.mx, e); P.y = lerp(S.y, q.my, e);
            P.o = S.o * (1 - smooth(clamp01(ti * 1.25)));
          } else P.o = 0;
          P.z = 1 - 0.3 * Math.sin(Math.PI * ti);
        }
        this._apply();
        this._draw();
        if (t < T_END) this._raf = requestAnimationFrame(step);
        else this._rest(m);
      };
      this._raf = requestAnimationFrame(step);
    }

    _apply() {
      const v = this._v, st = this._t.style, g = this._g;
      st.setProperty("--p", v.p.toFixed(4));
      if (g) {
        // whole device pixels on the page, so the knob and its pixel icon are never resampled
        const x = snap(this._ox + g.inset + v.p * g.travel, g.d) - this._ox;
        const y = snap(this._oy + g.inset, g.d) - this._oy;
        st.setProperty("--x", x.toFixed(4) + "px");
        st.setProperty("--y", y.toFixed(4) + "px");
      }
      st.setProperty("--sx", v.sx.toFixed(4));
      st.setProperty("--sy", v.sy.toFixed(4));
      st.setProperty("--a", v.a.toFixed(2));
      st.setProperty("--s", v.s.toFixed(2));
      st.setProperty("--ri", v.ri.toFixed(3));
      st.setProperty("--gi", v.gi.toFixed(3));
      st.setProperty("--k", v.k.toFixed(4));
      st.setProperty("--cm", (v.k * 100).toFixed(2) + "%");
      // the icon flips colour in the middle of the face cross-fade, so the dust is never a muddy mid-tone
      st.setProperty("--pm", (smooth(clamp01((v.k - 0.4) / 0.2)) * 100).toFixed(1) + "%");
    }

    _measure() {
      if (!this.isConnected) return;
      const cs = getComputedStyle(this);
      const h = parseFloat(cs.height), w = parseFloat(cs.width);
      if (!(h > 0) || !(w > 0)) return;
      const d = window.devicePixelRatio || 1;
      const kh = Math.max(1, snap(h * 0.82, d)), kw = Math.max(1, snap(h * 0.93, d));
      const inset = (h - kh) / 2;
      const th = Math.max(1, Math.round(Math.max(1.5, h * 0.024) * d)) / d; // lit edge: a whole number of device pixels
      const gap = Math.max(1, Math.round(h * 0.028 * d)) / d;
      const lift = Math.max(1, Math.round(h * 0.035 * d)) / d;
      const cellD = Math.max(1, Math.round((kh * 0.6 * d) / G)); // icon cell in device pixels
      const gapD = cellD >= 7 ? 2 : cellD >= 3 ? 1 : 0;
      const cell = cellD / d, size = cell * G;
      const st = this._t.style;
      st.setProperty("--kh", kh + "px");
      st.setProperty("--kw", kw + "px");
      st.setProperty("--th", th + "px");
      st.setProperty("--gp", gap + "px");
      st.setProperty("--lift", -lift + "px");
      this._svg.setAttribute("width", size);
      this._svg.setAttribute("height", size);
      this._svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
      this._svg.style.left = snap((kw - size) / 2, d) + "px";
      this._svg.style.top = snap((kh - size) / 2, d) + "px";
      const changed = !this._g || cellD !== this._g.cellD;
      this._g = { d, kh, kw, inset, travel: w - kw - inset * 2, cell, cellD, gapPx: gapD / d };
      this._origin();
      if (changed && !this._raf && this._mode) this._rest(this._mode);
      else { this._apply(); this._draw(); }
    }

    _draw() {
      const g = this._g;
      if (!g) return;
      const d = g.d, c = g.cell;
      for (let i = 0; i < N; i++) {
        const P = this._parts[i], r = this._rects[i];
        if (P.o <= 0.004) { r.setAttribute("opacity", "0"); continue; }
        const w = Math.max(1 / d, snap((c - g.gapPx) * P.z, d));
        const off = Math.floor(((c - w) / 2) * d) / d;
        r.setAttribute("x", snap(P.x * c, d) + off);
        r.setAttribute("y", snap(P.y * c, d) + off);
        r.setAttribute("width", w);
        r.setAttribute("height", w);
        r.setAttribute("opacity", P.o.toFixed(3));
      }
    }
  }

  customElements.define("hm-mode-toggle", HMModeToggle);
})();
