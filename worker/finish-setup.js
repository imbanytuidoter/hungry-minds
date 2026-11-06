// Finish a setup-testnet.js run that stopped midway (idempotent: skips what already exists).
const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, SUF] = process.argv;
const NEAR = (n) => utils.format.parseNearAmount(String(n));
(async () => {
  const oleh = await ensureAccount(`oleh-${SUF}.testnet`);
  const view = (m, a = {}) => oleh.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const services = await view("services");
  if (!services.some((s) => s.title === "Star facts")) {
    await oleh.functionCall({ contractId: CONTRACT, methodName: "publish_service", args: { mind_id: 5, title: "Star facts", description: "One true story about a star or planet you pick.", category: 2, price: NEAR(0.03), unit: "fact" }, gas: "100000000000000", attachedDeposit: NEAR(0.01) });
  }
  if (!(await view("sale_price", { id: 3 }))) {
    await oleh.functionCall({ contractId: CONTRACT, methodName: "list_for_sale", args: { id: 3, price: NEAR(3) }, gas: "100000000000000", attachedDeposit: "0" });
  }
  console.log("minds:", await view("total_minds"), "services:", (await view("services")).length, "listings:", JSON.stringify(await view("listings")));
  console.log("supply left:", await view("supply_left"), "look #0:", JSON.stringify(await view("get_look", { id: 0 })));
})().catch((e) => { console.error(e.message); process.exit(1); });
