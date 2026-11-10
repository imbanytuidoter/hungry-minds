// One-shot setup for a fresh testnet deploy:
//   1. deploy the contract wasm to CONTRACT (an existing faucet account, see testnet-account.js)
//   2. create two keeper accounts and a worker account from the faucet
//   3. hatch a small colony with looks, publish services, list one Mind for sale
//
//   node setup-testnet.js <contract>.testnet <path-to.wasm> <suffix>
//
// Keys live in ~/.near-credentials/testnet (near-cli's location), never in the repo.

const fs = require("fs");
const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");

const [, , CONTRACT, WASM, SUF] = process.argv;
const NEAR = (n) => utils.format.parseNearAmount(String(n));
const GAS = "100000000000000";

// tone/eyes/hat/outfit indices match web/lib/game/look.ts; natures index NATURES there.
const COLONY = {
  mira: [
    ["Nova", { tone: 0, eyes: 2, hat: 0, outfit: 6, natures: [1, 3] }],
    ["Pip", { tone: 1, eyes: 0, hat: 0, outfit: 1, natures: [6, 0] }],
    ["Moss", { tone: 2, eyes: 3, hat: 5, outfit: 2, natures: [5, 7] }],
  ],
  oleh: [
    ["Wren", { tone: 3, eyes: 1, hat: 4, outfit: 3, natures: [2, 0] }],
    ["Kiko", { tone: 4, eyes: 4, hat: 0, outfit: 5, natures: [2, 6] }],
    ["Sol", { tone: 5, eyes: 8, hat: 10, outfit: 0, natures: [5, 4] }],
  ],
};

// [mind, title, description, category, price, unit] — category = index into colony.rs CATEGORIES
const SERVICES = [
  ["Nova", "Bedtime story", "A new 3-minute story every night, starring you and her.", 1, 0.05, "story"],
  ["Nova", "Tiny poem", "A four-line poem about anything you send her.", 5, 0.04, "poem"],
  ["Pip", "Morning check-in", "She asks how you slept and remembers your answer tomorrow.", 0, 0.02, "call"],
  ["Moss", "Ukrainian in 5 words", "Five new words a day, quizzed the next morning.", 2, 0.03, "lesson"],
  ["Wren", "Riddle duel", "She asks a riddle, you get three guesses. Loser feeds the winner.", 3, 0.01, "riddle"],
  ["Kiko", "Pep talk", "Before an exam or interview, she hypes you up.", 0, 0.02, "call"],
  ["Sol", "Star facts", "One true story about a star or planet you pick.", 2, 0.03, "fact"],
];

async function main() {
  const contract = await ensureAccount(CONTRACT);
  const code = fs.readFileSync(WASM);
  const state = await contract.state();
  if (state.code_hash === "11111111111111111111111111111111") {
    await contract.deployContract(code);
    console.log(`deployed ${code.length} bytes to ${CONTRACT}`);
  } else {
    console.log(`${CONTRACT} already has code ${state.code_hash} — redeploying`);
    await contract.deployContract(code);
  }
  const view = (m, a = {}) => contract.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  console.log("params:", JSON.stringify(await view("params")));
  console.log("ghost window ms:", await view("ghost_window_ms"));

  const worker = await ensureAccount(`hm-worker-${SUF}.testnet`);
  console.log("worker ready:", worker.accountId);
  // only approved responders may answer thoughts (contract.rs respond)
  await contract.functionCall({ contractId: CONTRACT, methodName: "add_responder", args: { account_id: worker.accountId }, gas: GAS });
  console.log("worker approved as responder:", await view("is_responder", { account_id: worker.accountId }));

  if ((await view("total_minds")) > 0) {
    console.log("colony already hatched; done");
    return;
  }
  const ids = {};
  for (const [who, minds] of Object.entries(COLONY)) {
    const keeper = await ensureAccount(`${who}-${SUF}.testnet`);
    for (const [name, look] of minds) {
      const r = await keeper.functionCall({ contractId: CONTRACT, methodName: "hatch_mind", args: { name, look }, gas: GAS, attachedDeposit: NEAR(1) });
      const id = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
      ids[name] = { id, keeper };
      console.log(`hatched ${name} #${id} for ${keeper.accountId}`);
    }
  }
  for (const [mind, title, description, category, price, unit] of SERVICES) {
    const { id, keeper } = ids[mind];
    await keeper.functionCall({ contractId: CONTRACT, methodName: "publish_service", args: { mind_id: id, title, description, category, price: NEAR(price), unit }, gas: GAS, attachedDeposit: NEAR(0.01) });
    console.log(`published "${title}" on ${mind}`);
  }
  const wren = ids.Wren;
  await wren.keeper.functionCall({ contractId: CONTRACT, methodName: "list_for_sale", args: { id: wren.id, price: NEAR(3) }, gas: GAS, attachedDeposit: "0" });
  console.log("listed Wren for 3 NEAR");
  console.log("total minds:", await view("total_minds"), "services:", (await view("services")).length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
