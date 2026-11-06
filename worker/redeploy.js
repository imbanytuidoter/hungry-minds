// Redeploy new contract code to an existing account (state is kept; methods are added).
//   node redeploy.js <contract>.testnet <path-to.wasm>
const fs = require("fs");
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, WASM] = process.argv;
(async () => {
  const acc = await ensureAccount(CONTRACT);
  await acc.deployContract(fs.readFileSync(WASM));
  const snap = await acc.viewFunction({ contractId: CONTRACT, methodName: "colony_snapshot", args: {} });
  console.log(`redeployed; snapshot: ${snap.minds.length} minds, ${snap.services.length} services, ${snap.listings.length} listings, supply_left ${snap.supply_left}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
