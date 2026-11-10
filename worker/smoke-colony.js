// Smoke-test the colony methods on a deploy made by setup-testnet.js, with its keeper accounts:
// set_look, list_for_sale / unlist, set_service_live.
//   node smoke-colony.js <contract>.testnet <suffix>
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, SUF] = process.argv;
const GAS = "100000000000000";
(async () => {
  const mira = await ensureAccount(`mira-${SUF}.testnet`);
  const call = (methodName, args, deposit = "0") => mira.functionCall({ contractId: CONTRACT, methodName, args, gas: GAS, attachedDeposit: deposit });
  const view = (m, a = {}) => mira.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const before = await view("get_look", { id: 1 });
  await call("set_look", { id: 1, look: { ...before, hat: 1 } }, "10000000000000000000000");
  console.log("set_look:", JSON.stringify(before), "->", JSON.stringify(await view("get_look", { id: 1 })));
  await call("set_look", { id: 1, look: before }, "10000000000000000000000");
  await call("list_for_sale", { id: 2, price: "2000000000000000000000000" });
  console.log("listed Moss:", await view("sale_price", { id: 2 }));
  await call("unlist", { id: 2 });
  console.log("unlisted Moss:", await view("sale_price", { id: 2 }));
  await call("set_service_live", { service_id: 2, live: false });
  console.log("paused:", (await view("get_service", { service_id: 2 })).live === false);
  await call("set_service_live", { service_id: 2, live: true });
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
