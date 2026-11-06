// Contract refusals must reach the caller as readable messages (not a bare wasm trap).
//   node qa-errors.js <contract>.testnet <suffix>
const { ensureAccount } = require("./testnet-account");
const [, , CONTRACT, SUF] = process.argv;
(async () => {
  const oleh = await ensureAccount(`oleh-${SUF}.testnet`);
  const cases = [
    ["claim_earnings", { id: 0 }, "0"], // not oleh's Mind
    ["think", { id: 0, prompt: "hi" }, "0"], // not oleh's Mind
    ["revive", { id: 0 }, "1000000000000000000000000"], // Nova is awake
    ["buy_mind", { id: 0 }, "0"], // not for sale
  ];
  for (const [methodName, args, deposit] of cases) {
    try {
      await oleh.functionCall({ contractId: CONTRACT, methodName, args, gas: "100000000000000", attachedDeposit: deposit });
      console.log(`${methodName}: SUCCEEDED (unexpected)`);
    } catch (e) {
      const s = String(e.message || e);
      const m = s.match(/panicked: ([^"\\]+)/);
      console.log(`${methodName}: ${m ? "readable -> " + m[1] : "UNREADABLE -> " + s.slice(0, 120)}`);
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
