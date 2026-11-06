const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanReply, withTimeout, DEFAULT_MAX_REPLY } = require("./reply");

test("cleanReply trims and passes short replies through", () => {
  assert.equal(cleanReply("  hi there  "), "hi there");
  assert.equal(cleanReply(""), "");
  assert.equal(cleanReply(null), "");
  assert.equal(cleanReply(undefined), "");
});

test("cleanReply clamps to the contract's max, code-point-safe", () => {
  const long = "a".repeat(DEFAULT_MAX_REPLY + 500);
  assert.equal(cleanReply(long).length, DEFAULT_MAX_REPLY);

  // multi-byte: clamping must not split a surrogate pair into a broken char
  const emoji = "😺".repeat(DEFAULT_MAX_REPLY + 50);
  const clamped = cleanReply(emoji);
  assert.equal(Array.from(clamped).length, DEFAULT_MAX_REPLY);
  assert.ok(!clamped.includes("�"), "no replacement char from a split pair");
});

test("cleanReply drops citation markers models append", () => {
  assert.equal(cleanReply("a locked quanta of rhythm.^1"), "a locked quanta of rhythm.");
  assert.equal(cleanReply("Stars are hot [1] and far [^2]."), "Stars are hot and far.");
  assert.equal(cleanReply("Hi 【3†source】there"), "Hi there");
});

test("cleanReply keeps exponents", () => {
  assert.equal(cleanReply("2^10 is 1024"), "2^10 is 1024");
  assert.equal(cleanReply("Area grows as r^2, you see."), "Area grows as r^2, you see.");
  assert.equal(cleanReply("So true!^2 Yes."), "So true! Yes.");
});

test("cleanReply honours a custom max", () => {
  assert.equal(cleanReply("hello world", 5), "hello");
});

test("withTimeout resolves when the promise is fast enough", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "fast");
  assert.equal(v, "ok");
});

test("withTimeout rejects when the promise is too slow", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(() => withTimeout(slow, 10, "slow call"), /slow call timed out/);
});
