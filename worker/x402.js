// x402 door to a Mind's services: any agent or script can hire a Mind with one HTTP call,
// the way it hires an agent on NEAR Agent Market (A2A JSON-RPC + x402 v2), with no wallet
// popup and no gas of its own.
//
//   GET  /agent/x402/<mind id>   her card: name and live services (skills) with their prices
//   POST /agent/x402/<mind id>   A2A JSON-RPC: SendMessage (paid), GetTask (free)
//
// An unpaid SendMessage answers 402 with one `accepts` row per service she can take now. The
// payment works like Agent Market's USDC payment, in wNEAR: a signed delegate action (NEP-366)
// from the buyer's own account calling `ft_transfer_call` on the wNEAR contract, which moves
// price + 0.03 NEAR of the buyer's wNEAR to our contract with the order in `msg`. The worker
// relays it and pays only the gas and the 1 yoctoNEAR the token standard asks for (in a meta
// transaction the relayer pays every attached deposit, which is why the order is paid in
// tokens and not with an attached deposit). The contract (`ft_on_transfer`, agents.rs) checks
// the order, unwraps the wNEAR and places the same escrowed job for the buyer: only her agent
// (or the colony worker) can deliver, delivery pays 90% to her owner and 10% to the protocol,
// and past the deadline the buyer is refunded. A refused order gives the buyer's tokens back.
//
// Before relaying, the worker checks that the delegate is exactly that one call for the row
// the buyer accepted, that it is validly signed by a full-access key of the buyer's account
// with a fresh nonce and is not expired, and that the buyer holds the wNEAR; relays are rate
// limited. So a bad payment costs the worker nothing.
//
// The task id returned is "<job id>.<tag>": the tag is an HMAC only this worker can make, so
// the task id is the credential for the full result (the on-chain result is public anyway).

const crypto = require("crypto");
const { utils, transactions } = require("near-api-js");
const { SCHEMA } = transactions;

const JOB_DEPOSIT = 30_000_000_000_000_000_000_000n; // 0.03 NEAR, the contract's JOB_DEPOSIT
const AGENT_ONLY_CATEGORIES = 7; // the contract's: categories below this need her agent
const MAX_INPUT = 1000; // the contract's MAX_JOB_INPUT (bytes)
const MIN_GAS = 150_000_000_000_000n; // ft_transfer_call → ft_on_transfer → unwrap → order
const MAX_GAS = 300_000_000_000_000n;
const PAY_GAS = "200000000000000";
const WAIT_MS = 25_000; // a SendMessage waits this long for a quick delivery before answering WORKING
const MAX_TIMEOUT_S = 600;
const RELAYS_PER_MIN = 30;
const MAX_USED = 10_000;

const wrapOf = (network) => (network === "mainnet" ? "wrap.near" : "wrap.testnet");
const b64json = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const toB64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode and check a signed delegate against the row the buyer accepted. Returns
 *  { signed, sender, serviceId, input } or throws with the reason. Pure: unit-tested. */
function checkPayment(headerValue, { contractId, network, text, rows }) {
  const wrap = wrapOf(network);
  let p;
  try {
    p = b64json(headerValue);
  } catch {
    throw new Error("X-PAYMENT is not base64 JSON");
  }
  if (p?.x402Version !== 2) throw new Error("x402Version must be 2");
  const acc = p.accepted || {};
  const row = rows.find((r) => r.extra.service_id === acc?.extra?.service_id);
  if (!row) throw new Error("the accepted row is not one of this Mind's services she can take now");
  if (acc.network !== `near:${network}` || acc.payTo !== contractId || acc.asset !== wrap || acc.amount !== row.amount) throw new Error("the accepted row does not match this offer (network, asset, payTo or amount)");
  const raw = p.payload?.signedDelegateAction;
  if (typeof raw !== "string" || !raw) throw new Error("payload.signedDelegateAction is missing");
  let signed;
  try {
    signed = utils.serialize.deserialize(SCHEMA.SignedDelegate, Buffer.from(raw, "base64"));
  } catch {
    throw new Error("signedDelegateAction is not a NEAR signed delegate");
  }
  const d = signed.delegateAction;
  if (d.receiverId !== wrap) throw new Error(`the delegate must call ${wrap}`);
  if (d.actions.length !== 1 || !d.actions[0].functionCall) throw new Error("the delegate must hold exactly one function call");
  const fc = d.actions[0].functionCall;
  if (fc.methodName !== "ft_transfer_call") throw new Error("the delegate must call ft_transfer_call");
  if (BigInt(fc.deposit) !== 1n) throw new Error("attach exactly 1 yoctoNEAR (the token standard's security deposit)");
  if (BigInt(fc.gas) < MIN_GAS || BigInt(fc.gas) > MAX_GAS) throw new Error("gas must be between 150 and 300 Tgas");
  let args, order;
  try {
    args = JSON.parse(Buffer.from(fc.args).toString("utf8"));
    order = JSON.parse(args.msg);
  } catch {
    throw new Error("ft_transfer_call args (and their msg) must be JSON");
  }
  if (args.receiver_id !== contractId) throw new Error(`ft_transfer_call must send to ${contractId}`);
  if (String(args.amount) !== row.amount) throw new Error(`send exactly ${row.amount} (price + 0.03 NEAR storage deposit, in wNEAR)`);
  if (order?.service_id !== row.extra.service_id) throw new Error("msg is for a different service than the accepted row");
  if (typeof order.input !== "string" || order.input !== text) throw new Error("msg input must be the message text");
  return { signed, sender: d.senderId, serviceId: order.service_id, input: order.input, amount: row.amount };
}

/** The delegate's public key (ed25519 only), whether decoded from borsh or built in memory. */
function keyOf(d) {
  const k = d.publicKey;
  if (k?.ed25519Key) return new utils.PublicKey({ keyType: 0, data: Uint8Array.from(k.ed25519Key.data) });
  if (k?.keyType === 0 && k.data) return new utils.PublicKey({ keyType: 0, data: Uint8Array.from(k.data) });
  throw new Error("only ed25519 keys are supported");
}

/** The signature over the delegate (NEP-366: sha256 of the prefixed borsh) is the sender key's. */
function signatureOk(signed) {
  try {
    const hash = crypto.createHash("sha256").update(transactions.encodeDelegateAction(signed.delegateAction)).digest();
    const sig = signed.signature.ed25519Signature?.data ?? signed.signature.data;
    return keyOf(signed.delegateAction).verify(new Uint8Array(hash), Uint8Array.from(sig));
  } catch {
    return false;
  }
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

/** Why the order was refused: the contract's `job_order_refused` log, or the first failure. */
function failureOf(outcome, sender = null) {
  for (const r of outcome.receipts_outcome || []) {
    for (const line of r.outcome.logs || []) {
      const m = /^job_order_refused buyer=(\S+) reason=(.*)$/.exec(line);
      if (m && (!sender || m[1] === sender)) return m[2];
    }
  }
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
  const wrap = wrapOf(network);
  const provider = account.connection.provider;
  const used = new Set(); // payment headers already relayed (the chain's nonce also refuses a replay)
  const inFlight = new Set(); // one paid call per buyer at a time
  const relays = []; // timestamps of the last minute's relays
  const tagOf = (jobId) => crypto.createHmac("sha256", secret).update(`x402:${contractId}:${jobId}`).digest("hex").slice(0, 24);
  const taskId = (jobId) => `${jobId}.${tagOf(jobId)}`;
  const jobOfTask = (id) => {
    const m = /^(\d+)\.([0-9a-f]{24})$/.exec(String(id || ""));
    if (!m) return null;
    const a = Buffer.from(m[2]), b = Buffer.from(tagOf(Number(m[1])));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(m[1]) : null;
  };
  const ftView = (method, args) => account.viewFunction({ contractId: wrap, methodName: method, args });
  // Our contract needs a wNEAR storage registration to receive ft_transfer_call (checked, then remembered).
  let reg = false;
  async function isRegistered() {
    if (!reg) reg = !!(await ftView("storage_balance_of", { account_id: contractId }).catch(() => null));
    return reg;
  }
  /** Register our contract with wNEAR once (the worker pays the token's small storage fee). */
  async function ensureRegistered() {
    if (await isRegistered()) return true;
    try {
      const b = await ftView("storage_balance_bounds", {});
      await account.functionCall({ contractId: wrap, methodName: "storage_deposit", args: { account_id: contractId, registration_only: true }, gas: "30000000000000", attachedDeposit: b.min });
      console.log(`x402: registered ${contractId} with ${wrap} (${utils.format.formatNearAmount(b.min)} NEAR storage)`);
      reg = false;
      return await isRegistered();
    } catch (e) {
      console.error(`x402: could not register ${contractId} with ${wrap}:`, e.message);
      return false;
    }
  }
  void ensureRegistered();

  /** The rows for the services she can take right now (live, awake, agent present if needed). */
  async function offer(mindId) {
    const mind = await view("get_mind", { id: mindId }).catch(() => null);
    if (!mind) return null;
    const state = await view("live_state", { id: mindId }).catch(() => null);
    const awake = !mind.ghost && state !== "asleep" && state !== "ghost";
    const params = await view("params", {}).catch(() => null);
    const min = BigInt(params?.guest_min_price || "0");
    const hasAgent = !!(await view("agent_of", { mind_id: mindId }).catch(() => null));
    const all = (await view("services_for_mind", { mind_id: mindId }).catch(() => [])).filter((s) => s.live);
    const services = awake ? all.filter((s) => s.category >= AGENT_ONLY_CATEGORIES || hasAgent) : [];
    const rows = services.map((s) => {
      const price = BigInt(s.price) > min ? BigInt(s.price) : min;
      const amount = (price + JOB_DEPOSIT).toString();
      return {
        scheme: "exact",
        network: `near:${network}`,
        asset: wrap,
        amount,
        payTo: contractId,
        maxTimeoutSeconds: MAX_TIMEOUT_S,
        description: `${s.title} (${utils.format.formatNearAmount(price.toString())} NEAR + 0.03 NEAR storage deposit, returned by close_job; paid in wNEAR)`,
        extra: {
          method: "ft_transfer_call",
          service_id: s.id,
          args: { receiver_id: contractId, amount, msg: JSON.stringify({ service_id: s.id, input: "<the message text, exactly>" }) },
          deposit: "1",
          gas: PAY_GAS,
          price: price.toString(),
          storage_deposit: JOB_DEPOSIT.toString(),
          escrow: "held by the contract until delivery; refunded to the buyer past the deadline",
        },
      };
    });
    return { mind, awake, services, rows };
  }

  async function card(mindId) {
    const o = await offer(mindId);
    if (!o) return [404, { error: "no such Mind" }];
    return [
      200,
      {
        name: o.mind.name,
        description: `A Hungry Minds NFT on NEAR ${network}. Hire her services with x402 (paid in wNEAR): each order is held in escrow by ${contractId} until delivery.${o.awake ? "" : " She is asleep right now: feed her to wake her."}`,
        url: `${publicUrl}/api/agent/x402/${mindId}`,
        version: "1.0.0",
        protocolVersion: "1.0",
        capabilities: { streaming: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: o.services.map((s, i) => ({ id: `service-${s.id}`, name: s.title, description: s.description, tags: [s.unit].filter(Boolean), price: o.rows[i].extra.price })),
        x402: { x402Version: 2, accepts: o.rows },
      },
    ];
  }

  const textOf = (msg) => (Array.isArray(msg?.parts) ? msg.parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim() : "");

  async function taskView(jobId, mindId) {
    const id = taskId(jobId);
    const job = await view("get_job", { job_id: jobId }).catch(() => null);
    if (!job) {
      // closed (close_job deletes the record) or not visible yet on this RPC node
      const full = gateway?.resultOf?.(jobId);
      if (full) return { id, contextId: id, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: `job-${jobId}`, parts: [{ text: full.text || "" }] }], metadata: { job_id: jobId } };
      return { id, contextId: id, status: { state: "TASK_STATE_WORKING" }, metadata: { job_id: jobId } };
    }
    if (job.mind_id !== mindId) return null;
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

  /** Everything the chain must agree to before the worker spends gas on a relay. */
  async function preflight(p) {
    if (!signatureOk(p.signed)) return "the delegate's signature is not valid";
    const d = p.signed.delegateAction;
    let key;
    try {
      key = await provider.query({ request_type: "view_access_key", finality: "final", account_id: p.sender, public_key: keyOf(d).toString() });
    } catch {
      return `${keyOf(d).toString()} is not a key of ${p.sender}`;
    }
    if (key.permission !== "FullAccess") return "sign with a full-access key (ft_transfer_call attaches 1 yoctoNEAR)";
    if (BigInt(d.nonce) <= BigInt(key.nonce)) return "the delegate's nonce is already used: sign a new payment";
    const { header } = await provider.block({ finality: "final" });
    if (BigInt(d.maxBlockHeight) <= BigInt(header.height)) return "the delegate has expired: sign a new payment";
    if (BigInt(d.maxBlockHeight) > BigInt(header.height) + 2_000n) return "the delegate lives too long (at most 2000 blocks)";
    const bal = await ftView("ft_balance_of", { account_id: p.sender }).catch(() => "0");
    if (BigInt(bal || "0") < BigInt(p.amount)) return `${p.sender} holds too little wNEAR on ${wrap}: wrap NEAR first (near_deposit)`;
    return null;
  }

  /** Relay the signed delegate. The transaction is signed here so its hash is known: a payment
   *  runs through several receipts (transfer, unwrap, order), and a public RPC may give up
   *  waiting ("Internal server error", a timeout) while it still lands, so on an RPC error the
   *  outcome is read back by hash instead of reporting a failure that did not happen. */
  async function relay(p) {
    const action = new transactions.Action({ signedDelegate: { delegateAction: p.signed.delegateAction, signature: p.signed.signature } });
    for (let attempt = 1; ; attempt++) {
      const [hash, signedTx] = await account.signTransaction(p.sender, [action]);
      const txHash = utils.serialize.base_encode(hash);
      try {
        return await provider.sendTransaction(signedTx);
      } catch (e) {
        // the worker's key also signs replies and deliveries: on a nonce clash, sign again fresh
        if (/nonce/i.test(String(e.message || e)) && attempt < 4) {
          if (account.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
          await sleep(500 * attempt);
          continue;
        }
        const until = Date.now() + 90_000;
        while (Date.now() < until) {
          await sleep(3000);
          const out = await provider.txStatus(txHash, account.accountId, "EXECUTED_OPTIMISTIC").catch(() => null);
          if (out?.receipts_outcome?.length) return out;
        }
        throw e;
      }
    }
  }

  async function sendMessage(mindId, params, paymentHeader, rpcId) {
    const msg = params?.message || {};
    const text = textOf(msg);
    if (!text) return [400, rpcErr(rpcId, -32602, "the message has no text")];
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT) return [400, rpcErr(rpcId, -32602, `the message is longer than ${MAX_INPUT} bytes`)];

    // An answer to the agent's question continues a paid task: no new payment.
    if (msg.taskId) {
      const jobId = jobOfTask(msg.taskId);
      if (jobId === null) return [404, rpcErr(rpcId, -32001, "unknown task")];
      const job = await view("get_job", { job_id: jobId }).catch(() => null);
      if (!job || job.mind_id !== mindId) return [404, rpcErr(rpcId, -32001, "unknown task")];
      if (!gateway?.answerJob) return [409, rpcErr(rpcId, -32002, "this task is not waiting for an answer")];
      const err = await gateway.answerJob(jobId, text);
      if (err) return [409, rpcErr(rpcId, -32002, err)];
      return [200, { jsonrpc: "2.0", id: rpcId, result: { task: await taskView(jobId, mindId) } }];
    }

    const o = await offer(mindId);
    if (!o) return [404, rpcErr(rpcId, -32001, "no such Mind")];
    if (!o.rows.length) return [409, rpcErr(rpcId, -32002, o.awake ? `${o.mind.name} has no service she can take right now` : `${o.mind.name} is asleep: feed her to wake her`)];
    const skill = params?.metadata?.skillId || msg.metadata?.skillId;
    const rows = skill ? o.rows.filter((r) => `service-${r.extra.service_id}` === skill) : o.rows;
    if (!rows.length) return [404, rpcErr(rpcId, -32001, `no service ${skill} she can take right now`)];
    if (!(await isRegistered())) return [503, rpcErr(rpcId, -32004, `${contractId} is not registered with ${wrap} yet, so it cannot receive wNEAR`)];
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
    const t = Date.now();
    while (relays.length && relays[0] < t - 60_000) relays.shift();
    if (relays.length >= RELAYS_PER_MIN) return [429, rpcErr(rpcId, -32003, "too many paid calls right now, try again in a minute")];
    inFlight.add(p.sender);
    let outcome;
    try {
      const why = await preflight(p);
      if (why) return [402, { x402Version: 2, error: why, accepts: rows }];
      used.add(key);
      if (used.size > MAX_USED) used.delete(used.values().next().value);
      relays.push(Date.now());
      outcome = await relay(p);
    } catch (e) {
      return [402, { x402Version: 2, error: `the payment did not go through: ${String(e.message || e).slice(0, 300)}`, accepts: rows }];
    } finally {
      inFlight.delete(p.sender);
    }
    const jobId = orderedJobId(outcome, p.sender);
    if (jobId === null) return [402, { x402Version: 2, error: `the order was refused, your wNEAR was returned: ${failureOf(outcome, p.sender) || "no job was placed"}`, accepts: rows }];
    console.log(`x402: ${p.sender} ordered job ${jobId} (service ${p.serviceId}, mind ${mindId}), tx ${outcome.transaction.hash}`);

    // Give a quick agent the chance to finish inside this call.
    let task = await taskView(jobId, mindId);
    const until = Date.now() + WAIT_MS;
    while (task?.status.state === "TASK_STATE_WORKING" && Date.now() < until) {
      await sleep(2500);
      task = (await taskView(jobId, mindId)) || task;
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
    let body;
    try {
      body = await readBody(req, 20_000);
    } catch (e) {
      return out(e.status === 413 ? 413 : 400, rpcErr(null, -32700, e.status === 413 ? "the request is too large" : "parse error"));
    }
    const header = req.headers["x-payment"] || req.headers["payment-signature"] || "";
    if (body?.method === "SendMessage" || body?.method === "message/send") return out(...(await sendMessage(mindId, body.params, header, body.id)));
    if (body?.method === "GetTask" || body?.method === "tasks/get") return out(...(await getTask(mindId, body.params, body.id)));
    return out(400, rpcErr(body?.id, -32601, "supported methods: SendMessage, GetTask"));
  }


  return { route, card, isRegistered };
}

module.exports = { makeX402, checkPayment, signatureOk, orderedJobId, failureOf, JOB_DEPOSIT, wrapOf };
