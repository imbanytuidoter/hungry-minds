// Deploy to the live testnet contract, only code that passed the whole QA suite.
//
//   node ops/deploy-live.js
//
// 1. the source hash must match qa/out/last-pass.json (run `node qa/run.js` first)
// 2. the live contract must have enough free NEAR for the new code's storage
// 3. build the wasm, deploy it (state is kept), check a few views answer
// 4. build the site into a fresh folder beside the running one, switch the supervisor to it
// 5. check the live site and gateway answer

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { sourceHash, REPO } = require("./source-hash");

const LIVE = "hungry-minds-8250f6.testnet";
const RPC = process.env.NEAR_RPC || "https://near-testnet.drpc.org";
const CARGO_BIN = process.env.CARGO_BIN || "D:/dev/.cargo/bin";
const TOOLCHAIN = process.env.RUST_TOOLCHAIN || "+stable-x86_64-pc-windows-gnu";
const WASM = path.join(REPO, "contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm");
const env = { ...process.env, PATH: `${CARGO_BIN}${path.delimiter}${process.env.PATH}`, NEAR_RPC: RPC };

const die = (why) => {
  console.error(`\nDEPLOY REFUSED: ${why}`);
  process.exit(1);
};
function run(label, cmd, args, opts = {}) {
  console.log(`\n=== ${label}`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO, env: { ...env, ...(opts.env || {}) }, shell: true, stdio: "inherit", timeout: 900_000 });
  if (r.status !== 0) die(`${label} failed`);
}
async function view(method, args = {}) {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: LIVE, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) })).json();
  if (!r.result?.result) throw new Error(`${method}: ${JSON.stringify(r.error || r.result).slice(0, 160)}`);
  return JSON.parse(Buffer.from(r.result.result).toString());
}

(async () => {
  // 1. QA gate
  const stampFile = path.join(REPO, "qa/out/last-pass.json");
  const stamp = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, "utf8")) : null;
  const hash = sourceHash();
  if (!stamp) die("no passing QA run on record. Run `node qa/run.js` first.");
  if (stamp.hash !== hash) die(`this code was not tested (QA passed ${stamp.at} on a different version). Run \`node qa/run.js\` again.`);
  console.log(`QA passed on this exact code at ${stamp.at} (${stamp.steps} steps, ${stamp.checks} checks)`);

  // 2. build the wasm the QA run tested, check the contract can pay for its storage
  run("wasm build", "cargo", [TOOLCHAIN, "build", "--target", "wasm32-unknown-unknown", "--release", "--features", "demo-window"], { cwd: path.join(REPO, "contract"), env: { RUSTFLAGS: "--cfg near" } });
  const size = fs.statSync(WASM).size;
  const acct = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: LIVE } }) })).json()).result;
  const free = Number(BigInt(acct.amount) / 10n ** 21n) / 1000 - acct.storage_usage / 1e5;
  const old = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: LIVE } }) })).json()).result;
  const oldSize = old?.code_base64 ? Buffer.from(old.code_base64, "base64").length : 0;
  const extra = Math.max(0, size - oldSize) / 1e5; // storage costs 0.00001 NEAR a byte
  console.log(`live contract: ${free.toFixed(2)} NEAR free; code ${(oldSize / 1024).toFixed(0)} KB → ${(size / 1024).toFixed(0)} KB (+${extra.toFixed(2)} NEAR storage)`);
  if (free < 1 + extra) die(`only ${free.toFixed(2)} NEAR free on ${LIVE}, need ${(1 + extra).toFixed(2)}; top it up first`);

  // 3. deploy, then check it answers
  run("deploy to the live contract", "node", ["redeploy.js", LIVE, `"${WASM}"`], { cwd: path.join(REPO, "worker") });
  const supply = await view("supply_left");
  const official = await view("input_schemas", { ids: [0] });
  console.log(`live contract answers: supply_left ${supply}, input_schemas ok (${official.length})`);

  // 4. the site: a fresh build beside the running one, then switch
  const dist = `.next-live-${Date.now().toString(36)}`;
  run("live site build", "npx", ["next", "build"], { cwd: path.join(REPO, "web"), env: { NEXT_DIST_DIR: dist, NODE_OPTIONS: "--max-old-space-size=6144" } });
  fs.mkdirSync(path.join(__dirname, "live"), { recursive: true });
  const prev = fs.existsSync(path.join(__dirname, "live/site-dist.txt")) ? fs.readFileSync(path.join(__dirname, "live/site-dist.txt"), "utf8").trim() : null;
  fs.writeFileSync(path.join(__dirname, "live/site-dist.txt"), dist);
  // the supervisor serves the live site and worker; if it is down (the PC slept or rebooted,
  // its window was closed) start it, and it brings both up on the new code
  const sup = spawnSync("node", ["ops/live.js", "status"], { cwd: REPO, encoding: "utf8", shell: true }).stdout || "";
  if (/NOT running/.test(sup)) run("start the supervisor (it was not running)", "node", ["ops/live.js", "start"]);
  else {
    run("switch the site", "node", ["ops/live.js", "restart-site"]);
    run("restart the worker on the new code", "node", ["ops/live.js", "restart-worker"]);
  }

  // 5. check
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    up = await fetch("http://127.0.0.1:3000/api/agent/status").then((r) => r.ok).catch(() => false);
  }
  if (!up) die("the site did not come back on :3000 (is the supervisor running? `node ops/live.js status`)");
  if (prev && prev !== ".next" && prev !== dist) fs.rmSync(path.join(REPO, "web", prev), { recursive: true, force: true });
  console.log(`\nDEPLOYED ${hash.slice(0, 16)}… to ${LIVE}; site on :3000 serves ${dist}`);
})().catch((e) => die(e.message));
