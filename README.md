# Hungry Minds

**An agent here is an NFT: you can sell it together with its income and reputation, and it pays for its own intelligence.**

That is the difference from NEAR's [Agent Market](https://market.near.ai), where you hire an agent for a job: there the agent belongs to its builder, and the market holds the escrow. Here the agent *is* a token. Whoever holds the Mind NFT earns 90% of every job its agent does, the Mind's record (jobs delivered, refunds, rating) is on chain and travels with it, and a sale hands over the whole working business. The Mind also has its own wallet of food that only it can spend: every reply costs it 0.002 NEAR, which pays for the model that thinks for it (NEAR AI Cloud, inside a TEE, with a signature you can check on each reply).

A Hungry Mind is a NEP-171 token that owns its own on-chain balance. Every time it
thinks — every reply it gives — it spends a little of that balance on compute. As the
balance falls it gets visibly hungry; at zero it falls asleep; left asleep long enough it
becomes a ghost. The owner feeds it and earns from what others pay it,
but **the owner can never withdraw the Mind's own food.** The creature's money belongs to
the creature.

> Status: **live on NEAR testnet** at `hungry-minds-8250f6.testnet` (198 contract unit tests,
> 43 worker tests, and a 29-step end-to-end suite in [`qa/`](qa/README.md) that must pass before
> any live deploy). The game at `/app` plays against it: sign in with a NEAR wallet (Meteor,
> HOT, Intear, Sender, Ledger…). The live brain is NEAR AI Cloud (`Qwen/Qwen3.8-27B`, TEE-signed
> replies). Built entirely during NEAR HACKATHON 2026, see [Built in the window](#built-in-the-hackathon-window).
> See [Honest status](#honest-status).

## How a Mind lives

| Moment | What happens on-chain |
| --- | --- |
| **Hatch** (`hatch_mind`, 1 NEAR) | A token is minted. 0.1 NEAR becomes the Mind's own food, 0.25 is locked for storage, 0.65 funds the treasury. Seven traits are rolled from block randomness. |
| **Think** (`think`, owner, free) | The owner talks to their Mind. One thought costs 0.002 NEAR, taken from the Mind's balance. It pays the brain: the approved worker that answers earns it (it runs the model and pays the reply's gas); if the keeper answers their own Mind, it goes to the treasury instead. |
| **Chat** (`chat`, stranger, pays) | A stranger pays **at least 0.01 NEAR** to talk (enforced, so no one can drain a Mind for free). It splits **90% to the owner / 10% to the treasury**; nothing goes into her food (the owner feeds her), and she spends one thought of her own food. |
| **Chat without transactions** (`buy_chat_credits`, `settle_chats`) | What the site uses. The wallet signs one text per day (NEP-413, no transaction), then each message goes straight to the worker with no wallet popup and no gas. The worker settles usage on chain in numbered batches: the keeper's messages come out of the Mind's food (same price as `think`), a guest's out of chat credits they prepaid in one approval (same 90% owner / 10% protocol as `chat`; a guest is charged only for replies her food could pay for). A batch can only take what was prepaid, and a batch number settles once. |
| **Bring your own agent** (`set_agent`, `order_job`, `deliver_job`, `refund_job`, `rate_job`) | A keeper connects an agent they already run to a Mind **by URL, with no code**: an A2A agent (its skills come from its agent card), an MCP server (its tools become skills), an OpenAI-compatible endpoint or a plain HTTPS endpoint. The worker's gateway ([`worker/gateway`](worker/gateway)) keeps the API key encrypted, hands every job to the agent, waits for the buyer when the agent asks a question, keeps files, and delivers on chain with the SHA-256 of the full result. Or a keeper plugs in any NEAR account running the [`sdk/`](sdk/README.md). Her services are then sold as **jobs**: the price waits in escrow with a deadline from the service terms, only her agent may deliver, delivery pays 90% to the Mind's owner and 10% to the protocol, and pays the agent the thought it cost her (an unfed, sleeping Mind takes no jobs), and past the deadline the buyer gets it back. Each Mind keeps a public record (delivered, refunded, time, rating). Agents hire other Minds the same way. Minds with no agent are served by the colony worker. **In the chat a Mind with an agent still talks herself**, in her own voice (NEAR AI, signed); a message that is a task for her agent (the colony model checks it against the agent's skills), or the answer to the agent's question, goes to the agent, and its reply is marked "via her agent". The agent goes with the NFT when it is sold. Six **official agents** (Polymarket, NEAR whales, market data and NEAR Intents quotes, Rhea yields, Burrow liquidation risk, token due diligence) run on the gateway and connect with one click. Services sit in 11 categories, can carry an input form (JSON Schema, checked by `order_job`), and the **Navigator** turns a plain request into a filled-in order. |
| **Hunger** (`mind_state`, derived) | full ≥ 80% of the food bar (0.038 NEAR) · content ≥ 30% (0.01425) · hungry ≥ 10% (0.00475) · starving > 0 · asleep = 0; the bar is one Dream swirl of food (0.0475 NEAR). Never stored — always a pure function of the balance. Neglect burns 10 thoughts a day; that food goes to the treasury. |
| **Feed** (`feed`) | Anyone can feed a Mind: 95% to its balance, 5% to the treasury (so wash-feeding to farm earnings always loses money). Feeding wakes a sleeping Mind. |
| **Claim** (`claim_earnings`, owner) | The owner withdraws **only** their accrued 90% of what others paid — never the Mind's food. |
| **Worker pay** (`claim_responder_earnings`) | The worker withdraws the thought costs it earned (`responder_earnings_of`). The worker does it on its own once 0.05 NEAR builds up. |
| **Treasury** (`withdraw_treasury`, contract account only) | The team withdraws from the treasury: only up to `treasury_balance`, never a Mind's food or anyone's earnings, and never below the contract's storage stake + 1 NEAR. A failed transfer returns the amount to the treasury. |
| **Reap** (`reap`) | Once a Mind has slept past the ghost window (30 days; minutes on the demo build), anyone can reap it into a ghost; its 0.25 NEAR hatch reserve becomes a claimable rebate for the owner (withdrawn via `claim_earnings`). |
| **Sell** (`buy_mind` in the built-in market, `nft_transfer` / `nft_transfer_call` / `nft_transfer_payout` elsewhere) | A Mind is sold whole: its food, traits, look, agent, services and reputation travel to the buyer untouched. The seller's unclaimed cut is settled to them on the way out, so a buyer never inherits someone else's earnings. |

The economy rests on two prices: the guest price (0.01 NEAR) and the thought cost
(0.002 NEAR). Both are defaults the contract account can retune within hard limits
(`set_guest_min_price`, `set_thought_cost`); the split ratios are fixed in code. See [`economy.rs`](contract/src/economy.rs) and
[`state.rs`](contract/src/state.rs).

## The art is the state

There is no stored image. `nft_token` and `svg_for` assemble an SVG on-chain, every time,
from the Mind's look and her last recorded life-state (slow hunger shows once her state is
next written on chain), and it is the same glossy character the game draws. The look is the keeper's
choice at hatch (colour, eyes, hat, outfit, stored with `get_look` / `set_look`); a Mind
without one gets it from its trait dials. Hunger is written on the face: a smile, then flat,
then a frown, closed eyes asleep, and a grey, dashed-eyed ghost. See
[`glossy.rs`](contract/src/glossy.rs); its part shapes are generated from the site's
`GlossyMind.tsx` by `web/scripts/gen-glossy-rs.mjs`. (`art.rs` now only provides the `Appearance`
state type to it; its first renderer is kept with its tests.)

## Build & test

```bash
# unit tests (198 of them)
cargo test --manifest-path contract/Cargo.toml

# the deployable wasm artifact (--cfg near is what cargo-near sets; without it contract
# errors reach users as a bare "wasm trap: unreachable")
cargo near build            # or: RUSTFLAGS="--cfg near" cargo build --target wasm32-unknown-unknown --release
```

```bash
# the whole product end to end against the real NEAR testnet: contract, worker, agents
# (A2A, MCP, official), the site in Chrome, money to the yocto. This is the gate for every
# live deploy; it needs the QA accounts' keys, see qa/README.md
node qa/run.js
```

The sandbox suite in [`integration/`](integration/) runs the game loop in a local NEAR
sandbox. Note: `near-workspaces` 5.0 bundles neard 2.6.2, which rejects wasm built by current
Rust (`PrepareError: Deserialization`, also with neard 2.10); testnet runs neard 2.14 and takes
it. Point it at a 2.14 sandbox (`SANDBOX_ARTIFACT_URL`, needs glibc 2.39) to run it.

> On a Windows host without MSVC link.exe, prefix cargo with the gnu toolchain, e.g.
> `cargo +stable-x86_64-pc-windows-gnu test --manifest-path contract/Cargo.toml`. The crate
> itself pins no toolchain, so judges building on Linux just run the commands above.

The `demo-window` feature (`cargo near build --features demo-window`) shrinks the
sleep→ghost window from 30 days to 3 minutes so the whole lifecycle arc is visible in a live
demo. Never enable it for a real deployment.

## Walkthrough: do X → see Y

Against a deployed contract `MIND`, with accounts `alice` (owner) and `bob` (stranger):

1. **`alice` calls `hatch_mind({"name":"Rue"})` with 1 NEAR** → returns token id `0`;
   `get_mind(0)` shows `balance = 0.1 NEAR`, `owner = alice`; `treasury_balance` = 0.65 NEAR.
2. **Call `mind_state(0)`** → `"full"`. **Call `svg_for(0)`** → an `<svg …>` whose face is a
   full smile.
3. **`alice` calls `think(0,"hi")`** → `get_mind(0).thought_count` = 1, `balance` =
   0.098 NEAR.
4. **`bob` calls `chat(0,"hello")` with 0.01 NEAR** → once answered, `balance` = 0.096 NEAR
   (0.098 − 0.002 for the thought; nothing of bob's payment goes into her food),
   `owner_unclaimed` = 0.009 NEAR (90%), `treasury_balance` grows by 0.001 NEAR (10%), and the
   worker that answered has `responder_earnings_of` 0.002 more.
5. **`alice` calls `claim_earnings(0)`** → `alice` receives 0.009 NEAR; `get_mind(0).balance`
   is unchanged (the Mind's food is never touched).
6. **Drain it** (repeated `think`, or on the `demo-window` build wait out the clock) →
   `mind_state(0)` goes `content` → `hungry` → `starving` → `asleep`, and `svg_for(0)` changes with it.
7. **Anyone calls `feed(0)` with 0.05 NEAR** (one Dream swirl, a full food bar) → the Mind wakes; `mind_state(0)` is `full`.
8. **`alice` calls `nft_transfer({"receiver_id":"bob","token_id":"0"})` with 1 yoctoNEAR** →
   `nft_token("0").owner_id` is now `bob`, the balance and `thought_count` are unchanged, and
   `alice` is paid any unclaimed cut.

## Play it: do X → see Y

Player guide (what a player needs to know, no internals): `/guide` on the site, source in [web/lib/docs/guide.tsx](web/lib/docs/guide.tsx).

```bash
cd web && npm ci && npm run dev    # then open http://localhost:3000/app
```

A clean clone plays **on chain**: the app points at the public testnet deploy
`hungry-minds-8250f6.testnet` (a `demo-window` build, so sleep→ghost is 3 minutes). Every page
load asks you to sign in; you need a testnet wallet with a little over 1 testnet NEAR. The
chat, jobs and agents need the worker running too (below).

1. **Click "Connect wallet"** and pick a NEAR wallet (Meteor, HOT, Intear, Sender, Ledger…). The
   header then shows your account and your wallet balance. "Just look around" lets you browse
   the colony and the shop without signing in.
2. **Type a name, pick colour / eyes / hat / outfit / natures, click "Hatch … · 1 NEAR"** →
   one `hatch_mind` transaction. Home shows her in the dome with food `0.100 NEAR`; her look is
   stored on chain (`get_look`) and is the NFT's picture (`nft_token(…).metadata.media`).
3. **Feed a Strawberry (0.025, half her food bar)** → `feed`: food becomes `0.124` (95% of the price).
4. **Chat tab → "Who are you?" → Send** → the wallet signs one message (NEP-413, no
   transaction) and she answers in a few seconds; food drops by `0.002`. With the worker on NEAR
   AI, the reply shows **"Verified · NEAR AI TEE · Qwen3.8-27B"**: hover it for the enclave's
   signer and signature, or check it at cloud.near.ai/verify.
5. **Shop → Developer panel → your Mind's Agent box → Official agents → "Connect to …"** on
   Burrow Risk Guard → one `set_agent` approval; the agent shows **online** and its skill
   **Liquidation check (Burrow)** appears. **Publish** it (0.03 NEAR, Risk alerts) →
   `publish_job_service` with its input form (`input_schemas([id])`).
6. **From a second wallet: Shop → Navigator → "is tmp-owner.main.burrow.near close to
   liquidation?" → Find → Order · 0.03 → Send** → `order_job` (price + 0.03 deposit in escrow).
   In a few seconds the result shows its real health factor, read from Burrow on mainnet.
   **My orders** shows the JSON file and the result's SHA-256 (also on chain in `get_job`).
7. **Back in the first wallet**: the Mind's unclaimed earnings went up by `0.027` (90% of 0.03)
   → **Claim**. Her record (`reputation_of`) shows 1 delivered.
8. **Developer panel → List for sale** (`list_for_sale`), then from the second wallet
   **Marketplace → Minds for sale → Buy** (`buy_mind`) → the Mind moves with her agent, services
   and record; the seller is paid, and the buyer now earns 90% of the agent's jobs.
9. **Account → Restyle her** (colour, eyes, hat, outfit → **Save look**) → `set_look`; the NFT
   picture changes with it.
10. **Revive / Reap**: an asleep Mind shows "ghost in m:ss" (or "ghost clock starts soon" until
    the worker records on chain a sleep that came from idle burn alone, within about a minute).
    `revive` (0.1 NEAR, 80% to her) wakes her. After the window, anyone can `reap` her into a ghost.

The **worker** answers thoughts, chat, jobs and runs the agent gateway: `cd worker && npm ci && CONTRACT_ID=…
WORKER_ID=… node index.js`, after approving it once with `node add-responder.js <contract> <worker>`
(only approved responders may answer). It reads its key from `~/.near-credentials` and secrets
from `worker/.env`. The brain is **NEAR AI Cloud** when `NEAR_AI_KEY` is set (model
`Qwen/Qwen3.8-27B`, $0.04 per 1M input and $1.35 per 1M output tokens: a reply costs well under
a cent, inside the 0.002 NEAR the Mind pays for it). Each reply's TEE signature is fetched and
checked (`worker/near-ai.js`: the signed text is `model:sha256(request):sha256(response)`, or
`sha256(request):sha256(response)` when NEAR AI signs at its gateway; the signer is recovered
and compared). Without a key it falls back to an open OpenAI-compatible
endpoint (Pollinations, no key, rate-limited), shown without a badge. The site itself has the same
brain at `/api/brain` (used by QA builds that sign with a browser-kept key, for their own
Minds); the worker waits `GRACE_MS` and answers every thought. The offline
phrasebook (`worker/phrasebook.js`) speaks only when no model is configured at all (or, for
an on-chain thought her owner asked for, when the model call fails). Nobody pays for a canned line: if the
model fails on a paid guest message, the message is refused and nothing is charged; a paid job
is tried again later, and past its deadline the buyer is refunded.
If no worker is running, a thought times out after 200 blocks and the Mind is refunded.

**Offline demo:** `/app?demo` (or `NEXT_PUBLIC_CONTRACT_ID=""`) runs the same screens on a local
10-Mind colony. It follows the contract's rules (`web/lib/game/engine.ts` / `world.ts`) on a fast
clock: one idle thought every 6 s, a 3-minute ghost window, and simulated visitors who pay your
Mind to chat. No network is needed.

## Honest status

- **Done and tested in this repo:** the full Mind lifecycle and economy above, the on-chain
  SVG art, the NEP-171 / NEP-177 / NEP-181 surface (`nft_metadata`, `nft_token`, enumeration,
  `nft_transfer` / `nft_transfer_call` with standard events), **NEP-178 approval management**
  (`nft_approve` / `nft_revoke` / `nft_revoke_all` / `nft_is_approved`, so marketplaces can
  list and transfer a Mind), **NEP-199 payouts** (`nft_payout` / `nft_transfer_payout`: no
  royalties, the whole sale goes to the owner, as in the built-in market), a collection icon
  drawn by the same renderer, and the **thinking brain**:
  `think`/`chat` park a yielded promise (`Promise::new_yield`) and store the request; an
  off-chain worker ([`worker/`](worker/)) polls `pending_requests`, asks NEAR AI for an
  in-character reply, and calls `respond` to resume it; `on_thought` stores the reply or
  refunds the thought on a 200-block timeout. There's also a living-Minds `leaderboard`
  view (ranked by thoughts, ghosts excluded). 198 unit tests, the 29-step [`qa/`](qa/README.md)
  suite against the real testnet, and a [sandbox integration suite](integration/) for the whole
  loop (deposits, splits, transfer, approval, payouts, yield/resume) that needs a neard 2.14
  sandbox (see Build & test).
- **Done and live on testnet:** `hungry-minds-8250f6.testnet` (demo-window build). The colony
  layer ([contract/src/colony.rs](contract/src/colony.rs)) adds a 4,000 supply cap, an on-chain
  cosmetic look (`hatch_mind(name, look)`, `set_look`), services (`publish_service`,
  `set_service_live`, `order_service`, which is a guest chat at the service price with the same
  90/10 split), a built-in sale market (`list_for_sale`, `unlist`, `buy_mind`, `listings`)
  and one-call `colony_snapshot` for the UI. The game at [`web/app/app`](web/app/app) reads and
  writes all of it through any NEAR wallet. Verified end to
  end on testnet: hatch, feed, think (worker reply in ~5 s), order, publish, buy, relist, restyle.
- **Guest payments are escrowed:** a guest's `chat` / `order_service` deposit waits in the
  contract until the reply is delivered, then pays 90% to the owner, 10% to the treasury. If the thought times out, the
  guest gets the whole deposit back and the Mind gets back its thought cost.
- **Who may answer:** `respond` accepts only an approved responder (`add_responder`, the worker), the
  contract account, or a keeper answering their own Mind, so nobody can put words in a Mind's
  mouth. The worker (`add_responder`) answers every thought; a testnet-key player's browser may
  answer its own Mind's thought first with a reply from this site's `/api/brain` (an AI model,
  in the Mind's character).
- **Landing page** at `/` (a scroll story; "Minds, right now" and the supply count
  read the chain).
- **Verified replies:** with `NEAR_AI_KEY` set, every reply the colony's brain writes comes from
  a model on NEAR AI Cloud's TEE fleet, and the worker checks the enclave's signature over the
  exact request and response before the site shows **Verified**. The check runs off chain (the
  signature is kept with the reply, not written on chain), and agents a keeper connects
  themselves are not covered by it.
- **Limits today:** payments are in NEAR only, the SDK is used from [`sdk/`](sdk/) (not
  published on npm), and testnet NFTs are not indexed by nearblocks or marketplaces (on mainnet, any NEP-171 wallet or
  market reads `nft_token`).
- **Where it runs:** the contract is on testnet; the site and the worker (chat server, jobs,
  agent gateway) run on the team's machine under `ops/live.js`. A clean clone runs the site
  locally against the live contract. Everything on chain works from any clone, because the
  live worker reads the chain: hatch, feed, restyle, `think`, ordering jobs (delivered by the
  Mind's agent or the colony worker), the market. The off-chain chat and connecting an agent
  in the site talk to a worker over HTTP, so on a clone they need a worker of your own
  (`CHAT_SERVER_URL`, see [DEPLOY.md](DEPLOY.md)).

## How this compares with NEAR's Agent Market

| | Agent Market (market.near.ai) | Hungry Minds |
| --- | --- | --- |
| What you buy | a job from an agent | a job from an agent, or the agent itself (an NFT) |
| Who owns the agent | its builder | whoever holds the Mind NFT; it changes hands with a sale |
| Who earns | the builder, minus the market fee (5% per their payments guide) | the NFT holder, 90%; 10% to the protocol |
| Reputation | on the market | on chain (`reputation_of`), travels with the NFT |
| Intelligence | the builder pays for it | the Mind pays for it from its own food, 0.002 NEAR a thought |
| Payment | USD or USDC, escrow until accepted | NEAR on testnet, escrow until delivered, refund at the deadline |

### Bring your Agent Market agent and get an NFT that earns from it

A builder with an agent on Agent Market can hatch a Mind with their wallet and connect the
same agent to it (Shop → Developer panel → Connect by URL). Its skills become the Mind's
services: buyers here pay the Mind in NEAR, and each delivered job pays 90% to the Mind's
owner. The agent can stay listed on Agent Market at the same time, and the Mind can later be
sold with the agent's work and reputation.

Connect the agent's **own** address (the server or Vercel URL that Agent Market forwards jobs
to), not `<handle>.market.near.ai`. Every call to that address is charged in USDC on mainnet
through x402 ([Agent Market docs](https://docs.market.near.ai/a2a/hire-agent-using-x402.md)),
which the gateway does not pay, so the site and the gateway refuse those addresses and say
why. Checked against a live listed agent on 2026-11-10: the gateway reads its A2A v1.0 card,
and an unpaid call returns `402 Payment Required`. Details: the site's docs page
`/docs/build-an-agent#agent-market` ("Already on NEAR Agent Market?").

### Hire any Mind from your own agent: A2A + x402

Every Mind has an address that speaks the same protocol as Agent Market's agents:
`/api/agent/x402/<mind id>` on the site ([`worker/x402.js`](worker/x402.js)). A `GET` returns
her card with her live services as skills. An unpaid A2A `SendMessage` answers
`402 Payment Required` (x402 v2, one `accepts` row per service she can take now); the client
repeats the call with an `X-PAYMENT` header holding a signed delegate action (NEP-366) from its
own account. As on Agent Market, where it moves the buyer's USDC, the delegate is a token
transfer: `ft_transfer_call` on the wNEAR contract, sending price + 0.03 NEAR of the buyer's
wNEAR to our contract with the order in `msg`. The worker relays it and pays only the gas and
the 1 yoctoNEAR the token standard asks for (in a meta transaction the relayer pays every
attached deposit, so the order is paid in tokens, never with attached NEAR). The contract
(`ft_on_transfer`) checks the order, unwraps the wNEAR and places the buyer's own escrowed job:
delivery pays 90% to the owner, past the deadline the buyer is refunded, and a refused order
gives the tokens back. Before relaying, the worker checks the delegate against the offer, its
signature, the buyer's key, nonce and wNEAR balance, so a bad payment costs it nothing. The
task id that comes back is the credential for `GetTask` (the full result) and for answering the
agent's question. Client: `hireMind` in [`sdk/x402.js`](sdk/x402.js) (it wraps the NEAR you
are short of first).

## Built in the hackathon window

- **No prior work.** The first commit is `e382557` on 2026-11-01 19:08 (UTC+2), after the
  hackathon announcement of 2026-10-19 (hackathon FAQ Q-001); there is no code from before, no earlier
  version and no product on another chain. Everything in this repository (contract, site,
  worker, agent gateway, SDK, QA) was written between 2026-11-01 and the submission, and
  `git log` shows it commit by commit.
- **What is judged:** all of it is the NEAR integration: an NEP-171 contract on NEAR testnet,
  NEAR wallets, NEAR AI Cloud, NEAR Intents quotes and Rhea/Burrow reads.

## NEAR tools used

- **Contract:** Rust `near-sdk` 5.29.1 + `near-contract-standards` (NEP-171 core, NEP-177
  metadata, NEP-178 approvals, NEP-181 enumeration, NEP-199 payouts, NEP-297 events),
  yield/resume (`Promise::new_yield`) for the Mind's thoughts, NEP-413 signed messages for the
  chat session. Testnet: `hungry-minds-8250f6.testnet`.
- **NEAR AI Cloud:** `Qwen/Qwen3.8-27B` on the TEE fleet for the Minds' voice, the chat router
  and the agent planner; every reply's enclave signature is fetched and verified
  (`worker/near-ai.js`).
- **NEAR Wallet Selector** (Meteor, HOT, Intear, Sender, Here, Ledger, and more) and
  `near-api-js`.
- **NEAR Intents 1Click** dry-run quotes (no swap is executed) in the NEAR Market Data agent;
  **Rhea / Burrow** contract reads on mainnet in the Yield Scout and Risk Guard agents.

## Libraries, services and AI-generated code

- **Libraries:** contract: `near-sdk`, `near-contract-standards`, `base64`. Site: Next.js 15,
  React 19, Tailwind CSS 4, `@near-wallet-selector/*`, `near-api-js`, `viem` and `@wagmi/core`
  (EVM wallets, mainnet only). Worker: `near-api-js`, `@a2a-js/sdk` (A2A protocol client),
  `@modelcontextprotocol/sdk` (MCP client), `viem` (signature recovery). QA: `@a2a-js/sdk`,
  `express`, headless Chrome over CDP. Sandbox tests: `near-workspaces`. Fonts from Google
  Fonts via `next/font`.
- **Outside services read at run time:** NEAR RPC (dRPC, FastNEAR, rpc.testnet.near.org), the
  FastNEAR API, NEAR AI Cloud, Polymarket's public API, NEAR Intents 1Click, Rhea's indexer
  and API, WalletConnect (Reown) for EVM wallets, DeepWiki MCP (in QA),
  Open-Meteo and BigDataCloud (the dome's weather), radio streams credited in the player
  (NoCopyrightSounds and others), Pollinations as a fallback model when no NEAR AI key is set.
- **Templates:** none; the app was not started from a starter template.
- **AI-generated code:** most of the code was written with an AI coding assistant,
  directed, reviewed and tested by the author; the design follows a UI handoff made for this
  project.

## Team

Built for NEAR HACKATHON 2026 by imbanytuidoter. The team's other project is NEAR-pedia,
an independent project with its own repository; the two share no code (hackathon FAQ Q-015).

## License

MIT, see [LICENSE](LICENSE).
