// Approve an account to answer parked thoughts (`respond`) on a deploy. Signed by the
// contract account itself (its key in ~/.near-credentials/testnet).
//   node add-responder.js <contract>.testnet <worker>.testnet
const { ensureAccount } = require("./testnet-account");

const [, , CONTRACT, WORKER] = process.argv;
if (!CONTRACT || !WORKER) throw new Error("usage: node add-responder.js <contract>.testnet <worker>.testnet");

(async () => {
  const acc = await ensureAccount(CONTRACT);
  await acc.functionCall({ contractId: CONTRACT, methodName: "add_responder", args: { account_id: WORKER }, gas: "30000000000000" });
  const ok = await acc.viewFunction({ contractId: CONTRACT, methodName: "is_responder", args: { account_id: WORKER } });
  console.log(`${WORKER} is a responder on ${CONTRACT}: ${ok}`);
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error("add-responder failed:", e.message || e);
  process.exit(1);
});
