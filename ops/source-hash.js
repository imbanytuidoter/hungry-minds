// One hash over everything that ships: the contract source, the worker, the site and the SDK.
// qa/run.js stamps it when the whole suite passes; ops/deploy-live.js refuses to deploy a
// tree whose hash has no passing stamp, so nothing reaches live without QA on that exact code.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..");
const ROOTS = ["contract/src", "contract/Cargo.toml", "worker", "web/app", "web/components", "web/lib", "web/next.config.ts", "web/package.json", "sdk"];
const SKIP = /(^|[\\/])(node_modules|\.next[^\\/]*|target|\.chat-[^\\/]*|\.gateway-[^\\/]*|out|logs)([\\/]|$)/;
const EXT = /\.(rs|toml|js|cjs|mjs|ts|tsx|json|css)$/;

function files(p, acc = []) {
  const abs = path.join(REPO, p);
  if (!fs.existsSync(abs) || SKIP.test(p)) return acc;
  const st = fs.statSync(abs);
  if (st.isDirectory()) for (const f of fs.readdirSync(abs).sort()) files(path.join(p, f), acc);
  else if (EXT.test(p) && !/package-lock\.json$/.test(p)) acc.push(p.replace(/\\/g, "/"));
  return acc;
}

function sourceHash() {
  const h = crypto.createHash("sha256");
  for (const f of ROOTS.flatMap((r) => files(r))) {
    // line endings differ between editors on Windows; the code doesn't
    h.update(f + "\0" + fs.readFileSync(path.join(REPO, f), "utf8").replace(/\r\n/g, "\n") + "\0");
  }
  return h.digest("hex");
}

module.exports = { sourceHash, REPO };
if (require.main === module) console.log(sourceHash());
