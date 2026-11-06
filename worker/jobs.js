// Jobs for Minds that have no agent of their own (contract `agents.rs`): the worker reads
// the colony queue (`open_jobs` with no agent), answers each in the Mind's voice and calls
// `deliver_job` before its deadline. It also returns the price of any job, agent-run or
// not, whose deadline passed undelivered (`refund_job` may be called by anyone), so a buyer
// never has to come back for it.

const GAS = "100000000000000"; // 100 Tgas: deliver_job settles her metabolism and pays out
// A failed attempt (the model was busy, an RPC hiccup) is tried again after a pause that
// grows, so a free model's "one reply per 45 s" limit isn't hammered; past MAX_ATTEMPTS or
// the deadline the job is left for the refund below.
const MAX_ATTEMPTS = 6;
const RETRY_MS = [0, 30_000, 60_000, 90_000, 120_000, 180_000];

function makeJobRunner({ account, view, contractId, answer }) {
  const inFlight = new Set();
  const attempts = new Map();
  const lastTry = new Map();
  const done = new Set();
  const services = new Map();
  let lastRefundScan = 0;

  async function service(id) {
    if (!services.has(id)) services.set(id, await view("get_service", { service_id: id }));
    return services.get(id);
  }

  async function deliver(job) {
    const n = (attempts.get(job.id) || 0) + 1;
    attempts.set(job.id, n);
    lastTry.set(job.id, Date.now());
    try {
      const s = await service(job.service_id);
      // Data services (categories below 7) need a real agent; the chat model would invent the
      // numbers. The contract refuses such orders without an agent; this covers older jobs.
      if (s && s.category < 7) {
        done.add(job.id);
        console.log(`job ${job.id}: "${s.title}" needs an agent, left for a refund at its deadline`);
        return;
      }
      const prompt = `[Service: ${s?.title ?? "job"} — one ${s?.unit ?? "answer"}] ${job.input}`;
      const result = await answer(job.mind_id, prompt, job.id);
      if (!result) throw new Error("empty result");
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
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const mine = await view("open_jobs", {});
    for (const job of mine) {
      const n = attempts.get(job.id) || 0;
      if (inFlight.has(job.id) || done.has(job.id) || n >= MAX_ATTEMPTS) continue;
      if (n && Date.now() - (lastTry.get(job.id) || 0) < RETRY_MS[n]) continue; // wait before retrying
      if (BigInt(job.deadline) < nowNs) continue; // too late to deliver; refunded below
      inFlight.add(job.id);
      deliver(job).finally(() => inFlight.delete(job.id));
    }
    // Expired jobs of every Mind (agent-run ones included) go back to their buyers. Checked
    // once a minute: public RPCs rate-limit hard.
    if (Date.now() - lastRefundScan < 60_000) return;
    lastRefundScan = Date.now();
    const count = await view("open_job_count", {});
    if (count > 0) {
      for (let from = 0; from < count; from += 50) {
        const page = await view("open_jobs_all", { from_index: from, limit: 50 }).catch(() => []);
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

module.exports = { makeJobRunner };
