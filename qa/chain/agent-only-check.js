// On chain: a data service can't be ordered while its Mind has no agent, and can again once
// the agent is back. Unplugs Mind 4 (keeper bob), tries an order as alice, plugs the gateway back.
const path = require("path");
const os = require("os");
const { connect, keyStores } = require("../../worker/node_modules/near-api-js");
const C = "hm-qa-q1103b.testnet";
const MIND = 4;
(async () => {
  const near = await connect({ networkId: "testnet", nodeUrl: "https://near-testnet.drpc.org", keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials")) });
  const bob = await near.account("bob-q1103.testnet");
  const alice = await near.account("alice-q1103.testnet");
  const view = (m, a) => bob.viewFunction({ contractId: C, methodName: m, args: a });
  const call = (acc, m, args, dep = "0") => acc.functionCall({ contractId: C, methodName: m, args, gas: "100000000000000", attachedDeposit: dep });
  // a data-category service of Mind 4 (agent-ui2 publishes "Liquidation check (Burrow)", Risk alerts)
  const svc = (await view("services_for_mind", { mind_id: MIND })).find((x) => x.category < 7 && x.live);
  if (!svc) return console.log("FAIL  no live data service on Mind 4 to test with (run agent-ui2 keeper first)");
  const SERVICE = svc.id;
  const before = await view("agent_of", { mind_id: MIND });
  console.log("agent before:", before?.about);
  await call(bob, "set_agent", { mind_id: MIND, account_id: null, about: "" }, "10000000000000000000000");
  try {
    await call(alice, "order_job", { service_id: SERVICE, input: JSON.stringify({ account: "tmp-owner.main.burrow.near" }) }, "60000000000000000000000");
    console.log("FAIL  a data service was ordered with no agent");
  } catch (e) {
    const m = String(e.message).match(/needs her agent[^"\\]*/);
    console.log(m ? `PASS  refused with no agent: ${m[0]}` : `FAIL  refused for another reason: ${String(e.message).slice(0, 160)}`);
  }
  if (before) await call(bob, "set_agent", { mind_id: MIND, account_id: before.account, about: before.about }, "10000000000000000000000");
  console.log("agent restored:", (await view("agent_of", { mind_id: MIND }))?.about);
})().catch((e) => console.log("ERROR", e.message));
