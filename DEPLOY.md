# Deploy Hungry Minds to testnet

## Current deploy

`hungry-minds-8250f6.testnet` (demo-window build), deployed **clean**: no Minds were hatched
for it, so every Mind, service, sale and ghost you see there is a real player's. Worker:
`hm-worker-19652a.testnet`, approved with `add_responder` (only approved responders may answer
thoughts).
Keys are in the deployer's `~/.near-credentials/testnet/`, never in this repo. The web app
points here by default.

`hungry-minds-19652a.testnet` is the earlier development deploy: its 14 Minds were all
hatched by the team's seed and test accounts during setup and QA. Kept for reference only.

## Changing the live deploy (the only supported way)

```bash
node qa/run.js            # the whole suite on the QA contract; stamps qa/out/last-pass.json when it all passes
node ops/deploy-live.js   # refuses unless that stamp matches this exact code; then deploys the contract and the site
```

Never deploy by hand with `worker/redeploy.js` against the live contract: the deploy script is what
checks the QA stamp, the contract's free NEAR for storage, that the new code answers, and builds
the site beside the running one so visitors never see a half-built site. See `qa/README.md`.

The live site and worker run under a supervisor that restarts them when they crash or stop
answering, and keeps running after the terminal that started it closes:

```bash
node ops/live.js start    # in the background; logs in ops/logs/
node ops/live.js status   # supervisor, worker and site
node ops/live.js stop
```

## Quick path: no near-cli, just node

`rpc.testnet.near.org` is deprecated and rate-limits, so the scripts default to FastNEAR. If
FastNEAR's free tier returns 429, set `NEAR_RPC=https://near-testnet.drpc.org`.

```bash
# wasm (near-sdk 5.29 needs Rust >= 1.93; Windows hosts without MSVC use the gnu toolchain).
# --cfg near is what cargo-near sets: without it near-sdk compiles env::panic_str's off-chain
# branch and every contract error reaches users as a bare "wasm trap: unreachable".
RUSTFLAGS="--cfg near" cargo +stable-x86_64-pc-windows-gnu build --target wasm32-unknown-unknown --release \
  --features demo-window --manifest-path contract/Cargo.toml

cd worker && npm ci
node testnet-account.js hungry-minds-<suffix>.testnet           # faucet-funded account, key -> ~/.near-credentials
node setup-testnet.js hungry-minds-<suffix>.testnet ../contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm <suffix>
#   deploys, creates worker + two keeper accounts, hatches 6 Minds with looks,
#   publishes 7 services, lists one Mind for sale. Note: some of those demo services use
#   categories that are now agent-only, so they need an agent on the Mind first (or pick
#   categories 7-10)
node smoke-colony.js  hungry-minds-<suffix>.testnet <suffix>     # set_look, list/unlist, pause
node redeploy.js hungry-minds-<suffix>.testnet <wasm>            # new code, same state
node reset-contract.js hungry-minds-<suffix>.testnet <wasm> <beneficiary>.testnet  # testnet only: wipe to 0 Minds, same id
node add-responder.js hungry-minds-<suffix>.testnet hm-worker-<suffix>.testnet       # once: let the worker answer thoughts

CONTRACT_ID=hungry-minds-<suffix>.testnet WORKER_ID=hm-worker-<suffix>.testnet node index.js   # the brain
```

Then set `NEXT_PUBLIC_CONTRACT_ID` (or `TESTNET_DEPLOY` in `web/lib/chain.ts`) to the new account.

## Manual path with near-cli

Exact commands to get a live, judge-reproducible demo. `$ACC` is your testnet account.

## 1. Build the wasm

```bash
# optimized build + ABI (preferred)
cargo near build --manifest-path contract/Cargo.toml
# -> contract/target/near/hungry_minds_contract.wasm (+ an ABI json)

# For the live demo arc in minutes instead of 30 days, add the demo-window feature:
cargo near build --features demo-window --manifest-path contract/Cargo.toml
```

Fallback without cargo-near:

```bash
cargo build --target wasm32-unknown-unknown --release --manifest-path contract/Cargo.toml
# -> contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm
```

## 2. Accounts

```bash
# the contract account (or create a fresh subaccount)
near create-account hungry-minds.$ACC --masterAccount $ACC --initialBalance 10

# a throwaway worker account (answers chat, delivers and refunds jobs, records sleep; pays gas)
near create-account hm-worker.$ACC --masterAccount $ACC --initialBalance 5
```

## 3. Deploy

```bash
near deploy hungry-minds.$ACC <path-to>/hungry_minds_contract.wasm
```

No init call is needed — the contract initializes from `Default` on first use.

## 4. Hatch a demo Mind and pre-fund its thinking

```bash
# hatch (1 NEAR): 0.1 becomes the Mind's food, 0.65 treasury, 0.25 storage reserve
near call hungry-minds.$ACC hatch_mind '{"name":"Juno"}' \
  --accountId $ACC --deposit 1

# verify it is alive
near view hungry-minds.$ACC mind_state '{"id":0}'      # -> "full"
near view hungry-minds.$ACC svg_for '{"id":0}'         # -> an <svg ...>
```

## 5. Run the brain (worker)

```bash
cd worker
cp .env.example .env
#   CONTRACT_ID=hungry-minds.$ACC
#   WORKER_ID=hm-worker.$ACC   WORKER_KEY=ed25519:...   (its full-access key)
#   NEAR_AI_KEY=...            (NEAR AI Cloud, a Private-TEE model for "verified")
npm install && npm start
```

## 6. The demo loop (do X -> see Y)

```bash
# owner thinks: parks a thought, worker answers, reply lands on-chain
# (300 Tgas — think/chat park a yield and schedule the on_thought callback)
near call hungry-minds.$ACC think '{"id":0,"prompt":"who are you?"}' --accountId $ACC --gas 300000000000000
near view hungry-minds.$ACC last_thought '{"id":0}'    # -> Juno's reply

# a stranger pays 0.01 to chat (90% to Juno's owner, 10% treasury; Juno spends one thought of her own food)
near call hungry-minds.$ACC chat '{"id":0,"prompt":"hello"}' --accountId someone.testnet --deposit 0.01 --gas 300000000000000

# feed, claim, drain-to-asleep, reap (demo-window build), sell — see README walkthrough
```

The worker account never takes a Mind's food. It calls `respond`, `settle_chats`, `deliver_job` and
`refund_job`, and `settle` for a Mind that starved on idle burn (so her sleep is recorded and the ghost
window starts; SLEEP=off turns that off), and pays the gas for all of them. It also relays x402
payments (signed delegate actions: it pays their gas and the 1 yoctoNEAR the token standard asks
for) and registers the contract with wNEAR once.
Keep the worker's and NEAR AI keys out of git (worker/.gitignore covers `.env`).

## 7. Point the web at it (goes live, no code change)

```bash
cd web
cp .env.example .env.local
#   NEXT_PUBLIC_CONTRACT_ID=hungry-minds.$ACC
#   CHAT_SERVER_URL=http://127.0.0.1:8788   (the worker's chat server + agent gateway; this is the default)
#   NEXT_PUBLIC_SITE_URL=https://<public domain>   (link previews: makes og:image absolute on every
#                                                  Next page; also put the absolute image URL in
#                                                  web/public/seed/index.html, the static landing)
npm install && npm run build && npm start
```

The site's `/api/chat/*` and `/api/agent/*` routes forward to the worker at `CHAT_SERVER_URL`:
the off-chain chat (no transaction per message) and connecting an agent need it. Everything
else the site does is a transaction or a view on the contract, so it works with only the
contract deployed; the worker answers those on chain wherever it runs.

`NEXT_PUBLIC_CONTRACT_ID` unset: the game at `/app` plays the public testnet deploy
(`hungry-minds-8250f6.testnet`), reads the chain over RPC, and the Connect-wallet button +
hatch/feed/talk sign real transactions through NEAR Wallet Selector. Set to an account: the
same, against that contract. Set to an empty string (`NEXT_PUBLIC_CONTRACT_ID=""`): the offline
demo world, a local colony with no network (`/app?demo` does the same on any build).
