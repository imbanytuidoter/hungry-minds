// End-to-end check of agents connected by URL (worker/gateway) on the QA contract:
//   A2A: the official-SDK test agent (qa/fixtures/a2a-agent.js, port 9911, key test-secret)
//   MCP: DeepWiki's public MCP server
// keeper bob-q1103 owns Mind 4; buyer alice-q1103.
//   node gateway-e2e.js [a2a|mcp|all]
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const WORKER = path.resolve(__dirname, "../../worker");
const { connect, keyStores } = require(path.join(WORKER, "node_modules/near-api-js"));
const { nep413Payload, signInText } = require(path.join(WORKER, "chat-auth"));

const C = "hm-qa-q1103b.testnet";
const GW = "http://127.0.0.1:8789";
const KEEPER = "bob-q1103.testnet", BUYER = "alice-q1103.testnet";
const MIND = 4;
const which = process.argv[2] || "all";
const N = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const out = [];
const ok = (c, label, extra = "") => {
  const line = `${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 160) : ""}`;
  out.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MILLI = 10n ** 21n;

(async () => {
  const ks = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: "https://near-testnet.drpc.org", keyStore: ks });
  const keeper = await near.account(KEEPER);
  const buyer = await near.account(BUYER);
  const view = (m, a = {}) => keeper.viewFunction({ contractId: C, methodName: m, args: a });
  const call = (acc, m, args, deposit = "0", gas = "100000000000000") => acc.functionCall({ contractId: C, methodName: m, args, gas, attachedDeposit: deposit });
  const value = (o) => JSON.parse(Buffer.from(o.status.SuccessValue || "", "base64").toString() || "null");

  async function session(acc) {
    const kp = await ks.getKey("testnet", acc.accountId);
    const message = signInText(acc.accountId, Date.now());
    const nonce = crypto.randomBytes(32);
    const hash = crypto.createHash("sha256").update(nep413Payload({ message, nonce, recipient: C })).digest();
    const { signature } = kp.sign(new Uint8Array(hash));
    const r = await fetch(`${GW}/session`, { method: "POST", body: JSON.stringify({ accountId: acc.accountId, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(signature).toString("base64"), message, nonce: nonce.toString("base64") }) });
    const j = await r.json();
    if (r.status !== 200) throw new Error("session " + JSON.stringify(j));
    return j.token;
  }
  const post = async (p, body) => {
    const r = await fetch(`${GW}/agent/${p}`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const get = async (p) => {
    const r = await fetch(`${GW}/agent/${p}`);
    return { status: r.status, data: r.headers.get("content-type")?.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };

  const kt = await session(keeper);
  const bt = await session(buyer);

  async function service(title, price, sla = 300) {
    let s = (await view("services_for_mind", { mind_id: MIND })).find((x) => x.title === title);
    if (!s) {
      const id = value(await call(keeper, "publish_job_service", { mind_id: MIND, title, description: "via the gateway", category: 2, price: (BigInt(price) * MILLI).toString(), unit: "job", sla_secs: sla, output: "text" }, (30n * MILLI).toString()));
      s = await view("get_service", { service_id: id });
    }
    return s;
  }
  async function order(s, input) {
    const o = await call(buyer, "order_job", { service_id: s.id, input }, (BigInt(s.price) + 30n * MILLI).toString());
    return value(o);
  }
  async function waitJob(id, until = (j) => j.status !== "Open", ms = 180_000) {
    const t = Date.now();
    let j;
    while (Date.now() - t < ms) {
      j = await view("get_job", { job_id: id });
      // the RPC is load-balanced: a node that hasn't caught up yet doesn't know a fresh job
      if (j && until(j)) return j;
      await sleep(4000);
    }
    return j;
  }

  // ── A2A ──
  if (which === "all" || which === "a2a") {
    const bad = await post("connect", { token: bt, mindId: MIND, kind: "a2a", url: "http://127.0.0.1:9911", apiKey: "test-secret" });
    ok(bad.status === 403, "a stranger can't connect an agent to someone else's Mind", bad.data.error);
    const c = await post("connect", { token: kt, mindId: MIND, kind: "a2a", url: "http://127.0.0.1:9911", apiKey: "test-secret" });
    ok(c.status === 200 && c.data.agent.skills.length === 2, "owner connects an A2A agent by URL; skills imported from its card", c.data.error || c.data.agent?.skills.map((s) => s.name).join(", "));
    await call(keeper, "set_agent", { mind_id: MIND, account_id: c.data.gateway, about: c.data.about }, (10n * MILLI).toString());
    const a = await view("agent_of", { mind_id: MIND });
    ok(a?.account === c.data.gateway, "on chain her agent is now the gateway", a?.about);
    const st = await get(`status?ids=${MIND}`);
    ok(st.data.agents?.[0]?.online && !JSON.stringify(st.data).includes("test-secret"), "status: online, and the API key is never shown", st.data.agents?.[0]?.name);

    let test = await post("test", { token: kt, mindId: MIND, text: "check alice.testnet" });
    // a rerun right after a previous one meets the "one test every few seconds" limit
    if (test.status === 429) {
      await sleep(9000);
      test = await post("test", { token: kt, mindId: MIND, text: "check alice.testnet" });
    }
    ok(test.status === 200 && /NEAR/.test(test.data.text), "owner tests the agent for free", test.data.text || test.data.error);

    const lookup = await service("NEAR account lookup", 20);
    const report = await service("Account CSV report", 30);
    const m0 = await view("get_mind", { id: MIND });

    const j1 = await order(lookup, "check imbanana.testnet");
    const d1 = await waitJob(j1);
    ok(d1.status === "Delivered" && /imbanana\.testnet: [0-9.]+ NEAR/.test(d1.result || ""), "A2A job delivered with real chain data", d1.result);
    const m1 = await view("get_mind", { id: MIND });
    // a job left open by an earlier suite may be delivered in the same window: every payment is 90%
    const gain = N(m1.owner_unclaimed) - N(m0.owner_unclaimed);
    ok(gain > 0.0179 && Math.abs(gain / 0.018 - Math.round(gain / 0.018)) < 0.01, "NFT owner got 90% of 0.02 (per job)", gain.toFixed(4));

    const j2 = await order(lookup, "check my account please");
    const asking = await (async () => {
      for (let i = 0; i < 40; i++) {
        const r = await get(`job/${j2}?token=${bt}`);
        if (r.data.waiting) return r.data;
        await sleep(3000);
      }
      return null;
    })();
    ok(!!asking && /Which NEAR account/.test(asking.question), "the agent asks the buyer a question; the job waits", asking?.question);
    const other = await get(`job/${j2}?token=${await session(await near.account("alice-q1103b.testnet"))}`);
    ok(other.status === 403, "nobody else can read the job", other.data.error);
    const ans = await post("answer", { token: bt, jobId: j2, text: "imbanana.testnet" });
    ok(ans.status === 200, "buyer answers");
    const d2 = await waitJob(j2);
    ok(d2.status === "Delivered" && /imbanana\.testnet/.test(d2.result || ""), "the same task continues and is delivered", d2.result);

    const j3 = await order(report, "report imbanana.testnet");
    const d3 = await waitJob(j3);
    ok(d3.status === "Delivered" && /full result \+ 1 file/.test(d3.result || "") && /sha256 [0-9a-f]{64}/.test(d3.result), "file result: on chain a link and the SHA-256 of everything", d3.result);
    const jr = await get(`job/${j3}?token=${bt}`);
    const f = jr.data.result?.files?.[0];
    ok(f && f.name.endsWith(".csv"), "the buyer sees the file", f && `${f.name} ${f.size} B`);
    if (f) {
      const file = await get(`file/${f.id}?token=${bt}`);
      const csv = file.data.toString();
      ok(file.status === 200 && csv.startsWith("account,balance_near") && crypto.createHash("sha256").update(file.data).digest("hex") === f.sha256, "downloaded CSV matches its hash", csv.split("\n")[1]);
      ok(file.headers.get("content-disposition")?.startsWith("attachment") && file.headers.get("content-security-policy") === "sandbox", "files are served as downloads, sandboxed");
      const digest = crypto.createHash("sha256").update(JSON.stringify({ text: jr.data.result.text, files: [f.sha256] })).digest("hex");
      ok(d3.result.includes(digest), "the on-chain SHA-256 matches the stored result");
    }

    const chat = await fetch(`${GW}/chat`, { method: "POST", body: JSON.stringify({ token: kt, mindId: MIND, prompt: "check hungry-minds-8250f6.testnet" }) }).then((r) => r.json());
    ok(/hungry-minds-8250f6\.testnet: [0-9.]+ NEAR/.test(chat.reply || "") && !!chat.via, "a task in the chat goes to her agent (real data, marked via her agent)", `${chat.via || "no via"}: ${chat.reply || chat.error}`);
    // small talk stays with the Mind herself, in her own voice (signed by NEAR AI when a key is set)
    const hi = await fetch(`${GW}/chat`, { method: "POST", body: JSON.stringify({ token: kt, mindId: MIND, prompt: "Hi! How are you feeling today?" }) }).then((r) => r.json());
    ok(!!hi.reply && !hi.via && !/NEAR, \d+ bytes of storage/.test(hi.reply), "small talk is answered by the Mind herself, not her agent", hi.reply || hi.error);
  }

  // ── MCP ──
  if (which === "all" || which === "mcp") {
    const c = await post("connect", { token: kt, mindId: MIND, kind: "mcp", url: "https://mcp.deepwiki.com/mcp" });
    ok(c.status === 200 && c.data.agent.skills.some((s) => s.id === "ask_wiki_question"), "owner connects a real MCP server (DeepWiki); its tools become skills", c.data.error || c.data.agent?.skills.map((s) => s.id).join(", "));
    const a = await view("agent_of", { mind_id: MIND });
    if (a?.account !== c.data.gateway) await call(keeper, "set_agent", { mind_id: MIND, account_id: c.data.gateway, about: c.data.about }, (10n * MILLI).toString());
    const s = await service("ask_wiki_question", 20, 600);
    const j = await order(s, '{"repoName":"near/near-sdk-rs","question":"In one sentence: what is near_sdk::Promise for?"}');
    const d = await waitJob(j, undefined, 300_000);
    ok(d.status === "Delivered" && /promise/i.test(d.result || ""), "MCP job with JSON arguments delivered", d.result);
    const j2 = await order(s, "In the repo near/near-sdk-rs, what does the #[private] attribute do? One sentence.");
    const d2 = await waitJob(j2, undefined, 300_000);
    ok(d2.status === "Delivered" && (d2.result || "").length > 20, "MCP job in plain words (the colony model fills the tool's arguments)", d2.result);
    const chat = await fetch(`${GW}/chat`, { method: "POST", body: JSON.stringify({ token: kt, mindId: MIND, prompt: "What pages does the wiki of near/near-sdk-rs have?" }) }).then((r) => r.json());
    ok(/Storage|SDK|Promise/i.test(chat.reply || ""), "chat with an MCP agent picks the right tool", (chat.reply || chat.error || "").slice(0, 120));
  }

  console.log("\n" + out.join("\n"));
  console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed`);
})().catch((e) => {
  console.log(out.join("\n"));
  console.error("ERROR", e.stack || e);
});
