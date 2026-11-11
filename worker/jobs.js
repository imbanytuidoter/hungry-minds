// Jobs for Minds that have no agent of their own (contract `agents.rs`): the worker reads
// the colony queue (`open_jobs` with no agent), answers each in the Mind's voice and calls
// `deliver_job` before its deadline. It also returns the price of any job, agent-run or
// not, whose deadline passed undelivered (`refund_job` may be called by anyone), so a buyer
// never has to come back for it.

const { clipUtf8, MAX_JOB_RESULT_BYTES } = require("./reply");

const GAS = "100000000000000"; // 100 Tgas: deliver_job settles her metabolism and pays out
// A failed attempt (the model was busy, an RPC hiccup) is tried again after a pause that
// grows, so a free model's "one reply per 45 s" limit isn't hammered; past MAX_ATTEMPTS or
// the deadline the job is left for the refund below.
const MAX_ATTEMPTS = 6;
const RETRY_MS = [0, 30_000, 60_000, 90_000, 120_000, 180_000];
const PAGE = 50; // the contract's cap on one open_jobs page
// A Mind too hungry (or asleep) to pay the thought deliver_job charges is looked at again
// after this long, without spending an attempt: someone may feed her before the deadline.
const NOT_READY_MS = 60_000;
const PARAMS_MS = 60_000;

function makeJobRunner({ account, view, contractId, answer, now = () => Date.now() }) {
  const inFlight = new Set();
  const attempts = new Map();
  const lastTry = new Map();
  const done = new Set();
  const services = new Map();
  const notReady = new Map(); // job id -> when the Mind was last found unable to pay
  const busyMinds = new Set(); // Minds with a delivery in flight
  let params = { at: -Infinity, cost: 0n };
  let lastRefundScan = -Infinity;

  async function service(id) {
    if (!services.has(id)) services.set(id, await view("get_service", { service_id: id }));
    return services.get(id);
  }

  async function thoughtCost() {
    if (now() - params.at > PARAMS_MS) params = { at: now(), cost: BigInt((await view("params", {}))?.thought_cost ?? 0) };
    return params.cost;
  }

  /** Can she pay the thought deliver_job charges her (awake, food >= thought cost)? Checked
   *  before the model is asked, so no model call is spent on a job the contract would refuse
   *  ("she is asleep: feed her to wake her"). */
  async function canThink(mindId) {
    const state = await view("live_state", { id: mindId });
    if (!state || state === "asleep" || state === "ghost") return false;
    const bal = BigInt((await view("live_balance", { id: mindId })) ?? 0);
    return bal >= (await thoughtCost());
  }

  /** Every open job of a Mind with no agent. open_jobs skips `from_index` in the list of ALL
   *  open jobs and then filters, so a page can be short in the middle of the list: walk the
   *  whole list in steps of PAGE (open_job_count long) and drop repeats. */
  async function colonyJobs(count) {
    const seen = new Map();
    for (let from = 0; from < count; from += PAGE) {
      for (const job of (await view("open_jobs", { from_index: from, limit: PAGE })) || []) seen.set(job.id, job);
    }
    return [...seen.values()];
  }

  async function deliver(job) {
    try {
      const s = await service(job.service_id);
      // Data services (categories below 7) need a real agent; the chat model would invent the
      // numbers. The contract refuses such orders without an agent; this covers older jobs.
      if (s && s.category < 7) {
        done.add(job.id);
        console.log(`job ${job.id}: "${s.title}" needs an agent, left for a refund at its deadline`);
        return;
      }
      if (!(await canThink(job.mind_id))) {
        notReady.set(job.id, now());
        return; // not an attempt: nothing was spent
      }
      notReady.delete(job.id);
    } catch (e) {
      console.error(`job ${job.id}: could not read her state:`, e.message);
      notReady.set(job.id, now());
      return;
    }
    const n = (attempts.get(job.id) || 0) + 1;
    attempts.set(job.id, n);
    lastTry.set(job.id, now());
    try {
      const s = await service(job.service_id);
      const prompt = `[Service: ${s?.title ?? "job"} — one ${s?.unit ?? "answer"}] ${job.input}`;
      // deliver_job takes at most 2000 BYTES; the reply is clipped by characters, so clip
      // again by bytes (never mid-character) or the delivery panics and is retried for nothing.
      const result = clipUtf8(await answer(job.mind_id, prompt, job.id), MAX_JOB_RESULT_BYTES);
      if (!result.trim()) throw new Error("empty result");
      await account.functionCall({ contractId, methodName: "deliver_job", args: { job_id: job.id, result }, gas: GAS, attachedDeposit: "0" });
      done.add(job.id);
      console.log(`job ${job.id} mind ${job.mind_id} delivered: ${result.slice(0, 70)}`);
    } catch (e) {
      console.error(`job ${job.id} attempt ${n}/${MAX_ATTEMPTS} failed:`, e.message);
    }
  }

  async function refund(job) {
    try {
      await account.functionCall({ contractId, methodName: "refund_job", args: { job_id: job.id }, gas: "30000000000000", attachedDeposit: "0" });
      done.add(job.id);
      console.log(`job ${job.id} passed its deadline undelivered: refunded ${job.buyer}`);
    } catch (e) {
      console.error(`job ${job.id} refund failed:`, e.message);
    }
  }

  // One pass over the queue; safe to call on every poll.
  async function tick() {
    const nowNs = BigInt(now()) * 1_000_000n;
    const count = Number(await view("open_job_count", {})) || 0;
    const mine = count > 0 ? await colonyJobs(count) : [];
    for (const job of mine) {
      const n = attempts.get(job.id) || 0;
      // a job that used up its attempts is skipped, the scan goes on to the others
      if (inFlight.has(job.id) || done.has(job.id) || n >= MAX_ATTEMPTS) continue;
      if (n && now() - (lastTry.get(job.id) || 0) < RETRY_MS[n]) continue; // wait before retrying
      if (now() - (notReady.get(job.id) ?? -Infinity) < NOT_READY_MS) continue; // she couldn't pay a minute ago
      if (BigInt(job.deadline) < nowNs) continue; // too late to deliver; refunded below
      // one delivery per Mind at a time: her food check must see the thought the previous
      // delivery spent, or a Mind fed for one thought would get the model asked for all her jobs
      if (busyMinds.has(job.mind_id)) continue;
      inFlight.add(job.id);
      busyMinds.add(job.mind_id);
      deliver(job).finally(() => {
        inFlight.delete(job.id);
        busyMinds.delete(job.mind_id);
      });
    }
    for (const id of notReady.keys()) if (!mine.some((j) => j.id === id)) notReady.delete(id);
    // Expired jobs of every Mind (agent-run ones included) go back to their buyers. Checked
    // once a minute: public RPCs rate-limit hard.
    if (now() - lastRefundScan < 60_000) return;
    lastRefundScan = now();
    if (count > 0) {
      for (let from = 0; from < count; from += 50) {
        const page = (await view("open_jobs_all", { from_index: from, limit: 50 }).catch(() => [])) || [];
        for (const job of page) {
          if (BigInt(job.deadline) + 5_000_000_000n < nowNs && !inFlight.has(job.id) && !done.has(job.id)) {
            inFlight.add(job.id);
            refund(job).finally(() => inFlight.delete(job.id));
          }
        }
      }
    }
  }

  return { tick };
}

// A Mind that starves on idle burn alone only falls asleep ON CHAIN when something settles her
// metabolism, and the ghost window counts from that moment (state.rs is_reapable). Nobody does
// that for a Mind nobody touches, so her countdown never started and she could never be reaped.
// The worker records it: `settle` is permissionless and only applies drain she already owes.
// A Mind is sent only when the live view says she is asleep while the chain does not, AND idle
// drain is pending (live balance below the stored one): then settle is sure to record the sleep
// (contract.rs settle_metabolism), so no gas goes on no-op calls. Once a minute; one try per
// Mind per 10 minutes. Runs on its own (not under JOBS=off); SLEEP=off turns it off.
const SLEEP_SCAN_MS = 60_000;
const SLEEP_RETRY_MS = 10 * 60_000;

function makeSleepRecorder({ account, view, contractId, now = () => Date.now(), log = console }) {
  const tried = new Map(); // mind id -> last attempt (ms)
  let lastScan = -Infinity;

  async function tick() {
    if (now() - lastScan < SLEEP_SCAN_MS) return [];
    lastScan = now();
    const sent = [];
    let total = Infinity;
    for (let from = 0; from < total; from += 60) {
      const snap = await view("colony_snapshot", { from_index: from, limit: 60 });
      if (!snap || !Array.isArray(snap.minds) || !snap.minds.length) break;
      total = Number(snap.total_minds) || 0;
      for (const row of snap.minds) {
        const m = row.mind;
        if (m.ghost || row.live_state !== "asleep" || Number(m.asleep_since) !== 0) continue;
        if (!(BigInt(row.live_balance) < BigInt(m.balance))) continue; // no idle drain pending: settle would change nothing
        if (now() - (tried.get(row.id) ?? -Infinity) < SLEEP_RETRY_MS) continue;
        tried.set(row.id, now());
        sent.push(row.id);
        // one at a time: the worker account also signs replies and deliveries, and a burst of
        // parallel calls from one key races its nonce
        await account
          .functionCall({ contractId, methodName: "settle", args: { id: row.id }, gas: "30000000000000", attachedDeposit: "0" })
          .then(() => log.log(`mind ${row.id} starved on idle burn: sleep recorded on chain, ghost window started`))
          .catch((e) => log.error(`settle ${row.id} failed:`, e.message));
      }
    }
    return sent;
  }

  return { tick };
}

module.exports = { makeJobRunner, makeSleepRecorder };
