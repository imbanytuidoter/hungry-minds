const test = require("node:test");
const assert = require("node:assert/strict");
const { makeJobRunner, makeSleepRecorder } = require("./jobs");

const settle = () => new Promise((r) => setTimeout(r, 20));

function rig(answers) {
  const calls = [];
  const job = { id: 7, mind_id: 1, service_id: 3, input: "a joke", buyer: "b.testnet", deadline: String((BigInt(Date.now()) + 600_000n) * 1_000_000n) };
  const view = async (m) => {
    if (m === "open_jobs") return calls.some((c) => c.methodName === "deliver_job") ? [] : [job];
    if (m === "get_service") return { id: 3, title: "Joke", unit: "joke", category: 8 };
    if (m === "open_job_count") return 0;
    return null;
  };
  const account = { functionCall: async (c) => calls.push(c) };
  let i = 0;
  const runner = makeJobRunner({ account, view, contractId: "c", answer: async () => answers[i++] ?? "" });
  return { runner, calls, asked: () => i };
}

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
