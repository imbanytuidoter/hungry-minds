// Wipe a testnet deploy back to zero Minds while keeping its account id: delete the account
// (its state goes with it; leftover NEAR to BENEFICIARY), recreate it from the faucet helper
// under the same name, and deploy the wasm again. Testnet only.
//   node reset-contract.js <contract>.testnet <path-to.wasm> <beneficiary>.testnet
// Stop the worker first: it keeps per-contract files (below) that belong to the old deploy.
const fs = require("fs");
const path = require("path");
const { ensureAccount, CRED_DIR } = require("./testnet-account");

/** The worker's files for this contract (names as chat-server.js, chat-ledger.js and
 *  gateway/store.js write them). After a reset they describe a contract that no longer exists:
 *  the chat ledger's batch numbers no longer match the fresh settle_nonce_of (every settlement
 *  would panic "batch out of order"), and the gateway's connections, jobs and files point at
 *  Minds and jobs that are gone. The session secret (.chat-secret-*) is kept. */
function staleWorkerFiles(dir, contract) {
  const exact = new Set([
    `.chat-ledger-${contract}.json`,
    `.chat-ledger-${contract}.json.tmp`,
    `.gateway-${contract}.json`,
    `.gateway-${contract}.json.tmp`,
    `.gateway-files-${contract}`,
  ]);
  const logPrefix = `.chat-log-${contract}.`; // .chat-log-<contract>.jsonl (and any rotated copy)
  return fs.readdirSync(dir).filter((f) => exact.has(f) || f.startsWith(logPrefix)).map((f) => path.join(dir, f));
}

function wipeWorkerFiles(dir, contract) {
  for (const f of staleWorkerFiles(dir, contract)) {
    fs.rmSync(f, { recursive: true, force: true });
    console.log("removed stale worker file", path.basename(f));
  }
}

if (require.main === module) {
  const [, , CONTRACT, WASM, BENEFICIARY] = process.argv;
  if (!CONTRACT?.endsWith(".testnet") || !WASM || !BENEFICIARY) throw new Error("usage: node reset-contract.js <contract>.testnet <wasm> <beneficiary>.testnet");
  (async () => {
    const acc = await ensureAccount(CONTRACT);
    const before = await acc.viewFunction({ contractId: CONTRACT, methodName: "total_minds", args: {} }).catch(() => "?");
    console.log(`${CONTRACT}: ${before} Minds before reset`);
    await acc.deleteAccount(BENEFICIARY);
    console.log("deleted; leftover NEAR sent to", BENEFICIARY);
    fs.renameSync(path.join(CRED_DIR, `${CONTRACT}.json`), path.join(CRED_DIR, `${CONTRACT}.deleted-${Date.now()}.json`));
    // the old deploy's state is gone for good now: so is the worker's record of it
    wipeWorkerFiles(__dirname, CONTRACT);
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = await ensureAccount(CONTRACT);
    await fresh.deployContract(fs.readFileSync(WASM));
    const view = (m) => fresh.viewFunction({ contractId: CONTRACT, methodName: m, args: {} });
    console.log(`redeployed: ${await view("total_minds")} Minds, supply_left ${await view("supply_left")}, pending ${await view("pending_count")}`);
  })().catch((e) => {
    console.error("reset failed:", e.message || e);
    process.exit(1);
  });
}

module.exports = { staleWorkerFiles };
