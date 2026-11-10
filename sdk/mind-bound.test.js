const test = require("node:test");
const assert = require("node:assert/strict");
const { mindGuard } = require("./mind-bound");

// a fake RPC: get_job / nft_token answers from a table
function fakeRpc(jobs, owners) {
  global.fetch = async (_url, req) => {
    const p = JSON.parse(req.body).params;
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
    const out = p.method_name === "get_job" ? jobs[args.job_id] ?? null : p.method_name === "nft_token" ? (owners[args.token_id] ? { owner_id: owners[args.token_id] } : null) : null;
    return { json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(out))] } }) };
  };
}

test("an agent bound to Mind 12 serves only jobs ordered from Mind 12", async () => {
  fakeRpc({ 5: { id: 5, mind_id: 12, status: "Open" }, 6: { id: 6, mind_id: 99, status: "Open" }, 7: { id: 7, mind_id: 12, status: "Delivered" } }, { 12: "bob.testnet" });
  const g = mindGuard({ contractId: "c.testnet", mindId: 12 });
  assert.equal((await g.check({ mind_id: 12, job_id: 5 })).ok, true);
  assert.match((await g.check({ mind_id: 99, job_id: 6 })).reason, /belongs to Mind #12/);
  assert.match((await g.check({ mind_id: 12, job_id: 6 })).reason, /another Mind/); // a forged mind_id
  assert.match((await g.check({ mind_id: 12, job_id: 8 })).reason, /not on chain/);
  assert.match((await g.check({ mind_id: 12, job_id: 7 })).reason, /delivered/);
  assert.equal((await g.check({ mind_id: 12 })).ok, true, "chat for its own Mind passes");
  assert.equal(await g.owner(), "bob.testnet");
});
