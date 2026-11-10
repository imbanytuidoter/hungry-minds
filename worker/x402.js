// x402 door to a Mind's services: any agent or script can hire a Mind with one HTTP call,
// the way it hires an agent on NEAR Agent Market (A2A JSON-RPC + x402 v2), with no wallet
// popup and no gas of its own.
//
//   GET  /agent/x402/<mind id>   her card: name and live services (skills) with their prices
//   POST /agent/x402/<mind id>   A2A JSON-RPC: SendMessage (paid), GetTask (free)
//
// An unpaid SendMessage answers 402 with one `accepts` row per live service. The payment is
// a signed delegate action (NEP-366) from the buyer's own account: one call to our
// contract's `order_job({ service_id, input })` with the price plus the 0.03 NEAR storage
// deposit attached. The worker relays it and pays the gas; on chain it is the buyer's own
// order, so nothing about the job changes: the price waits in escrow, only her agent (or
// the colony worker) can deliver, delivery pays 90% to her owner and 10% to the protocol,
// and past the deadline the buyer is refunded. The buyer closes the job later to get the
// 0.03 NEAR deposit back (`close_job`).
//
// Unlike Agent Market, where the payment is a USDC `ft_transfer` on mainnet, here it is NEAR
// on testnet into the contract's escrow, so the row's `extra` says which call to sign.
//
// The task id returned is "<job id>.<tag>": the tag is an HMAC only this worker can make, so
// the task id is the credential for the full result (the on-chain result is public anyway).

const crypto = require("crypto");
const { utils, transactions } = require("near-api-js");
const { SCHEMA } = transactions;

const JOB_DEPOSIT = 30_000_000_000_000_000_000_000n; // 0.03 NEAR, the contract's JOB_DEPOSIT
const MAX_GAS = 300_000_000_000_000n;
const ORDER_GAS = "100000000000000";
const RELAY_GAS = "300000000000000";
const WAIT_MS = 25_000; // a SendMessage waits this long for a quick delivery before answering WORKING
const MAX_TIMEOUT_S = 600;

const b64json = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const toB64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode and check a signed delegate against the row the buyer accepted. Returns
 *  { signed, sender, serviceId, input } or throws with the reason. Pure: unit-tested. */
function checkPayment(headerValue, { contractId, network, text, rows }) {
  let p;
  try {
    p = b64json(headerValue);
  } catch {
    throw new Error("X-PAYMENT is not base64 JSON");
  }
  if (p?.x402Version !== 2) throw new Error("x402Version must be 2");
  const acc = p.accepted || {};
  const row = rows.find((r) => r.extra.service_id === acc?.extra?.service_id);
  if (!row) throw new Error("the accepted row is not one of this Mind's live services");
  if (acc.network !== `near:${network}` || acc.payTo !== contractId || acc.amount !== row.amount) throw new Error("the accepted row does not match this offer (network, payTo or amount)");
  const raw = p.payload?.signedDelegateAction;
  if (typeof raw !== "string" || !raw) throw new Error("payload.signedDelegateAction is missing");
  let signed;
  try {
    signed = utils.serialize.deserialize(SCHEMA.SignedDelegate, Buffer.from(raw, "base64"));
  } catch {
    throw new Error("signedDelegateAction is not a NEAR signed delegate");
  }
  const d = signed.delegateAction;
  if (d.receiverId !== contractId) throw new Error(`the delegate must call ${contractId}`);
  if (d.actions.length !== 1 || !d.actions[0].functionCall) throw new Error("the delegate must hold exactly one function call");
  const fc = d.actions[0].functionCall;
  if (fc.methodName !== "order_job") throw new Error("the delegate must call order_job");
  let args;
  try {
    args = JSON.parse(Buffer.from(fc.args).toString("utf8"));
  } catch {
    throw new Error("order_job args are not JSON");
  }
  if (args.service_id !== row.extra.service_id) throw new Error("order_job is for a different service than the accepted row");
  if (typeof args.input !== "string" || args.input !== text) throw new Error("order_job input must be the message text");
  if (BigInt(fc.deposit) !== BigInt(row.amount)) throw new Error(`attach exactly ${row.amount} yoctoNEAR (price + 0.03 NEAR storage deposit)`);
  if (BigInt(fc.gas) > MAX_GAS) throw new Error("too much gas");
  return { signed, sender: d.senderId, serviceId: args.service_id, input: args.input };
}

/** The job id from a relayed transaction's logs (`job_ordered id=N ... buyer=<sender>`). */
function orderedJobId(outcome, sender) {
  for (const r of outcome.receipts_outcome || []) {
    for (const line of r.outcome.logs || []) {
      const m = /^job_ordered id=(\d+) .* buyer=(\S+) /.exec(line);
      if (m && m[2] === sender) return Number(m[1]);
    }
  }
  return null;
}

/** The first failure message in a transaction outcome, if any. */
function failureOf(outcome) {
  for (const o of [outcome.transaction_outcome, ...(outcome.receipts_outcome || [])]) {
    const f = o?.outcome?.status?.Failure;
    if (f) {
      const s = JSON.stringify(f);
      const m = /"(?:panic_msg|ExecutionError)":"([^"]+)"/.exec(s);
      return m ? m[1] : s.slice(0, 300);
    }
  }
  return null;
}

function makeX402({ view, account, contractId, network, secret, gateway = null, publicUrl = "" }) {
  const used = new Set(); // payment headers already relayed (the chain's nonce also refuses a replay)
  const inFlight = new Set(); // one paid call per buyer at a time
  const tagOf = (jobId) => crypto.createHmac("sha256", secret).update(`x402:${contractId}:${jobId}`).digest("hex").slice(0, 24);
  const taskId = (jobId) => `${jobId}.${tagOf(jobId)}`;
  const jobOfTask = (id) => {
    const m = /^(\d+)\.([0-9a-f]{24})$/.exec(String(id || ""));
    if (!m) return null;
    const a = Buffer.from(m[2]), b = Buffer.from(tagOf(Number(m[1])));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(m[1]) : null;
  };

  async function offer(mindId) {
    const mind = await view("get_mind", { id: mindId }).catch(() => null);
    if (!mind) return null;
    const params = await view("params", {}).catch(() => null);
    const min = BigInt(params?.guest_min_price || "0");
    const services = (await view("services_for_mind", { mind_id: mindId }).catch(() => [])).filter((s) => s.live);
    const rows = services.map((s) => {
      const price = BigInt(s.price) > min ? BigInt(s.price) : min;
      return {
        scheme: "exact",
        network: `near:${network}`,
        asset: "near",
        amount: (price + JOB_DEPOSIT).toString(),
        payTo: contractId,
        maxTimeoutSeconds: MAX_TIMEOUT_S,
        description: `${s.title} (${utils.format.formatNearAmount(price.toString())} NEAR + 0.03 NEAR storage deposit, returned by close_job)`,
        extra: {
          method: "order_job",
          service_id: s.id,
          args: { service_id: s.id, input: "<the message text, exactly>" },
          gas: ORDER_GAS,
          price: price.toString(),
          storage_deposit: JOB_DEPOSIT.toString(),
          escrow: "held by the contract until delivery; refunded to the buyer past the deadline",
        },
      };
    });
    return { mind, services, rows };
  }

  async function card(mindId) {
    const o = await offer(mindId);
    if (!o) return [404, { error: "no such Mind" }];
    return [
      200,
      {
        name: o.mind.name,
        description: `A Hungry Minds NFT on NEAR ${network}. Hire her services with x402: each order is held in escrow by ${contractId} until delivery.`,
        url: `${publicUrl}/api/agent/x402/${mindId}`,
        protocolVersion: "1.0",
        capabilities: { streaming: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: o.services.map((s, i) => ({ id: `service-${s.id}`, name: s.title, description: s.description, price: o.rows[i].extra.price, unit: s.unit })),
        x402: { x402Version: 2, accepts: o.rows },
      },
    ];
  }

  const textOf = (msg) => (Array.isArray(msg?.parts) ? msg.parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim() : "");

  async function taskView(jobId, mindId) {
    const job = await view("get_job", { job_id: jobId }).catch(() => null);
    if (!job || job.mind_id !== mindId) return null;
    const id = taskId(jobId);
    if (job.status === "Delivered") {
      const full = gateway?.resultOf?.(jobId);
      const parts = [{ text: full?.text || job.result || "" }];
      for (const f of full?.files || []) parts.push({ text: `[file] ${f.name} (${f.mime}, ${f.size} bytes, sha256 ${f.sha256})` });
      return { id, contextId: id, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: `job-${jobId}`, parts }], metadata: { job_id: jobId, buyer: job.buyer } };
    }
    if (job.status === "Refunded") return { id, contextId: id, status: { state: "TASK_STATE_FAILED", message: { role: "ROLE_AGENT", parts: [{ text: "Not delivered in time: the price was refunded to the buyer." }] } }, metadata: { job_id: jobId } };
    const q = gateway?.questionOf?.(jobId);
    if (q) return { id, contextId: id, status: { state: "TASK_STATE_INPUT_REQUIRED", message: { role: "ROLE_AGENT", parts: [{ text: q }] } }, metadata: { job_id: jobId } };
    return { id, contextId: id, status: { state: "TASK_STATE_WORKING" }, metadata: { job_id: jobId, deadline_ns: job.deadline } };
  }

  async function sendMessage(mindId, params, paymentHeader, rpcId) {
    const msg = params?.message || {};
    const text = textOf(msg);
    if (!text) return [400, rpcErr(rpcId, -32602, "the message has no text")];

    // An answer to the agent's question continues a paid task: no new payment.
    if (msg.taskId) {
      const jobId = jobOfTask(msg.taskId);
      if (jobId === null) return [404, rpcErr(rpcId, -32001, "unknown task")];
      if (!gateway?.answerJob) return [409, rpcErr(rpcId, -32002, "this task is not waiting for an answer")];
      const err = await gateway.answerJob(jobId, text);
      if (err) return [409, rpcErr(rpcId, -32002, err)];
      return [200, { jsonrpc: "2.0", id: rpcId, result: { task: await taskView(jobId, mindId) } }];
    }

    const o = await offer(mindId);
    if (!o) return [404, rpcErr(rpcId, -32001, "no such Mind")];
    if (!o.rows.length) return [409, rpcErr(rpcId, -32002, `${o.mind.name} has no live services right now`)];
    const skill = params?.metadata?.skillId || msg.metadata?.skillId;
    const rows = skill ? o.rows.filter((r) => `service-${r.extra.service_id}` === skill) : o.rows;
    if (!rows.length) return [404, rpcErr(rpcId, -32001, `no live service ${skill}`)];
    if (!paymentHeader) return [402, { x402Version: 2, error: "payment required", accepts: rows }];

    let p;
    try {
      p = checkPayment(paymentHeader, { contractId, network, text, rows });
    } catch (e) {
      return [402, { x402Version: 2, error: e.message, accepts: rows }];
    }
    const key = crypto.createHash("sha256").update(paymentHeader).digest("hex");
    if (used.has(key)) return [402, { x402Version: 2, error: "this payment was already used", accepts: rows }];
    if (inFlight.has(p.sender)) return [429, rpcErr(rpcId, -32003, "one paid call at a time per account")];
    used.add(key);
    inFlight.add(p.sender);
    let outcome;
    try {
      outcome = await account.signAndSendTransaction({ receiverId: p.sender, actions: [new transactions.Action({ signedDelegate: { delegateAction: p.signed.delegateAction, signature: p.signed.signature } })] });
    } catch (e) {
      inFlight.delete(p.sender);
      return [402, { x402Version: 2, error: `the payment did not go through: ${String(e.message || e).slice(0, 300)}`, accepts: rows }];
    }
    inFlight.delete(p.sender);
    const jobId = orderedJobId(outcome, p.sender);
    if (jobId === null) return [402, { x402Version: 2, error: `order_job failed: ${failureOf(outcome) || "no job was ordered"}`, accepts: rows }];
    console.log(`x402: ${p.sender} ordered job ${jobId} (service ${p.serviceId}, mind ${mindId}), tx ${outcome.transaction.hash}`);

    // Give a quick agent the chance to finish inside this call.
    let task = await taskView(jobId, mindId);
    const until = Date.now() + WAIT_MS;
    while (task?.status.state === "TASK_STATE_WORKING" && Date.now() < until) {
      await sleep(2500);
      task = await taskView(jobId, mindId);
    }
    const receipt = { success: true, transaction: outcome.transaction.hash, network: `near:${network}`, payer: p.sender };
    return [200, { jsonrpc: "2.0", id: rpcId, result: { task } }, { "payment-response": toB64(receipt), "x-payment-response": toB64(receipt) }];
  }

  async function getTask(mindId, params, rpcId) {
    const jobId = jobOfTask(params?.id);
    if (jobId === null) return [404, rpcErr(rpcId, -32001, "unknown task")];
    const task = await taskView(jobId, mindId);
    if (!task) return [404, rpcErr(rpcId, -32001, "unknown task")];
    return [200, { jsonrpc: "2.0", id: rpcId, result: { task } }];
  }

  function rpcErr(id, code, message) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }

  async function route(req, res, url, readBody) {
    const out = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const m = /^\/agent\/x402\/(\d+)(\/\.well-known\/agent-card\.json)?$/.exec(url.pathname);
    if (!m) return out(404, { error: "not found" });
    const mindId = Number(m[1]);
    if (req.method === "GET") return out(...(await card(mindId)));
    if (req.method !== "POST" || m[2]) return out(405, { error: "use GET for the card, POST for A2A" });
    const body = await readBody(req, 20_000);
    const header = req.headers["x-payment"] || req.headers["payment-signature"] || "";
    if (body?.method === "SendMessage" || body?.method === "message/send") return out(...(await sendMessage(mindId, body.params, header, body.id)));
    if (body?.method === "GetTask" || body?.method === "tasks/get") return out(...(await getTask(mindId, body.params, body.id)));
    return out(400, rpcErr(body?.id, -32601, "supported methods: SendMessage, GetTask"));
  }

  return { route, card, checkPayment: (h, o) => checkPayment(h, { contractId, network, ...o }) };
}

module.exports = { makeX402, checkPayment, orderedJobId, failureOf, JOB_DEPOSIT };
