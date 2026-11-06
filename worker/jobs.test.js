const test = require("node:test");
const assert = require("node:assert/strict");
const { makeJobRunner } = require("./jobs");

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

test("a job with an answer is delivered once", async () => {
  const { runner, calls } = rig(["Why did the robot cross the road?"]);
  await runner.tick();
  await settle();
  await runner.tick();
  await settle();
  assert.equal(calls.filter((c) => c.methodName === "deliver_job").length, 1);
  assert.equal(calls[0].args.result, "Why did the robot cross the road?");
});
