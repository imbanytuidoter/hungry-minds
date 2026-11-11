// Regression tests for the fixes from the A4/A5/A6/A8 reviews (worker side). Each test names
// the finding it covers.
process.env.CHAT_PORT = "0"; // chat-server reads its port on load: any free one
delete process.env.CHAT_SECRET;

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { transactions, KeyPair } = require("near-api-js");

const { clipUtf8, phrasebookAllowed } = require("./reply");
const { secretFor, sendJson, startChatServer, MIN_SECRET_CHARS } = require("./chat-server");
const { Ledger } = require("./chat-ledger");
const { staleWorkerFiles } = require("./reset-contract");
const { privateIp } = require("./gateway/safe-fetch");
const { makeGateway, trimSkills, publicUrl, capSchema, HANDED_OVER } = require("./gateway");
const { Store } = require("./gateway/store");
const { schemaText, argLine, MAX_SCHEMA_PROMPT } = require("./gateway/connectors");
const { makeX402, checkPayment, serdeRefuses, JOB_DEPOSIT } = require("./x402");

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hm-audit-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ── A8 M2: a guest's paid thought is never "answered" from the phrasebook ──
test("A8 M2: the phrasebook may answer only the owner's thought, or anything when no model exists", () => {
  assert.equal(phrasebookAllowed({ hasModel: true, byOwner: false }), false, "guest + model failed: leave it to time out (refund)");
  assert.equal(phrasebookAllowed({ hasModel: true, byOwner: true }), true);
  assert.equal(phrasebookAllowed({ hasModel: false, byOwner: false }), true, "no model at all: the phrasebook is her voice");
});

// ── A4 F7: results clipped by bytes ──
test("A4 F7: clipUtf8 keeps whole characters within the byte limit", () => {
  assert.equal(clipUtf8("abc", 2000), "abc");
  assert.equal(clipUtf8("😀😀😀", 9), "😀😀"); // 4 bytes each
  assert.equal(clipUtf8("aї", 2), "a"); // ї is 2 bytes: not split
});

// ── A4 F5: no short secrets ──
test("A4 F5: an empty or short secret file is replaced, a short CHAT_SECRET is refused", () => {
  const dir = tmp();
  const file = path.join(dir, ".chat-secret-c.testnet");
  fs.writeFileSync(file, "");
  const err = console.error;
  console.error = () => {};
  try {
    const s = secretFor(dir, "c.testnet");
    assert.ok(s.length >= MIN_SECRET_CHARS);
    assert.equal(fs.readFileSync(file, "utf8"), s, "the new secret is kept");
    fs.writeFileSync(file, "abc");
    assert.notEqual(secretFor(dir, "c.testnet"), "abc");
    const good = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, good + "\n");
    assert.equal(secretFor(dir, "c.testnet"), good, "a proper secret survives restarts");
  } finally {
    console.error = err;
  }
  process.env.CHAT_SECRET = "short";
  try {
    assert.throws(() => secretFor(dir, "c.testnet"), /at least 64/);
  } finally {
    delete process.env.CHAT_SECRET;
  }
});

// ── A4 F6: replying after the head went out ──
test("A4 F6: sendJson destroys a response whose head already went out, and never throws", () => {
  let destroyed = false;
  let wrote = false;
  sendJson({ headersSent: true, destroy: () => (destroyed = true), writeHead: () => (wrote = true) }, 500, { error: "x" });
  assert.equal(destroyed, true);
  assert.equal(wrote, false);
  const out = {};
  const loop = {};
  loop.self = loop;
  sendJson({ headersSent: false, writeHead: (c) => (out.code = c), end: (b) => (out.body = b) }, 200, loop);
  assert.equal(out.code, 500, "a body that can't be serialized becomes a 500 before any head is written");
});

// ── A4 F4: a reset wipes the old deploy's worker files ──
test("A4 F4: reset-contract finds exactly this contract's ledger, logs and gateway files", () => {
  const dir = tmp();
  const c = "hm.testnet";
  const mine = [`.chat-ledger-${c}.json`, `.chat-ledger-${c}.json.tmp`, `.chat-log-${c}.jsonl`, `.gateway-${c}.json`, `.gateway-files-${c}`];
  const others = [`.chat-secret-${c}`, `.chat-ledger-x.${c}.json`, `.gateway-other.testnet.json`, `.chat-log-hm.testnet2.jsonl`, "index.js"];
  for (const f of [...mine, ...others]) (f.startsWith(".gateway-files") ? fs.mkdirSync : fs.writeFileSync)(path.join(dir, f), ...(f.startsWith(".gateway-files") ? [] : [""]));
  assert.deepEqual(staleWorkerFiles(dir, c).map((f) => path.basename(f)).sort(), [...mine].sort());
});

// ── A5 F7: IPv6 forms that carry a private IPv4 ──
test("A5 F7: mapped, compatible, NAT64, 6to4 and Teredo forms of private IPv4 are private", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:0:7f00:1", "::7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:80ff:fffe", "::", "::1", "fe80::1%eth0", "fd00::1", "ff02::1", "not-an-ip"])
    assert.equal(privateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    assert.equal(privateIp(ip), false, ip);
  // what the WHATWG URL parser turns http://[::ffff:127.0.0.1]/ into
  assert.equal(privateIp(new URL("http://[::ffff:127.0.0.1]/").hostname.replace(/^\[|\]$/g, "")), true);
});

// ── A5 F5/F6, F10: bounded skills and schemas, clean public URL ──
test("A5 F5/F6: skills and schemas are bounded; a 4 KB+ schema is dropped, prompts are capped", () => {
  const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(20) }])) };
  assert.equal(capSchema(huge), null);
  const small = { type: "object", properties: { q: { type: "string" } } };
  assert.deepEqual(capSchema(small), small);
  const skills = trimSkills(Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, name: "n".repeat(500), description: "d".repeat(5000), examples: Array(20).fill("e".repeat(999)), inputSchema: huge })));
  assert.equal(skills.length, 50);
  assert.equal(skills[0].name.length, 100);
  assert.equal(skills[0].description.length, 500);
  assert.equal(skills[0].examples.length, 5);
  assert.equal(skills[0].inputSchema, null);
  assert.ok(Buffer.byteLength(schemaText(huge)) <= MAX_SCHEMA_PROMPT);
  assert.ok(Buffer.byteLength(argLine(huge)) <= MAX_SCHEMA_PROMPT);
});

test("A5 F10: the public agent URL has no credentials, query or fragment", () => {
  assert.equal(publicUrl("https://user:pw@agent.example.com/mcp?key=SECRET#x"), "https://agent.example.com/mcp");
  assert.equal(publicUrl("polymarket"), "polymarket", "an official agent's id stays");
});

// ── A4 F3 + F8: allowance counts her food, caches params and get_mind ──
test("A4 F3/F8: a guest (and her keeper) can't chat past what her food can pay; params and get_mind are cached", async () => {
  const dir = tmp();
  const COST = 2_000_000_000_000_000_000_000n;
  const counts = {};
  const view = async (m) => {
    counts[m] = (counts[m] || 0) + 1;
    if (m === "get_mind") return { owner: "own.testnet", name: "Mimi" };
    if (m === "live_state") return "content";
    if (m === "params") return { thought_cost: COST.toString(), guest_min_price: "1000000000000000000000" };
    if (m === "live_balance") return (COST * 3n).toString(); // three thoughts of food
    if (m === "chat_credits_of") return "100000000000000000000000"; // 100 messages of credits
    return null;
  };
  const log = console.log;
  console.log = () => {};
  const srv = startChatServer({ account: {}, view, contractId: "c.testnet", workerId: "w.testnet", askLLM: async () => "hi", fallbackReply: () => "", cleanReply: (s) => s, dir });
  console.log = log;
  try {
    if (!srv.server.listening) await new Promise((r) => srv.server.once("listening", r));
    const port = srv.server.address().port;
    const get = async (who) => (await fetch(`http://127.0.0.1:${port}/allowance?account=${who}&mind=1`)).json();
    assert.equal((await get("g2.testnet")).left, 3, "credits for 100, food for 3");
    for (let i = 0; i < 3; i++) srv.ledger.add(1, "g1.testnet", false, "p", "r"); // another guest used her food up
    const g = await get("g2.testnet");
    assert.equal(g.left, 0);
    assert.match(g.error, /too hungry/);
    const own = await get("own.testnet");
    assert.equal(own.left, 0, "the keeper's own messages count guests' unsettled ones too");
    assert.equal(counts.params, 1, "params read once");
    assert.equal(counts.get_mind, 1, "get_mind cached for the public allowance");
  } finally {
    srv.close();
  }
});

test("A4 F3: the ledger counts every unsettled message on a Mind, keeper's and guests'", () => {
  const l = new Ledger(path.join(tmp(), "l.json"));
  l.add(1, "own.testnet", true, "p", "r");
  l.add(1, "g.testnet", false, "p", "r");
  l.add(2, "g.testnet", false, "p", "r");
  assert.equal(l.pendingOnMind(1), 2);
  l.startBatch(1);
  assert.equal(l.pendingOnMind(1), 2, "a batch in flight still counts");
});

// ── gateway: A6 F1 / A5 F3 navigate, A5 F4 sold Minds ──
function gatewayRig({ owner = "new.testnet" } = {}) {
  const dir = tmp();
  const store = new Store(dir, "c.testnet", "s".repeat(64));
  store.setConn(1, { kind: "http", url: "https://u:p@agent.example.com/run?key=SECRET", name: "Bot", skills: [], connectedBy: "old.testnet", online: true, since: 1 }, "api-key");
  let plans = 0;
  const views = {};
  const view = async (m) => {
    views[m] = (views[m] || 0) + 1;
    if (m === "get_mind") return { owner, name: "Mimi" };
    if (m === "colony_snapshot") return { services: [{ id: 5, mind_id: 1, title: "Wallet check", description: "check a wallet", live: true, category: 8, orders: 0, price: "1" }], minds: [{ id: 1, live_state: "content", mind: { name: "Mimi" } }] };
    if (m === "input_schemas") return [null];
    if (m === "agent_profiles") return [];
    return null;
  };
  const tokens = { "tok-old": "old.testnet", "tok-new": "new.testnet", "tok-x": "x.testnet" };
  const gw = makeGateway({ view, account: {}, contractId: "c.testnet", workerId: "w.testnet", store, plan: async () => (plans++, '{"picks":[]}'), readToken: (t) => tokens[t] || null });
  const call = async (method, p, body = {}) => {
    let out;
    await gw.route({ method }, {}, new URL(`http://l/agent/${p}`), async () => body, (code, obj) => (out = [code, obj]));
    return out;
  };
  return { gw, store, call, plans: () => plans, views };
}

test("A6 F1 / A5 F3: the Navigator needs a session, is rate limited per account, and reads the catalogue once a minute", async () => {
  const { call, plans, views } = gatewayRig();
  assert.equal((await call("POST", "navigate", { text: "check my wallet" }))[0], 401, "no token: no model call");
  assert.equal(plans(), 0);
  for (let i = 0; i < 6; i++) assert.equal((await call("POST", "navigate", { text: "check my wallet", token: "tok-x" }))[0], 200);
  assert.equal((await call("POST", "navigate", { text: "check my wallet", token: "tok-x" }))[0], 429, "the 7th in a minute is refused");
  assert.equal((await call("POST", "navigate", { text: "check my wallet", token: "tok-new" }))[0], 200, "another account has its own budget");
  assert.equal(plans(), 7);
  assert.equal(views.colony_snapshot, 1, "the catalogue is cached");
});

test("A5 F4: after a sale the old owner's agent refuses the new owner's tests and chat; either can disconnect", async () => {
  const { gw, store, call } = gatewayRig();
  const t = await call("POST", "test", { token: "tok-new", mindId: 1 });
  assert.equal(t[0], 409);
  assert.equal(t[1].error, HANDED_OVER);
  await assert.rejects(gw.chat(1, "new.testnet", "hi"), new RegExp(HANDED_OVER));
  assert.equal(gw.about(1).connectedBy, "old.testnet", "the chat server can see who connected it");
  const st = (await call("GET", "status"))[1].agents[0];
  assert.equal(st.needs_reconnect, true);
  assert.equal(st.online, false);
  assert.equal(st.url, "https://agent.example.com/run", "no key or credentials in the public URL");
  assert.equal((await call("POST", "disconnect", { token: "tok-x", mindId: 1 }))[0], 403, "a stranger can't");
  assert.equal((await call("POST", "disconnect", { token: "tok-old", mindId: 1 }))[0], 200, "whoever connected it takes it back");
  assert.equal(store.conn(1), null);
});

// ── A5 F2: what serde would refuse is never relayed ──
test("A5 F2: lone surrogates, 1e400 and deep nesting are caught before the relay", () => {
  assert.match(serdeRefuses(JSON.parse('{"a":1e400}')), /too large/);
  assert.match(serdeRefuses(JSON.parse('{"a":"\\ud800"}')), /lone surrogate/);
  assert.match(serdeRefuses(JSON.parse('{"\\udc00":1}')), /lone surrogate/);
  assert.match(serdeRefuses(JSON.parse(`{"a":${"[".repeat(70)}${"]".repeat(70)}}`)), /nests deeper/);
  assert.equal(serdeRefuses(JSON.parse('{"token":"x","n":1e300,"deep":[[[1]]],"emoji":"😀"}')), null);
  assert.throws(() => checkPayment("x", { contractId: "c", network: "testnet", text: "\ud800 hi", rows: [] }), /lone surrogate/);
});

// an x402 rig like poc-a5/x402-refusal.js: every relay "lands" with the contract's refusal
function x402Rig(schema) {
  const CONTRACT = "hm.testnet", WRAP = "wrap.testnet";
  const PRICE = 10_000_000_000_000_000_000_000n;
  const AMOUNT = (PRICE + JOB_DEPOSIT).toString();
  const key = KeyPair.fromRandom("ed25519");
  let nonce = 5n;
  let relayed = 0;
  const header = (text, row) => {
    const args = { receiver_id: CONTRACT, amount: AMOUNT, msg: JSON.stringify({ service_id: 7, input: text }) };
    const delegateAction = { senderId: "buyer.testnet", receiverId: WRAP, actions: [transactions.functionCall("ft_transfer_call", args, 200_000_000_000_000n, 1n)], nonce: nonce++, maxBlockHeight: 1000n, publicKey: key.getPublicKey() };
    const hash = crypto.createHash("sha256").update(transactions.encodeDelegateAction(delegateAction)).digest();
    const signed = { delegateAction, signature: new transactions.Signature({ keyType: 0, data: key.sign(new Uint8Array(hash)).signature }) };
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: Buffer.from(transactions.encodeSignedDelegate(signed)).toString("base64") } })).toString("base64");
  };
  const view = async (m) =>
    ({
      get_mind: { name: "M", ghost: false },
      live_state: "content",
      params: { guest_min_price: "0" },
      agent_of: "gw.testnet",
      services_for_mind: [{ id: 7, live: true, category: 7, price: PRICE.toString(), title: "svc", description: "", unit: "" }],
      input_schemas: [schema],
      jobs_of: [],
      get_job: null,
    })[m];
  const provider = {
    query: async () => ({ permission: "FullAccess", nonce: 4 }),
    block: async () => ({ header: { height: 500 } }),
    sendTransactionUntil: async () => ({}),
    txStatus: async () => ({ transaction: { hash: "H" }, transaction_outcome: { outcome: { status: { SuccessValue: "" } } }, receipts_outcome: [{ outcome: { logs: ["job_order_refused buyer=buyer.testnet reason=refused"] } }] }),
  };
  const account = {
    accountId: "worker.testnet",
    connection: { provider },
    viewFunction: async ({ methodName }) => (methodName === "storage_balance_of" ? { total: "1" } : methodName === "ft_balance_of" ? "100000000000000000000000000" : null),
    functionCall: async () => ({}),
    signTransaction: async () => {
      relayed++;
      return [new Uint8Array(32), {}];
    },
  };
  const x = makeX402({ view, account, contractId: CONTRACT, network: "testnet", secret: "s".repeat(64), gateway: null });
  const send = async (text) => {
    const row = (await x.card(1))[1].x402.accepts[0];
    const body = { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text }] } } };
    let out;
    const res = { writeHead: (c) => (out = { code: c }), end: (b) => (out.body = JSON.parse(b)) };
    await x.route({ method: "POST", headers: { "x-payment": header(text, row) } }, res, new URL("http://l/agent/x402/1"), async () => body);
    return out;
  };
  return { send, relayed: () => relayed };
}

test("A5 F2: a form input serde would refuse is not relayed", async () => {
  const r = x402Rig(JSON.stringify({ type: "object", properties: { token: { type: "string" } }, required: ["token"] }));
  for (const input of ['{"token":"x","n":1e400}', '{"token":"\\ud800"}', `{"token":"x","z":${"[".repeat(100)}${"]".repeat(100)}}`]) {
    const out = await r.send(input);
    assert.equal(out.code, 402, input);
  }
  assert.equal((await r.send("\ud800 hi")).code, 400, "a lone surrogate in the text itself");
  assert.equal(r.relayed(), 0, "the worker paid no gas for any of them");
});

test("A5 F2: after the contract refuses a relayed order, that buyer is not relayed again for a while", async () => {
  const r = x402Rig(null);
  const first = await r.send("hello");
  assert.equal(first.code, 402);
  assert.match(first.body.error, /refused/);
  assert.equal(r.relayed(), 1);
  const second = await r.send("hello again");
  assert.equal(second.code, 429);
  assert.equal(r.relayed(), 1, "no second relay");
});
