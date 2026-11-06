// colonySnapshot must read every page of a big colony. A fake RPC plays the contract with
// its real page caps (colony_snapshot ≤ 60 Minds, services / listings ≤ 100 each).
//   node --test web/scripts/test-paging.mjs
import test from "node:test";
import assert from "node:assert/strict";

const MINDS = 150, SERVICES = 230, LISTINGS = 105;
const page = (n, from = 0, limit = 100, cap = 100) => Array.from({ length: Math.max(0, Math.min(n - from, Math.min(limit, cap))) }, (_, i) => from + i);
let calls = 0;

globalThis.fetch = async (_url, init) => {
  calls++;
  const p = JSON.parse(init.body).params;
  const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
  let out;
  if (p.method_name === "colony_snapshot") {
    const from = args.from_index ?? 0;
    const lim = Math.min(args.limit ?? 60, 60);
    out = {
      params: {}, total_minds: MINDS, supply_left: 4000 - MINDS, treasury: "0", ghost_window_ms: 180000,
      minds: page(MINDS, from, lim, 60).map((id) => ({ id, mind: { owner: "a.testnet" }, live_balance: "0", live_state: "full", look: null })),
      services: page(SERVICES).map((id) => ({ id })),
      listings: page(LISTINGS).map((id) => ({ id })),
    };
  } else if (p.method_name === "services") out = page(SERVICES, args.from_index, args.limit).map((id) => ({ id }));
  else if (p.method_name === "listings") out = page(LISTINGS, args.from_index, args.limit).map((id) => ({ id }));
  else throw new Error("unexpected view " + p.method_name);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: [...Buffer.from(JSON.stringify(out))] } }), { status: 200 });
};

const chain = await import("../lib/chain.ts");

test("every Mind, service and listing of a big colony is read", async () => {
  calls = 0;
  const snap = await chain.colonySnapshot();
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(snap.minds), [...Array(MINDS).keys()], "all Minds, in order, no duplicates");
  assert.deepEqual(ids(snap.services), [...Array(SERVICES).keys()], "all services");
  assert.deepEqual(ids(snap.listings), [...Array(LISTINGS).keys()], "all listings");
  // 3 snapshot pages + 2 more service pages + 1 more listing page
  assert.equal(calls, 3 + 2 + 1, "no wasted calls");
});

test("a small colony is still one view", async () => {
  calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const res = await real(u, init);
    const body = await res.json();
    const v = JSON.parse(Buffer.from(body.result.result).toString());
    if (v.minds) Object.assign(v, { total_minds: 7, minds: v.minds.slice(0, 7), services: v.services.slice(0, 5), listings: v.listings.slice(0, 1) });
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(v))] } }), { status: 200 });
  };
  const snap = await chain.colonySnapshot();
  globalThis.fetch = real;
  assert.equal(snap.minds.length, 7);
  assert.equal(snap.services.length, 5);
  assert.equal(calls, 1);
});

test("hatch id is read from either result shape", () => {
  assert.equal(chain.returnedNumber(41), 41);
  assert.equal(chain.returnedNumber({ status: { SuccessValue: Buffer.from("42").toString("base64") } }), 42);
  assert.equal(chain.returnedNumber(undefined), null);
  assert.equal(chain.returnedNumber({ status: { SuccessValue: "" } }), null);
});
