// End-to-end money check on a throwaway QA contract (same wasm as the live deploy, so the
// live colony stays clean). Every NEAR flow the site exposes, with the numbers checked:
//   hatch 1 NEAR -> 0.1 food / 0.25 reserve / 0.65 colony; feed 95/5; owner thought costs
//   thought_cost; guest chat + service order held in escrow and split 70/20/10 only on
//   delivery; unanswered guest chat refunded in full; claim_earnings pays the 20 %;
//   sale pays the seller the price and moves the Mind with its food; readable refusals.
// Replies come from the site's real brain (POST /api/brain on BRAIN_URL).
//
//   node qa-finance.js <path-to.wasm> <suffix>
const fs = require("fs");
const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");

const [, , WASM, SUF] = process.argv;
const BRAIN = process.env.BRAIN_URL || "http://localhost:3000/api/brain";
const GAS = "300000000000000";
const Y = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const fmt = (y) => (BigInt(y) < 0n ? "-" : "") + utils.format.formatNearAmount(String(BigInt(y) < 0n ? -BigInt(y) : BigInt(y)), 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (x) => (x < 0n ? -x : x);
let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fails++;
};
// Stored balances drift by metabolism (idle burn) between calls: allow a hair of it.
const near = (a, b, tol = Y(0.0005)) => abs(BigInt(a) - BigInt(b)) <= tol;

(async () => {
  const qa = await ensureAccount(`hm-qa-${SUF}.testnet`);
  const alice = await ensureAccount(`alice-${SUF}.testnet`);
  const bob = await ensureAccount(`bob-${SUF}.testnet`);
  const C = qa.accountId;
  if ((await qa.state()).code_hash === "11111111111111111111111111111111") await qa.deployContract(fs.readFileSync(WASM));
  const view = (m, a = {}) => qa.viewFunction({ contractId: C, methodName: m, args: a });
  const call = (acc, methodName, args, deposit = "0") => acc.functionCall({ contractId: C, methodName, args, gas: GAS, attachedDeposit: String(deposit) });
  const wallet = async (acc) => BigInt((await acc.getAccountBalance()).available);
  const mind = (id) => view("get_mind", { id });
  const treasury = async () => BigInt(await view("treasury_balance"));
  const P = await view("params");
  const cost = BigInt(P.thought_cost);

  // Answer a parked thought with the real AI brain, the way the worker / browser does.
  const answer = async (mindId) => {
    let req;
    for (let i = 0; i < 40 && !req; i++) {
      req = (await view("pending_requests", {})).find((r) => r.mind_id === mindId);
      if (!req) await sleep(1500);
    }
    if (!req) throw new Error("no pending request appeared");
    const m = await mind(mindId);
    let text = "";
    for (let i = 0; i < 4 && !text; i++) {
      const res = await fetch(BRAIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: { name: m.name, traits: m.traits, state: "content", thoughts: m.thought_count, natures: [] }, prompt: req.prompt }) });
      text = res.ok ? (await res.json()).text : "";
      if (!text) await sleep(15000);
    }
    ok(!!text, "the AI brain answered", JSON.stringify(text.slice(0, 80)));
    // Public RPCs sometimes answer 500 while the tx still lands: retry only while the
    // request is still parked, so it is never answered twice.
    for (let i = 0; i < 5; i++) {
      try {
        await call(qa, "respond", { request_id: req.request_id, reply: text || "…" });
        break;
      } catch (e) {
        await sleep(4000);
        if (!(await view("pending_requests", {})).some((r) => r.request_id === req.request_id)) break;
        console.log("  (respond retry:", String(e.message || e).slice(0, 60) + ")");
      }
    }
    return text;
  };
  // The yielded tx (think/chat/order) ends only after the reply; its RPC wait may time out
  // even though the chain finished — the state checks below are what decide PASS/FAIL.
  const settle = (p) => p.catch((e) => console.log("  (tx wait ended:", String(e.message || e).slice(0, 70) + ")"));

  // 1. hatch
  const t0 = await treasury();
  const left0 = await view("supply_left");
  const out = await call(alice, "hatch_mind", { name: `Qa${SUF}`, look: { tone: 2, eyes: 10, hat: 6, outfit: 4, natures: [0, 5] } }, Y(1));
  const id = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
  let m = await mind(id);
  ok(m.owner === alice.accountId && BigInt(m.balance) === Y(0.1), "hatch: 0.1 NEAR becomes her food, alice owns her", `#${id} food ${fmt(m.balance)}`);
  ok((await treasury()) - t0 === Y(0.65), "hatch: 0.65 NEAR to the colony (0.25 stays as storage reserve)");
  ok((await view("supply_left")) === left0 - 1, "hatch: supply_left counts down");
  const tok = await view("nft_token", { token_id: String(id) });
  ok(tok.owner_id === alice.accountId && tok.metadata.media.startsWith("data:image/svg+xml;base64,"), "hatch: NEP-171 token with on-chain SVG");

  // 2. feed
  let t1 = await treasury();
  let b1 = BigInt((await mind(id)).balance);
  await call(alice, "feed", { id }, Y(0.5));
  // RPC nodes behind a load balancer can lag a block: wait until the feed is visible.
  for (let i = 0; i < 20 && BigInt((m = await mind(id)).balance) === b1; i++) await sleep(1500);
  ok(near(BigInt(m.balance) - b1, Y(0.475)), "feed: 95 % to her food", `+${fmt(BigInt(m.balance) - b1)}`);
  ok((await treasury()) - t1 === Y(0.025), "feed: 5 % to the colony");

  // 3. owner thought
  b1 = BigInt(m.balance);
  const n1 = m.thought_count;
  const thinking = call(alice, "think", { id, prompt: "Hi! How do you feel today?" });
  const r1 = await answer(id);
  await settle(thinking);
  m = await mind(id);
  ok(m.thought_count === n1 + 1 && near(b1 - BigInt(m.balance), cost), "owner thought costs exactly thought_cost", `-${fmt(b1 - BigInt(m.balance))} (cost ${fmt(cost)})`);
  ok(m.last_reply === r1, "the reply is stored on chain");

  // 4. guest chat: escrow, then 70/20/10 on delivery
  const pay = Y(0.05);
  t1 = await treasury();
  b1 = BigInt(m.balance);
  let u1 = BigInt(m.owner_unclaimed);
  const chatting = call(bob, "chat", { id, prompt: "Tell me a tiny joke" }, pay);
  await sleep(4000);
  const mid = await mind(id);
  ok(BigInt(mid.owner_unclaimed) === u1 && (await treasury()) === t1, "guest chat: payment held in escrow until she answers");
  await answer(id);
  await settle(chatting);
  m = await mind(id);
  ok(near(BigInt(m.balance) - b1, (pay * 70n) / 100n - cost), "guest chat: 70 % to her food (minus the thought)", `+${fmt(BigInt(m.balance) - b1)}`);
  ok(BigInt(m.owner_unclaimed) - u1 === (pay * 20n) / 100n, "guest chat: 20 % to the keeper");
  ok((await treasury()) - t1 === (pay * 10n) / 100n, "guest chat: 10 % to the colony");

  // 5. service order
  const sOut = await call(alice, "publish_service", { mind_id: id, title: "QA joke", description: "One short joke.", category: 0, price: String(Y(0.03)), unit: "joke" }, Y(0.01));
  const sid = JSON.parse(Buffer.from(sOut.status.SuccessValue, "base64").toString());
  t1 = await treasury();
  u1 = BigInt((await mind(id)).owner_unclaimed);
  const ordering = call(bob, "order_service", { service_id: sid, prompt: "A joke about cats" }, Y(0.03));
  await answer(id);
  await settle(ordering);
  ok(BigInt((await mind(id)).owner_unclaimed) - u1 === (Y(0.03) * 20n) / 100n && (await treasury()) - t1 === (Y(0.03) * 10n) / 100n, "service order: same 70/20/10 on delivery");
  const svc = await view("get_service", { service_id: sid });
  ok(Number(svc.orders) === 1, "service order recorded", `orders ${svc.orders}, fed ${fmt(svc.fed)}`);

  // 6. claim earnings
  m = await mind(id);
  const owed = BigInt(m.owner_unclaimed);
  const w1 = await wallet(alice);
  await call(alice, "claim_earnings", { id });
  const w2 = await wallet(alice);
  ok(BigInt((await mind(id)).owner_unclaimed) === 0n && near(w2 - w1, owed, Y(0.003)), "claim_earnings pays the keeper's 20 %", `owed ${fmt(owed)}, wallet +${fmt(w2 - w1)} (net of gas)`);

  // 7. refusals are readable
  const refusal = async (acc, method, args, dep = "0") => {
    try {
      await call(acc, method, args, dep);
      return "(no error)";
    } catch (e) {
      return String(e.message || e).slice(0, 120);
    }
  };
  const e1 = await refusal(bob, "claim_earnings", { id });
  ok(/only the owner/.test(e1), "a stranger cannot claim the keeper's earnings", e1);
  const e2 = await refusal(bob, "chat", { id, prompt: "hi" }, Y(0.001));
  ok(!/unreachable/.test(e2) && e2 !== "(no error)", "an underpaid chat is refused with a reason", e2);

  // 8. sale
  await call(alice, "list_for_sale", { id, price: String(Y(1)) });
  ok((await view("listings")).some((l) => l.id === id || l.mind_id === id), "listed for sale");
  const food = BigInt((await mind(id)).balance);
  const s1 = await wallet(alice);
  await call(bob, "buy_mind", { id }, Y(1));
  const s2 = await wallet(alice);
  m = await mind(id);
  ok(m.owner === bob.accountId && (await view("nft_token", { token_id: String(id) })).owner_id === bob.accountId, "buy_mind moves the Mind and the NFT to the buyer");
  ok(near(s2 - s1, Y(1), Y(0.001)), "the seller receives the price", `+${fmt(s2 - s1)}`);
  ok(near(BigInt(m.balance), food), "her food goes with her");
  ok(!(await view("listings")).some((l) => l.id === id || l.mind_id === id), "listing removed after the sale");

  // 9. unanswered guest chat is refunded in full (yield timeout, ~200 blocks)
  const g1 = await wallet(alice);
  t1 = await treasury();
  const tBefore = Date.now();
  try {
    await call(alice, "chat", { id, prompt: "Nobody will answer this" }, Y(0.05));
  } catch (e) {
    console.log("  (chat tx ended with:", String(e.message || e).slice(0, 80) + ")");
  }
  let g2 = await wallet(alice);
  for (let i = 0; i < 60 && g1 - g2 > Y(0.01); i++) {
    await sleep(5000);
    g2 = await wallet(alice);
  }
  ok(g1 - g2 < Y(0.01) && (await treasury()) === t1, "a timed-out guest chat refunds the payer", `wallet change ${fmt(g2 - g1)} after ${Math.round((Date.now() - tBefore) / 1000)}s`);
  ok((await view("pending_count")) === 0, "nothing left stuck in flight");

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
