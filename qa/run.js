// The whole QA suite in one command, against the QA contract (hm-qa-q1103b.testnet) and the
// real outside services the agents use. Exit code 0 only if nothing failed; then it stamps
// qa/out/last-pass.json with the source hash, which ops/deploy-live.js requires.
//
//   node qa/run.js              everything (static checks, builds, QA deploy, chain + UI suites, live smoke)
//   node qa/run.js --skip-build reuse the last wasm and .next-qa build (no QA redeploy)
//   node qa/run.js --no-ui      skip the browser suites
//   node qa/run.js --skip-build --only="agent by url"   just the steps whose name contains it (no stamp)
//
// Needs: the QA keys in ~/.near-credentials/testnet (bob-q1103, alice-q1103, alice-q1103b,
// bob-q1103b, hm-worker-19652a, hm-qa-q1103b), Chrome, Rust (wasm32 target), Node 20+.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sourceHash, REPO } = require("../ops/source-hash");

const QA = "hm-qa-q1103b.testnet";
const RPC = process.env.NEAR_RPC || "https://near-testnet.drpc.org";
const OUT = path.join(__dirname, "out");
const LOG = path.join(OUT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const args = new Set(process.argv.slice(2));
// --only="agent by url": run just the steps whose name contains this (servers still start;
// combine with --skip-build); such a run never stamps
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).toLowerCase();
// cargo comes from PATH; CARGO_BIN puts another toolchain first
const CARGO_BIN = process.env.CARGO_BIN || "";
const TOOLCHAIN = process.env.RUST_TOOLCHAIN || "+stable-x86_64-pc-windows-gnu";
const WASM = path.join(REPO, "contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm");
const PORTS = { chat: 8789, site: 3001, a2a: 9911 };

fs.mkdirSync(OUT, { recursive: true });
const log = (s) => {
  process.stdout.write(s + "\n");
  fs.appendFileSync(LOG, s + "\n");
};
const results = [];
const env = { ...process.env, PATH: CARGO_BIN ? `${CARGO_BIN}${path.delimiter}${process.env.PATH}` : process.env.PATH, NEAR_RPC: RPC, SHOT_DIR: OUT };
// --no-near-ai: the QA worker answers with the free open model instead of NEAR AI, so a run
// spends none of the NEAR AI credits (the Verified-badge check is skipped then)
if (args.has("--no-near-ai")) env.NEAR_AI = "off";

/** Run a command to the end; record a step that passes on exit 0 (and no FAIL lines). Steps
 *  that lean on outside services (Polymarket, DeepWiki, NEAR RPC, the open model) pass
 *  `retry: 1`: one more try, since their outages are not our bugs; a second failure fails. */
function step(name, cmd, cmdArgs, opts = {}) {
  if (ONLY && !name.toLowerCase().includes(ONLY)) return true; // --only: just the named suites
  if (opts.retry && !run(name, cmd, cmdArgs, { ...opts, record: false })) {
    log(`  … retrying ${name} once (it depends on outside services)`);
    return run(name, cmd, cmdArgs, opts);
  }
  if (opts.retry) return results.push({ name, ok: true, pass: lastPass, fails: 0 }), true;
  return run(name, cmd, cmdArgs, opts);
}
let lastPass = 0;
function run(name, cmd, cmdArgs, opts) {
  log(`\n=== ${name}`);
  const t = Date.now();
  const r = spawnSync(cmd, cmdArgs, { windowsHide: true, cwd: opts.cwd || REPO, env: { ...env, ...(opts.env || {}) }, shell: true, encoding: "utf8", timeout: opts.timeout || 900_000, maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  fs.appendFileSync(LOG, text);
  const lines = text.split(/\r?\n/);
  const pass = lines.filter((l) => /\bPASS\s{1,2}\S/.test(l)).length;
  const fails = lines.filter((l) => /\bFAIL\s{1,2}\S|STEPS CRASHED|^ERROR\b|"ERROR/.test(l));
  const ok = r.status === 0 && fails.length === 0 && !(opts.needPass && pass === 0);
  for (const l of lines.filter((l) => /\b(PASS|FAIL)\s{1,2}\S/.test(l))) log("  " + l.trim().replace(/^"|",?$/g, ""));
  if (!ok) {
    for (const l of fails.slice(0, 10)) if (!/\bFAIL\s{1,2}\S/.test(l)) log("  " + l.trim());
    if (r.status !== 0 && !fails.length) log(text.trim().split(/\r?\n/).slice(-12).map((l) => "  | " + l).join("\n"));
  }
  log(`--- ${ok ? "OK" : "FAILED"} ${name} (${pass} checks passed, ${Math.round((Date.now() - t) / 1000)} s)`);
  lastPass = pass;
  if (opts.record !== false) results.push({ name, ok, pass, fails: fails.length });
  return ok;
}

// ── servers the suites need, started and stopped here ──
const servers = [];
function freePort(port) {
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, encoding: "utf8" });
}
function start(name, cmd, cmdArgs, cwd, extraEnv, port) {
  freePort(port);
  const out = fs.openSync(path.join(OUT, `${name}.log`), "w");
  const p = spawn(cmd, cmdArgs, { windowsHide: true, cwd, env: { ...env, ...extraEnv }, shell: true, stdio: ["ignore", out, out] });
  servers.push({ name, p, port });
  return p;
}
async function waitFor(url, ms = 90_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
function stopAll() {
  for (const s of servers) spawnSync("taskkill", ["/PID", String(s.p.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  for (const s of servers) freePort(s.port);
}

// ── test accounts need a little testnet NEAR; top them up from bob-q1103b ──
// Each run hatches a Mind (1 NEAR, most of it into the QA contract's treasury) and buys one,
// so the bank is refilled from that treasury (withdraw_treasury, as the contract account):
// the suite recycles its own testnet NEAR instead of draining it.
async function topUps() {
  const { connect, keyStores, utils } = require(path.join(REPO, "worker/node_modules/near-api-js"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials")) });
  const BANK = "bob-q1103b.testnet";
  const bank = await near.account(BANK);
  const nearOf = async (id) => Number(BigInt((await (await near.account(id)).state()).amount) / 10n ** 21n) / 1000;
  const want = [["alice-q1103.testnet", 6], ["bob-q1103.testnet", 3], ["alice-q1103b.testnet", 1]];
  // The QA keepers' Minds earn from every run (guest chat, jobs) and nobody claims it, so the test
  // NEAR piles up in the contract. Claim it, and send what a keeper has above its own need to the bank.
  const minds = [];
  for (let from = 0; ; from += 60) {
    const s = await bank.viewFunction({ contractId: QA, methodName: "colony_snapshot", args: { from_index: from, limit: 60 } });
    minds.push(...s.minds);
    if (s.minds.length < 60) break;
  }
  for (const [id, min] of want) {
    const mine = minds.filter((x) => x.mind.owner === id && BigInt(x.mind.owner_unclaimed || "0") >= 5n * 10n ** 22n);
    if (!mine.length) continue;
    const acc = await near.account(id);
    for (const x of mine) await acc.functionCall({ contractId: QA, methodName: "claim_earnings", args: { id: x.id }, gas: "30000000000000", attachedDeposit: "0" });
    const spare = Math.floor((await nearOf(id)) - (min + 2));
    if (spare > 0) await acc.sendMoney(BANK, BigInt(utils.format.parseNearAmount(String(spare))));
    log(`  ${id} claimed its QA Minds' earnings (${mine.length} Minds)${spare > 0 ? `, ${spare} NEAR to the bank` : ""}`);
  }
  let need = 2; // keep a little in the bank for gas
  for (const [id, min] of want) need += Math.max(0, Math.ceil(min + 1 - (await nearOf(id))));
  const have = await nearOf(BANK);
  if (have < need) {
    const qa = await near.account(QA);
    const treasury = Number(BigInt(await qa.viewFunction({ contractId: QA, methodName: "treasury_balance", args: {} })) / 10n ** 21n) / 1000;
    const take = Math.min(Math.ceil(need - have + 5), Math.floor(treasury - 0.5));
    if (take > 0) {
      await qa.functionCall({ contractId: QA, methodName: "withdraw_treasury", args: { receiver_id: BANK, amount: utils.format.parseNearAmount(String(take)) }, gas: "30000000000000", attachedDeposit: "0" });
      log(`  refilled the bank from the QA treasury: +${take} NEAR (treasury had ${treasury.toFixed(2)})`);
    } else log(`  the bank has ${have.toFixed(2)} NEAR and the QA treasury ${treasury.toFixed(2)}: top up ${BANK} by hand`);
  }
  for (const [id, min] of want) {
    const bal = await nearOf(id);
    if (bal < min) {
      // give what the bank can spare: a partial top-up still lets most suites run
      const give = Math.min(Math.ceil(min + 1 - bal), Math.floor((await nearOf(BANK)) - 1));
      if (give <= 0) { log(`  ${id}: ${bal.toFixed(2)} NEAR, the bank is empty: top up ${BANK} by hand`); continue; }
      await bank.sendMoney(id, BigInt(utils.format.parseNearAmount(String(give))));
      log(`  topped up ${id}: ${bal.toFixed(2)} + ${give} NEAR`);
    } else log(`  ${id}: ${bal.toFixed(2)} NEAR`);
  }
}

// ── QA buyers close their finished orders ──
// The contract refuses a 51st order that is not closed (agents.rs order_job), and several suites
// order without closing, so every run starts by closing what is finished (Delivered/Refunded).
// Each close returns the job's 0.03 NEAR deposit to the buyer. `dry` only counts.
const QA_BUYERS = ["alice-q1103.testnet", "alice-q1103b.testnet", "bob-q1103.testnet"];
async function closeFinishedJobs(dry = false) {
  const { connect, keyStores } = require(path.join(REPO, "worker/node_modules/near-api-js"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials")) });
  for (const id of QA_BUYERS) {
    try {
      const acc = await near.account(id);
      const jobs = await acc.viewFunction({ contractId: QA, methodName: "jobs_of", args: { account_id: id } });
      // an open job past its deadline (its agent was offline) is refunded first, so it can be closed
      const late = jobs.filter((j) => j.status === "Open" && BigInt(j.deadline) < BigInt(Date.now()) * 1_000_000n);
      if (!dry) for (const j of late) await acc.functionCall({ contractId: QA, methodName: "refund_job", args: { job_id: j.id }, gas: "30000000000000", attachedDeposit: "0" }).then(() => (j.status = "Refunded"), () => {});
      const done = jobs.filter((j) => j.status !== "Open");
      if (!dry) for (const j of done) await acc.functionCall({ contractId: QA, methodName: "close_job", args: { job_id: j.id }, gas: "30000000000000", attachedDeposit: "0" });
      log(`  ${id}: ${jobs.length} orders not closed, ${dry ? "would close" : "closed"} ${done.length} finished`);
    } catch (e) {
      log(`  ${id}: closing finished orders failed: ${e.message}`);
    }
  }
}
// ── the suites' shared test Mind must be awake ──
// Every agent/order suite works with bob-q1103's Mind #4 (UiQa2). Minds burn food just by living
// (about 0.02 NEAR a day), so between runs she starves to sleep and every order fails with
// "she is asleep". Her keeper feeds her first, as a real owner would (95% becomes her food).
const TEST_MINDS = [4, 11]; // 11: Pip, whom the x402 suite hires
async function feedTestMinds() {
  const { connect, keyStores, utils } = require(path.join(REPO, "worker/node_modules/near-api-js"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials")) });
  const keeper = await near.account("bob-q1103.testnet");
  const fmt = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(3);
  for (const id of TEST_MINDS) {
    try {
      const m = await keeper.viewFunction({ contractId: QA, methodName: "get_mind", args: { id } });
      if (!m || m.ghost) {
        log(`  Mind #${id}: ${m ? "a ghost" : "missing"}, can't be fed: the agent suites will fail`);
        continue;
      }
      const live = BigInt((await keeper.viewFunction({ contractId: QA, methodName: "live_balance", args: { id } })) || "0");
      if (live >= 50_000_000_000_000_000_000_000n) {
        log(`  Mind #${id} ${m.name}: ${fmt(live)} NEAR of food`);
        continue;
      }
      await keeper.functionCall({ contractId: QA, methodName: "feed", args: { id }, gas: "50000000000000", attachedDeposit: utils.format.parseNearAmount("0.1") });
      log(`  Mind #${id} ${m.name}: had ${fmt(live)} NEAR of food, her keeper fed her 0.1 NEAR`);
    } catch (e) {
      log(`  Mind #${id}: feeding failed: ${e.message}`);
    }
  }
}
if (require.main === module && process.argv.includes("--count-orders")) {
  closeFinishedJobs(true).then(() => process.exit(0));
  return;
}

(async () => {
  const hash = sourceHash();
  log(`QA run ${new Date().toISOString()} · source ${hash.slice(0, 16)}… · log ${LOG}`);
  try {
    // 1. static checks
    step("contract unit tests", "cargo", [TOOLCHAIN, "test", "--lib", "--quiet"], { cwd: path.join(REPO, "contract") });
    step("worker unit tests", "node", ["--test"], { cwd: path.join(REPO, "worker") });
    step("SDK unit tests", "node", ["--test"], { cwd: path.join(REPO, "sdk") });
    step("site typecheck", "npx", ["tsc", "--noEmit", "-p", "."], { cwd: path.join(REPO, "web") });
    step("site lint", "npx", ["eslint", "components", "lib", "app"], { cwd: path.join(REPO, "web") });

    // 2. build what we test, put it on the QA contract
    if (!args.has("--skip-build")) {
      step("wasm build", "cargo", [TOOLCHAIN, "build", "--target", "wasm32-unknown-unknown", "--release", "--features", "demo-window"], { cwd: path.join(REPO, "contract"), env: { RUSTFLAGS: "--cfg near" } });
      step("deploy to the QA contract", "node", ["redeploy.js", QA, `"${WASM}"`], { cwd: path.join(REPO, "worker") });
      freePort(PORTS.site);
      step("QA site build", "npx", ["next", "build"], { cwd: path.join(REPO, "web"), env: { NEXT_DIST_DIR: ".next-qa", NEXT_PUBLIC_CONTRACT_ID: QA, NEXT_PUBLIC_QA_SIGNIN: "1", NODE_OPTIONS: "--max-old-space-size=6144" } });
    }
    log("\n=== test accounts");
    // a public RPC hiccup ("Internal server error") must not leave the test accounts dry
    for (let i = 1; i <= 3; i++) {
      const err = await topUps().then(() => null, (e) => e);
      if (!err) break;
      log(`  top-up attempt ${i} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await closeFinishedJobs();
    await feedTestMinds();

    // 3. the servers
    start("qa-worker", "node", ["index.js"], path.join(REPO, "worker"), { CONTRACT_ID: QA, WORKER_ID: "hm-worker-19652a.testnet", CHAT_PORT: String(PORTS.chat), GATEWAY_ALLOW_LOCAL: "1", POLL_MS: "4000", GRACE_MS: "20000" }, PORTS.chat);
    start("a2a-agent", "node", ["fixtures/a2a-agent.js"], __dirname, { PORT: String(PORTS.a2a) }, PORTS.a2a);
    start("qa-site", "npx", ["next", "start", "-p", String(PORTS.site)], path.join(REPO, "web"), { NEXT_DIST_DIR: ".next-qa", CHAT_SERVER_URL: `http://127.0.0.1:${PORTS.chat}` }, PORTS.site);
    const up = (await waitFor(`http://127.0.0.1:${PORTS.chat}/agent/status`)) && (await waitFor(`http://127.0.0.1:${PORTS.a2a}/.well-known/agent-card.json`)) && (await waitFor(`http://localhost:${PORTS.site}/app`));
    log(`\n=== servers ${up ? "up" : "NOT UP"} (worker ${PORTS.chat}, site ${PORTS.site}, A2A fixture ${PORTS.a2a})`);
    results.push({ name: "servers", ok: up, pass: up ? 1 : 0, fails: up ? 0 : 1 });

    if (up) {
      // 4. chain-level suites (order matters: later ones reuse Mind 4's state)
      step("official agents on real data", "node", ["chain/official-test.js"], { cwd: __dirname, needPass: true, retry: 1 });
      step("connector kinds (HTTPS, OpenAI-compatible)", "node", ["chain/kinds-test.js"], { cwd: __dirname, needPass: true, retry: 1 });
      step("SDK agent end to end", "node", ["chain/agents-e2e.js"], { cwd: __dirname, needPass: true, retry: 1 });
      step("gateway: A2A + MCP end to end", "node", ["chain/gateway-e2e.js", "all"], { cwd: __dirname, needPass: true, retry: 1, timeout: 1_200_000 });
      step("x402: hire a Mind over A2A, gasless", "node", ["chain/x402-e2e.js"], { cwd: __dirname, needPass: true, retry: 1 });

      // 5. the real site in Chrome
      if (!args.has("--no-ui")) {
        // prof: whose browser profile to use (default: one per role), retry: 0 for a step that can only be seen once
        const ui = (name, file, role, account, extra = [], { prof = role, retry = 1 } = {}) => step(name, "node", ["drive.js", file, role, account, ...extra], { cwd: __dirname, needPass: true, retry, env: { PROFILE: path.join(os.tmpdir(), `hm-qa-${prof}-${account.split(".")[0]}`) } });
        const fresh = `Qa${Date.now().toString(36).slice(-5)}`;
        ui("game: hatch, feed, chat, publish", "ui/e2e-ui.js", "owner", "bob-q1103.testnet", [fresh]);
        ui("game: guest orders the service", "ui/e2e-ui.js", "guest", "alice-q1103.testnet", [fresh]);
        ui("game: guest chat credits", "ui/e2e-ui.js", "guestchat", "alice-q1103.testnet", [fresh]);
        ui("game: claim and list for sale", "ui/e2e-ui.js", "sell", "bob-q1103.testnet", [fresh]);
        ui("game: buy the Mind", "ui/e2e-ui.js", "buy", "alice-q1103.testnet", [fresh]);
        // the seller's own browser (the "sell" profile) sees the real sale once
        ui("game: seller sees the sale, then the marketplace", "ui/e2e-ui.js", "sold", "bob-q1103.testnet", [fresh], { prof: "sell", retry: 0 });
        ui("agent by URL: owner connects", "ui/agent-ui.js", "keeper", "bob-q1103.testnet");
        ui("agent by URL: buyer orders, answers, gets a file", "ui/agent-ui.js", "buyer", "alice-q1103.testnet");
        ui("official agent: owner connects and publishes", "ui/agent-ui2.js", "keeper", "bob-q1103.testnet");
        ui("official agent: Navigator, form, result", "ui/agent-ui2.js", "buyer", "alice-q1103.testnet");
        ui("look: the hatch draft survives a reload", "ui/look-ui.js", "draft", "anon");
        ui("look: restyle saves on chain", "ui/look-ui.js", "restyle", "bob-q1103.testnet", ["Penny"]);
      }
      step("data services need an agent (on chain)", "node", ["chain/agent-only-check.js"], { cwd: __dirname, needPass: true });
      step("NFT standard: wallets and outside marketplaces", "node", ["chain/nft-standard.js"], { cwd: __dirname, needPass: true, retry: 1 });
    }

    // 6. the live site, read only (skipped when it isn't running)
    if (!args.has("--no-ui") && (await waitFor("http://localhost:3000/app", 3000))) {
      step("live: first visit", "node", ["drive.js", "ui/e2e-main.js"], { cwd: __dirname, needPass: true });
      step("live: every tab", "node", ["drive.js", "ui/e2e-sweep.js", "http://localhost:3000"], { cwd: __dirname });
    } else log("\n=== live site not running on :3000: live smoke skipped");
  } finally {
    stopAll();
  }

  const failed = results.filter((r) => !r.ok);
  const checks = results.reduce((a, r) => a + r.pass, 0);
  log(`\n${"=".repeat(60)}\n${failed.length ? "FAILED" : "ALL PASSED"}: ${results.length - failed.length}/${results.length} steps, ${checks} checks`);
  for (const r of failed) log(`  ✗ ${r.name}`);
  // stamp only the exact code that was tested (an edit during the run means a new run)
  const unchanged = sourceHash() === hash;
  if (ONLY) log("--only run: not stamped (a deploy needs the whole suite)");
  else if (!failed.length && unchanged) {
    fs.writeFileSync(path.join(OUT, "last-pass.json"), JSON.stringify({ hash, at: new Date().toISOString(), steps: results.length, checks }, null, 2));
    log(`stamped qa/out/last-pass.json: live deploys of this code are allowed`);
  } else if (!failed.length) log("the code changed during the run: not stamped, run it again");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  log("RUNNER CRASHED: " + (e.stack || e));
  stopAll();
  process.exit(2);
});
