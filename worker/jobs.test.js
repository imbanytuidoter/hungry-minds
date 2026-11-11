const test = require("node:test");
const assert = require("node:assert/strict");
const { makeJobRunner, makeSleepRecorder } = require("./jobs");

const settle = () => new Promise((r) => setTimeout(r, 20));

const COST = "2000000000000000000000"; // 0.002 NEAR
const deadline = () => String((BigInt(Date.now()) + 600_000n) * 1_000_000n);
function rig(answers, { state = "content", balance = "90000000000000000000000" } = {}) {
  const calls = [];
  const job = { id: 7, mind_id: 1, service_id: 3, input: "a joke", buyer: "b.testnet", deadline: deadline() };
  const view = async (m) => {
    if (m === "open_jobs") return calls.some((c) => c.methodName === "deliver_job") ? [] : [job];
    if (m === "get_service") return { id: 3, title: "Joke", unit: "joke", category: 8 };
    if (m === "open_job_count") return 1;
    if (m === "params") return { thought_cost: COST };
    if (m === "live_state") return state;
    if (m === "live_balance") return balance;
    return null;
  };
  const account = { functionCall: async (c) => calls.push(c) };
  let i = 0;
  const runner = makeJobRunner({ account, view, contractId: "c", answer: async () => answers[i++] ?? "" });
  return { runner, calls, asked: () => i };
}

test("the model is not asked for a job her food can't pay, nor while she sleeps", async () => {
  const hungry = rig(["a joke"], { balance: "1000" });
  await hungry.runner.tick();
  await settle();
  assert.equal(hungry.asked(), 0, "no model call for a hungry Mind");
  assert.equal(hungry.calls.length, 0);
  const sleeping = rig(["a joke"], { state: "asleep" });
  await sleeping.runner.tick();
  await settle();
  assert.equal(sleeping.asked(), 0, "no model call for a sleeping Mind");
});

test("a job result is clipped to 2000 bytes, never mid-character", async () => {
  const { runner, calls } = rig(["ї".repeat(1500)]); // 3000 bytes
  await runner.tick();
  await settle();
  const r = calls.find((c) => c.methodName === "deliver_job").args.result;
  assert.equal(r, "ї".repeat(1000));
  assert.equal(Buffer.byteLength(r), 2000);
});

test("every open job is found past the first page, and a failing one doesn't block the rest", async () => {
  // open_jobs skips from_index over ALL open ids, then filters (agent = none), then takes 50,
  // so a page can be short in the middle of the list
  const all = Array.from({ length: 120 }, (_, i) => ({ id: i, mind_id: i, service_id: 3, input: `q${i}`, buyer: "b.testnet", deadline: deadline(), colony: i % 3 !== 0 }));
  const asked = [];
  const view = async (m, a) => {
    if (m === "open_job_count") return all.length;
    if (m === "open_jobs") return all.slice(a.from_index || 0).filter((j) => j.colony).slice(0, Math.min(a.limit ?? 50, 50));
    if (m === "get_service") return { id: 3, title: "Q", unit: "answer", category: 8 };
    if (m === "params") return { thought_cost: COST };
    if (m === "live_state") return "content";
    if (m === "live_balance") return "90000000000000000000000";
    return [];
  };
  const failing = { functionCall: async () => { throw new Error("rpc down"); } };
  const runner = makeJobRunner({ account: failing, view, contractId: "c", answer: async (_m, p) => (asked.push(p), "ok") });
  await runner.tick();
  await settle();
  const ids = new Set(asked.map((p) => Number(/q(\d+)$/.exec(p)[1])));
  assert.equal(asked.length, ids.size, "no job asked twice in one pass");
  assert.equal(ids.size, all.filter((j) => j.colony).length, "every colony job is tried, the last ones included");
  assert.ok(ids.has(119));
});

test("a job whose model failed is not delivered, and is not retried at once", async () => {
  const { runner, calls, asked } = rig([""]);
  await runner.tick();
  await settle();
  assert.equal(calls.length, 0, "nothing delivered for an empty answer");
  await runner.tick();
  await settle();
  assert.equal(asked(), 1, "the retry waits instead of hammering the model");
});

// colony_snapshot rows as the contract returns them (u64 as numbers, NearToken as strings)
const row = (id, o) => ({ id, live_state: o.live, live_balance: o.liveBal, mind: { ghost: !!o.ghost, asleep_since: o.since ?? 0, balance: o.bal } });
function sleepRig() {
  const calls = [];
  const minds = [
    row(0, { live: "asleep", bal: "3000000000000000000000", liveBal: "1000000000000000000000" }), // starved, not recorded: settle
    row(1, { live: "asleep", bal: "1000000000000000000000", liveBal: "1000000000000000000000", since: 1794098978088789200 }), // already recorded
    row(2, { live: "asleep", bal: "3000000000000000000000", liveBal: "1000000000000000000000", ghost: true }), // a ghost
    row(3, { live: "asleep", bal: "1000000000000000000000", liveBal: "1000000000000000000000" }), // no drain pending: settle would do nothing
    row(4, { live: "full", bal: "90000000000000000000000", liveBal: "90000000000000000000000" }), // awake
  ];
  const view = async (m, a) => (m === "colony_snapshot" ? { total_minds: minds.length, minds: a.from_index === 0 ? minds : [] } : null);
  const account = { functionCall: async (c) => calls.push(c) };
  let t = 1_000_000;
  const rec = makeSleepRecorder({ account, view, contractId: "c", now: () => t, log: { log() {}, error() {} } });
  return { rec, calls, advance: (ms) => (t += ms) };
}

test("the sleep recorder settles only a Mind that starved with her sleep unrecorded, once", async () => {
  const { rec, calls, advance } = sleepRig();
  assert.deepEqual(await rec.tick(), [0]);
  await settle();
  assert.deepEqual(calls.map((c) => [c.methodName, c.args.id]), [["settle", 0]]);
  advance(61_000); // next scan, still inside the 10-minute retry window
  assert.deepEqual(await rec.tick(), []);
  advance(10 * 60_000); // the chain still says awake: one more try
  assert.deepEqual(await rec.tick(), [0]);
});

test("the sleep recorder scans at most once a minute", async () => {
  const { rec, advance } = sleepRig();
  await rec.tick();
  advance(30_000);
  assert.deepEqual(await rec.tick(), [], "a second tick inside the minute does nothing");
});

test("a job with an answer is delivered once", async () => {
  const { runner, calls } = rig(["Why did the robot cross the road?"]);
  await runner.tick();
  await settle();
  await runner.tick();
  await settle();
  assert.equal(calls.filter((c) => c.methodName === "deliver_job").length, 1);
  assert.equal(calls[0].args.result, "Why did the robot cross the road?");
});
