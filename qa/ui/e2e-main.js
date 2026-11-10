// The real site (:3000, live contract) as a first-time visitor: nothing signed in, real
// numbers, the shop open without an account, every wallet in the picker.
const SITE = "http://localhost:3000";
const C = "hungry-minds-8250f6.testnet";
const view = async (method) => {
  const r = await (await fetch("https://near-testnet.drpc.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: C, method_name: method, args_base64: "e30=" } }) })).json();
  return JSON.parse(Buffer.from(r.result.result).toString());
};
module.exports = async (b) => {
  const out = [];
  const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  const total = await view("total_minds");
  const left = await view("supply_left");

  await b.goto(SITE + "/");
  await b.sleep(4000);
  const land = await b.text();
  // the landing tells the mechanics, not live counters: it states the cap,
  // which must be the contract's; the live count is checked in the app below
  const cap = Number(total) + Number(left);
  ok(land.includes(`Only ${cap.toLocaleString("en-US")} Minds will ever hatch`), "landing states the real supply cap from chain", `${total} hatched, ${left} left, cap ${cap}`);
  ok(!/Nova|Pip|Moss|Wren|Kiko/.test(land), "no sample Minds on the landing");

  // the language test shares this browser profile and may have left another language behind
  await b.goto(SITE + "/app");
  await b.js(`localStorage.removeItem("hm-lang"); "x"`);
  await b.goto(SITE + "/app");
  const dlg = await b.until(`[...document.querySelectorAll('[role=dialog] button')].map(x=>x.textContent.trim()).join(' | ')`, 30000);
  ok(dlg === "Connect wallet | Just look around", "reload asks to sign in, wallet only", dlg);
  ok(!/wallet [0-9.]+ NEAR/.test(await b.text()), "nobody is signed in on load (no wallet chip)");
  const counter = (await b.text()).match(/(\d[\d,]*) \/ 4,000 hatched/);
  ok(counter && Number(counter[1].replace(/,/g, "")) === total, "app counter matches chain", counter ? counter[0] : "");

  out.push("  " + (await b.click("Connect wallet")));
  const wallets = await b.until(`(() => { const n = [...document.querySelectorAll('.single-wallet .wallet-content .title, .single-wallet')].map(e => e.textContent.trim().split('\\n')[0]); return n.length > 5 ? [...new Set(n)].join(', ') : null; })()`, 30000);
  const count = wallets ? new Set(wallets.split(", ").map((w) => w.replace(/(Wallet).*$/, "$1"))).size : 0;
  ok(!!wallets && /Meteor/.test(wallets) && /HOT/.test(wallets) && /Ledger/.test(wallets), "wallet picker has the NEAR wallets (EVM is mainnet-only by design)", wallets);
  await b.shot(process.env.SHOT_DIR + "/main-wallets.png");
  await b.js(`document.querySelector('.close-button, .nws-modal-close, button[aria-label="Close"]')?.click(); "x"`);
  await b.sleep(800);

  out.push("  " + (await b.click("Just look around")));
  await b.sleep(800);
  out.push("  " + (await b.click("/^Shop$/")));
  const shop = await b.until(`document.body.innerText.includes("Marketplace") && document.body.innerText`, 15000);
  ok(!!shop, "the shop opens without an account");
  const services = await view("colony_snapshot").then((s) => s.services.length);
  ok(services > 0 || /No services published yet/.test(shop || ""), "shop shows the real (empty) service list", `${services} services on chain`);
  await b.shot(process.env.SHOT_DIR + "/main-shop.png");
  return out;
};
