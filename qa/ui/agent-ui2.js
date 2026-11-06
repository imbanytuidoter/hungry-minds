// Official agents + categories + input forms + Navigator through the real site (QA build on :3001).
//   node drive.js agent-ui2.js keeper bob-q1103.testnet   connect Burrow Risk Guard to UiQa2, publish its skill
//   node drive.js agent-ui2.js buyer alice-q1103.testnet  ask the Navigator, order through the form, get the result
const os = require("os");
const SITE = "http://localhost:3001/app";
const C = "hm-qa-q1103b.testnet";
const RPC = "https://near-testnet.drpc.org";
const MIND = 4;
const SKILL = "Liquidation check (Burrow)";
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

module.exports = async (b, [role, account]) => {
  const out = [];
  const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 160) : ""}`);
  const k = require(`${os.homedir()}/.near-credentials/testnet/${account}.json`);
  await b.goto(SITE);
  await b.js(`localStorage.setItem("hm-burner", JSON.stringify({ accountId: ${JSON.stringify(account)}, key: ${JSON.stringify(k.private_key)} })); "ok"`);
  await b.goto(SITE);
  await b.js("window.confirm = () => true");
  ok(!!(await b.until(`document.body.innerText.includes(${JSON.stringify(account)})`, 30000)), "site loads signed in", account);

  if (role === "keeper") {
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^Developer panel$/")));
    await b.until(`document.body.innerText.includes("Agent")`, 15000);
    if (await b.until(`[...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("button")].some(x => x.textContent.trim() === "Disconnect")`, 8000)) {
      out.push("  " + (await b.js(`(() => { const row = document.querySelector('[data-mind="${MIND}"]'); const x = row && [...row.querySelectorAll("button")].find(x => x.textContent.trim() === "Disconnect"); if (!x) return "NO DISCONNECT"; x.click(); return "clicked Disconnect in her row"; })()`)));
      let a = 1;
      for (let i = 0; i < 30 && a; i++) { await b.sleep(1500); a = await view("agent_of", { mind_id: MIND }); }
      ok(!a, "Disconnect unplugs the old agent");
    }
    ok(!!(await b.until(`(document.querySelector('[data-mind="${MIND}"]') || document.body).innerText.includes("Burrow Risk Guard") && (document.querySelector('[data-mind="${MIND}"]') || document.body).innerText.includes("Polymarket Pulse")`, 20000)), "Connect opens on the Official agents list");
    const mindName = (await view("get_mind", { id: MIND })).name;
    await b.until(`[...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("button")].some(x => x.textContent.trim() === "Connect to ${mindName}" && x.closest("div").innerText.startsWith("Burrow Risk Guard"))`, 30000);
    out.push("  " + (await b.js(`(() => { const btn = [...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("button")].find(x => x.textContent.trim() === "Connect to ${mindName}" && x.closest("div").innerText.startsWith("Burrow Risk Guard")); if (!btn) return "NO BUTTON"; btn.click(); return "clicked " + btn.textContent.trim(); })()`)));
    let a = null;
    for (let i = 0; i < 40 && !a; i++) { await b.sleep(1500); a = await view("agent_of", { mind_id: MIND }); }
    ok(a?.account === "hm-worker-19652a.testnet" && /official agent/.test(a.about), "one click + one approval: the official agent is her agent on chain", a?.about);
    ok(!!(await b.until(`(document.querySelector('[data-mind="${MIND}"]') || document.body).innerText.includes(${JSON.stringify(SKILL)})`, 30000)), "its skill shows, ready to publish");
    const existing = (await view("services_for_mind", { mind_id: MIND })).find((x) => x.title === SKILL);
    let svc = existing;
    if (existing) {
      ok(!!(await b.until(`[...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("span")].some(x => x.textContent.trim() === "Published" && x.parentElement.innerText.startsWith(${JSON.stringify(SKILL)}))`, 10000)), "the skill shows as already published");
    } else {
      const cat = await b.js(`(() => { const btn = [...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("button")].find(x => x.textContent.trim() === "Publish" && x.parentElement.innerText.startsWith(${JSON.stringify(SKILL)})); const sel = btn && btn.parentElement.querySelector('select[aria-label="Category"]'); return sel ? sel.options[sel.selectedIndex].text : null; })()`);
      ok(cat === "Risk alerts", "the skill's category is preselected", cat);
      out.push("  " + (await b.js(`(() => { const btn = [...(document.querySelector('[data-mind="${MIND}"]') || document).querySelectorAll("button")].find(x => x.textContent.trim() === "Publish" && x.parentElement.innerText.startsWith(${JSON.stringify(SKILL)})); if (!btn) return "NO PUBLISH"; btn.click(); return "clicked Publish"; })()`)));
      for (let i = 0; i < 40 && !svc; i++) { await b.sleep(1500); svc = (await view("services_for_mind", { mind_id: MIND })).find((x) => x.title === SKILL); }
    }
    ok(!!svc && svc.category === 5, "published on chain in Risk alerts", svc && `service ${svc.id}, category ${svc.category}`);
    if (svc) {
      const [schema] = await view("input_schemas", { ids: [svc.id] });
      ok(!!schema && JSON.parse(schema).required?.includes("account"), "with its input form stored on chain", schema);
    }
    await b.shot(process.env.SHOT_DIR + "/official-1-keeper.png");
    return out;
  }

  if (role === "buyer") {
    out.push("  " + (await b.click("/^Shop$/")));
    ok(!!(await b.until(`document.body.innerText.includes("Prediction markets") && document.body.innerText.includes("Risk alerts") && document.body.innerText.includes("Whales & wallets")`, 20000)), "the shop has the agent-market categories");
    ok(!!(await b.until(`document.body.innerText.includes("Navigator")`, 5000)), "the Navigator is on the marketplace");
    out.push("  " + (await b.type('input[aria-label="What do you need"]', "is tmp-owner.main.burrow.near close to liquidation on Burrow?")));
    out.push("  " + (await b.click("/^Find$/")));
    const sug = await b.until(`(() => { const btn = [...document.querySelectorAll("button")].find(x => /^Order · /.test(x.textContent.trim())); return btn ? btn.closest("div").innerText : null; })()`, 120000);
    ok(!!sug && sug.includes(SKILL), "the Navigator suggests the liquidation check", sug && sug.replace(/\s+/g, " "));
    ok(!!sug && sug.includes("tmp-owner.main.burrow.near"), "with the account filled in");
    await b.shot(process.env.SHOT_DIR + "/official-2-navigator.png");
    out.push("  " + (await b.click("/^Order · /")));
    const filled = await b.until(`document.querySelector('input[aria-label="account"]')?.value`, 15000);
    ok(filled === "tmp-owner.main.burrow.near", "the order opens as a form, prefilled", filled);
    const before = (await view("jobs_of", { account_id: account }))[0]?.id ?? -1;
    out.push("  " + (await b.click("/^Send · /")));
    let j = null;
    for (let i = 0; i < 30 && !j; i++) { await b.sleep(1500); const x = (await view("jobs_of", { account_id: account }))[0]; if (x && x.id !== before) j = x; }
    ok(!!j && j.input === '{"account":"tmp-owner.main.burrow.near"}', "the job is placed with JSON input", j?.input);
    let d = j;
    for (let i = 0; i < 60 && (!d || d.status === "Open"); i++) { await b.sleep(2000); d = (await view("get_job", { job_id: j.id })) || d; }
    ok(d?.status === "Delivered" && /Health factor: [0-9.]+%/.test(d.result || ""), "delivered with the real health factor", (d?.result || "").split("\n").slice(0, 3).join(" | "));
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^My orders/")));
    ok(!!(await b.until(`[...document.querySelectorAll("button")].some(x => /health-factor\\.json/.test(x.textContent))`, 30000)), "My orders offers the structured result (JSON) to download");
    await b.shot(process.env.SHOT_DIR + "/official-3-result.png");
    return out;
  }
  return ["unknown role " + role];
};
