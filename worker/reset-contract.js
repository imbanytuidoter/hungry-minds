// Wipe a testnet deploy back to zero Minds while keeping its account id: delete the account
// (its state goes with it; leftover NEAR to BENEFICIARY), recreate it from the faucet helper
// under the same name, and deploy the wasm again. Testnet only.
//   node reset-contract.js <contract>.testnet <path-to.wasm> <beneficiary>.testnet
const fs = require("fs");
const path = require("path");
const { ensureAccount, CRED_DIR } = require("./testnet-account");

const [, , CONTRACT, WASM, BENEFICIARY] = process.argv;
if (!CONTRACT?.endsWith(".testnet") || !WASM || !BENEFICIARY) throw new Error("usage: node reset-contract.js <contract>.testnet <wasm> <beneficiary>.testnet");

(async () => {
  const acc = await ensureAccount(CONTRACT);
  const before = await acc.viewFunction({ contractId: CONTRACT, methodName: "total_minds", args: {} }).catch(() => "?");
  console.log(`${CONTRACT}: ${before} Minds before reset`);
  await acc.deleteAccount(BENEFICIARY);
  console.log("deleted; leftover NEAR sent to", BENEFICIARY);
  fs.renameSync(path.join(CRED_DIR, `${CONTRACT}.json`), path.join(CRED_DIR, `${CONTRACT}.deleted-${Date.now()}.json`));
  await new Promise((r) => setTimeout(r, 3000));
  const fresh = await ensureAccount(CONTRACT);
  await fresh.deployContract(fs.readFileSync(WASM));
  const view = (m) => fresh.viewFunction({ contractId: CONTRACT, methodName: m, args: {} });
  console.log(`redeployed: ${await view("total_minds")} Minds, supply_left ${await view("supply_left")}, pending ${await view("pending_count")}`);
})().catch((e) => {
  console.error("reset failed:", e.message || e);
  process.exit(1);
});
