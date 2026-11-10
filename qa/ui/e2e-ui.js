// Drive the real site UI (QA build on :3001, QA contract) as one player, checking the chain
// after every action.  node drive.js e2e-ui.js <role> <account> [mindName]
//   roles: owner (hatch, feed, chat, publish a service, claim), guest, guestchat, agentjob,
//   sell (list for sale), buy (buy the listed Mind), sold (the seller's view after the sale)
const os = require("os");
const SITE = "http://localhost:3001/app";
const C = "hm-qa-q1103b.testnet";
const RPC = "https://near-testnet.drpc.org";
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
const N = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

module.exports = async (b, [role, account, name = "UiQa"]) => {
  const out = [];
  const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  const k = require(`${os.homedir()}/.near-credentials/testnet/${account}.json`);
  await b.goto(SITE);
  await b.js(`localStorage.setItem("hm-burner", JSON.stringify({ accountId: ${JSON.stringify(account)}, key: ${JSON.stringify(k.private_key)} })); "ok"`);
  await b.goto(SITE);
  await b.js("window.confirm = () => true");
  ok(!!(await b.until(`document.body.innerText.includes(${JSON.stringify(account)}) || document.body.innerText.includes("Make your own")`, 30000)), "site loads signed in", account);
  // every Mind, page by page: a snapshot holds at most 60, and each run hatches one more
  const rows = async () => {
    const all = [];
    for (let from = 0; ; from += 60) {
      const s = await view("colony_snapshot", { from_index: from, limit: 60 });
      all.push(...s.minds.map((r) => ({ id: r.id, ...r.mind })));
      if (!s.minds.length || from + 60 >= s.total_minds) return all;
    }
  };
  const snapMine = async () => (await rows()).filter((m) => m.owner === account);

  if (role === "owner") {
    // hatch (skipped when this keeper already has her)
    const existing = (await snapMine()).find((m) => m.name === name);
    if (!existing) {
    // a keeper who already has a Mind opens on Home: hatch another from Account
    if (!(await b.until(`!!document.querySelector('input[aria-label="Name"]')`, 8000))) {
      out.push("  " + (await b.click("/^Account$/")));
      await b.sleep(1000);
      out.push("  " + (await b.click("/^Hatch (another Mind|a Mind)/")));
    }
    await b.until(`!!document.querySelector('input[aria-label="Name"]')`, 20000);
    await b.type('input[aria-label="Name"]', name);
    await b.click("Cap");
    await b.click("Scarf");
    await b.sleep(400);
    out.push("  " + (await b.click(`Hatch ${name}`)));
    }
    const hatched = await b.until(`document.body.innerText.includes("Feed ${name}")`, 90000);
    let mine = await snapMine();
    for (let i = 0; i < 20 && !mine.some((m) => m.name === name); i++) { await b.sleep(1500); mine = await snapMine(); }
    const me = mine.find((m) => m.name === name);
    ok(!!hatched && !!me, "hatch through the UI mints her on chain", me ? `#${me.id} food ${N((await view("get_mind", { id: me.id })).balance)}` : (await b.text()).slice(0, 200));
    if (!me) return out;
    const look = await view("get_look", { id: me.id });
    ok(look.hat === 6 && look.outfit === 1, "the picked look is stored on chain", JSON.stringify(look));
    await b.shot(process.env.SHOT_DIR + "/ui-1-home.png");

    const f0 = BigInt((await view("get_mind", { id: me.id })).balance);
    // each food card says how much of her Food bar it fills (one Dream swirl of food, 0.0475 NEAR, is 100%)
    const gains = await b.js(`[...document.querySelectorAll('.hm-food-gain')].map(x => x.textContent.trim()).join(' | ')`);
    ok(gains === "+10% food | +50% food | +100% food", "food cards show how much each one fills her up", gains);
    const after = await b.js(`document.querySelector('.hm-feed-after')?.textContent.trim() || ''`);
    ok(/Food \d+% → \d+% · pays for ≈ 2 replies/.test(after), "the feed panel shows her food before and after this meal", after);
    out.push("  " + (await b.click(`Feed ${name}`)));
    let f1 = f0;
    for (let i = 0; i < 40 && f1 === f0; i++) { await b.sleep(1500); f1 = BigInt((await view("get_mind", { id: me.id })).balance); }
    // the default meal is one Pea pod (0.005 NEAR): 95% of it reaches her
    ok(Math.abs(N(f1 - f0) - 0.00475) < 0.00001, "Feed button: 0.005 NEAR -> +0.00475 food on chain", `+${N(f1 - f0)}`);

    // owner chat
    out.push("  " + (await b.click("/^Chat$/")));
    await b.until(`!!document.querySelector('input[aria-label="Message"]')`, 15000);
    const n0 = (await view("get_mind", { id: me.id })).thought_count;
    await b.type('input[aria-label="Message"]', "Hi! What do you like most?");
    out.push("  " + (await b.click("/^Send$/")));
    let m = await view("get_mind", { id: me.id });
    for (let i = 0; i < 80 && !(m.thought_count > n0 && m.last_reply); i++) { await b.sleep(2000); m = await view("get_mind", { id: me.id }); }
    const shown = m.last_reply && (await b.until(`document.body.innerText.includes(${JSON.stringify((m.last_reply || "").slice(0, 25))})`, 30000));
    ok(m.thought_count > n0 && !!m.last_reply, "owner chat: AI reply stored on chain", JSON.stringify((m.last_reply || "").slice(0, 70)));
    ok(!!shown, "the reply shows up in the chat on the site");
    await b.shot(process.env.SHOT_DIR + "/ui-2-chat.png");

    // publish a service
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(1500);
    out.push("  " + (await b.click("Developer panel")));
    await b.until(`!!document.querySelector('input[aria-label="Service name"]')`, 15000);
    // pick this Mind in the form (a keeper with several Minds gets a picker)
    out.push("  " + (await b.js(`(() => { const s = document.querySelector('select[aria-label="Mind"]'); if (!s) return 'no picker'; const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(name)})); if (!o) return 'no option'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return 'picked ' + o.textContent.trim(); })()`)));
    await b.sleep(400);
    // everything inside the "Publish a service" card (agent skill rows have their own Price + Publish)
    const form = `[...document.querySelectorAll(".card")].find(c => c.innerText.includes("Publish a service"))`;
    const fill = (sel, v) => b.js(`(() => { const root = ${form}; const el = root && root.querySelector(${JSON.stringify(sel)}); if (!el) return "NOT FOUND " + ${JSON.stringify(sel)}; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "typed"; })()`);
    out.push("  " + (await fill('input[aria-label="Service name"]', "UI joke")));
    out.push("  " + (await fill('textarea[aria-label="Description"]', "One short joke about anything.")));
    out.push("  " + (await fill('input[aria-label="Price"]', "0.03")));
    out.push("  " + (await fill('input[aria-label="Unit"]', "joke")));
    await b.sleep(400);
    out.push("  " + (await b.js(`(() => { const root = ${form}; const btn = root && [...root.querySelectorAll("button")].find(x => x.textContent.trim() === "Publish"); if (!btn) return "NO PUBLISH"; btn.click(); return "clicked Publish"; })()`)));
    let svc;
    for (let i = 0; i < 40 && !svc; i++) { await b.sleep(1500); svc = (await view("services_for_mind", { mind_id: me.id }).catch(() => [])).find((s) => s.title === "UI joke"); }
    ok(!!svc && N(svc.price) === 0.03, "Publish button: service stored on chain", svc ? `#${svc.id} ${N(svc.price)} NEAR` : "");
    await b.shot(process.env.SHOT_DIR + "/ui-3-publish.png");
    return out;
  }

  if (role === "guest") {
    const target = (await rows()).find((x) => x.name === name);
    const svc = (await view("services_for_mind", { mind_id: target.id })).find((s) => s.title === "UI joke");
    const before = await view("get_mind", { id: target.id });
    // order the service through the shop
    await b.until(`document.body.innerText.includes("Browse services") || document.body.innerText.includes("Shop")`, 20000);
    out.push("  " + (await b.click("/^Shop$/")));
    await b.until(`document.body.innerText.includes("UI joke")`, 20000);
    out.push("  " + (await b.js(`(() => { const card = (x) => { let e = x; while (e.parentElement && [...e.parentElement.querySelectorAll("button")].filter(y => /Try this/.test(y.textContent)).length === 1) e = e.parentElement; return e; }; const btn = [...document.querySelectorAll("button")].find(x => /Try this/.test(x.textContent) && card(x).innerText.includes("UI joke") && card(x).innerText.includes(${JSON.stringify(name)})); if (!btn) return "NO TRY BUTTON"; btn.click(); return "clicked Try this"; })()`)));
    await b.until(`!!document.querySelector('input[aria-label="Message"]')`, 15000);
    await b.type('input[aria-label="Message"]', "about cats");
    await b.sleep(400);
    out.push("  " + (await b.click("/^Send · /")));
    let m = before;
    // the payment sits in escrow until the reply lands: wait for the order to settle
    for (let i = 0; i < 150 && Number((await view("get_service", { service_id: svc.id })).orders) === Number(svc.orders); i++) await b.sleep(4000);
    await b.sleep(3000);
    m = await view("get_mind", { id: target.id });
    const s2 = await view("get_service", { service_id: svc.id });
    ok(m.thought_count > before.thought_count && !!m.last_reply, "guest order through the UI: AI answered on chain", JSON.stringify((m.last_reply || "").slice(0, 70)));
    ok(Math.abs(N(m.owner_unclaimed) - N(before.owner_unclaimed) - 0.027) < 0.0001, "NFT owner got 90 % of 0.03", `+${(N(m.owner_unclaimed) - N(before.owner_unclaimed)).toFixed(4)}`);
    ok(Number(s2.orders) === Number(svc.orders) + 1, "the order is counted on the service");
    await b.shot(process.env.SHOT_DIR + "/ui-4-guest.png");
    return out;
  }

  if (role === "guestchat") {
    // a guest talks to someone else's Mind: buy a credit pack once, then chat with no wallet
    const target = (await rows()).find((x) => x.name === name);
    // Account → "Visit other Minds" → her card, then Chat (the visit carries over to the Chat tab)
    out.push("  " + (await b.click("/^Account$/")));
    await b.until(`document.body.innerText.includes("Visit other Minds") && document.body.innerText.includes(${JSON.stringify(name)})`, 20000);
    out.push("  " + (await b.js(`(() => { const btn = [...document.querySelectorAll('button.lift')].find(x => x.innerText.split("\\n").some(l => l.trim() === ${JSON.stringify(name)})); if (!btn) return 'NO CARD'; btn.click(); return 'visited ' + ${JSON.stringify(name)}; })()`)));
    await b.sleep(1000);
    out.push("  " + (await b.click("/^Chat$/")));
    await b.until(`!!document.querySelector('input[aria-label="Message"]')`, 15000);
    ok(await b.until(`document.body.innerText.includes("Chat with ${name}")`, 5000), "guest opens chat with someone else's Mind");
    const c0 = N(await view("chat_credits_of", { account_id: account }));
    if (await b.until(`[...document.querySelectorAll('button')].some(x => /^10 messages/.test(x.textContent.trim()))`, 15000)) {
      out.push("  " + (await b.click("/^10 messages/")));
      let c = c0;
      for (let i = 0; i < 40 && c === c0; i++) { await b.sleep(1500); c = N(await view("chat_credits_of", { account_id: account })); }
      ok(Math.abs(c - c0 - 0.1) < 0.0001, "10-message pack: +0.1 NEAR chat credits on chain", `${c0} -> ${c}`);
    } else out.push("  (no pack offered, credits " + c0 + ")");
    const before = await view("get_mind", { id: target.id });
    const cBefore = N(await view("chat_credits_of", { account_id: account }));
    await b.type('input[aria-label="Message"]', "Hi, I'm a guest. Tell me a fun fact.");
    out.push("  " + (await b.click("/^Send$/")));
    const got = await b.until(`[...document.querySelectorAll('[aria-live] > div')].length >= 2 && !document.querySelector('.hm-dots')`, 120000);
    ok(!!got, "guest message answered without a wallet popup", (await b.text()).match(/messages? left/)?.[0] || "");
    // with a NEAR AI key in worker/.env the reply comes from the TEE model and carries its proof
    // (not on a --no-near-ai run: the QA worker then uses the free open model on purpose)
    const envFile = require("path").resolve(__dirname, "../../worker/.env");
    if (process.env.NEAR_AI !== "off" && require("fs").existsSync(envFile) && /^NEAR_AI_KEY=\S+/m.test(require("fs").readFileSync(envFile, "utf8"))) {
      const badge = await b.until(`(document.body.innerText.match(/Verified · NEAR AI TEE · [^\\n]+|NEAR AI · [^\\n]+ · unsigned/) || [null])[0]`, 15000);
      ok(/^Verified/.test(badge || ""), "the reply is signed by NEAR AI's TEE and shows Verified", badge || "no badge");
    }
    let m = before;
    for (let i = 0; i < 60 && m.thought_count === before.thought_count; i++) { await b.sleep(3000); m = await view("get_mind", { id: target.id }); }
    const cAfter = N(await view("chat_credits_of", { account_id: account }));
    ok(m.thought_count === before.thought_count + 1, "batch settled: her thought counted on chain", `${before.thought_count} -> ${m.thought_count}`);
    ok(Math.abs(cBefore - cAfter - 0.01) < 0.0001, "guest paid 0.01 from credits", `${cBefore} -> ${cAfter}`);
    ok(Math.abs(N(m.owner_unclaimed) - N(before.owner_unclaimed) - 0.009) < 0.0001, "NFT owner got 90 % of 0.01", `+${(N(m.owner_unclaimed) - N(before.owner_unclaimed)).toFixed(4)}`);
    await b.shot(process.env.SHOT_DIR + "/ui-4b-guestchat.png");
    return out;
  }

  if (role === "agentjob") {
    // order an agent-run service through the shop, see the result, rate it, close it
    const svc = (await view("services_for_mind", { mind_id: 4 })).find((s) => s.title === "Wallet check-up");
    out.push("  " + (await b.click("/^Shop$/")));
    await b.until(`document.body.innerText.includes("Wallet check-up")`, 20000);
    ok(await b.until(`document.body.innerText.includes("Own agent")`, 5000), "the shop marks an agent-run Mind 'Own agent'");
    out.push("  " + (await b.js(`(() => { const card = (x) => { let e = x; while (e.parentElement && [...e.parentElement.querySelectorAll("button")].filter(y => /Try this/.test(y.textContent)).length === 1) e = e.parentElement; return e; }; const btn = [...document.querySelectorAll("button")].find(x => /Try this/.test(x.textContent) && card(x).innerText.includes("Wallet check-up")); if (!btn) return "NO TRY BUTTON"; btn.click(); return "clicked Try this"; })()`)));
    await b.until(`!!document.querySelector('input[aria-label="Message"]')`, 15000);
    ok(await b.until(`document.body.innerText.includes("storage deposit")`, 5000), "the chat explains escrow, deadline and deposit");
    await b.type('input[aria-label="Message"]', "check bob-q1103.testnet please");
    await b.sleep(400);
    const jobs0 = (await view("jobs_of", { account_id: account })).length;
    out.push("  " + (await b.click("/^Send · /")));
    let mine = [];
    for (let i = 0; i < 30 && mine.length <= jobs0; i++) { await b.sleep(1500); mine = await view("jobs_of", { account_id: account }); }
    const job = mine[0];
    ok(!!job && job.service_id === svc.id, "Send places a job on chain", job ? `job ${job.id} ${job.status}` : "");
    const shown = await b.until(`document.body.innerText.includes("Wallet check-up for bob-q1103.testnet")`, 120000);
    ok(!!shown, "the agent's result shows up in the chat");
    await b.shot(process.env.SHOT_DIR + "/ui-6-agentjob.png");
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(800);
    out.push("  " + (await b.click("/^My orders/")));
    ok(await b.until(`document.body.innerText.includes("Delivered by alice-q1103b.testnet")`, 20000), "My orders shows it delivered by the agent");
    out.push("  " + (await b.js(`(() => { const s = document.querySelector('button[aria-label="5 stars"]'); if (!s) return 'NO STARS'; s.click(); return 'rated 5'; })()`)));
    let j = job;
    for (let i = 0; i < 30 && j.rating === 0; i++) { await b.sleep(1500); j = await view("get_job", { job_id: job.id }); }
    ok(j.rating === 5, "rating stored on chain", `${j.rating}★`);
    await b.shot(process.env.SHOT_DIR + "/ui-7-orders.png");
    out.push("  " + (await b.js(`(() => { const btn = [...document.querySelectorAll('button')].find(x => /^Close · get/.test(x.textContent.trim())); if (!btn) return 'NO CLOSE'; btn.click(); return 'clicked close'; })()`)));
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { await b.sleep(1500); gone = (await view("get_job", { job_id: job.id })) === null; }
    ok(gone, "Close deletes the job and returns the deposit");
    return out;
  }

  if (role === "sell") {
    const me = (await snapMine()).find((x) => x.name === name);
    out.push("  " + (await b.click("/^Shop$/")));
    await b.sleep(1500);
    out.push("  " + (await b.click("Developer panel")));
    await b.until(`[...document.querySelectorAll('button')].some(x => /^Claim /.test(x.textContent.trim()))`, 30000);
    const owed = N((await view("get_mind", { id: me.id })).owner_unclaimed);
    out.push("  " + (await b.js(`(() => { const btns = [...document.querySelectorAll("button")].filter(x => /^Claim /.test(x.textContent.trim())); const row = (x) => { let e = x; while (e.parentElement && [...e.parentElement.querySelectorAll("button")].filter(y => /^(Claim |Nothing to claim)/.test(y.textContent.trim())).length === 1) e = e.parentElement; return e; }; const btn = btns.find(x => row(x).innerText.includes(${JSON.stringify(name)})); if (!btn) return "NO CLAIM BUTTON"; btn.click(); return "clicked " + btn.textContent.trim(); })()`)));
    let u = owed;
    for (let i = 0; i < 30 && u > 0; i++) { await b.sleep(1500); u = N((await view("get_mind", { id: me.id })).owner_unclaimed); }
    ok(owed > 0 && u === 0, "Claim button pays the keeper", `claimed ${owed}`);
    // a keeper with several Minds has one sell row each: use the row that names this Mind
    out.push("  " + (await b.js(`(() => {
      const row = [...document.querySelectorAll('input[aria-label="Asking price"]')].map((inp) => { let e = inp; while (e.parentElement && e.parentElement.querySelectorAll('input[aria-label="Asking price"]').length === 1) e = e.parentElement; return [inp, e]; }).find(([, e]) => e.innerText.includes(${JSON.stringify(name)}));
      if (!row) return 'NO SELL ROW';
      const [inp, e] = row;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, '1');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'row ready';
    })()`)));
    // the Claim transaction keeps the panel busy for a moment: a click on a disabled button does nothing
    await b.until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'List for sale' && !x.disabled)`, 30000);
    await b.sleep(400);
    out.push("  " + (await b.js(`(() => { const inp = [...document.querySelectorAll('input[aria-label="Asking price"]')].find((i) => { let e = i; while (e.parentElement && e.parentElement.querySelectorAll('input[aria-label="Asking price"]').length === 1) e = e.parentElement; return e.innerText.includes(${JSON.stringify(name)}); }); const btn = inp && [...inp.parentElement.querySelectorAll('button')].find(x => x.textContent.trim() === 'List for sale'); if (!btn) return 'NO LIST BUTTON'; btn.click(); return 'clicked List for sale (' + inp.value + ')'; })()`)));
    let listed;
    for (let i = 0; i < 30 && !listed; i++) { await b.sleep(1500); listed = (await view("listings")).find((l) => l.id === me.id); }
    ok(!!listed && N(listed.price) === 1, "List for sale stores the listing on chain", listed ? `${N(listed.price)} NEAR` : "");
    return out;
  }

  if (role === "buy") {
    const target = (await rows()).find((x) => x.name === name);
    out.push("  " + (await b.click("/^Shop$/")));
    await b.until(`document.body.innerText.includes(${JSON.stringify(name)})`, 20000);
    // the listing shows her condition as the chain has it now
    const pct = Math.min(100, Math.round((N((await view("get_mind", { id: target.id })).balance) / 0.0475) * 100));
    await b.until(`[...document.querySelectorAll('.hm-condition')].some(x => x.closest('.card') && x.closest('.card').innerText.includes(${JSON.stringify(name)}))`, 20000);
    const cond = await b.js(`(() => { const c = [...document.querySelectorAll('.hm-condition')].find(x => x.closest('.card') && x.closest('.card').innerText.includes(${JSON.stringify(name)})); return c ? c.innerText.replace(/\\s+/g, ' ') : ''; })()`);
    ok(cond.includes(`food ${pct}%`) && /thoughts/.test(cond) && /(agent|no agent)/.test(cond), "the listing shows her state, food, agent and services", cond);
    out.push("  " + (await b.js(`(() => { const btn = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('Buy ·') && x.closest('div') && x.closest('div').parentElement.innerText.includes(${JSON.stringify(name)})); if (!btn) return 'NO BUY BUTTON'; btn.click(); return 'clicked ' + btn.textContent.trim(); })()`)));
    let owner = target.owner;
    for (let i = 0; i < 40 && owner !== account; i++) { await b.sleep(1500); owner = (await view("get_mind", { id: target.id })).owner; }
    ok(owner === account, "Buy button: the Mind and NFT move to the buyer", owner);
    ok(!(await view("listings")).some((l) => l.id === target.id), "listing cleared after the sale");
    await b.shot(process.env.SHOT_DIR + "/ui-5-bought.png");
    return out;
  }

  // the seller comes back after a real sale on chain (same browser profile as "sell", which
  // remembers the Minds it saw): the "has a new owner" card, then the two ways to a new Mind
  if (role === "sold") {
    const target = (await rows()).find((x) => x.name === name);
    ok(!!target && target.owner !== account, "the Mind belongs to the buyer now", target?.owner);
    const card = await b.until(`!!document.querySelector(".hm-sold")`, 40000);
    ok(!!card, "seller sees the sold card after the real sale");
    const text = card ? await b.js(`document.querySelector(".hm-sold").innerText`) : "";
    ok(text.includes(name) && text.includes(target?.owner || "?"), "card names the Mind and the new owner", text.replace(/\s+/g, " ").slice(0, 120));
    const opts = await b.js(`[...document.querySelectorAll(".hm-sold .hm-getmind-opt")].map(x => x.innerText.split("\\n")[0].trim())`);
    ok(JSON.stringify(opts) === JSON.stringify(["Hatch a new Mind", "Buy a grown Mind"]), "card offers hatch and buy", JSON.stringify(opts));
    await b.shot(process.env.SHOT_DIR + "/ui-6-sold.png");
    await b.js(`(() => { const o = document.querySelectorAll(".hm-sold .hm-getmind-opt")[1]; if (o) o.click(); return "ok"; })()`);
    await b.sleep(1500);
    ok(await b.js(`!document.querySelector(".hm-sold") && document.body.innerText.includes("Sell your Minds")`), "Buy a grown Mind opens the marketplace");
    await b.goto(SITE);
    await b.sleep(6000);
    ok(!(await b.js(`!!document.querySelector(".hm-sold")`)), "the card does not come back after a reload");
    return out;
  }
  return "unknown role";
};
