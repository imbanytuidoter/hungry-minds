# Hungry Minds

An NFT that is alive, and has to eat.

A Hungry Mind is a NEP-171 token that owns its own on-chain balance. Every time it
thinks — every reply it gives — it spends a little of that balance on compute. As the
balance falls it gets visibly hungry; at zero it falls asleep; left asleep long enough it
becomes a ghost. The owner can feed it and can earn from strangers who pay to talk to it,
but **the owner can never withdraw the Mind's own food.** The creature's money belongs to
the creature.

That one rule — a token with a wallet it spends down by living — is the whole product.
Everything else (the art, the economy, the lifecycle) follows from it.

> Status: the on-chain contract is built and tested (71 unit tests + a sandbox integration
> suite, builds to wasm). The thinking "brain" (yield/resume + off-chain worker → NEAR AI) is
> real; the web app reads the chain and signs actions through a wallet the moment it points at
> a deployed contract. What's left is the testnet deploy itself and the verified-TEE upgrade —
> see [Honest status](#honest-status). This README describes only what the code does today.

## How a Mind lives

| Moment | What happens on-chain |
| --- | --- |
| **Hatch** (`hatch_mind`, 2 NEAR) | A token is minted. 1.0 NEAR becomes the Mind's own food, 0.25 is locked for storage, 0.75 funds the treasury. Seven traits are rolled from block randomness. |
| **Think** (`think`, owner, free) | The owner talks to their Mind. One thought costs 0.002 NEAR, taken from the Mind's balance. |
| **Chat** (`chat`, stranger, pays) | A stranger pays **at least 0.01 NEAR** to talk (enforced, so no one can drain a Mind for free). It splits **70% to the Mind / 20% to the owner / 10% to the treasury**, and one thought is spent. |
| **Hunger** (`mind_state`, derived) | full ≥ 0.5 · content ≥ 0.1 · hungry ≥ 0.02 · starving > 0 · asleep = 0. Never stored — always a pure function of the balance. |
| **Feed** (`feed`) | Anyone can feed a Mind: 95% to its balance, 5% to the treasury (so wash-feeding to farm earnings always loses money). Feeding wakes a sleeping Mind. |
| **Claim** (`claim_earnings`, owner) | The owner withdraws **only** their accrued 20% guest-chat cut — never the Mind's food. |
| **Reap** (`reap`) | Once a Mind has slept past the ghost window (30 days; minutes on the demo build), anyone can reap it into a ghost; its 0.25 NEAR hatch reserve becomes a claimable rebate for the owner (withdrawn via `claim_earnings`). |
| **Sell** (`nft_transfer` / `nft_transfer_call`) | A Mind is sold whole: its food, traits and life so far travel to the buyer untouched. The seller's unclaimed cut is settled to them on the way out, so a buyer never inherits someone else's earnings. |

The economy balances on two fixed constants only: the guest price (0.01 NEAR) and the
thought cost (0.002 NEAR). See [`economy.rs`](contract/src/economy.rs) and
[`state.rs`](contract/src/state.rs).

## The art is the state

There is no stored image. `nft_token` and `svg_for` assemble an SVG on-chain, every time,
from the Mind's seven traits and its current life-state — so a wallet always shows the
*current* creature. Temperament is the palette (8 moods), body/eyes/accessory/pattern make
each one unique, and the face is written by hunger: a full smile fades to flat, to a frown,
to closed eyes with drifting z's asleep, to a hollow, dashed, floating ghost. See
[`art.rs`](contract/src/art.rs).

## Build & test

```bash
# unit tests (71 of them)
cargo test --manifest-path contract/Cargo.toml

# the deployable wasm artifact
cargo near build            # or: cargo build --target wasm32-unknown-unknown --release
```

```bash
# end-to-end tests: the whole game loop in a real NEAR sandbox (Linux/macOS — see integration/)
cd contract && cargo build --target wasm32-unknown-unknown --release && cd ../integration && npm install && npm test
```

> On a Windows host without MSVC link.exe, prefix cargo with the gnu toolchain, e.g.
> `cargo +stable-x86_64-pc-windows-gnu test --manifest-path contract/Cargo.toml`. The crate
> itself pins no toolchain, so judges building on Linux just run the commands above.

The `demo-window` feature (`cargo near build --features demo-window`) shrinks the
sleep→ghost window from 30 days to 3 minutes so the whole lifecycle arc is visible in a live
demo. Never enable it for a real deployment.

## Walkthrough: do X → see Y

Against a deployed contract `MIND`, with accounts `alice` (owner) and `bob` (stranger):

1. **`alice` calls `hatch_mind({"name":"Rue"})` with 2 NEAR** → returns token id `0`;
   `get_mind(0)` shows `balance = 1 NEAR`, `owner = alice`; `treasury_balance` = 0.75 NEAR.
2. **Call `mind_state(0)`** → `"full"`. **Call `svg_for(0)`** → an `<svg …>` whose face is a
   full smile.
3. **`alice` calls `think(0,"hi")`** → `get_mind(0).thought_count` = 1, `balance` =
   0.998 NEAR.
4. **`bob` calls `chat(0,"hello")` with 0.01 NEAR** → `balance` = 1.003 NEAR (0.998 + 0.007
   to the Mind − 0.002 for the thought), `owner_unclaimed` = 0.002 NEAR, `treasury_balance`
   grows by 0.001 NEAR.
5. **`alice` calls `claim_earnings(0)`** → `alice` receives 0.002 NEAR; `get_mind(0).balance`
   is unchanged (the Mind's food is never touched).
6. **Drain it** (repeated `think`, or on the `demo-window` build wait out the clock) →
   `mind_state(0)` goes `content` → `hungry` → `starving` → `asleep`, and `svg_for(0)` changes with it.
7. **Anyone calls `feed(0)` with 0.2 NEAR** → the Mind wakes; `mind_state(0)` is `content`.
8. **`alice` calls `nft_transfer({"receiver_id":"bob","token_id":"0"})` with 1 yoctoNEAR** →
   `nft_token("0").owner_id` is now `bob`, the balance and `thought_count` are unchanged, and
   `alice` is paid any unclaimed cut.

## Honest status

- **Done and tested in this repo:** the full Mind lifecycle and economy above, the on-chain
  SVG art, the NEP-171 / NEP-177 / NEP-181 surface (`nft_metadata`, `nft_token`, enumeration,
  `nft_transfer` / `nft_transfer_call` with standard events), **NEP-178 approval management**
  (`nft_approve` / `nft_revoke` / `nft_revoke_all` / `nft_is_approved`, so marketplaces can
  list and transfer a Mind), and the **thinking brain**:
  `think`/`chat` park a yielded promise (`Promise::new_yield`) and store the request; an
  off-chain worker ([`worker/`](worker/)) polls `pending_requests`, asks NEAR AI for an
  in-character reply, and calls `respond` to resume it; `on_thought` stores the reply or
  refunds the thought on a 200-block timeout. There's also a living-Minds `leaderboard`
  view (ranked by thoughts, ghosts excluded). 71 unit tests, plus a
  [sandbox integration suite](integration/) that runs the whole loop (deposits, splits,
  transfer, approval, yield/resume) against real `neard`; builds to wasm.
- **Done, needs a deploy to light up:** the web app ([`web/`](web/)) reads the chain over RPC
  and signs `hatch`/`feed`/`think`/`chat`/`transfer` through NEAR Wallet Selector. It stays in
  a preview (sample Minds) until `NEXT_PUBLIC_CONTRACT_ID` points at a deployed contract, then
  it's live with no code change ([lib/chain.ts](web/lib/chain.ts), [lib/live.ts](web/lib/live.ts)).
- **Not done yet:** the testnet deploy itself ([DEPLOY.md](DEPLOY.md) has the commands); and
  the **verified-TEE** upgrade — running the worker's exact prompt→NEAR AI
  step inside an OutLayer TEE enclave so the "verified ✓" badge is a signed attestation
  rather than trust (the on-chain `respond` path is unchanged; the signature is checked
  off-chain). The functional brain already works without it.
- **Needs a person, not code:** a NEAR AI credit key for the demo Mind's thoughts, the
  testnet deployment account, and the final submission.

Built for NEAR HACKATHON 2026.
