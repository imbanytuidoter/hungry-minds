const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Ledger, MAX_ITEMS, MAX_COUNT } = require("./chat-ledger");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-ledger-")), "l.json");

test("usage counts per keeper's Mind and per guest", () => {
  const l = new Ledger(tmp());
  l.add(0, "alice", true, "hi", "hello");
  l.add(0, "alice", true, "how are you", "fine");
  l.add(0, "bob", false, "yo", "hey");
  l.add(1, "bob", false, "yo", "hey");
  assert.strictEqual(l.pendingOwn(0), 2);
  assert.strictEqual(l.pendingGuest("bob"), 2);
  assert.strictEqual(l.pendingGuest("alice"), 0);
});

test("usage survives a restart, including a batch in flight", () => {
  const file = tmp();
  const l = new Ledger(file);
  l.add(0, "alice", true, "hi", "hello");
  l.startBatch(7);
  l.add(0, "alice", true, "again", "yes");
  const back = new Ledger(file);
  assert.strictEqual(back.inflight.batch, 7);
  assert.strictEqual(back.pendingOwn(0), 2); // in flight + new still count until settled
  back.finishBatch();
  assert.strictEqual(back.pendingOwn(0), 1);
});

test("a batch in flight is resent as is, never rebuilt", () => {
  const l = new Ledger(tmp());
  l.add(0, "alice", true, "hi", "hello");
  const a = l.startBatch(1);
  l.add(0, "alice", true, "more", "ok");
  const b = l.startBatch(2);
  assert.strictEqual(b, a);
  assert.strictEqual(b.batch, 1);
  assert.strictEqual(b.items[0].count, 1);
});

test("one batch stays within the contract's bounds", () => {
  const l = new Ledger(tmp());
  for (let m = 0; m < MAX_ITEMS + 5; m++) l.add(m, "bob", false, "p", "r");
  for (let i = 0; i < MAX_COUNT + 3; i++) l.add(999, "alice", true, "p", "r");
  const b = l.startBatch(1);
  assert.ok(b.items.length <= MAX_ITEMS);
  assert.ok(b.items.every((i) => i.count <= MAX_COUNT));
  l.finishBatch();
  assert.ok(l.hasWork()); // the rest waits for the next batch
});
