// End-to-end smoke test against the live testnet deploy: an owner thinks, a guest orders a
// service, and both replies come back on chain through the worker. Prints balances so the
// 70/20/10 split can be checked by eye.
//
//   node smoke-testnet.js <contract>.testnet <suffix>

const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, SUF] = process.argv;
const GAS = "300000000000000";
const fmt = (y) => utils.format.formatNearAmount(y, 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mira = await ensureAccount(`mira-${SUF}.testnet`); // owns Nova (#0)
  const oleh = await ensureAccount(`oleh-${SUF}.testnet`); // a stranger to Nova
  const view = (m, a = {}) => mira.viewFunction({ contractId: CONTRACT, methodName: m, args: a });

  const before = await view("get_mind", { id: 0 });
  console.log("Nova before:", fmt(before.balance), "thoughts", before.thought_count, "unclaimed", fmt(before.owner_unclaimed));

  // The call waits for the yield to resume, so it returns once the worker has replied
  // (or after the 200-block timeout).
  const t0 = Date.now();
  await mira.functionCall({ contractId: CONTRACT, methodName: "think", args: { id: 0, prompt: "Who are you?" }, gas: GAS, attachedDeposit: "0" });
  console.log(`think resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, await view("last_thought", { id: 0 }));

  await oleh.functionCall({ contractId: CONTRACT, methodName: "order_service", args: { service_id: 1, prompt: "about the sea" }, gas: GAS, attachedDeposit: utils.format.parseNearAmount("0.04") });
  await sleep(1500);
  console.log("order reply ->", await view("last_thought", { id: 0 }));

  const after = await view("get_mind", { id: 0 });
  console.log("Nova after:", fmt(after.balance), "thoughts", after.thought_count, "unclaimed", fmt(after.owner_unclaimed));
  console.log("service #1:", JSON.stringify(await view("get_service", { service_id: 1 })));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
