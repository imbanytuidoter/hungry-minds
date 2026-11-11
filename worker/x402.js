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
// A buyer whose relayed order the contract refused anyway (something preflight could not
// see) waits this long before the worker pays gas for them again.
const REFUSED_BLOCK_MS = 10 * 60_000;
const MAX_FORM_DEPTH = 64; // serde_json gives up at 128; well inside that
// The contract's own limits (agents.rs), checked before a relay so a full queue costs no gas.
const MAX_OPEN_JOBS = 1000; // open jobs in the whole contract
const MAX_OPEN_PER_MIND = 20; // open jobs waiting on one Mind
const MAX_OPEN_PER_BUYER_MIND = 5; // open jobs of one buyer on one Mind
const MAX_BUYER_JOBS = 50; // jobs of one buyer not yet closed
// A paid call ends within this (preflight, relay, read-back and the short wait for a quick
// delivery), well inside the site proxy's 200 s, so the buyer hears from us, not a dead socket.
const TOTAL_MS = 150_000;
const RPC_MS = 8_000; // each view / RPC read on the paid path
const RELAY_MIN_LEFT = 60_000; // with less than this left, don't start a relay at all (503: try again)
// Contract refusals the buyer can't fix by sending a better payment (the Mind's state, the
// queue, a price changed under them, our own gas setting): no 10-minute block for these.
const NOT_BUYERS_FAULT = /she is asleep|jobs waiting|queue is full|service is paused|needs her agent|a ghost takes|attach the price plus|no such service|no such Mind|could not be unwrapped|attach more gas/i;

/** True if serde_json (without float_roundtrip) would refuse this JSON number literal as out
 *  of range: an integer literal of more than 308 digits, or any value whose magnitude, as
 *  written, is above f64::MAX (JSON.parse rounds 1.7976931348623158e308 down to MAX; serde's
 *  faster parse can overflow there). Compared on the decimal digits, not on a rounded double. */
const F64_MAX_DIGITS = "17976931348623157"; // f64::MAX = 1.7976931348623157e308
function numberTooBig(lit) {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lit);
  if (!m) return false;
  const [, int, frac = "", e] = m;
  if (!frac && e === undefined && int.length > 308) return true;
  const all = int + frac;
  const lead = all.search(/[1-9]/);
  if (lead < 0) return false; // zero
  const exp = int.length - lead - 1 + Number(e || 0); // the value is d.ddd × 10^exp
  if (exp !== 308) return exp > 308;
  const sig = all.slice(lead).replace(/0+$/, "");
  const n = Math.max(sig.length, F64_MAX_DIGITS.length);
  return sig.padEnd(n, "0") > F64_MAX_DIGITS.padEnd(n, "0");
}
/** Every number literal in a JSON text (strings skipped). */
function numberLiterals(raw) {
  const out = [];
  const num = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let i = 0; i < raw.length; ) {
    const c = raw[i];
    if (c === '"') {
      for (i++; i < raw.length && raw[i] !== '"'; i += raw[i] === "\\" ? 2 : 1);
      i++;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      num.lastIndex = i;
      const m = num.exec(raw);
      if (!m) {
        i++;
        continue;
      }
      out.push(m[0]);
      i = num.lastIndex;
    } else i++;
  }
  return out;
}

/** Why serde_json (the contract) would refuse this form input that JSON.parse took, or null.
 *  JSON.parse turns 1e400 into Infinity, keeps lone surrogate escapes ("\ud800") as broken
 *  strings and nests as deep as asked; serde_json refuses all three. With `raw` (the text that
 *  was parsed) the number literals are checked as written too (see numberTooBig). Pure:
 *  unit-tested. */
function serdeRefuses(value, raw) {
  if (typeof raw === "string" && numberLiterals(raw).some(numberTooBig)) return "the JSON input has a number too large to store";
  const walk = (v, depth) => {
    if (depth > MAX_FORM_DEPTH) return `the JSON input nests deeper than ${MAX_FORM_DEPTH} levels`;
    if (typeof v === "number") return Number.isFinite(v) ? null : "the JSON input has a number too large to store";
    if (typeof v === "string") return v.isWellFormed() ? null : "the JSON input has a broken unicode escape (a lone surrogate)";
    if (v && typeof v === "object") {
      for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
        if (typeof k === "string" && !k.isWellFormed()) return "the JSON input has a broken unicode escape (a lone surrogate)";
        const why = walk(x, depth + 1);
        if (why) return why;
      }
    }
    return null;
  };
  return walk(value, 1);
}

const wrapOf = (network) => (network === "mainnet" ? "wrap.near" : "wrap.testnet");
const b64json = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const toB64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `pr`, or a rejection ({ timeout: true }) after `ms`: near-api-js retries a failing RPC for
 *  minutes, longer than a buyer's HTTP call can wait. */
const within = (pr, ms) => {
  let t;
  return Promise.race([pr, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error("the RPC timed out"), { timeout: true })), Math.max(1, ms))))]).finally(() => clearTimeout(t));
};

/** Decode and check a signed delegate against the row the buyer accepted. Returns
 *  { signed, sender, serviceId, input } or throws with the reason. Pure: unit-tested. */
function checkPayment(headerValue, { contractId, network, text, rows }) {
  const wrap = wrapOf(network);
  // JSON.stringify writes a lone surrogate as "\ud800", which the contract's serde refuses
  // (the order would bounce after the worker paid the relay gas)
  if (typeof text !== "string" || !text.isWellFormed()) throw new Error("the message text is not valid unicode (it has a lone surrogate)");
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
  const refusedUntil = new Map(); // buyer -> until when relays for them are paused (REFUSED_BLOCK_MS)
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

  /** The rows for the services she can take right now (live, awake, agent present if needed).
   *  A view that fails throws (the caller answers 503 "try again"): guessing "no schema", "no
   *  minimum price" or "awake" from a failed read would relay orders the contract refuses. */
  async function readOffer(mindId) {
    const v = (m, a) => within(view(m, a), RPC_MS);
    const mind = await v("get_mind", { id: mindId });
    if (!mind) return null;
    const state = await v("live_state", { id: mindId });
    const awake = !mind.ghost && !!state && state !== "asleep" && state !== "ghost";
    if (Date.now() - paramsCache.at > 60_000 || !paramsCache.v) {
      const p = await v("params", {});
      if (!p) throw new Error("params unavailable");
      paramsCache = { at: Date.now(), v: p };
    }
    const min = BigInt(paramsCache.v?.guest_min_price || "0");
    const agentInfo = await v("agent_of", { mind_id: mindId });
    const agent = typeof agentInfo === "string" ? agentInfo : agentInfo?.account || null;
    const hasAgent = !!agentInfo;
    const all = ((await v("services_for_mind", { mind_id: mindId })) || []).filter((s) => s.live);
    const services = awake ? all.filter((s) => s.category >= AGENT_ONLY_CATEGORIES || hasAgent) : [];
    const schemas = services.length ? await v("input_schemas", { ids: services.map((s) => s.id) }) : [];
    if (services.length && (!Array.isArray(schemas) || schemas.length !== services.length)) throw new Error("input_schemas unavailable");
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
    return { mind, awake, services, rows, owner: mind.owner || null, agent };
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
    const job = await within(view("get_job", { job_id: jobId }), RPC_MS);
    if (!job) {
      // closed (close_job deletes the record) or not visible yet on this RPC node: the full
      // result only if the gateway saw this job delivered (never one it stored and then failed
      // to deliver: that job may have been refunded)
      const full = gateway?.resultOf?.(jobId, null);
      if (full) return { id, contextId: id, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: `job-${jobId}`, parts: [{ text: full.text || "" }] }], metadata: { job_id: jobId } };
      return { id, contextId: id, status: { state: "TASK_STATE_WORKING" }, metadata: { job_id: jobId } };
    }
    if (job.mind_id !== mindId) return null;
    if (job.status === "Delivered") {
      const full = gateway?.resultOf?.(jobId, job.status);
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
   *  contract's own order checks it can see from outside (self-order, form, the buyer's open
   *  orders, her queue, the contract's queue). Returns null, or { why, kind }: kind "buyer" (a
   *  refusal the buyer controls: 402), "state" (the Mind or the queue: 409, nothing the buyer
   *  did wrong) or "retry" (a read failed or timed out: 503, never relayed on a guess).
   *  `dl`: the paid call's deadline (every RPC here ends by it, at most RPC_MS each). */
  async function preflight(p, row, o, mindId, dl) {
    const lim = (pr) => within(pr, Math.min(RPC_MS, dl - Date.now()));
    const buyer = (why) => ({ why, kind: "buyer" });
    const state = (why) => ({ why, kind: "state" });
    const retry = { why: "the chain could not be read just now: try again in a moment (nothing was sent)", kind: "retry" };
    if (!signatureOk(p.signed)) return buyer("the delegate's signature is not valid");
    const d = p.signed.delegateAction;
    const kid = `${p.sender}:${keyOf(d).toString()}`;
    if (BigInt(d.nonce) <= (topNonce.get(kid) ?? -1n)) return buyer("the delegate's nonce is already used: sign a new payment");
    // the contract refuses these orders (order_checks): her owner, or her agent, buying her services
    if (o.owner && p.sender === o.owner) return buyer("you can't order your own Mind's services");
    if (o.agent && p.sender === o.agent) return buyer("her own agent can't order her services");
    const schema = row.extra.input_schema;
    if (schema) {
      let v;
      try {
        v = JSON.parse(p.input);
      } catch {
        return buyer("this service takes its form as JSON input (see extra.input_schema)");
      }
      const strict = serdeRefuses(v, p.input);
      if (strict) return buyer(strict);
      const required = Array.isArray(schema.required) ? schema.required.filter((f) => typeof f === "string") : [];
      // serde's Value::get on an array or a scalar finds no field: only a plain object can carry them
      const plain = v !== null && typeof v === "object" && !Array.isArray(v);
      for (const f of required) {
        if (!plain || !Object.hasOwn(v, f) || v[f] === null || v[f] === "") return buyer(`missing field: ${f}`);
      }
    }
    let key;
    try {
      key = await lim(provider.query({ request_type: "view_access_key", finality: "optimistic", account_id: p.sender, public_key: keyOf(d).toString() }));
    } catch (e) {
      // "does not exist": a real answer about the key or account; anything else is the RPC
      if (!e?.timeout && /does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|AccessKeyDoesNotExist|AccountDoesNotExist/i.test(String(e?.message || e) + String(e?.type || ""))) return buyer(`${keyOf(d).toString()} is not a key of ${p.sender}`);
      return retry;
    }
    if (!key || key.nonce === undefined) return retry;
    if (key.permission !== "FullAccess") return buyer("sign with a full-access key (ft_transfer_call attaches 1 yoctoNEAR)");
    if (BigInt(d.nonce) <= BigInt(key.nonce)) return buyer("the delegate's nonce is already used: sign a new payment");
    if (BigInt(d.nonce) > BigInt(key.nonce) + 1_000_000n) return buyer("the delegate's nonce is too far ahead of the key's: sign with the key's next nonce");
    let height, bal, mine, mindOpen, allOpen;
    try {
      height = BigInt((await lim(provider.block({ finality: "optimistic" }))).header.height);
      bal = await lim(ftView("ft_balance_of", { account_id: p.sender }));
      mine = await lim(view("jobs_of", { account_id: p.sender }));
      mindOpen = Number(await lim(view("open_count_of", { mind_id: mindId })));
      allOpen = Number(await lim(view("open_job_count", {})));
    } catch {
      return retry;
    }
    if (!Array.isArray(mine) || !Number.isFinite(mindOpen) || !Number.isFinite(allOpen) || (typeof bal !== "string" && typeof bal !== "number")) return retry;
    if (BigInt(d.maxBlockHeight) < height + 100n) return buyer("the delegate expires too soon (give it at least 100 blocks): sign a new payment");
    if (BigInt(d.maxBlockHeight) > height + 2_000n) return buyer("the delegate lives too long (at most 2000 blocks)");
    if (BigInt(bal || "0") < BigInt(p.amount)) return buyer(`${p.sender} holds too little wNEAR on ${wrap}: wrap NEAR first (near_deposit)`);
    if (mine.length >= MAX_BUYER_JOBS) return buyer(`you have ${MAX_BUYER_JOBS} orders not yet closed: close finished ones first (close_job)`);
    if (mine.filter((j) => j?.mind_id === mindId && j?.status === "Open").length >= MAX_OPEN_PER_BUYER_MIND) return buyer(`you already have ${MAX_OPEN_PER_BUYER_MIND} open jobs with her: wait for one to finish`);
    if (mindOpen >= MAX_OPEN_PER_MIND) return state(`she has ${MAX_OPEN_PER_MIND} jobs waiting: try again when one is delivered`);
    if (allOpen >= MAX_OPEN_JOBS) return state("the job queue is full, try again later");
    return null;
  }

  /** An RPC error after which the transaction may still have landed (worth reading back). */
  const maybeLanded = (e) => /timeout|timed out|internal|server error|50\d|econn|socket|fetch failed|network/i.test(String(e?.message || e));

  /** Relay the signed delegate. The transaction is signed here so its hash is known: a payment
   *  runs through several receipts (transfer, unwrap, order), and a public RPC may give up
   *  waiting ("Internal server error", a timeout) while it still lands, so on an RPC error the
   *  outcome is read back by hash instead of reporting a failure that did not happen. */
  async function relay(p, dl = Date.now() + TOTAL_MS) {
    const action = new transactions.Action({ signedDelegate: { delegateAction: p.signed.delegateAction, signature: p.signed.signature } });
    // near-api-js retries a failing RPC call with growing pauses for minutes; the buyer's HTTP
    // call can't wait that long, so every call here has its own short deadline, and the outcome
    // is read back by hash in short polls, until the paid call's deadline `dl`.
    const readBack = async (txHash, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const out = await within(provider.txStatus(txHash, account.accountId, "EXECUTED_OPTIMISTIC"), Math.min(12_000, until - Date.now())).catch(() => null);
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
        await within(provider.sendTransactionUntil(signedTx, "INCLUDED"), Math.min(25_000, dl - Date.now() - 5_000));
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
      const out = await readBack(txHash, dl - Date.now() - 2_000);
      if (out) return out;
      throw Object.assign(new Error(`the transaction ${txHash} did not show up in time; it may still land, check it on the explorer`), { unknown: true, txHash });
    }
  }

  async function sendMessage(mindId, params, paymentHeader, rpcId) {
    const dl = Date.now() + TOTAL_MS; // the whole paid call, preflight included
    const msg = params?.message || {};
    const text = textOf(msg);
    if (!text) return [400, rpcErr(rpcId, -32602, "the message has no text")];
    if (!text.isWellFormed()) return [400, rpcErr(rpcId, -32602, "the message text is not valid unicode (it has a lone surrogate)")];
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT) return [400, rpcErr(rpcId, -32602, `the message is longer than ${MAX_INPUT} bytes`)];

    // An answer to the agent's question continues a paid task: no new payment.
    if (msg.taskId) {
      const jobId = jobOfTask(msg.taskId);
      if (jobId === null) return [404, rpcErr(rpcId, -32001, "unknown task")];
      const job = await within(view("get_job", { job_id: jobId }), RPC_MS);
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
    // the same signed payment sent again (a client retrying after a timeout): it went to the
    // chain already, so no 402 that invites paying twice
    if (used.has(p.dedupe)) return [409, rpcErr(rpcId, -32006, `this payment was already relayed: check your order (jobs_of ${p.sender} on ${contractId}) before paying again`, { payer: p.sender })];
    {
      // its dedupe entry may have been evicted: the same key and nonce as the last relay is the same payment
      const d0 = p.signed.delegateAction;
      if (topNonce.get(`${p.sender}:${keyOf(d0).toString()}`) === BigInt(d0.nonce)) return [409, rpcErr(rpcId, -32006, `this payment was already relayed: check your order (jobs_of ${p.sender} on ${contractId}) before paying again`, { payer: p.sender })];
    }
    const blockedFor = (refusedUntil.get(p.sender) || 0) - Date.now();
    if (blockedFor > 0) return [429, rpcErr(rpcId, -32003, `your last paid order was refused by the contract after it was relayed; try again in ${Math.ceil(blockedFor / 60_000)} min`)];
    if (inFlight.has(p.sender)) return [429, rpcErr(rpcId, -32003, "one paid call at a time per account")];
    const t = Date.now();
    while (relays.length && relays[0] < t - 60_000) relays.shift();
    if (relays.length >= RELAYS_PER_MIN) return [429, rpcErr(rpcId, -32003, "too many paid calls right now, try again in a minute")];
    // reserve the slot and the buyer before any await, so concurrent calls can't all slip in
    relays.push(t);
    inFlight.add(p.sender);
    let outcome;
    try {
      const why = await preflight(p, row, o, mindId, dl);
      if (!why && dl - Date.now() < RELAY_MIN_LEFT) {
        // the reads took so long that the relay could not be followed to the end: not now
        relays.splice(relays.indexOf(t), 1);
        return [503, rpcErr(rpcId, -32004, "the chain is slow right now: try again in a moment (nothing was sent)")];
      }
      if (why) {
        relays.splice(relays.indexOf(t), 1);
        if (why.kind === "retry") return [503, rpcErr(rpcId, -32004, why.why)];
        if (why.kind === "state") return [409, rpcErr(rpcId, -32002, why.why)];
        return need(why.why, rows);
      }
      used.add(p.dedupe);
      if (used.size > MAX_USED) used.delete(used.values().next().value);
      outcome = await relay(p, dl);
      const d = p.signed.delegateAction; // it reached the chain: this nonce is spent for this key
      topNonce.set(`${p.sender}:${keyOf(d).toString()}`, BigInt(d.nonce));
    } catch (e) {
      // Sent, but the outcome is unknown (the RPC gave up, it may still land): not a refusal
      // to pay, so no 402 that would invite paying again; 504 with the hash to look it up.
      if (e.unknown) return [504, rpcErr(rpcId, -32005, String(e.message || e).slice(0, 300), { transaction: e.txHash, network: `near:${network}`, payer: p.sender })];
      if (e.rejected) used.delete(p.dedupe); // never reached the chain: the buyer may send it again
      return need(`the payment did not go through: ${String(e.message || e).slice(0, 300)}`, rows);
    } finally {
      inFlight.delete(p.sender);
    }
    const jobId = orderedJobId(outcome, p.sender);
    if (jobId === null) {
      // The worker paid the gas and the contract refused the order anyway (its tokens went
      // back to the buyer). If the buyer could have avoided it (their input, their balance,
      // their key, ordering their own Mind...), don't relay for them again for a while; a
      // refusal about her state or the queue (asleep, full, paused, price changed) is not theirs.
      const reason = failureOf(outcome, p.sender);
      if (!reason || !NOT_BUYERS_FAULT.test(reason)) {
        refusedUntil.set(p.sender, Date.now() + REFUSED_BLOCK_MS);
        if (refusedUntil.size > 5000) for (const [k, t] of refusedUntil) if (t < Date.now()) refusedUntil.delete(k);
      }
      return need(`the order was refused and nothing was charged (a refusal after the unwrap is refunded in NEAR): ${reason || "no job was placed"}`, rows);
    }
    console.log(`x402: ${p.sender} ordered job ${jobId} (service ${p.serviceId}, mind ${mindId}), tx ${outcome.transaction.hash}`);

    // Give a quick agent the chance to finish inside this call (and inside the deadline). The
    // job is placed: a slow read only means the buyer gets a WORKING task to poll.
    const working = { id: taskId(jobId), contextId: taskId(jobId), status: { state: "TASK_STATE_WORKING" }, metadata: { job_id: jobId } };
    let task = (await taskView(jobId, mindId).catch(() => null)) || working;
    const until = Math.min(Date.now() + WAIT_MS, dl - RPC_MS);
    while (task?.status.state === "TASK_STATE_WORKING" && Date.now() + 2500 < until) {
      await sleep(2500);
      task = (await taskView(jobId, mindId).catch(() => null)) || task;
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

  function rpcErr(id, code, message, data) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
  }

  async function route(req, res, url, readBody) {
    // serialize first, then the head: a body that can't be serialized, or a response whose
    // head already went out, must not throw inside this async handler
    const out = (code, body, headers = {}) => {
      if (res.headersSent) return res.destroy?.();
      let text;
      try {
        text = JSON.stringify(body);
      } catch {
        code = 500;
        text = '{"error":"server error"}';
        headers = {};
      }
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(text);
    };
    const m = /^\/agent\/x402\/(\d+)(\/\.well-known\/agent-card\.json)?$/.exec(url.pathname);
    if (!m) return out(404, { error: "not found" });
    const mindId = Number(m[1]);
    if (req.method === "GET") {
      try {
        return out(...(await card(mindId)));
      } catch (e) {
        console.error("x402: chain read failed:", e?.message || e);
        return out(503, { error: "the chain could not be read just now: try again in a moment" });
      }
    }
    if (req.method !== "POST" || m[2]) return out(405, { error: "use GET for the card, POST for A2A" });
    let body;
    try {
      body = await readBody(req, 20_000);
    } catch (e) {
      return out(e.status === 413 ? 413 : 400, rpcErr(null, -32700, e.status === 413 ? "the request is too large" : "parse error"));
    }
    const header = req.headers["x-payment"] || req.headers["payment-signature"] || "";
    try {
      if (body?.method === "SendMessage" || body?.method === "message/send") return out(...(await sendMessage(mindId, body.params, header, body.id)));
      if (body?.method === "GetTask" || body?.method === "tasks/get") return out(...(await getTask(mindId, body.params, body.id)));
    } catch (e) {
      // a view failed or timed out before anything was relayed (relay errors are answered
      // inside sendMessage): never a guess, never a 402
      console.error("x402: chain read failed:", e?.message || e);
      return out(503, rpcErr(body?.id, -32004, "the chain could not be read just now: try again in a moment (nothing was sent)"));
    }
    return out(400, rpcErr(body?.id, -32601, "supported methods: SendMessage, GetTask"));
  }


  return { route, card, isRegistered };
}

module.exports = { makeX402, checkPayment, serdeRefuses, numberTooBig, signatureOk, orderedJobId, failureOf, JOB_DEPOSIT, wrapOf };
