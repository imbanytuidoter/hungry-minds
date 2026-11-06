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
const CARGO_BIN = process.env.CARGO_BIN || "D:/dev/.cargo/bin";
const TOOLCHAIN = process.env.RUST_TOOLCHAIN || "+stable-x86_64-pc-windows-gnu";
const WASM = path.join(REPO, "contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm");
const PORTS = { chat: 8789, site: 3001, a2a: 9911 };

fs.mkdirSync(OUT, { recursive: true });
const log = (s) => {
  process.stdout.write(s + "\n");
  fs.appendFileSync(LOG, s + "\n");
};
const results = [];
const env = { ...process.env, PATH: `${CARGO_BIN}${path.delimiter}${process.env.PATH}`, NEAR_RPC: RPC, SHOT_DIR: OUT };

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
  const r = spawnSync(cmd, cmdArgs, { cwd: opts.cwd || REPO, env: { ...env, ...(opts.env || {}) }, shell: true, encoding: "utf8", timeout: opts.timeout || 900_000, maxBuffer: 64 * 1024 * 1024 });
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
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], { encoding: "utf8" });
}
function start(name, cmd, cmdArgs, cwd, extraEnv, port) {
  freePort(port);
  const out = fs.openSync(path.join(OUT, `${name}.log`), "w");
  const p = spawn(cmd, cmdArgs, { cwd, env: { ...env, ...extraEnv }, shell: true, stdio: ["ignore", out, out] });
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
  for (const s of servers) spawnSync("taskkill", ["/PID", String(s.p.pid), "/T", "/F"], { encoding: "utf8" });
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
      const give = Math.ceil(min + 1 - bal);
      await bank.sendMoney(id, BigInt(utils.format.parseNearAmount(String(give))));
      log(`  topped up ${id}: ${bal.toFixed(2)} + ${give} NEAR`);
    } else log(`  ${id}: ${bal.toFixed(2)} NEAR`);
  }
}

(async () => {
  const hash = sourceHash();
  log(`QA run ${new Date().toISOString()} · source ${hash.slice(0, 16)}… · log ${LOG}`);
  try {
    // 1. static checks
    step("contract unit tests", "cargo", [TOOLCHAIN, "test", "--lib", "--quiet"], { cwd: path.join(REPO, "contract") });
    step("worker unit tests", "node", ["--test"], { cwd: path.join(REPO, "worker") });
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
    await topUps().catch((e) => log("  top-up failed: " + e.message));

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

      // 5. the real site in Chrome
      if (!args.has("--no-ui")) {
        const ui = (name, file, role, account, extra = []) => step(name, "node", ["drive.js", file, role, account, ...extra], { cwd: __dirname, needPass: true, retry: 1, env: { PROFILE: path.join(os.tmpdir(), `hm-qa-${role}-${account.split(".")[0]}`) } });
        const fresh = `Qa${Date.now().toString(36).slice(-5)}`;
        ui("game: hatch, feed, chat, publish", "ui/e2e-ui.js", "owner", "bob-q1103.testnet", [fresh]);
        ui("game: guest orders the service", "ui/e2e-ui.js", "guest", "alice-q1103.testnet", [fresh]);
        ui("game: guest chat credits", "ui/e2e-ui.js", "guestchat", "alice-q1103.testnet", [fresh]);
        ui("game: claim and list for sale", "ui/e2e-ui.js", "sell", "bob-q1103.testnet", [fresh]);
        ui("game: buy the Mind", "ui/e2e-ui.js", "buy", "alice-q1103.testnet", [fresh]);
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
      step("live: every tab in every language", "node", ["drive.js", "ui/e2e-sweep.js", "http://localhost:3000"], { cwd: __dirname });
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
