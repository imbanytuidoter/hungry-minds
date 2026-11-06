// End-to-end: the whole Hungry Minds game loop against a real NEAR sandbox.
//
// Unit tests (contract/src) mock the VM. These run the compiled wasm in a real runtime, so
// they prove the parts a mock can't: real attached deposits, the 90/10 (guest chat) and 95/5
// (feed) splits across real account balances, NEP-171 ownership transfer, NEP-199 payouts,
// and — the centrepiece — the yield/resume "brain": think/chat park a yielded promise, the
// worker (played here by root, approved with add_responder) calls respond, and the reply lands
// on-chain.
//
// Runs on Linux or macOS. It CANNOT run on Windows: near-sandbox ships no Windows binary (its
// install throws "Unsupported platform: Windows_NT"); on a Windows box run it under WSL.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker, ONE_NEAR } from "near-workspaces";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM =
  process.env.CONTRACT_WASM ||
  path.resolve(
    __dirname,
    "../../contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm"
  );

const T300 = 300_000_000_000_000n; // 300 Tgas — think/chat park a yield + callback
const THOUGHT = ONE_NEAR / 500n; // 0.002 NEAR (economy::THOUGHT_COMPUTE_COST)
const GUEST = ONE_NEAR / 100n; // 0.01 NEAR (economy::GUEST_PRICE)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive one parked thought through the real yield/resume loop and return the reply the
 * contract stored. `think`/`chat` return a yielded promise, so the caller's transaction
 * does not finalise until someone resumes it — the standard near-workspaces pattern is to
 * fire the call without awaiting, poll for the parked request, resume it, then read back.
 */
async function answerOneThought(contract, root, fire, { byOwner }) {
  const seen = (await contract.view("pending_requests", {})).map((p) => p.request_id);
  // Fire the thinking call; don't await its finality (it blocks on the yield). Swallow so a
  // finality quirk can't fail the test — we assert on the on-chain result via views below.
  const inflight = fire().catch((e) => ({ _err: e }));

  let req;
  for (let i = 0; i < 25 && !req; i++) {
    await sleep(400);
    const pending = await contract.view("pending_requests", {});
    req = pending.find((p) => !seen.includes(p.request_id));
  }
  assert.ok(req, "the thought was parked as a pending request");
  assert.equal(req.by_owner, byOwner);

  await root.call(
    contract,
    "respond",
    { request_id: req.request_id, reply: `re:${req.request_id}` },
    { gas: T300 }
  );
  await inflight; // let the original tx settle once resumed

  // The resume callback (on_thought) may land a block later.
  let reply = "";
  for (let i = 0; i < 20 && !reply; i++) {
    reply = await contract.view("last_thought", { id: req.mind_id });
    if (!reply) await sleep(400);
  }
  return { reply, requestId: req.request_id };
}

test("the whole game loop, on a real sandbox", async (t) => {
  const worker = await Worker.init();
  const root = worker.rootAccount;
  const contract = await root.createSubAccount("mind", {
    initialBalance: ONE_NEAR * 30n,
  });
  await contract.deploy(WASM);
  const alice = await root.createSubAccount("alice", {
    initialBalance: ONE_NEAR * 10n,
  });
  const bob = await root.createSubAccount("bob", {
    initialBalance: ONE_NEAR * 10n,
  });
  // only approved responders may answer a parked thought: root plays the worker
  await contract.call(contract, "add_responder", { account_id: root.accountId }, { gas: T300 });

  try {
    await t.test("hatch mints a Mind seeded with its own food", async () => {
      await alice.call(
        contract,
        "hatch_mind",
        { name: "Juno" },
        { attachedDeposit: ONE_NEAR, gas: T300 }
      );
      assert.equal(await contract.view("total_minds", {}), 1);

      const m = await contract.view("get_mind", { id: 0 });
      assert.equal(m.owner, alice.accountId);
      assert.equal(m.name, "Juno");
      assert.equal(BigInt(m.balance), ONE_NEAR / 10n, "0.1 of the 1 NEAR hatch becomes the Mind's food");
      assert.equal(m.thought_count, 0);
      assert.equal(await contract.view("mind_state", { id: 0 }), "full");
    });

    await t.test("the art is drawn on-chain, framed and bare", async () => {
      const framed = await contract.view("svg_for", { id: 0 });
      const bare = await contract.view("svg_for_bare", { id: 0 });
      assert.ok(framed.includes("<svg"), "framed art is an SVG");
      assert.ok(framed.includes("url(#bg"), "framed art paints a background window");
      assert.ok(!bare.includes("url(#bg"), "bare art is transparent for the habitat");
    });

    await t.test("owner think -> worker respond: the reply lands on-chain", async () => {
      const before = BigInt((await contract.view("get_mind", { id: 0 })).balance);
      const { reply, requestId } = await answerOneThought(
        contract,
        root,
        () => alice.call(contract, "think", { id: 0, prompt: "who are you?" }, { gas: T300 }),
        { byOwner: true }
      );
      assert.equal(reply, `re:${requestId}`, "the worker's reply is stored on the Mind");

      const m = await contract.view("get_mind", { id: 0 });
      assert.equal(m.thought_count, 1, "thinking counts");
      assert.equal(BigInt(m.balance), before - THOUGHT, "a thought costs 0.002 NEAR");
      assert.equal(
        (await contract.view("pending_requests", {})).length,
        0,
        "the parked request is cleared once answered"
      );
    });

    await t.test("a stranger pays to chat: 90% to the owner, 10% treasury, and the Mind thinks a reply", async () => {
      const before = BigInt((await contract.view("get_mind", { id: 0 })).balance);
      const { reply } = await answerOneThought(
        contract,
        root,
        () =>
          bob.call(
            contract,
            "chat",
            { id: 0, prompt: "hi" },
            { attachedDeposit: GUEST, gas: T300 }
          ),
        { byOwner: false }
      );
      assert.ok(reply.startsWith("re:"), "the guest's chat gets a reply too");

      const m = await contract.view("get_mind", { id: 0 });
      // nothing of the guest's fee goes into her food: she only spends 0.002 thinking
      assert.equal(BigInt(m.balance), before - THOUGHT);
      // 90% is the owner's to claim; never the Mind's food
      assert.equal(BigInt(m.owner_unclaimed), (GUEST * 90n) / 100n);
    });

    await t.test("feeding tops it up — 95% reaches the Mind", async () => {
      const before = BigInt((await contract.view("get_mind", { id: 0 })).balance);
      const meal = ONE_NEAR / 5n; // 0.2 NEAR
      await alice.call(contract, "feed", { id: 0 }, { attachedDeposit: meal, gas: T300 });
      const m = await contract.view("get_mind", { id: 0 });
      assert.equal(BigInt(m.balance), before + (meal * 95n) / 100n);
    });

    await t.test("the owner claims only their cut, never the Mind's food", async () => {
      const foodBefore = BigInt((await contract.view("get_mind", { id: 0 })).balance);
      await alice.call(contract, "claim_earnings", { id: 0 }, { gas: T300 });
      const m = await contract.view("get_mind", { id: 0 });
      assert.equal(BigInt(m.owner_unclaimed), 0n, "the cut is paid out");
      assert.equal(BigInt(m.balance), foodBefore, "the Mind's food is untouched");
    });

    await t.test("selling it hands over balance, traits and memory (NEP-171)", async () => {
      await alice.call(
        contract,
        "nft_transfer",
        { receiver_id: bob.accountId, token_id: "0" },
        { attachedDeposit: 1n, gas: T300 }
      );
      const m = await contract.view("get_mind", { id: 0 });
      assert.equal(m.owner, bob.accountId, "ownership moved to the buyer");
      assert.ok(m.last_reply.startsWith("re:"), "its memory travelled with it");

      const tok = await contract.view("nft_token", { token_id: "0" });
      assert.equal(tok.owner_id, bob.accountId);
      assert.ok(
        tok.metadata.media.startsWith("data:image/svg+xml;base64,"),
        "the token carries its live art as media"
      );
    });

    await t.test("enumeration reports the collection (NEP-181)", async () => {
      assert.equal(String((await contract.view("nft_total_supply", {}))), "1");
      const mine = await contract.view("nft_tokens_for_owner", {
        account_id: bob.accountId,
        limit: 50,
      });
      assert.equal(mine.length, 1);
      assert.equal(mine[0].token_id, "0");
    });

    await t.test("NEP-199: the whole sale goes to the owner, no royalties", async () => {
      const p = await contract.view("nft_payout", { token_id: "0", balance: "1000", max_len_payout: 10 });
      assert.deepEqual(p.payout, { [bob.accountId]: "1000" });
      const meta = await contract.view("nft_metadata", {});
      assert.ok(meta.icon.startsWith("data:image/svg+xml;base64,"), "the collection has an icon");
    });

    await t.test("NEP-178: an approved marketplace transfers, then approvals clear", async () => {
      const market = await root.createSubAccount("market", { initialBalance: ONE_NEAR * 5n });
      // bob (current owner) approves the market; the deposit covers storage, excess refunds
      await bob.call(
        contract,
        "nft_approve",
        { token_id: "0", account_id: market.accountId },
        { attachedDeposit: ONE_NEAR / 100n, gas: T300 }
      );
      assert.equal(
        await contract.view("nft_is_approved", { token_id: "0", approved_account_id: market.accountId }),
        true
      );

      // the market moves it to alice on bob's behalf
      await market.call(
        contract,
        "nft_transfer",
        { receiver_id: alice.accountId, token_id: "0" },
        { attachedDeposit: 1n, gas: T300 }
      );
      assert.equal((await contract.view("get_mind", { id: 0 })).owner, alice.accountId);
      // the approval did not survive the transfer
      assert.equal(
        await contract.view("nft_is_approved", { token_id: "0", approved_account_id: market.accountId }),
        false
      );
    });
  } finally {
    await worker.tearDown();
  }
});
