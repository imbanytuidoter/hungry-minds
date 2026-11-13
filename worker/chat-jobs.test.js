// Chat, jobs and x402 behaviour under failure and load: empty model replies, a failing agent, rate
// limits, concurrent guests, cached allowances, hidden results, paged jobs, hungry Minds.
// Everything is mocked: no chain, no model, only 127.0.0.1.
process.env.CHAT_PORT = "0"; // chat-server reads its port on load: any free one
process.env.SETTLE_EVERY_MS = "3600000";
process.env.GATEWAY_ALLOW_LOCAL = "1"; // the stand-in agents run on 127.0.0.1
delete process.env.CHAT_SECRET;

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { transactions, KeyPair } = require("near-api-js");

const { startChatServer, secretFor } = require("./chat-server");
const { issueToken } = require("./chat-auth");
const { makeGateway } = require("./gateway");
const { Store } = require("./gateway/store");
const { scrubUrls, makeRateLimiter } = require("./gateway/limits");
const { makeX402, serdeRefuses, numberTooBig, JOB_DEPOSIT } = require("./x402");

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hm-r2-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = async (fn) => {
  const [l, e] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.error] = [l, e];
  }
};

// ── chat server rig ──
const COST = 2_000_000_000_000_000_000_000n; // 0.002 NEAR
function chatView({ food = 500n, latency = 0, counts = {} } = {}) {
  return async (m, a) => {
    counts[m] = (counts[m] || 0) + 1;
    if (latency) await sleep(latency);
    if (m === "params") return { thought_cost: COST.toString(), guest_min_price: COST.toString() };
    if (m === "get_mind") return { id: a.id, name: "Mo", owner: "keeper.testnet", traits: [1, 2, 3, 4, 5, 6, 7] };
    if (m === "live_state") return "content";
    if (m === "live_balance") return (COST * food).toString();
    if (m === "chat_credits_of") return (COST * 100n).toString();
    if (m === "get_look") return { natures: [] };
    if (m === "settle_nonce_of") return 0;
    return null;
  };
}
async function chatRig(opts) {
  const dir = tmp();
  const srv = await quiet(() => startChatServer({ account: {}, contractId: "c.testnet", workerId: "w.testnet", cleanReply: (s) => s, fallbackReply: () => "a canned line", dir, view: chatView(), ...opts }));
  if (!srv.server.listening) await new Promise((r) => srv.server.once("listening", r));
  const port = srv.server.address().port;
  const secret = secretFor(dir, "c.testnet");
  const chat = async (who, prompt = "hello there", mindId = 0) => {
    const r = await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: issueToken(secret, who).token, mindId, prompt }) });
    return [r.status, await r.json()];
  };
  const allowance = async (who, mindId = 0) => (await fetch(`http://127.0.0.1:${port}/allowance?account=${who}&mind=${mindId}`)).json();
  return { srv, chat, allowance };
}

test("with a model configured, an empty reply is refused (503) and nothing is charged; without one the phrasebook answers", async () => {
  const a = await chatRig({ askLLM: async () => "" }); // hasModel defaults to true
  try {
    const [code, body] = await quiet(() => a.chat("guest.testnet"));
    assert.equal(code, 503);
    assert.match(body.error, /no reply, nothing was charged/);
    assert.equal(a.srv.ledger.rows().length, 0, "the guest is not charged");
  } finally {
    a.srv.close();
  }
  const b = await chatRig({ askLLM: async () => "", hasModel: false });
  try {
    const [code, body] = await quiet(() => b.chat("guest.testnet"));
    assert.equal(code, 200);
    assert.equal(body.reply, "a canned line", "no model at all: the phrasebook is her voice");
  } finally {
    b.srv.close();
  }
});

function fakeGateway({ fails }) {
  let calls = 0;
  return {
    calls: () => calls,
    serves: () => true,
    about: () => ({ name: "bot", connectedBy: "keeper.testnet", skills: [{ name: "x", description: "y", examples: [] }], waiting: () => false }),
    chat: async () => {
      calls++;
      if (fails) throw new Error("can't reach https://u:pw@agent.example.com/mcp?token=SECRET (fetch failed)");
      return "agent data";
    },
  };
}

test("after her agent fails, she answers herself for a minute (no planner, no agent call); the error shows no key", async () => {
  let plans = 0;
  const gateway = fakeGateway({ fails: true });
  const r = await chatRig({ askLLM: async () => "her own voice", plan: async () => (plans++, '{"agent": true}'), gateway });
  try {
    const [c1, b1] = await quiet(() => r.chat("guest.testnet"));
    assert.equal(c1, 502);
    assert.doesNotMatch(b1.error, /SECRET|pw@/, "no API key from the agent's URL reaches the guest");
    for (let i = 0; i < 5; i++) {
      const [c, b] = await quiet(() => r.chat("guest.testnet"));
      assert.equal(c, 200);
      assert.equal(b.reply, "her own voice");
      assert.equal(b.via, null);
    }
    assert.equal(gateway.calls(), 1, "the failed agent is not called again during the cool-down");
    assert.equal(plans, 1, "nor the planner");
  } finally {
    r.srv.close();
  }
});

test("messages routed to her agent are limited to 10 a minute per account", async () => {
  let plans = 0;
  const gateway = fakeGateway({ fails: false });
  const r = await chatRig({ askLLM: async () => "her own voice", plan: async () => (plans++, '{"agent": true}'), gateway });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await quiet(() => r.chat("guest.testnet")))[0], 200);
    const [code, body] = await r.chat("guest.testnet");
    assert.equal(code, 429);
    assert.match(body.error, /10 messages a minute/);
    assert.equal(plans, 10, "the 11th never reached the planner");
    assert.equal((await quiet(() => r.chat("other.testnet")))[0], 200, "another account has its own budget");
  } finally {
    r.srv.close();
  }
});

test("makeRateLimiter counts per key within the window", () => {
  const take = makeRateLimiter(2, 60_000);
  assert.equal(take("a"), true);
  assert.equal(take("a"), true);
  assert.equal(take("a"), false);
  assert.equal(take("b"), true);
});

test("concurrent guests on a Mind with food for ONE thought: exactly one is answered", async () => {
  const r = await chatRig({ view: chatView({ food: 1n, latency: 30 }), askLLM: async () => (await sleep(100), "a real reply") });
  try {
    const codes = await quiet(() => Promise.all(Array.from({ length: 5 }, (_, i) => r.chat(`sybil${i}.testnet`, "hi")).map((p) => p.then((x) => x[0]))));
    assert.deepEqual(codes.filter((c) => c === 200).length, 1, `statuses ${codes}`);
    assert.equal(codes.filter((c) => c === 402).length, 4);
    assert.equal(r.srv.ledger.pendingOnMind(0), 1, "one message on her ledger, not five");
    // the reservations were all released: a fresh look sees only the settled-to-be message
    assert.equal((await r.allowance("keeper.testnet")).left, 0);
  } finally {
    r.srv.close();
  }
});

test("a refused message releases its reservation", async () => {
  const r = await chatRig({ view: chatView({ food: 1n }), askLLM: async () => "" }); // model gives nothing: 503
  try {
    assert.equal((await quiet(() => r.chat("g1.testnet")))[0], 503);
    assert.equal((await r.allowance("g2.testnet")).left, 1, "her one thought is free again");
  } finally {
    r.srv.close();
  }
});

test("/allowance keeps live_state, live_balance and chat_credits_of a few seconds; a chat message reads them fresh", async () => {
  const counts = {};
  const r = await chatRig({ view: chatView({ counts }), askLLM: async () => "hi" });
  try {
    for (let i = 0; i < 5; i++) await r.allowance("guest.testnet");
    assert.equal(counts.live_state, 1);
    assert.equal(counts.live_balance, 1);
    assert.equal(counts.chat_credits_of, 1);
    await quiet(() => r.chat("guest.testnet"));
    assert.equal(counts.live_balance, 2, "the paid path does not trust the cache");
  } finally {
    r.srv.close();
  }
});

// ── gateway rig ──
async function agentServer(reply = { result: "THE PAID ANALYSIS" }) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/run`, calls: () => calls, close: () => srv.close() };
}
function gwRig({ jobs, food = 10n, state = "content", deliver = async () => ({}), getJob }) {
  const store = new Store(tmp(), "c.testnet", "s".repeat(64));
  const views = {};
  const view = async (m, a) => {
    views[m] = (views[m] || 0) + 1;
    if (m === "open_job_count") return jobs.length;
    if (m === "open_jobs") return jobs.slice(a.from_index ?? 0).filter(() => a.agent === "w.testnet").slice(0, Math.min(a.limit ?? 50, 50));
    if (m === "get_job") return getJob ? getJob(a.job_id) : jobs.find((j) => j.id === a.job_id) || null;
    if (m === "get_mind") return { owner: "owner.testnet" };
    if (m === "live_state") return state;
    if (m === "live_balance") return (COST * food).toString();
    if (m === "params") return { thought_cost: COST.toString() };
    return null;
  };
  const gw = makeGateway({ view, account: { functionCall: deliver }, contractId: "c.testnet", workerId: "w.testnet", store, plan: null, readToken: (t) => t });
  const get = async (p) => {
    let out;
    await gw.route({ method: "GET" }, null, new URL(`http://x/agent/${p}`), null, (code, obj) => (out = [code, obj]));
    return out;
  };
  return { gw, store, views, get };
}
const far = () => String((BigInt(Date.now()) + 3_600_000n) * 1_000_000n);

test("a stored result is hidden until the job is Delivered on chain (onJob and x402 resultOf)", async () => {
  const agent = await agentServer();
  try {
    const job = { id: 42, mind_id: 3, service_id: 9, buyer: "buyer.testnet", input: "analyse", deadline: far(), status: "Open" };
    const r = gwRig({ jobs: [job], deliver: async () => { throw new Error("Smart contract panicked: she is asleep: feed her to wake her (anyone can)"); } });
    r.store.setConn(3, { kind: "http", url: agent.url, name: "a", skills: [], connectedBy: "owner.testnet" }, "");
    await quiet(async () => {
      await r.gw.tick();
      await sleep(300);
    });
    assert.ok(r.store.result(42), "the result is kept (the on-chain record will point at it)");
    const [code, body] = await r.get("job/42?token=buyer.testnet");
    assert.equal(code, 200);
    assert.equal(body.result, null, "but not shown while the job is Open");
    assert.equal(r.gw.resultOf(42, "Open"), null);
    assert.equal(r.gw.resultOf(42, "Refunded"), null);
    assert.equal(r.gw.resultOf(42, null), null, "a closed job the gateway never saw delivered: hidden");
    job.status = "Delivered";
    assert.equal((await r.get("job/42?token=buyer.testnet"))[1].result.text, "THE PAID ANALYSIS");
    assert.equal(r.gw.resultOf(42, null).text, "THE PAID ANALYSIS", "once seen delivered, still shown after close_job");
  } finally {
    agent.close();
  }
});

test("after a successful delivery the result is marked delivered", async () => {
  const agent = await agentServer();
  try {
    const job = { id: 7, mind_id: 3, service_id: 9, buyer: "buyer.testnet", input: "go", deadline: far(), status: "Open" };
    const r = gwRig({ jobs: [job] });
    r.store.setConn(3, { kind: "http", url: agent.url, name: "a", skills: [], connectedBy: "owner.testnet" }, "");
    await quiet(async () => {
      await r.gw.tick();
      await sleep(300);
    });
    assert.equal(r.store.result(7).delivered, true);
    assert.equal(r.gw.resultOf(7, null).text, "THE PAID ANALYSIS");
  } finally {
    agent.close();
  }
});

test("the gateway reads every page of its open jobs (50 parked jobs can't hide the rest)", async () => {
  const agent = await agentServer();
  try {
    const jobs = [];
    for (let i = 0; i < 50; i++) jobs.push({ id: i, mind_id: 1, service_id: 1, buyer: "griefer.testnet", input: "x", deadline: far(), status: "Open" });
    for (let i = 50; i < 60; i++) jobs.push({ id: i, mind_id: 2, service_id: 1, buyer: "victim.testnet", input: "x", deadline: far(), status: "Open" });
    const r = gwRig({ jobs, food: 100n });
    r.store.setConn(1, { kind: "http", url: agent.url, name: "a", skills: [], connectedBy: "o.testnet" }, "");
    r.store.setConn(2, { kind: "http", url: agent.url, name: "b", skills: [], connectedBy: "p.testnet" }, "");
    for (let i = 0; i < 50; i++) r.store.setJob(i, { state: "asking", question: "?" });
    await quiet(async () => {
      await r.gw.tick();
      await sleep(400);
    });
    assert.equal(r.views.open_jobs, 2, "two pages read");
    assert.equal(agent.calls(), 10, "all ten jobs past the first page were worked");
  } finally {
    agent.close();
  }
});

test("a Mind asleep or too hungry for the thought: her agent is not run and no attempt is spent", async () => {
  const agent = await agentServer();
  try {
    for (const [state, food] of [["asleep", 10n], ["hungry", 0n]]) {
      const job = { id: 1, mind_id: 3, service_id: 9, buyer: "b.testnet", input: "go", deadline: far(), status: "Open" };
      let delivered = 0;
      const r = gwRig({ jobs: [job], state, food, deliver: async () => delivered++ });
      r.store.setConn(3, { kind: "http", url: agent.url, name: "a", skills: [], connectedBy: "owner.testnet" }, "");
      await quiet(async () => {
        await r.gw.tick();
        await sleep(100);
        await r.gw.tick(); // looked at again only after a minute
        await sleep(100);
      });
      assert.equal(agent.calls(), 0, state);
      assert.equal(delivered, 0);
      assert.equal(r.store.conn(3).lastError ?? null, null, "not a failure of her agent");
      assert.equal(r.views.live_state, 1, "the second tick waits out the minute");
    }
  } finally {
    agent.close();
  }
});

test("food for one thought: only one of her jobs runs at a time", async () => {
  const agent = await agentServer();
  try {
    const jobs = [1, 2, 3].map((id) => ({ id, mind_id: 3, service_id: 9, buyer: "b.testnet", input: "go", deadline: far(), status: "Open" }));
    const r = gwRig({ jobs, food: 1n });
    r.store.setConn(3, { kind: "http", url: agent.url, name: "a", skills: [], connectedBy: "owner.testnet" }, "");
    await quiet(async () => {
      await r.gw.tick();
      await sleep(300);
    });
    assert.equal(agent.calls(), 1);
  } finally {
    agent.close();
  }
});

test("URLs in errors lose their credentials, query and fragment; the API key is masked", () => {
  assert.equal(scrubUrls("can't reach an MCP server at http://127.0.0.1:1/mcp?token=MCPSECRET456 (fetch failed)"), "can't reach an MCP server at http://127.0.0.1:1 (fetch failed)");
  assert.equal(scrubUrls("GET https://u:pw@a.example.com/x#k=1 failed"), "GET https://a.example.com failed");
  assert.equal(scrubUrls("bad key sk-live-123456 rejected", ["sk-live-123456"]), "bad key *** rejected");
  assert.equal(scrubUrls("no url here"), "no url here");
});

test("a key in the agent URL never reaches /status last_error or the chat error", async () => {
  const store = new Store(tmp(), "c.testnet", "s".repeat(64));
  store.setConn(7, { kind: "a2a", url: "http://127.0.0.1:1/?api_key=SUPERSECRET123", name: "x", skills: [], connectedBy: "o.testnet" }, "");
  store.setConn(8, { kind: "mcp", url: "http://127.0.0.1:1/mcp?token=MCPSECRET456", name: "y", skills: [], connectedBy: "o.testnet" }, "APIKEY-789");
  store.setConn(9, { kind: "http", url: "https://a.example.com/run", name: "z", skills: [], connectedBy: "o.testnet", lastError: "old error from https://a.example.com/run?key=LEGACYSECRET" }, "");
  const gw = makeGateway({ view: async (m) => (m === "get_mind" ? { owner: "o.testnet" } : null), account: {}, contractId: "c.testnet", workerId: "w.testnet", store, plan: null, readToken: () => null });
  await gw.health();
  let out;
  await gw.route({ method: "GET" }, null, new URL("http://x/agent/status"), null, (c, o) => (out = o));
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /SUPERSECRET123|MCPSECRET456|LEGACYSECRET|APIKEY-789/);
  assert.ok(out.agents.find((a) => a.mind_id === 7).last_error, "the error itself is still shown");
  let chatErr = "";
  try {
    await gw.chat(7, "guest.testnet", "hello");
  } catch (e) {
    chatErr = e.message;
  }
  assert.ok(chatErr);
  assert.doesNotMatch(chatErr, /SUPERSECRET123/);
  assert.doesNotMatch(JSON.stringify(store.conn(7)) + JSON.stringify(store.conn(8)), /"lastError":"[^"]*(SUPERSECRET123|MCPSECRET456)/, "nor what is stored");
});

// ── x402 ──
test("number literals serde (no float_roundtrip) would refuse are caught as written", () => {
  for (const lit of ["1.7976931348623158e308", "1.79769313486231571e308", "17976931348623158" + "0".repeat(292), "-1.8e308", "1e309", "1" + "0".repeat(308), "0.1e310"])
    assert.equal(numberTooBig(lit), true, lit.slice(0, 40));
  for (const lit of ["1.7976931348623157e308", "1.79769313486231570e308", "-1.7976931348623157e308", "1e308", "9".repeat(308), "0", "0.0e999", "1e-400", "123.456"])
    assert.equal(numberTooBig(lit), false, lit.slice(0, 40));
  const raw = '{"token":"x","n":1.7976931348623158e308,"s":"1e999 in a string"}';
  assert.match(serdeRefuses(JSON.parse(raw), raw), /too large/, "JSON.parse rounds this to a finite double; serde may not");
  const fine = '{"token":"1e999","n":1.5e300}';
  assert.equal(serdeRefuses(JSON.parse(fine), fine), null, "digits inside strings don't count");
});

const CONTRACT = "hm.testnet", WRAP = "wrap.testnet";
const PRICE = 10_000_000_000_000_000_000_000n;
const AMOUNT = (PRICE + JOB_DEPOSIT).toString();
/** An x402 door with every chain read mocked. `views`: overrides (a value, or a function that may
 *  throw / hang). `logs`: what a relayed transaction logs. */
function x402Rig({ schema = null, views = {}, logs = ["job_order_refused buyer=buyer.testnet reason=refused"], gateway = null } = {}) {
  const key = KeyPair.fromRandom("ed25519");
  let nonce = 5n;
  let relayed = 0;
  const header = (text, row, { sender = "buyer.testnet", n } = {}) => {
    const args = { receiver_id: CONTRACT, amount: AMOUNT, msg: JSON.stringify({ service_id: 7, input: text }) };
    const delegateAction = { senderId: sender, receiverId: WRAP, actions: [transactions.functionCall("ft_transfer_call", args, 200_000_000_000_000n, 1n)], nonce: n ?? nonce++, maxBlockHeight: 1000n, publicKey: key.getPublicKey() };
    const hash = crypto.createHash("sha256").update(transactions.encodeDelegateAction(delegateAction)).digest();
    const signed = { delegateAction, signature: new transactions.Signature({ keyType: 0, data: key.sign(new Uint8Array(hash)).signature }) };
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: Buffer.from(transactions.encodeSignedDelegate(signed)).toString("base64") } })).toString("base64");
  };
  const base = {
    get_mind: { name: "M", ghost: false, owner: "keeper.testnet" },
    live_state: "content",
    params: { guest_min_price: "0" },
    agent_of: { account: "gw.testnet", about: "", since: 0 },
    services_for_mind: [{ id: 7, live: true, category: 7, price: PRICE.toString(), title: "svc", description: "", unit: "" }],
    input_schemas: [schema],
    jobs_of: [],
    get_job: null,
    open_count_of: 0,
    open_job_count: 0,
  };
  const view = async (m, a) => {
    const v = m in views ? views[m] : base[m];
    return typeof v === "function" ? v(a) : v;
  };
  const provider = {
    query: async () => ({ permission: "FullAccess", nonce: 4 }),
    block: async () => ({ header: { height: 500 } }),
    sendTransactionUntil: async () => ({}),
    txStatus: async () => ({ transaction: { hash: "H" }, transaction_outcome: { outcome: { status: { SuccessValue: "" } } }, receipts_outcome: [{ outcome: { logs } }] }),
  };
  const account = {
    accountId: "worker.testnet",
    connection: { provider },
    viewFunction: async ({ methodName }) => {
      if (methodName === "storage_balance_of") return { total: "1" };
      if (methodName === "ft_balance_of") return typeof views.ft_balance_of === "function" ? views.ft_balance_of() : "100000000000000000000000000";
      return null;
    },
    functionCall: async () => ({}),
    signTransaction: async () => {
      relayed++;
      return [new Uint8Array(32), {}];
    },
  };
  const x = makeX402({ view, account, contractId: CONTRACT, network: "testnet", secret: "s".repeat(64), gateway });
  const send = async (text, o = {}) => {
    const row = (await x.card(1))[1].x402.accepts[0];
    const h = o.header || header(text, row, o);
    const body = { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text }] } } };
    let out;
    const res = { writeHead: (c) => (out = { code: c }), end: (b) => (out.body = JSON.parse(b)) };
    await quiet(() => x.route({ method: "POST", headers: { "x-payment": h } }, res, new URL("http://l/agent/x402/1"), async () => body));
    out.header = h;
    return out;
  };
  const getCard = async () => {
    let out;
    const res = { writeHead: (c) => (out = { code: c }), end: (b) => (out.body = JSON.parse(b)) };
    await quiet(() => x.route({ method: "GET", headers: {} }, res, new URL("http://l/agent/x402/1"), async () => ({})));
    return out;
  };
  return { send, getCard, relayed: () => relayed };
}
const FORM = JSON.stringify({ type: "object", properties: { account: { type: "string" } }, required: ["account"] });

test("her owner or her agent ordering her services is refused before the relay", async () => {
  const r = x402Rig();
  const own = await r.send("hi", { sender: "keeper.testnet" });
  assert.equal(own.code, 402);
  assert.match(own.body.error, /your own Mind/);
  const ag = await r.send("hi", { sender: "gw.testnet" });
  assert.equal(ag.code, 402);
  assert.match(ag.body.error, /her own agent/);
  assert.equal(r.relayed(), 0);
});

test("required fields only count on a plain object, as own properties", async () => {
  const r = x402Rig({ schema: JSON.stringify({ type: "object", required: ["constructor"] }) });
  for (const input of ["{}", '[{"constructor":"x"}]', '"constructor"', "null"]) {
    const out = await r.send(input);
    assert.equal(out.code, 402, input);
    assert.match(out.body.error, /missing field: constructor/, input);
  }
  const r2 = x402Rig({ schema: FORM });
  assert.match((await r2.send('{"account":"x","n":1.7976931348623158e308}')).body.error, /too large/);
  assert.equal(r.relayed() + r2.relayed(), 0);
});

test("her queue, the contract's queue and the buyer's open jobs on her are checked before the relay", async () => {
  const full = await x402Rig({ views: { open_count_of: 20 } }).send("hi");
  assert.equal(full.code, 409);
  assert.match(full.body.error.message, /20 jobs waiting/);
  const queue = await x402Rig({ views: { open_job_count: 1000 } }).send("hi");
  assert.equal(queue.code, 409);
  assert.match(queue.body.error.message, /queue is full/);
  const mine = Array.from({ length: 5 }, (_, i) => ({ id: i, mind_id: 1, status: "Open" }));
  const five = await x402Rig({ views: { jobs_of: mine } }).send("hi");
  assert.equal(five.code, 402);
  assert.match(five.body.error, /5 open jobs with her/);
  const elsewhere = x402Rig({ views: { jobs_of: [...mine.map((j) => ({ ...j, mind_id: 2 })), { id: 9, mind_id: 1, status: "Delivered" }], get_job: { id: 77, mind_id: 1, status: "Delivered", result: "done" } }, logs: ["job_ordered id=77 service=7 mind=1 buyer=buyer.testnet price=1"] });
  const ok = await elsewhere.send("hi"); // delivered at once, so the call does not wait out WAIT_MS
  assert.equal(ok.code, 200, "open jobs on other Minds, or closed ones here, don't count");
});

test("a view that fails is a 503 'try again', never a relay on a guess", async () => {
  const boom = () => {
    throw new Error("RPC 502");
  };
  for (const v of ["jobs_of", "open_count_of", "open_job_count", "ft_balance_of"]) {
    const r = x402Rig({ views: { [v]: boom } });
    const out = await r.send("hi");
    assert.equal(out.code, 503, v);
    assert.match(out.body.error.message, /try again/);
    assert.equal(r.relayed(), 0, v);
  }
  const card = await x402Rig({ views: { services_for_mind: boom } }).getCard();
  assert.equal(card.code, 503, "the offer itself");
  const schemaDown = await x402Rig({ schema: FORM, views: { input_schemas: boom } }).getCard();
  assert.equal(schemaDown.code, 503, "a failed schema read is not 'no form'");
});

test("a refusal about her state is not held against the buyer; one about their payment is", async () => {
  const asleep = x402Rig({ logs: ["job_order_refused buyer=buyer.testnet reason=she is asleep: feed her to wake her (anyone can)"] });
  assert.equal((await asleep.send("hi")).code, 402);
  assert.equal((await asleep.send("hi again")).code, 402, "no 10-minute block");
  assert.equal(asleep.relayed(), 2);
  for (const reason of ["she has 20 jobs waiting: try again when one is delivered", "the job queue is full, try again later", "this service is paused", "attach the price plus 30000000000000000000000 yoctoNEAR storage deposit"]) {
    const r = x402Rig({ logs: [`job_order_refused buyer=buyer.testnet reason=${reason}`] });
    await r.send("a");
    assert.equal((await r.send("b")).code, 402, reason);
  }
  const own = x402Rig({ logs: ["job_order_refused buyer=buyer.testnet reason=missing field: account"] });
  await own.send("hi");
  assert.equal((await own.send("hi again")).code, 429, "the buyer's own input: blocked for a while");
  assert.equal(own.relayed(), 1);
});

test("the same signed payment sent again after its relay is a 409 'already relayed', not a 402", async () => {
  const r = x402Rig({ logs: ["job_order_refused buyer=buyer.testnet reason=she is asleep: feed her to wake her (anyone can)"] });
  const first = await r.send("hi");
  assert.equal(first.code, 402);
  const again = await r.send("hi", { header: first.header });
  assert.equal(again.code, 409);
  assert.match(again.body.error.message, /already relayed/);
  assert.equal(r.relayed(), 1);
});

test("a hanging chain read ends in a 503 within the per-read deadline, never relayed", async () => {
  const r = x402Rig({ views: { open_job_count: () => new Promise(() => {}) } });
  const t = Date.now();
  const out = await r.send("hi");
  assert.equal(out.code, 503);
  assert.ok(Date.now() - t < 12_000, "bounded by the 8 s read deadline");
  assert.equal(r.relayed(), 0);
});

test("x402 GetTask shows the full result only for a Delivered job", async () => {
  const results = { 5: { text: "FULL RESULT", files: [] } };
  const gateway = { resultOf: (id, status) => (status === "Delivered" ? results[id] : null), questionOf: () => null };
  let job = { id: 5, mind_id: 1, status: "Open", result: null, deadline: "1" };
  const r = x402Rig({ gateway, views: { get_job: () => job }, logs: ["job_ordered id=5 service=7 mind=1 buyer=buyer.testnet price=1"] });
  job = { ...job, status: "Delivered", result: "short" };
  const out = await r.send("hi");
  assert.equal(out.code, 200);
  assert.equal(out.body.result.task.artifacts[0].parts[0].text, "FULL RESULT");
});
