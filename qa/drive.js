// Multi-step headless Chrome driver over CDP. Survives navigations and wallet redirects.
//   PROFILE=<dir> node drive.js <steps.js> [args...]
// steps.js exports async (b, args) => result, where b has:
//   goto(url), js(expr) -> value, until(expr, ms) -> value, click(text|selector), type(selector, text),
//   shot(path), url(), sleep(ms), log(...)
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const [, , stepsFile, ...args] = process.argv;
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${process.env.PROFILE || `${process.env.TEMP}/drive-prof-${port}`}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let list;
  for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(250); } }
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = {}; const logs = []; const bindings = {}; const targets = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
    if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") { const t = m.params.targetInfo; if (t.type === "page" && t.url && t.url !== "about:blank") targets.push(t.url); }
    if (m.method === "Runtime.bindingCalled" && bindings[m.params.name]) bindings[m.params.name](m.params.payload);
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning" || process.env.ALL_LOGS)) logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setDiscoverTargets", { discover: true });
  const W = +(process.env.W || 1440), H = +(process.env.H || 900);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
  const js = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const b = {
    sleep,
    log: (...a) => console.log(...a),
    logs: () => logs.splice(0),
    // run `source` in every new document before the page's own scripts (e.g. a mock wallet)
    init: (source) => send("Page.addScriptToEvaluateOnNewDocument", { source }),
    allLogs: () => logs.slice(),
    // URLs of every page/popup the browser opened or navigated to (incl. wallet popups)
    targets: () => targets.slice(),
    // a trusted mouse click (user gesture) on the element `expr` evaluates to, so popups open
    realClick: async (expr) => {
      const r = await js(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!r || r.__error) return "NOT FOUND";
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
      return "clicked";
    },
    // window[name](payload) in the page calls handler(payload) here (survives navigations)
    bind: async (name, handler) => { bindings[name] = handler; await send("Runtime.addBinding", { name }); },
    goto: async (url) => { await send("Page.navigate", { url }); await sleep(2500); },
    js,
    url: () => js("location.href"),
    until: async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await js(expr); if (v && !v.__error) return v; } catch {} await sleep(500); } return null; },
    // click the first visible button/link whose text matches (string = substring, RegExp source with /.../)
    click: (text) => js(`(() => { const re = ${JSON.stringify(text)}; const els = [...document.querySelectorAll('button, a, [role=button], .single-wallet, input[type=submit]')].filter(e => e.offsetParent !== null); const el = re.startsWith('/') ? els.find(e => new RegExp(re.slice(1, -1), 'i').test(e.textContent.trim())) : els.find(e => e.textContent.trim().includes(re)) ; if (!el) return 'NOT FOUND: ' + re; el.click(); return 'clicked: ' + el.textContent.trim().slice(0, 40); })()`),
    type: (sel, text) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NOT FOUND'; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed'; })()`),
    shot: async (p) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(p, Buffer.from(s.result.data, "base64")); },
    // the whole page as it lays out at the current viewport (no stretched viewport)
    shotFull: async (p) => {
      const m = await send("Page.getLayoutMetrics");
      const { width, height } = m.result.cssContentSize || m.result.contentSize;
      const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(height, 6000), scale: 1 } });
      fs.writeFileSync(p, Buffer.from(s.result.data, "base64"));
    },
    text: () => js("document.body.innerText.replace(/\\s+/g,' ')"),
  };
  let result;
  try {
    result = await require(path.resolve(stepsFile))(b, args);
  } catch (e) {
    result = "STEPS CRASHED: " + (e.stack || e);
  }
  console.log("RESULT:", typeof result === "string" ? result : JSON.stringify(result, null, 1));
  const l = logs.filter((x) => !/favicon|DevTools/.test(x));
  if (l.length) console.log("page errors:\n" + l.slice(0, 25).join("\n"));
  await send("Browser.close").catch(() => {});
  setTimeout(() => { try { chrome.kill(); } catch {} process.exit(0); }, 1500);
})();
