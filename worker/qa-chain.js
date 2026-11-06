// Chain-side QA of the live deploy: every view the site relies on, the NFT standards, and the
// owner actions the UI doesn't expose directly (claim_earnings, nft_transfer round trip).
//   node qa-chain.js <contract>.testnet <suffix>
const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, SUF] = process.argv;
const fmt = (y) => utils.format.formatNearAmount(String(y), 4);
let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fails++;
};

(async () => {
  const mira = await ensureAccount(`mira-${SUF}.testnet`);
  const oleh = await ensureAccount(`oleh-${SUF}.testnet`);
  const view = (m, a = {}) => mira.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const call = (acc, methodName, args, deposit = "0") => acc.functionCall({ contractId: CONTRACT, methodName, args, gas: "100000000000000", attachedDeposit: deposit });

  const p = await view("params");
  ok(p.thought_cost === utils.format.parseNearAmount("0.002") && p.guest_min_price === utils.format.parseNearAmount("0.01"), "economy params are the defaults", `thought ${fmt(p.thought_cost)} guest ${fmt(p.guest_min_price)} revive ${fmt(p.revive_price)} idle ${p.idle_rate_per_day}/day`);
  const total = await view("total_minds");
  ok((await view("max_supply")) === 4000 && (await view("supply_left")) === 4000 - total, "supply cap 4000 and supply_left consistent", `${total} hatched`);
  ok((await view("ghost_window_ms")) === 180000, "ghost window is the demo 3 minutes");
  const snap = await view("colony_snapshot");
  ok(snap.minds.length === total, "colony_snapshot returns every Mind", `${snap.services.length} services, ${snap.listings.length} listings`);
  const states = snap.minds.reduce((a, r) => ((a[r.mind.ghost ? "ghost" : r.live_state] = (a[r.mind.ghost ? "ghost" : r.live_state] || 0) + 1), a), {});
  ok(states.ghost >= 1 && states.asleep >= 1, "lifecycle present on chain", JSON.stringify(states));
  ok((await view("pending_count")) === 0, "no thoughts stuck in flight");

  // NFT standards
  const meta = await view("nft_metadata");
  ok(meta.spec && meta.name === "Hungry Minds" && meta.symbol === "MIND", "NEP-177 nft_metadata", `${meta.spec} ${meta.name} (${meta.symbol})`);
  const tok = await view("nft_token", { token_id: "0" });
  ok(tok && tok.owner_id && tok.metadata.media.startsWith("data:image/svg+xml;base64,"), "NEP-171 nft_token with on-chain SVG media", `#0 ${tok.metadata.title} owned by ${tok.owner_id}`);
  ok(String(await view("nft_total_supply")) === String(total), "NEP-181 nft_total_supply");
  const miraTokens = await view("nft_tokens_for_owner", { account_id: mira.accountId });
  ok(miraTokens.length >= 3, "NEP-181 nft_tokens_for_owner", `${mira.accountId} holds ${miraTokens.map((t) => t.metadata.title).join(", ")}`);

  // claim_earnings: only the 20% cut, never the Mind's food
  const nova = await view("get_mind", { id: 0 });
  if (BigInt(nova.owner_unclaimed) > 0n) {
    const before = BigInt((await mira.getAccountBalance()).available);
    await call(mira, "claim_earnings", { id: 0 });
    const after = await view("get_mind", { id: 0 });
    const gained = BigInt((await mira.getAccountBalance()).available) - before;
    ok(after.owner_unclaimed === "0" && after.balance === nova.balance, "claim_earnings pays the cut, food untouched", `claimed ${fmt(nova.owner_unclaimed)} (net of gas ${fmt(gained)}), Nova food still ${fmt(after.balance)}`);
  } else ok(true, "claim_earnings skipped (nothing unclaimed on Nova)");

  // nft_transfer round trip: the Mind (food, memory) travels whole
  const pip = await view("get_mind", { id: 1 });
  await call(mira, "nft_transfer", { receiver_id: oleh.accountId, token_id: "1" }, "1");
  const moved = await view("get_mind", { id: 1 });
  ok(moved.owner === oleh.accountId && moved.thought_count === pip.thought_count, "nft_transfer moves the Mind whole", `Pip -> ${moved.owner}, food ${fmt(moved.balance)}`);
  await call(oleh, "nft_transfer", { receiver_id: mira.accountId, token_id: "1" }, "1");
  ok((await view("get_mind", { id: 1 })).owner === mira.accountId, "transfer back");

  // a stranger cannot take what isn't theirs
  let refused = false;
  try {
    await call(oleh, "claim_earnings", { id: 0 });
  } catch (e) {
    refused = /only the owner/.test(String(e.message || e));
  }
  ok(refused, "a stranger cannot claim someone else's earnings");

  console.log(fails ? `\n${fails} FAILED` : "\nall chain checks passed");
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
