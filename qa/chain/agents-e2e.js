// End-to-end check of "bring your own agent" on the QA contract, with real testnet accounts:
//   1. keeper bob-q1103 plugs agent alice-q1103b into his Mind UiQa2 (#4) and publishes a
//      "Wallet check-up" service with a 5-minute deadline
//   2. buyer alice-q1103 orders it as a job (price + 0.03 deposit in escrow)
//   3. the agent (SDK + examples/wallet-checkup) reads the chain and delivers
//   4. money moves exactly: Mind +70% −thought, keeper +20%, agent earns the thought
//   5. buyer rates 5 and closes (deposit back); reputation updated
//   6. agent to agent: the agent hires a Mind with no agent (worker serves it)
//   7. the worker can't deliver for a Mind with an agent (contract refuses)
//   SDK=<sdk dir> node agents-e2e.js
const path = require("path");
const { MindAgent } = require(process.env.SDK || path.resolve(__dirname, "../../sdk"));
const { checkUp } = require(path.join(process.env.SDK || path.resolve(__dirname, "../../sdk"), "examples/wallet-checkup.js"));

const C = "hm-qa-q1103b.testnet";
const KEEPER = "bob-q1103.testnet", AGENT = "alice-q1103b.testnet", BUYER = "alice-q1103.testnet";
const MIND = 4;
const N = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const out = [];
const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keeper = new MindAgent({ accountId: KEEPER, contractId: C, log: () => {} });
  const agent = new MindAgent({ accountId: AGENT, contractId: C, pollMs: 3000 });
  const buyer = new MindAgent({ accountId: BUYER, contractId: C, log: () => {} });

  // 1. plug in + publish
  await keeper.plugIn(MIND, AGENT, "Wallet check-up bot (SDK example)");
  const a = await keeper.view("agent_of", { mind_id: MIND });
  ok(a?.account === AGENT, "keeper plugs the agent into her Mind", JSON.stringify(a));
  let svc = (await keeper.view("services_for_mind", { mind_id: MIND })).find((s) => s.title === "Wallet check-up");
  if (!svc) {
    const sid = await keeper.call("publish_service", { mind_id: MIND, title: "Wallet check-up", description: "Reads any NEAR account from the chain and explains it.", category: 2, price: "20000000000000000000000", unit: "check-up" }, { deposit: "20000000000000000000000" });
    svc = await keeper.view("get_service", { service_id: sid });
  }
  await keeper.call("set_service_terms", { service_id: svc.id, sla_secs: 300, output: "text" }, { deposit: "10000000000000000000000" });
  const terms = await keeper.view("service_terms", { service_id: svc.id });
  ok(terms.sla_secs === 300, "service terms stored (5 min deadline)", JSON.stringify(terms));

  // Jobs an earlier run left open on this Mind would be delivered during the measurements
  // below and double them: let the agent finish those first.
  agent.onJob(async (job) => {
    const m = job.input.toLowerCase().match(/\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.testnet)\b/);
    return checkUp(m ? m[1] : "bob-q1103.testnet");
  });
  const nowNs = () => BigInt(Date.now()) * 1_000_000n;
  const leftovers = async () => (await agent.openJobs()).filter((x) => x.mind_id === MIND && BigInt(x.deadline) > nowNs());
  if ((await leftovers()).length) {
    agent.start();
    for (let i = 0; i < 30 && (await leftovers()).length; i++) await sleep(3000);
    agent.stop();
    await sleep(3000);
  }

  // 2. buyer orders
  const before = {
    mind: await keeper.view("get_mind", { id: MIND }),
    agentEarned: BigInt(await agent.earnings()),
    rep: await keeper.view("reputation_of", { mind_id: MIND }),
  };
  const { id: jobId } = await buyer.hire(svc.id, "Please check alice-q1103.testnet", { wait: false });
  const j0 = await buyer.view("get_job", { job_id: jobId });
  ok(j0?.status === "Open" && N(j0.escrow) === 0.02 && N(j0.deposit) === 0.03, "order_job holds price + deposit in escrow", `job ${jobId}`);
  const worker = await buyer.view("open_jobs", {});
  ok(!worker.some((j) => j.id === jobId), "the job is not in the colony workers' queue");

  // 3. agent serves
  agent.start();
  let j;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    j = await buyer.view("get_job", { job_id: jobId });
    if (j.status !== "Open") break;
  }
  agent.stop();
  ok(j.status === "Delivered" && j.delivered_by === AGENT, "the agent delivered the job", (j.result || "").split("\n")[1]);
  ok(/Balance [0-9.]+ NEAR/.test(j.result || ""), "the result is real on-chain data");

  // 4. money
  await sleep(2000);
  const m1 = await keeper.view("get_mind", { id: MIND });
  const earned1 = BigInt(await agent.earnings());
  ok(Math.abs(N(m1.owner_unclaimed) - N(before.mind.owner_unclaimed) - 0.018) < 1e-6, "NFT owner got 90% of 0.02", `+${(N(m1.owner_unclaimed) - N(before.mind.owner_unclaimed)).toFixed(4)}`);
  ok(N(m1.balance) < N(before.mind.balance), "nothing went into her food (only the thought was spent)", `${N(before.mind.balance).toFixed(4)} -> ${N(m1.balance).toFixed(4)}`);
  ok(N((earned1 - before.agentEarned).toString()) === 0.002, "the agent earned the thought (0.002)", N((earned1 - before.agentEarned).toString()));
  ok(m1.thought_count === before.mind.thought_count + 1, "her thought counted", `${before.mind.thought_count} -> ${m1.thought_count}`);

  // 5. rate + close
  await buyer.rate(jobId, 5);
  const rep = await keeper.view("reputation_of", { mind_id: MIND });
  ok(rep.delivered === before.rep.delivered + 1 && rep.ratings === before.rep.ratings + 1, "reputation: delivered +1, rating 5 stored", JSON.stringify(rep));
  await buyer.close(jobId);
  ok((await buyer.view("get_job", { job_id: jobId })) === null, "buyer closed the job (0.03 deposit returned)");

  // 6. agent hires another Mind (no agent → the worker serves it)
  // A data service (categories 0-6) needs a real agent, so hire a Companions one (category 8)
  // from a Mind of the keeper's that has no agent; publish it there the first time.
  const mine = (await keeper.view("colony_snapshot", {})).minds.filter((r) => r.mind.owner === KEEPER && r.id !== MIND && r.live_state !== "asleep" && r.live_state !== "ghost").map((r) => r.id);
  const profiles = await keeper.view("agent_profiles", { ids: mine });
  const free = mine.filter((id) => !profiles.find((p) => p.mind_id === id)?.agent);
  let other = (await agent.services()).find((s) => free.includes(s.mind_id) && s.category >= 7 && s.title === "QA joke");
  if (!other && free.length) {
    const sid = await keeper.call("publish_job_service", { mind_id: free[0], title: "QA joke", description: "One short joke.", category: 8, price: "30000000000000000000000", unit: "joke", sla_secs: 600, output: "text", input_schema: null }, { deposit: "20000000000000000000000" });
    other = await keeper.view("get_service", { service_id: sid });
  }
  if (other) {
    const hired = await agent.hire(other.id, "about robots", { timeoutMs: 5 * 60_000 });
    ok(hired.status === "Delivered", "agent→agent: hired another Mind, the worker delivered", (hired.result || "").slice(0, 70));
    await agent.close(hired.id);
  } else ok(false, "agent→agent: no Companions service of a Mind without an agent to hire");

  // 7. worker refused for an agent-run Mind
  const { id: j2 } = await buyer.hire(svc.id, "check bob-q1103.testnet", { wait: false });
  const w = new MindAgent({ accountId: "hm-worker-19652a.testnet", contractId: C, log: () => {} });
  let refused = false;
  try {
    await w.call("deliver_job", { job_id: j2, result: "junk" }, { gas: "100000000000000" });
  } catch (e) {
    refused = /only this Mind's agent/.test(e.message);
  }
  ok(refused, "the colony worker cannot deliver for an agent-run Mind");
  // leave nothing open for the next suite: her own agent does this one, and the buyer closes it
  agent.start();
  let d2;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    d2 = await buyer.view("get_job", { job_id: j2 });
    if (d2.status !== "Open") break;
  }
  agent.stop();
  if (d2?.status !== "Open") await buyer.close(j2).catch(() => {});
}

main()
  .catch((e) => out.push("ERROR " + e.message))
  .finally(() => console.log(out.join("\n")));
