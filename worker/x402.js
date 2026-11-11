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
// and past the deadline the buyer is refunded. A refused order gives the buyer's tokens back
// (in NEAR if it is refused after the unwrap); wNEAR above the price is never unwrapped.
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
  // The chain parses these bytes with serde, stricter than JSON.parse (duplicate keys, extra
  // fields, 18.0 for 18, bad UTF-8): accept only the exact canonical bytes, so nothing that
  // passes here can fail there at the relayer's cost.
  const canonical = JSON.stringify({ receiver_id: contractId, amount: row.amount, msg: JSON.stringify({ service_id: row.extra.service_id, input: text }) });
  if (!Buffer.from(fc.args).equals(Buffer.from(canonical, "utf8"))) throw new Error(`ft_transfer_call args must be exactly ${canonical}`);
  if (!d.publicKey?.ed25519Key) throw new Error("only ed25519 keys are supported");
  const dedupe = `${d.senderId}:${keyOf(d).toString()}:${d.nonce}`;
  return { signed, sender: d.senderId, serviceId: order.service_id, input: order.input, amount: row.amount, dedupe };
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
  const used = new Set(); // delegates already relayed, as sender:key:nonce (the header's wording doesn't matter)
  const topNonce = new Map(); // sender:key -> the highest delegate nonce relayed (a lower one would fail on chain)
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
  let lastRegTry = Date.now();
  /** Registered? If not, try again at most every 5 minutes (a startup RPC hiccup shouldn't close the door). */
  async function registeredNow() {
    if (await isRegistered()) return true;
    if (Date.now() - lastRegTry < 300_000) return false;
    lastRegTry = Date.now();
    return ensureRegistered();
  }

  // The offer is read from five views; keep it a few seconds so a burst of unpaid calls (or a
  // card being polled) doesn't hammer the RPC the worker also needs for its own work.
  const offers = new Map();
  let paramsCache = { at: 0, v: null };
  async function offer(mindId) {
    const hit = offers.get(mindId);
    if (hit && Date.now() - hit.at < 5_000) return hit.v;
    const v = await readOffer(mindId);
    offers.set(mindId, { at: Date.now(), v });
    if (offers.size > 500) offers.delete(offers.keys().next().value);
    return v;
  }

  /** The rows for the services she can take right now (live, awake, agent present if needed). */
  async function readOffer(mindId) {
    const mind = await view("get_mind", { id: mindId }).catch(() => null);
    if (!mind) return null;
    const state = await view("live_state", { id: mindId }).catch(() => null);
    const awake = !mind.ghost && state !== "asleep" && state !== "ghost";
    if (Date.now() - paramsCache.at > 60_000) paramsCache = { at: Date.now(), v: await view("params", {}).catch(() => null) };
    const min = BigInt(paramsCache.v?.guest_min_price || "0");
    const hasAgent = !!(await view("agent_of", { mind_id: mindId }).catch(() => null));
    const all = (await view("services_for_mind", { mind_id: mindId }).catch(() => [])).filter((s) => s.live);
    const services = awake ? all.filter((s) => s.category >= AGENT_ONLY_CATEGORIES || hasAgent) : [];
    const schemas = services.length ? await view("input_schemas", { ids: services.map((s) => s.id) }).catch(() => services.map(() => null)) : [];
    const rows = services.map((s, i) => {
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
          // a service with a form takes its input as JSON with the form's required fields
          input_schema: (() => { try { return schemas[i] ? JSON.parse(schemas[i]) : null; } catch { return null; } })(),
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

  /** Everything the chain must agree to before the worker spends gas on a relay: the
   *  delegate (signature, key, nonce window, expiry window), the buyer's wNEAR, and the
   *  contract's own order checks it can see from outside (form, open orders). */
  async function preflight(p, row) {
    if (!signatureOk(p.signed)) return "the delegate's signature is not valid";
    const d = p.signed.delegateAction;
    const kid = `${p.sender}:${keyOf(d).toString()}`;
    if (BigInt(d.nonce) <= (topNonce.get(kid) ?? -1n)) return "the delegate's nonce is already used: sign a new payment";
    let key;
    try {
      key = await provider.query({ request_type: "view_access_key", finality: "optimistic", account_id: p.sender, public_key: keyOf(d).toString() });
    } catch {
      return `${keyOf(d).toString()} is not a key of ${p.sender}`;
    }
    if (key.permission !== "FullAccess") return "sign with a full-access key (ft_transfer_call attaches 1 yoctoNEAR)";
    if (BigInt(d.nonce) <= BigInt(key.nonce)) return "the delegate's nonce is already used: sign a new payment";
    if (BigInt(d.nonce) > BigInt(key.nonce) + 1_000_000n) return "the delegate's nonce is too far ahead of the key's: sign with the key's next nonce";
    const { header } = await provider.block({ finality: "optimistic" });
    if (BigInt(d.maxBlockHeight) < BigInt(header.height) + 100n) return "the delegate expires too soon (give it at least 100 blocks): sign a new payment";
    if (BigInt(d.maxBlockHeight) > BigInt(header.height) + 2_000n) return "the delegate lives too long (at most 2000 blocks)";
    const bal = await ftView("ft_balance_of", { account_id: p.sender }).catch(() => "0");
    if (BigInt(bal || "0") < BigInt(p.amount)) return `${p.sender} holds too little wNEAR on ${wrap}: wrap NEAR first (near_deposit)`;
    const schema = row.extra.input_schema;
    if (schema) {
      let v;
      try {
        v = JSON.parse(p.input);
      } catch {
        return "this service takes its form as JSON input (see extra.input_schema)";
      }
      for (const f of Array.isArray(schema.required) ? schema.required : []) {
        if (v?.[f] === undefined || v[f] === null || v[f] === "") return `missing field: ${f}`;
      }
    }
    const open = await view("jobs_of", { account_id: p.sender }).catch(() => []);
    if (open.length >= 50) return "you have 50 orders not yet closed: close finished ones first (close_job)";
    return null;
  }

  /** An RPC error after which the transaction may still have landed (worth reading back). */
  const maybeLanded = (e) => /timeout|timed out|internal|server error|50\d|econn|socket|fetch failed|network/i.test(String(e?.message || e));

  /** Relay the signed delegate. The transaction is signed here so its hash is known: a payment
   *  runs through several receipts (transfer, unwrap, order), and a public RPC may give up
   *  waiting ("Internal server error", a timeout) while it still lands, so on an RPC error the
   *  outcome is read back by hash instead of reporting a failure that did not happen. */
  async function relay(p) {
    const action = new transactions.Action({ signedDelegate: { delegateAction: p.signed.delegateAction, signature: p.signed.signature } });
    // near-api-js retries a failing RPC call with growing pauses for minutes; the buyer's HTTP
    // call can't wait that long, so every call here has its own short deadline, and the outcome
    // is read back by hash in short polls.
    const within = (pr, ms) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("the RPC timed out"), { timeout: true })), ms))]);
    const readBack = async (txHash, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const out = await within(provider.txStatus(txHash, account.accountId, "EXECUTED_OPTIMISTIC"), 12_000).catch(() => null);
        if (out?.receipts_outcome?.length) return out;
        await sleep(2500);
      }
      return null;
    };
    for (let attempt = 1; ; attempt++) {
      const [hash, signedTx] = await account.signTransaction(p.sender, [action]);
      const txHash = utils.serialize.base_encode(hash);
      try {
        // wait only until it is in a block (that is when a bad nonce or key would be refused)
        await within(provider.sendTransactionUntil(signedTx, "INCLUDED"), 25_000);
      } catch (e) {
        // the worker's key also signs replies and deliveries: on a nonce clash, sign again fresh,
        // unless the previous attempt did land after all
        if (/nonce/i.test(String(e.message || e)) && attempt < 4) {
          const landed = await readBack(txHash, 4_000);
          if (landed) return landed;
          if (account.accessKeyByPublicKeyCache) account.accessKeyByPublicKeyCache = {};
          await sleep(500 * attempt);
          continue;
        }
        if (!e.timeout && !maybeLanded(e)) throw Object.assign(e, { rejected: true });
      }
      const out = await readBack(txHash, 75_000);
      if (out) return out;
      throw new Error(`the transaction ${txHash} did not show up in time; it may still land, check it on the explorer`);
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
    if (!(await registeredNow())) return [503, rpcErr(rpcId, -32004, `${contractId} is not registered with ${wrap} yet, so it cannot receive wNEAR`)];
    if (!paymentHeader) return need("payment required", rows);

    let p;
    try {
      p = checkPayment(paymentHeader, { contractId, network, text, rows });
    } catch (e) {
      return need(e.message, rows);
    }
    const row = rows.find((r) => r.extra.service_id === p.serviceId);
    if (used.has(p.dedupe)) return need("this payment was already used", rows);
    if (inFlight.has(p.sender)) return [429, rpcErr(rpcId, -32003, "one paid call at a time per account")];
    const t = Date.now();
    while (relays.length && relays[0] < t - 60_000) relays.shift();
    if (relays.length >= RELAYS_PER_MIN) return [429, rpcErr(rpcId, -32003, "too many paid calls right now, try again in a minute")];
    // reserve the slot and the buyer before any await, so concurrent calls can't all slip in
    relays.push(t);
    inFlight.add(p.sender);
    let outcome;
    try {
      const why = await preflight(p, row);
      if (why) {
        relays.splice(relays.indexOf(t), 1);
        return need(why, rows);
      }
      used.add(p.dedupe);
      if (used.size > MAX_USED) used.delete(used.values().next().value);
      outcome = await relay(p);
      const d = p.signed.delegateAction; // it reached the chain: this nonce is spent for this key
      topNonce.set(`${p.sender}:${keyOf(d).toString()}`, BigInt(d.nonce));
    } catch (e) {
      if (e.rejected) used.delete(p.dedupe); // never reached the chain: the buyer may send it again
      return need(`the payment did not go through: ${String(e.message || e).slice(0, 300)}`, rows);
    } finally {
      inFlight.delete(p.sender);
    }
    const jobId = orderedJobId(outcome, p.sender);
    if (jobId === null) return need(`the order was refused and nothing was charged (a refusal after the unwrap is refunded in NEAR): ${failureOf(outcome, p.sender) || "no job was placed"}`, rows);
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

  /** A 402 with the offer, in the body and (x402 v2) the PAYMENT-REQUIRED header. */
  function need(error, rows) {
    const body = { x402Version: 2, error, accepts: rows };
    return [402, body, { "payment-required": toB64(body) }];
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
