const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().replace(/\s+/g, "");
// The landing story: one shape, morphed point by point as you scroll, lit by her food.
(() => {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const smooth = (u) => u * u * (3 - 2 * u);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);

  const HMx = window.HM || {};
  const LINKS = {
    game: HMx.GAME || "/app",
    hatch: "/app?hatch=1",
    guide: HMx.GUIDE || "/guide",
    docs: HMx.DOCS || "/docs",
    nearblocks: HMx.NEARBLOCKS || "https://testnet.nearblocks.io/address/hungry-minds-8250f6.testnet",
  };
  // keep a link's #section when its base is swapped (the guide link points at /guide#feed)
  $$("[data-go]").forEach((a) => { const to = LINKS[a.dataset.go]; if (to) a.href = to + (new URL(a.getAttribute("href") || "", location.href).hash || ""); });

  const REPLY = 0.002;
  const FIRST_FOOD = 0.1;
  const SCALE_MAX = 0.12; // top of the food ruler
  const fmtFood = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(3));
  const fmtInt = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"));
  const BAR = 0.0475; // a full food bar (one Dream swirl of food), as in contract/src/state.rs
  const moodOf = (v) => (v >= BAR * 0.8 ? "full" : v >= BAR * 0.3 ? "content" : v >= BAR * 0.1 ? "hungry" : v >= REPLY ? "starving" : "asleep");
  const repliesIn = (food) => Math.max(0, Math.floor(food / REPLY + 1e-9));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- shapes ---------------- */
  const circle = (cx, cy, r) => `M${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  // her real body outline, from the on-chain art (viewBox -20 -30 240 250), placed where the art image sits
  const artToStage = (x, y) => [50 + (x + 20) * 1.25, 27.5 + (y + 30) * 1.25];
  const SHAPES = [
    { tag: "a seed, one of 4,000", d: "M200 168 C 226 194, 246 236, 244 270 C 242 299, 223 318, 200 318 C 177 318, 158 299, 156 270 C 154 236, 174 194, 200 168 Z" },
    { tag: "the egg, 1 NEAR", d: "M200 92 C 260 92, 292 186, 292 238 C 292 294, 252 326, 200 326 C 148 326, 108 294, 108 238 C 108 186, 140 92, 200 92 Z" },
    { tag: "a Mind", d: "M100 38 C 148 38, 174 76, 174 120 C 174 162, 144 186, 100 186 C 56 186, 26 162, 26 120 C 26 76, 52 38, 100 38 Z", tf: artToStage },
    { tag: "each notch is one reply", d: circle(200, 206, 104) },
    { tag: "asleep, under 0.002", d: "M168 214 C 218 202, 276 220, 302 254 C 320 280, 300 310, 252 310 L 148 310 C 106 310, 90 290, 96 262 C 102 236, 128 222, 168 214 Z" },
    { tag: "a ghost", d: "M200 96 C 252 96, 280 138, 280 192 C 280 236, 286 272, 294 302 C 278 312, 264 296, 249 305 C 233 315, 220 297, 204 307 C 186 317, 174 297, 158 305 C 142 313, 126 301, 110 305 C 118 274, 120 236, 120 192 C 120 138, 148 96, 200 96 Z" },
    { tag: "hungry minds", d: circle(200, 206, 111.5) },
  ];
  const N = 144;
  const probeSvg = document.createElementNS(SVGNS, "svg");
  probeSvg.setAttribute("width", "0");
  probeSvg.setAttribute("height", "0");
  probeSvg.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  const probe = document.createElementNS(SVGNS, "path");
  probeSvg.appendChild(probe);
  document.body.appendChild(probeSvg);

  function sample(shape) {
    probe.setAttribute("d", shape.d);
    const L = probe.getTotalLength();
    let pts = [];
    for (let k = 0; k < N; k++) {
      const q = probe.getPointAtLength((L * k) / N);
      pts.push(shape.tf ? shape.tf(q.x, q.y) : [q.x, q.y]);
    }
    let a = 0;
    for (let k = 0; k < N; k++) { const p = pts[k], q = pts[(k + 1) % N]; a += p[0] * q[1] - q[0] * p[1]; }
    if (a < 0) pts.reverse();
    return pts;
  }
  const centroid = (p) => { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; };
  // rotate the point order of `cur` so it lines up with `prev` (no twisting during the morph)
  function align(prev, cur) {
    const cp = centroid(prev), cc = centroid(cur);
    let best = 0, bestD = Infinity;
    for (let s = 0; s < N; s++) {
      let d = 0;
      for (let k = 0; k < N; k += 3) {
        const a = prev[k], b = cur[(k + s) % N];
        const dx = a[0] - cp[0] - (b[0] - cc[0]), dy = a[1] - cp[1] - (b[1] - cc[1]);
        d += dx * dx + dy * dy;
      }
      if (d < bestD) { bestD = d; best = s; }
    }
    return cur.map((_, k) => cur[(k + best) % N]);
  }
  const P = [];
  SHAPES.forEach((s, i) => { const pts = sample(s); P.push(i === 0 ? pts : align(P[i - 1], pts)); });

  function toPath(p) {
    const n = p.length;
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 0; i < n; i++) {
      const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
      d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d + "Z";
  }
  function shapeAt(t) {
    const i = Math.min(SHAPES.length - 2, Math.floor(t));
    const u = clamp(t - i);
    const A = P[i], B = P[i + 1];
    const out = new Array(N);
    for (let k = 0; k < N; k++) out[k] = [lerp(A[k][0], B[k][0], u), lerp(A[k][1], B[k][1], u)];
    // a small breath outward mid morph, so it reads as one soft body changing, not two outlines blending
    const bulge = Math.sin(Math.PI * u) * 0.035;
    if (bulge > 0.0005) {
      const c = centroid(out);
      for (const q of out) { q[0] += (q[0] - c[0]) * bulge; q[1] += (q[1] - c[1]) * bulge; }
    }
    return out;
  }

  /* ---------------- stage elements ---------------- */
  const el = {
    formG: $("#formG"), fill: $("#formFill"), bone: $("#formBone"), hatch: $("#formHatch"), line: $("#formLine"),
    seam: $("#seam"), artShade: $("#artShade"), sleepZ: $("#sleepZ"), fadeStop: $("#fadeStop"), crack: $("#crack"), art: $("#art"), coin: $("#coin"), notches: $("#notches"),
    sleepEyes: $("#sleepEyes"), ghostEyes: $("#ghostEyes"), logo: $("#logoImg"),
    ring: $("#ring"), arcFood: $("#arcFood"), arcRes: $("#arcReserve"), arcTre: $("#arcTreasury"),
    floor: $("#floor"), lightGrad: $("#lightGrad"), embroidery: $("#embroidery"),
    poolWarm: $("#poolWarm"), poolCold: $("#poolCold"), ruler: $("#ruler"), mark: $("#mark"), markVal: $("#markVal"), tag: $("#tag"),
    roReplies: $("#roReplies"), coinNum: $("#coinNum"), roFood: $("#roFood"), roMood: $("#roMood"),
  };

  // 50 notches on the coin rim: one per reply her first 0.10 NEAR can pay for
  const NOTCHES = 50;
  const notchEls = [];
  for (let k = 0; k < NOTCHES; k++) {
    const a = (k / NOTCHES) * Math.PI * 2 - Math.PI / 2;
    const l = document.createElementNS(SVGNS, "line");
    l.setAttribute("x1", (200 + Math.cos(a) * 113).toFixed(2));
    l.setAttribute("y1", (206 + Math.sin(a) * 113).toFixed(2));
    l.setAttribute("x2", (200 + Math.cos(a) * 123).toFixed(2));
    l.setAttribute("y2", (206 + Math.sin(a) * 123).toFixed(2));
    l.style.stroke = "var(--gold-bright)";
    l.setAttribute("stroke-width", "2");
    l.setAttribute("stroke-linecap", "round");
    el.notches.appendChild(l);
    notchEls.push(l);
  }

  // ring arcs for the 1 NEAR split (circumference of r=156)
  const RC = 2 * Math.PI * 156;
  const GAP = 5;
  const arcs = [
    { el: el.arcTre, start: 0.35, len: 0.65 },
    { el: el.arcRes, start: 0.1, len: 0.25 },
    { el: el.arcFood, start: 0, len: 0.1 },
  ];

  /* ---------------- embroidery: gold thread ferns, a vine and moss knots ---------------- */
  (function embroider() {
    let seed = 20261108;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = el.embroidery;
    const add = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); g.appendChild(n); return n; };
    const LEAF = "M0 0 C 5 -6, 15 -7, 22 0 C 15 7, 5 6, 0 0 Z";
    function stem(x0, y0, x1, y1, bend, n, size, mode) {
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
      const cx = (x0 + x1) / 2 + nx * bend, cy = (y0 + y1) / 2 + ny * bend;
      add("path", { d: `M${x0} ${y0} Q ${cx} ${cy} ${x1} ${y1}`, class: "stitch" });
      for (let k = 1; k <= n; k++) {
        const s = k / (n + 1);
        const px = (1 - s) * (1 - s) * x0 + 2 * (1 - s) * s * cx + s * s * x1;
        const py = (1 - s) * (1 - s) * y0 + 2 * (1 - s) * s * cy + s * s * y1;
        const tx = 2 * (1 - s) * (cx - x0) + 2 * s * (x1 - cx);
        const ty = 2 * (1 - s) * (cy - y0) + 2 * s * (y1 - cy);
        const ang = (Math.atan2(ty, tx) * 180) / Math.PI;
        const sz = size * (1 - s * 0.55);
        const sides = mode === "vine" ? [k % 2 ? 1 : -1] : [-1, 1];
        for (const side of sides) {
          const tr = `translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${(ang + side * 56).toFixed(1)}) scale(${sz.toFixed(2)})`;
          add("path", { d: LEAF, transform: tr, class: "stitch", "vector-effect": "non-scaling-stroke" });
          add("path", { d: "M3 0 L 18 0", transform: tr, class: "stitch-fine", "vector-effect": "non-scaling-stroke" });
        }
      }
    }
    stem(54, 372, -34, 120, 46, 10, 1.25, "fern");
    stem(104, 360, 70, 212, 22, 6, 0.85, "fern");
    stem(352, 372, 444, 108, -54, 9, 1.15, "vine");
    stem(306, 362, 338, 236, -18, 4, 0.75, "vine");
    // two curled tendrils
    add("path", { d: "M430 150 C 470 130, 476 96, 452 86 C 434 80, 424 96, 436 104", class: "stitch" });
    add("path", { d: "M-20 170 C -58 156, -66 124, -44 112 C -28 104, -16 118, -28 128", class: "stitch" });
    // moss: french knots under her
    for (let k = 0; k < 170; k++) {
      const u = rnd() * 2 - 1;
      const x = 200 + u * 190 * (0.35 + 0.65 * rnd());
      const y = 328 + (rnd() - 0.5) * 24 * (1 - Math.abs(u) * 0.5) + Math.abs(u) * 12;
      add("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: (0.9 + rnd() * 1.7).toFixed(2), class: "knot", opacity: (0.45 + rnd() * 0.55).toFixed(2) });
    }
  })();

  /* ---------------- live data ---------------- */
  const live = { status: "static", data: null, mind: null }; // the numbers follow the story, nothing is read from the chain
  let mindFood = FIRST_FOOD; // her food at the Mind scene: live balance once read

  const decodeSvg = (uri) => {
    const i = uri.indexOf(",");
    const meta = uri.slice(0, i), body = uri.slice(i + 1);
    if (meta.includes("base64")) { const bin = atob(body); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); return new TextDecoder().decode(bytes); }
    return decodeURIComponent(body);
  };
  // the art comes with a pastel tile behind her; on velvet she stands without it
  const cleanArt = (svg) => svg.replace(/<rect x="-20" y="-30" width="240" height="250"[^>]*\/>/, "").replace(/<ellipse cx="100" cy="198"[^>]*\/>/, "");
  const svgUri = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const setArt = (uri) => { el.art.setAttribute("href", uri); };

  // the Mind that hatches out of the egg: a blue one, drawn by the same code as the contract
  fetch("/kit/minds/hatch-blue.svg").then((r) => r.text()).then((t) => setArt(svgUri(cleanArt(t)))).catch(() => {});

  // The plate shows her whole, hat to feet: the art is inlined and fitted to its own outline.
  function plate(host, file) {
    fetch(file).then((r) => r.text()).then((t) => {
      host.innerHTML = cleanArt(t).replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid meet" role="img" aria-label="A Mind picture drawn by the contract"><g class="fit">').replace(/<\/svg>\s*$/, "</g></svg>");
      const svg = host.querySelector("svg"), g = host.querySelector(".fit");
      if (!svg || !g) return;
      const b = g.getBBox(), pad = 10;
      if (b.width && b.height) svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`);
    }).catch(() => {});
  }
  plate($("#plateSleep"), "/kit/minds/qa-4-uiqa2.svg");
  plate($("#plateGhost"), "/kit/minds/qa-8-sleepy.svg");

  function countTo(node, to, fmt, ms = 1100) {
    if (!node) return;
    if (reduce || to == null || !isFinite(to)) { node.textContent = fmt(to); return; }
    const from = 0, t0 = performance.now();
    const step = (now) => { const u = clamp((now - t0) / ms); node.textContent = fmt(lerp(from, to, easeOut(u))); if (u < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function liveLine(id, html) { const n = $(id); if (n) n.innerHTML = `<i class="notch"></i><span>${html}</span>`; }

  function pickMind(minds) {
    if (!minds || !minds.length) return null;
    const alive = minds.filter((m) => !m.ghost && m.state !== "ghost");
    const pool = alive.length ? alive : minds;
    return pool.slice().sort((a, b) => (b.thoughts || 0) - (a.thoughts || 0))[0];
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);


  function renderMinds(d) {
    const ul = $("#minds");
    if (!d.minds.length) { ul.innerHTML = `<li class="minds-note">No Mind has hatched yet</li>`; return; }
    const ticks = [0.01, 0.03, 0.08].map((v) => `<b style="left:${((v / FIRST_FOOD) * 100).toFixed(1)}%"></b>`).join("");
    ul.innerHTML = d.minds.map((m) => {
      const ghost = m.ghost || m.state === "ghost";
      const art = m.svg ? (() => { try { return svgUri(cleanArt(decodeSvg(m.svg))); } catch (e) { return ""; } })() : "";
      const w = ghost ? 0 : clamp(m.balance / FIRST_FOOD) * 100;
      return `<li class="mind-row">
        <span class="well">${art ? `<img src="${art}" alt="${esc(m.name)}, her picture from the contract">` : ""}</span>
        <span><span class="mr-name">${esc(m.name)}</span>
          <span class="mr-sub">${ghost ? "a ghost" : esc(m.state)} · ${fmtInt(m.thoughts)} ${m.thoughts === 1 ? "thought" : "thoughts"}</span>
          <span class="foodbar" aria-hidden="true"><i style="--w:${w.toFixed(1)}%"></i>${ticks}</span></span>
        <span class="mr-food"><span class="num">${ghost ? "—" : fmtFood(m.balance)}</span><small>NEAR of food</small></span>
      </li>`;
    }).join("");
  }

  /* ---------------- chapter reveals ---------------- */
  const chapters = $$(".ch");
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) e.target.classList.add("in"); }, { threshold: 0.18 });
  chapters.forEach((c) => io.observe(c));
  chapters[0].classList.add("in");

  /* ---------------- scroll model ---------------- */
  let tops = [], focusFrac = 0.5, phone = false;
  function measure() {
    phone = innerWidth <= 760;
    focusFrac = phone ? 0.66 : 0.5;
    chapters.forEach((c) => { const n = c.querySelector(".ch-inner"); if (n) n.style.setProperty("--h", n.offsetHeight + "px"); });
    tops = chapters.map((c) => c.getBoundingClientRect().top + scrollY);
    const last = chapters[chapters.length - 1];
    tops.push(last.getBoundingClientRect().bottom + scrollY);
    dirty = true;
  }
  function targets() {
    const focus = scrollY + innerHeight * focusFrac;
    let i = 0;
    while (i < chapters.length - 1 && focus >= tops[i + 1]) i++;
    const f = clamp((focus - tops[i]) / (tops[i + 1] - tops[i]));
    let t = i < chapters.length - 1 ? i + smooth(clamp((f - 0.62) / 0.38)) : i;
    const inner = clamp((f - 0.04) / 0.52);
    return {
      t,
      pe: i < 1 ? 0 : i === 1 ? inner : 1,
      pc: i < 3 ? 0 : i === 3 ? clamp(inner * 1.1) : 1,
    };
  }

  /* ---------------- render ---------------- */
  const cur = { t: 0, pe: 0, pc: 0 };
  let intro = reduce ? 1 : 0;
  const introStart = performance.now() + 250;
  let dirty = true;
  let lastTxt = { mark: "", tag: "", ro: "" };
  let GOLD = [243, 211, 140], BONE = [222, 219, 206];
  const readPal = () => { GOLD = tok('--goldhi-rgb').split(',').map(Number); BONE = tok('--bone-rgb').split(',').map(Number); dirty = true; };
  window.addEventListener('palette', () => setTimeout(readPal, 0));
  setTimeout(readPal, 0);
  const mix = (a, b, u) => `rgb(${a.map((v, k) => Math.round(lerp(v, b[k], u))).join(",")})`;

  function render() {
    const { t, pe, pc } = cur;
    const pts = shapeAt(t);
    const d = toPath(pts);
    el.fill.setAttribute("d", d);
    el.bone.setAttribute("d", d);
    el.hatch.setAttribute("d", d);
    el.line.setAttribute("d", d);

    const near = (k, w = 0.5) => smooth(clamp(1 - Math.abs(t - k) / w));
    const a = near(2, 0.46);                       // her picture
    const g = near(5, 0.78);                        // ghostliness
    const b = smooth(clamp((t - 5.42) / 0.5));      // badge

    // food along the story
    const R0 = repliesIn(mindFood);
    const spent = Math.round(pc * R0);
    const drained = Math.max(0, mindFood - spent * REPLY);
    let food;
    if (t <= 1) food = FIRST_FOOD * pe;
    else if (t <= 2) food = lerp(FIRST_FOOD * pe, mindFood, t - 1);
    else food = drained; // holds at her live balance until the coin chapter spends it
    const Lf = 0.16 + 0.84 * Math.sqrt(clamp(food / FIRST_FOOD));
    let L = t < 1 ? lerp(0.62, Lf, smooth(clamp(t))) : Lf;
    L = lerp(L, 0.1, g);
    L = lerp(L, 0.72, b);
    const iFill = clamp((intro - 0.25) / 0.75);
    const iLine = clamp(intro / 0.7);
    L *= easeOut(iFill);

    // light
    el.poolWarm.style.opacity = (L * (1 - g * 0.85)).toFixed(3);
    el.poolWarm.style.transform = `translate(-50%,-50%) scale(${(0.72 + 0.36 * L).toFixed(3)})`;
    el.poolCold.style.opacity = (g * 0.95 * iFill).toFixed(3);
    el.lightGrad.setAttribute("r", (70 + 250 * L).toFixed(1));
    el.floor.setAttribute("opacity", (L * (1 - a * 0.4)).toFixed(3));

    // the shape
    const solid = (1 - a) * (1 - g) * (1 - b);
    el.fill.setAttribute("opacity", ((0.16 + 0.84 * L) * solid * iFill).toFixed(3));
    el.artShade.setAttribute("d", d);
    el.artShade.setAttribute("opacity", a.toFixed(3));
    el.hatch.setAttribute("opacity", (0.55 * solid * iFill).toFixed(3));
    el.bone.setAttribute("opacity", (g * 0.17).toFixed(3));
    el.line.setAttribute("stroke", mix(GOLD, BONE, g));
    el.line.setAttribute("stroke-opacity", (lerp(0.95, 0.4, a) * lerp(1, 0.75, g) * (1 - b)).toFixed(3));
    el.line.setAttribute("stroke-dashoffset", (1 - easeOut(iLine)).toFixed(4));
    el.formG.setAttribute("transform", `translate(0 ${(-16 * g).toFixed(2)})`);
    el.formG.setAttribute("opacity", (1 - 0.3 * g).toFixed(3));

    // accessories
    el.seam.setAttribute("opacity", (near(0, 0.4) * iFill).toFixed(3));
    const ringOp = near(1, 0.55);
    el.ring.setAttribute("opacity", ringOp.toFixed(3));
    for (const arc of arcs) {
      const len = Math.max(0, arc.len * RC * pe - GAP);
      arc.el.setAttribute("stroke-dasharray", `${len.toFixed(1)} ${RC.toFixed(1)}`);
      arc.el.setAttribute("stroke-dashoffset", (-arc.start * RC - GAP / 2).toFixed(1));
    }
    el.crack.setAttribute("stroke-dashoffset", (1 - clamp((pe - 0.55) / 0.4)).toFixed(4));
    el.crack.setAttribute("opacity", near(1, 0.45).toFixed(3));
    el.art.setAttribute("opacity", a.toFixed(3));
    el.coin.setAttribute("opacity", near(3, 0.45).toFixed(3));
    const leftNotches = Math.min(NOTCHES, R0 - spent);
    const capN = Math.min(NOTCHES, R0);
    for (let k = 0; k < NOTCHES; k++) {
      const o = k < leftNotches ? 1 : k < capN ? 0.24 : 0.06;
      if (notchEls[k]._o !== o) { notchEls[k].setAttribute("stroke-opacity", o); notchEls[k]._o = o; }
    }
    el.sleepEyes.setAttribute("opacity", near(4, 0.45).toFixed(3));
    el.sleepZ.setAttribute("opacity", (near(4, 0.4) * 0.85).toFixed(3));
    el.fadeStop.setAttribute("stop-opacity", (1 - 0.82 * g).toFixed(3));
    el.ghostEyes.setAttribute("opacity", near(5, 0.45).toFixed(3));
    el.logo.setAttribute("opacity", b.toFixed(3));

    // ruler
    const rv = smooth(clamp((t - 0.55) / 0.35)) * (1 - smooth(clamp((t - 4.4) / 0.45)));
    el.ruler.style.opacity = (rv * iFill).toFixed(3);
    el.mark.style.setProperty("--p", Math.sqrt(clamp(food / SCALE_MAX)).toFixed(4));
    const mv = fmtFood(food);
    if (mv !== lastTxt.mark) { el.markVal.textContent = mv; lastTxt.mark = mv; }

    // tag
    const ri = Math.round(t);
    const tagOp = clamp(1 - Math.abs(t - ri) / 0.28) * iFill;
    const tg = SHAPES[ri].tag;
    if (tg !== lastTxt.tag) { el.tag.textContent = tg; lastTxt.tag = tg; }
    el.tag.style.opacity = (tagOp * 0.9).toFixed(3);

    // reply readout in the text
    const ro = `${R0 - spent}|${fmtFood(t >= 2.5 ? drained : mindFood)}`;
    if (ro !== lastTxt.ro && (live.status !== "loading")) {
      const f2 = t >= 2.5 ? drained : mindFood;
      el.roReplies.textContent = fmtInt(R0 - (t >= 2.5 ? spent : 0));
      if (el.coinNum) el.coinNum.textContent = fmtInt(R0 - (t >= 2.5 ? spent : 0));
      el.roFood.textContent = fmtFood(f2);
      el.roMood.textContent = moodOf(f2);
      lastTxt.ro = ro;
    }
  }

  function frame(now) {
    if (!reduce && intro < 1) { intro = clamp((now - introStart) / 1800); dirty = true; }
    const tg = targets();
    if (reduce) {
      const snapped = Math.round(tg.t);
      if (snapped !== cur.t || tg.pe !== cur.pe || tg.pc !== cur.pc) { cur.t = snapped; cur.pe = tg.pe; cur.pc = tg.pc; dirty = true; }
    } else {
      const k = 0.11;
      for (const key of ["t", "pe", "pc"]) {
        const dv = tg[key] - cur[key];
        if (Math.abs(dv) > 0.0004) { cur[key] += dv * k; dirty = true; }
        else if (dv !== 0) { cur[key] = tg[key]; dirty = true; }
      }
    }
    if (dirty) { render(); dirty = false; }
    requestAnimationFrame(frame);
  }

  addEventListener("resize", measure);
  addEventListener("load", measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
  // start the story at whatever scroll the page opened at, without morphing through everything
  Object.assign(cur, targets());
  if (!reduce && cur.t > 0.5) intro = 1;
  requestAnimationFrame(frame);
})();
