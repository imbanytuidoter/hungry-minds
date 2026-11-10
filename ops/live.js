// Keeps the live testnet service up: the worker (chat, jobs, agent gateway) and the site.
// Restarts either one when it exits or stops answering, with a growing pause so a crash loop
// can't spin. Logs go to ops/logs/. Start it detached so it outlives the terminal:
//
//   node ops/live.js start     start the supervisor in the background (one at a time)
//   node ops/live.js stop      stop it and both services
//   node ops/live.js status    is it running, and are the services answering
//   node ops/live.js run       run in the foreground (what `start` launches)
//
// The site serves the build named in ops/live/site-dist.txt (default .next), so a deploy can
// build a fresh copy beside the running one and switch with no half-built window.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const STATE = path.join(__dirname, "live");
const LOGS = path.join(__dirname, "logs");
const PID = path.join(STATE, "supervisor.pid");
const DIST = path.join(STATE, "site-dist.txt");
const CONTRACT = process.env.LIVE_CONTRACT || "hungry-minds-8250f6.testnet";
const SITE_PORT = 3000;
const CHAT_PORT = 8788;
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const stamp = () => new Date().toISOString();
const note = (s) => fs.appendFileSync(path.join(LOGS, "supervisor.log"), `${stamp()} ${s}\n`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const running = () => {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, "utf8") : 0);
  return pid && alive(pid) ? pid : 0;
};
function freePort(port) {
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
}
async function answers(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

const SERVICES = {
  worker: {
    port: CHAT_PORT,
    health: `http://127.0.0.1:${CHAT_PORT}/agent/status`,
    spawn: () =>
      spawn(process.execPath, ["index.js"], {
        windowsHide: true,
        cwd: path.join(REPO, "worker"),
        env: { ...process.env, CONTRACT_ID: CONTRACT, WORKER_ID: "hm-worker-19652a.testnet", POLL_MS: "5000", GRACE_MS: "20000", NEAR_RPC: process.env.NEAR_RPC || "https://near-testnet.drpc.org" },
      }),
  },
  site: {
    port: SITE_PORT,
    health: `http://127.0.0.1:${SITE_PORT}/api/agent/status`,
    spawn: () => {
      const dist = fs.existsSync(DIST) ? fs.readFileSync(DIST, "utf8").trim() : ".next";
      return spawn(process.execPath, [path.join(REPO, "web/node_modules/next/dist/bin/next"), "start", "-p", String(SITE_PORT)], {
        cwd: path.join(REPO, "web"),
        env: { ...process.env, NEXT_DIST_DIR: dist, CHAT_SERVER_URL: `http://127.0.0.1:${CHAT_PORT}` },
      });
    },
  },
};

function supervise(name) {
  const s = SERVICES[name];
  let delay = 2000;
  let child = null;
  let misses = 0;
  const launch = () => {
    freePort(s.port);
    const log = fs.createWriteStream(path.join(LOGS, `${name}.log`), { flags: "a" });
    child = s.spawn();
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    note(`${name} started (pid ${child.pid})`);
    const startedAt = Date.now();
    child.on("exit", (code) => {
      note(`${name} exited (code ${code}); restarting in ${delay / 1000} s`);
      child = null;
      // a service that ran a while gets a fresh short pause; a crash loop backs off to 1 min
      delay = Date.now() - startedAt > 120_000 ? 2000 : Math.min(delay * 2, 60_000);
      setTimeout(launch, delay);
    });
  };
  launch();
  // a service that is up but stuck (no answer 3 times in a row) is restarted too
  setInterval(async () => {
    if (!child) return;
    if (await answers(s.health)) return void (misses = 0);
    if (++misses >= 3) {
      note(`${name} not answering ${misses}x: restarting`);
      misses = 0;
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
  }, 60_000);
  return () => child && spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
}

async function main(cmd) {
  if (cmd === "run") {
    if (running() && running() !== process.pid) return console.log(`already running (pid ${running()})`);
    fs.writeFileSync(PID, String(process.pid));
    note(`supervisor up (pid ${process.pid}) for ${CONTRACT}`);
    const stops = [supervise("worker"), supervise("site")];
    const quit = () => {
      stops.forEach((f) => f());
      note("supervisor stopped");
      try {
        fs.unlinkSync(PID);
      } catch {
        /* already gone */
      }
      process.exit(0);
    };
    process.on("SIGTERM", quit);
    process.on("SIGINT", quit);
    // ops/live/stop is the portable stop signal (Windows has no SIGTERM for detached processes)
    setInterval(() => fs.existsSync(path.join(STATE, "stop")) && (fs.unlinkSync(path.join(STATE, "stop")), quit()), 2000);
    return;
  }
  if (cmd === "start") {
    if (running()) return console.log(`already running (pid ${running()})`);
    const p = spawn(process.execPath, [__filename, "run"], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
    console.log(`supervisor started (pid ${p.pid}); logs in ops/logs/`);
    return;
  }
  if (cmd === "stop") {
    const pid = running();
    if (!pid) return console.log("not running");
    fs.writeFileSync(path.join(STATE, "stop"), "1");
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500));
    if (alive(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    freePort(SITE_PORT);
    freePort(CHAT_PORT);
    return console.log("stopped");
  }
  if (cmd === "restart-site") {
    // the supervisor restarts it with the build named in site-dist.txt
    freePort(SITE_PORT);
    return console.log("site restarting");
  }
  if (cmd === "restart-worker") {
    // the supervisor restarts it with the worker code now on disk
    freePort(CHAT_PORT);
    return console.log("worker restarting");
  }
  const pid = running();
  const [w, s] = await Promise.all([answers(SERVICES.worker.health), answers(SERVICES.site.health)]);
  console.log(`supervisor: ${pid ? `running (pid ${pid})` : "NOT running"} · worker: ${w ? "up" : "down"} · site: ${s ? "up" : "down"}`);
}

main(process.argv[2] || "status");
