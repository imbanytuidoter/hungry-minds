const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readBody } = require("./chat-server");

// a request that delivers `chunks` (Buffers) one by one
function fakeReq(chunks) {
  const r = new EventEmitter();
  setImmediate(() => {
    for (const c of chunks) r.emit("data", c);
    r.emit("end");
  });
  return r;
}

test("a letter split across two chunks arrives whole", async () => {
  const b = Buffer.from(JSON.stringify({ prompt: "Привіт, 日本 😀" }), "utf8");
  const cut = b.indexOf(Buffer.from("日")) + 1; // in the middle of a 3-byte letter
  const body = await readBody(fakeReq([b.subarray(0, cut), b.subarray(cut)]));
  assert.equal(body.prompt, "Привіт, 日本 😀");
});

test("too large is refused with 413 and nothing is kept", async () => {
  await assert.rejects(readBody(fakeReq([Buffer.alloc(600, 97), Buffer.alloc(600, 97)]), 1000), (e) => e.status === 413);
});

test("bad JSON is refused", async () => {
  await assert.rejects(readBody(fakeReq([Buffer.from("{nope")])), /bad json/);
});
