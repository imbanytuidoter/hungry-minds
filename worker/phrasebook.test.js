const test = require("node:test");
const assert = require("node:assert/strict");
const { phrasebookReply } = require("./phrasebook");

const mind = { state: "content", traits: [0, 1] };

test("phrasebook answers for any timestamp (Date.now() used to crash it)", () => {
  // 1778000000000 >> 3 is negative in 32 bits, which picked no line and threw
  for (const n of [0, 7, 8, 1778000000000, 1778000000123, Date.now(), Number.MAX_SAFE_INTEGER, -5, NaN]) {
    const r = phrasebookReply(mind, "hi", n);
    assert.equal(typeof r, "string");
    assert.ok(r.length > 10, `n=${n}: ${r}`);
  }
});

test("phrasebook names the service and the hunger", () => {
  assert.match(phrasebookReply(mind, "[Service: Joke — one line] go", 1), /^Here's your joke/);
  assert.match(phrasebookReply({ ...mind, state: "hungry" }, "hi", 1), /snack/);
  assert.equal(phrasebookReply({ ...mind, state: "asleep" }, "hi", 1), "z z z");
});
