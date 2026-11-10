// End-to-end check of the x402 door (worker/x402.js) on the QA contract: a buyer with no
// wallet popup and no gas of their own hires a Mind over A2A + x402 with the SDK's hireMind,
// paying in their own wNEAR; the order is an ordinary escrowed job on chain.
//   Mind 11 "Pip" (keeper bob-q1103), service 18, no agent: the colony worker delivers.
//   buyer alice-q1103. Worker on 127.0.0.1:8789, QA site on localhost:3001.
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const WORKER = path.resolve(__dirname, "../../worker");
const SDK = path.resolve(__dirname, "../../sdk");
const { connect, keyStores, transactions } = require(path.join(WORKER, "node_modules/near-api-js"));
const { hireMind, paymentFor, ensureWnear } = require(path.join(SDK, "x402"));

const C = "hm-qa-q1103b.testnet";
const WRAP = "wrap.testnet";
const WORKER_ID = "hm-worker-19652a.testnet";
const MIND = 11, SERVICE = 18;
const BUYER = "alice-q1103.testnet";
const URL_W = `http://127.0.0.1:8789/agent/x402/${MIND}`;
const URL_SITE = `http://localhost:3001/api/agent/x402/${MIND}`;
const RPC = process.env.NEAR_RPC || "https://near-testnet.drpc.org";
const ok = (c, label, extra = "") => console.log(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 160) : ""}`);
const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
};
const send = (text, extra = {}) => ({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ks = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks });
  const buyer = await near.account(BUYER);
  const view = (m, a = {}) => buyer.viewFunction({ contractId: C, methodName: m, args: a });
  const wnear = async () => BigInt(await buyer.viewFunction({ contractId: WRAP, methodName: "ft_balance_of", args: { account_id: BUYER } }));
  const svc = await view("get_service", { service_id: SERVICE });

  // the card, straight from the worker and through the site
  const card = await (await fetch(URL_W)).json();
  ok(card.skills?.some((s) => s.id === `service-${SERVICE}`), "her card lists the services she can take as skills", card.skills?.map((s) => s.name).join(", "));
  const viaSite = await fetch(URL_SITE).then((r) => r.json()).catch(() => null);
  ok(viaSite?.name === card.name, "the site serves the same card at /api/agent/x402/<id>", viaSite?.name);

  // unpaid: 402 with one row per service; the amount is price + 0.03, in wNEAR, to the contract
  const text = `x402 QA ${Date.now()}: tell me a one-line joke`;
  const unpaid = await post(URL_SITE, send(text));
  const row = unpaid.data.accepts?.find((r) => r.extra?.service_id === SERVICE);
  ok(unpaid.status === 402 && unpaid.data.x402Version === 2 && !!row, "an unpaid call answers 402 with x402 v2 accepts", unpaid.status === 402 ? 402 : JSON.stringify(unpaid.data).slice(0, 120));
  ok(row && BigInt(row.amount) === BigInt(svc.price) + 30_000_000_000_000_000_000_000n && row.payTo === C && row.asset === WRAP && row.network === "near:testnet", "the row asks for price + 0.03 NEAR of wNEAR, to the contract", row?.amount);

  await ensureWnear(buyer, WRAP, (BigInt(row.amount) * 3n).toString()); // the buyer's own wNEAR (an ordinary tx they pay)

  // refused before anything is relayed: a payment for other text, and the old kind (NEAR attached)
  const bad = await post(URL_SITE, send(text), { "X-PAYMENT": await paymentFor(buyer, row, "other text") });
  ok(bad.status === 402 && /input must be the message text/.test(bad.data.error || ""), "a payment that doesn't match the message is refused (nothing relayed)", bad.data.error);
  if (buyer.accessKeyByPublicKeyCache) buyer.accessKeyByPublicKeyCache = {};
  const attached = await buyer.signedDelegate({ receiverId: WRAP, blockHeightTtl: 600, actions: [transactions.functionCall("ft_transfer_call", { receiver_id: C, amount: row.amount, msg: JSON.stringify({ service_id: SERVICE, input: text }) }, 200_000_000_000_000n, BigInt(row.amount))] });
  const attachedHeader = Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: Buffer.from(transactions.encodeSignedDelegate(attached)).toString("base64") } })).toString("base64");
  const dep = await post(URL_SITE, send(text), { "X-PAYMENT": attachedHeader });
  ok(dep.status === 402 && /exactly 1 yoctoNEAR/.test(dep.data.error || ""), "a delegate with NEAR attached (which the relayer would pay) is refused", dep.data.error);

  // paid, through the site, with the SDK
  const before = await wnear();
  const task = await hireMind({ url: URL_SITE, accountId: BUYER, text, skillId: `service-${SERVICE}`, nodeUrl: RPC, waitMs: 240_000, pollMs: 5_000 });
  const reply = task.artifacts?.[0]?.parts?.[0]?.text || "";
  ok(task.status.state === "TASK_STATE_COMPLETED" && reply.length > 0, "the paid call comes back COMPLETED with the result", reply);
  const jobId = task.metadata?.job_id;
  const job = await view("get_job", { job_id: jobId });
  ok(job && job.buyer === BUYER && job.service_id === SERVICE && job.status === "Delivered" && job.input === text, "on chain it is the buyer's own escrowed job, delivered", job && `${job.buyer} ${job.status}`);
  ok(job && BigInt(job.escrow) === BigInt(svc.price), "the order held exactly the price in escrow", job?.escrow);

  // who paid: the buyer's wNEAR fell by exactly the amount; the worker attached 1 yoctoNEAR and paid gas
  await sleep(2000);
  const spent = before - (await wnear());
  ok(spent === BigInt(row.amount), "the buyer's wNEAR fell by exactly price + 0.03", `${Number(spent / 10n ** 18n) / 1e6} wNEAR`);
  const tx = task.payment?.transaction ? await near.connection.provider.txStatus(task.payment.transaction, WORKER_ID, "FINAL").catch(() => null) : null;
  const inner = tx?.transaction?.actions?.[0]?.Delegate?.delegate_action?.actions?.[0]?.FunctionCall;
  ok(tx?.transaction?.signer_id === WORKER_ID && tx?.transaction?.receiver_id === BUYER && inner?.method_name === "ft_transfer_call" && String(inner?.deposit) === "1", "the worker relayed it with only 1 yoctoNEAR attached", inner && `${tx.transaction.signer_id} → ${tx.transaction.receiver_id}, deposit ${inner.deposit}`);

  // the task id is the credential: GetTask works with it, not with a guessed id
  const got = await post(URL_W, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: task.id } });
  ok(got.data.result?.task?.status?.state === "TASK_STATE_COMPLETED", "GetTask with the task id returns the result");
  const guess = await post(URL_W, { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: `${jobId}.000000000000000000000000` } });
  ok(guess.status === 404, "a guessed task id is refused", guess.status);

  // a reused payment header is refused
  const header = await paymentFor(buyer, row, text + " again");
  const first = await post(URL_W, send(text + " again"), { "X-PAYMENT": header });
  const replay = await post(URL_W, send(text + " again"), { "X-PAYMENT": header });
  ok(first.status === 200 && replay.status === 402 && /already used/.test(replay.data.error || ""), "the same payment can't be used twice", `${first.status} ${first.data.error?.message || first.data.error || ""} / ${replay.data.error}`);

  // tidy: close the finished jobs so the 0.03 NEAR deposits come back (the second may still be open)
  for (const id of [jobId, first.data.result?.task?.metadata?.job_id].filter((x) => x != null)) {
    const j = await view("get_job", { job_id: id }).catch(() => null);
    if (j && j.status !== "Open") await buyer.functionCall({ contractId: C, methodName: "close_job", args: { job_id: id }, gas: "30000000000000", attachedDeposit: "0" }).catch(() => {});
  }
})().catch((e) => {
  console.log("FAIL  x402 suite crashed  — " + (e.message || e));
  process.exit(1);
});
