// The agent gateway through the real site (QA build on :3001), checking the chain as it goes.
//   node drive.js agent-ui.js keeper bob-q1103.testnet   connect an A2A agent by URL, see skills, test it
//   node drive.js agent-ui.js buyer alice-q1103.testnet  order in Agents, answer the agent, get a file
const os = require("os");
const SITE = "http://localhost:3001/app";
const C = "hm-qa-q1103b.testnet";
const RPC = "https://near-testnet.drpc.org";
const MIND = 4;
const view = async (method, args = {}) => {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: C, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) })).json();
      if (r.result?.result) return JSON.parse(Buffer.from(r.result.result).toString());
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("view failed " + method);
};
// The element (inside the Developer panel row of Mind `name`) that contains `inner`.
const inMindRow = (name, js) => `(() => { const rows = [...document.querySelectorAll("div")].filter(d => d.querySelector(":scope > div > div > span") && d.innerText.startsWith(${JSON.stringify(name)})); const row = rows.sort((a, b) => a.innerText.length - b.innerText.length)[0]; if (!row) return "NO ROW"; ${js} })()`;

module.exports = async (b, [role, account]) => {
  const out = [];
  const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 150) : ""}`);
  const k = require(`${os.homedir()}/.near-credentials/testnet/${account}.json`);
  await b.goto(SITE);
  await b.js(`localStorage.setItem("hm-burner", JSON.stringify({ accountId: ${JSON.stringify(account)}, key: ${JSON.stringify(k.private_key)} })); "ok"`);
  await b.goto(SITE);
  await b.js("window.confirm = () => true");
  ok(!!(await b.until(`document.body.innerText.includes(${JSON.stringify(account)})`, 30000)), "site loads signed in", account);
  const mindName = (await view("get_mind", { id: MIND })).name;

  if (role === "keeper") {
    // the panel works on her active Mind: an earlier suite may have hatched a newer one and
    // made it active, so pick Mind 4 first
    await b.until(`!!document.querySelector('select[aria-label="Switch Mind"] option[value="${MIND}"]')`, 20000);
    out.push("  " + (await b.js(`(() => { const s = document.querySelector('select[aria-label="Switch Mind"]'); if (!s) return "no Mind switch"; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "${MIND}"); s.dispatchEvent(new Event("change", { bubbles: true })); return "picked Mind " + s.value; })()`)));
    await b.sleep(800);
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^Developer panel$/")));
    await b.until(`document.body.innerText.includes("Agent")`, 15000);
    // The panel has an agent box for each of her keeper's Minds (an earlier suite hatches more),
    // so every click and field below is looked up inside Mind 4's own row.
    const ROW = `document.querySelector('[data-mind="${MIND}"]')`;
    const inRow = (js) => b.js(`(() => { const row = ${ROW}; if (!row) return "NO ROW for Mind ${MIND}"; ${js} })()`);
    const rowHas = (label) => `(() => { const row = ${ROW}; return !!row && [...row.querySelectorAll("button")].some(x => x.textContent.trim() === ${JSON.stringify(label)}); })()`;
    const rowClick = (label) => inRow(`const x = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!x) return "NOT FOUND in row: ${label}"; x.click(); return "clicked in row: ${label}";`);
    const rowType = (aria, text) => inRow(`const el = row.querySelector('input[aria-label="${aria}"]'); if (!el) return "NOT FOUND in row: ${aria}"; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); return "typed in row";`);
    // start clean: disconnect whatever is connected to her
    if (await b.until(rowHas("Disconnect"), 8000)) {
      out.push("  " + (await rowClick("Disconnect")));
      let a = 1;
      for (let i = 0; i < 30 && a; i++) { await b.sleep(1500); a = await view("agent_of", { mind_id: MIND }); }
      ok(!a, "Disconnect unplugs the agent on chain");
    }
    await b.until(rowHas("A2A agent"), 20000);
    out.push("  " + (await rowClick("A2A agent")));
    await b.sleep(300);
    out.push("  " + (await rowType("Agent URL", "http://127.0.0.1:9911")));
    out.push("  " + (await rowType("API key", "test-secret")));
    await b.sleep(300);
    out.push("  " + (await rowClick("Connect")));
    let a = null;
    for (let i = 0; i < 40 && !a; i++) { await b.sleep(1500); a = await view("agent_of", { mind_id: MIND }); }
    ok(a?.account === "hm-worker-19652a.testnet", "Connect: the gateway checks the agent, then one approval makes it her agent on chain", a?.about);
    ok(!!(await b.until(`document.body.innerText.includes("Near Lookup Agent") && document.body.innerText.includes("Account CSV report")`, 30000)), "the agent's card and skills show in the panel");
    ok(!!(await b.until(`document.body.innerText.includes("online")`, 10000)), "it shows online");
    out.push("  " + (await rowType("Test request", "check alice.testnet")));
    out.push("  " + (await rowClick("Run")));
    const t = await b.until(`(document.body.innerText.match(/alice\\.testnet: [0-9.]+ NEAR[^\\n]*/) || [])[0]`, 60000);
    ok(!!t, "Try it runs the real agent for free", t);
    await b.shot(process.env.SHOT_DIR + "/agent-1-panel.png");
    out.push("  " + (await b.click("/^Marketplace$/")));
    ok(!!(await b.until(`document.body.innerText.includes("online · Near Lookup Agent")`, 15000)), "the marketplace shows the agent and that it's online");
    await b.shot(process.env.SHOT_DIR + "/agent-2-market.png");
    return out;
  }

  if (role === "buyer") {
    const lookup = (await view("services_for_mind", { mind_id: MIND })).find((s) => s.title === "NEAR account lookup");
    const report = (await view("services_for_mind", { mind_id: MIND })).find((s) => s.title === "Account CSV report");
    out.push("  " + (await b.click("/^Shop$/")));
    await b.until(`document.body.innerText.includes("NEAR account lookup")`, 20000);
    const order = async (title, text) => {
      out.push("  " + (await b.js(`(() => { const card = (x) => { let e = x; while (e.parentElement && [...e.parentElement.querySelectorAll("button")].filter(y => /Try this/.test(y.textContent)).length === 1) e = e.parentElement; return e; }; const btn = [...document.querySelectorAll("button")].find(x => /Try this/.test(x.textContent) && card(x).innerText.includes(${JSON.stringify(title)})); if (!btn) return "NO TRY BUTTON"; btn.click(); return "Try this: ${title}"; })()`)));
      await b.until(`!!document.querySelector('input[aria-label="Message"]')`, 15000);
      await b.type('input[aria-label="Message"]', text);
      await b.sleep(400);
      const before = (await view("jobs_of", { account_id: account }))[0]?.id ?? -1;
      out.push("  " + (await b.click("/^Send · /")));
      let j = null;
      for (let i = 0; i < 30; i++) { await b.sleep(1500); const x = (await view("jobs_of", { account_id: account }))[0]; if (x && x.id !== before) { j = x; break; } }
      return j;
    };
    ok(!!(await b.until(`document.body.innerText.includes("For agents")`, 5000)), "the agent-market categories show");
    const j1 = await order("NEAR account lookup", "check my account");
    ok(j1?.service_id === lookup.id, "ordering places a job", j1 && `job ${j1.id}`);
    ok(!!(await b.until(`document.body.innerText.includes("chats herself; tasks and orders go to her agent Near Lookup Agent")`, 5000)), "the chat says she chats herself and tasks go to her agent");
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^My orders/")));
    const q = await b.until(`(document.body.innerText.match(/The agent asks:[^\\n]*/) || [])[0]`, 90000);
    ok(!!q, "My orders shows the agent's question", q);
    out.push("  " + (await b.type('input[aria-label="Answer"]', "imbanana.testnet")));
    out.push("  " + (await b.click("/^Send$/")));
    let d1 = j1;
    // a load-balanced RPC node may not know a fresh job yet (null): keep waiting
    for (let i = 0; i < 60 && (!d1 || d1.status === "Open"); i++) { await b.sleep(2000); d1 = (await view("get_job", { job_id: j1.id })) || d1; }
    ok(d1?.status === "Delivered" && /imbanana\.testnet: [0-9.]+ NEAR/.test(d1.result), "after the answer the job is delivered", d1.result);
    await b.shot(process.env.SHOT_DIR + "/agent-3-asked.png");
    out.push("  " + (await b.click("/^Marketplace$/")));
    await b.sleep(800);
    const j2 = await order("Account CSV report", "report imbanana.testnet");
    let d2 = j2;
    for (let i = 0; i < 60 && (!d2 || d2.status === "Open"); i++) { await b.sleep(2000); d2 = (await view("get_job", { job_id: j2.id })) || d2; }
    ok(d2?.status === "Delivered" && /full result/.test(d2.result), "CSV job delivered (link + hash on chain)", d2?.result?.slice(-90));
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^My orders/")));
    ok(!!(await b.until(`[...document.querySelectorAll("button")].some(x => /imbanana\\.testnet\\.csv/.test(x.textContent))`, 30000)), "My orders shows the CSV file to download");
    ok(!!(await b.until(`document.body.innerText.includes("(the same hash is on chain)")`, 5000)), "and the result's SHA-256");
    await b.shot(process.env.SHOT_DIR + "/agent-4-file.png");
    return out;
  }
  return ["unknown role " + role];
};
