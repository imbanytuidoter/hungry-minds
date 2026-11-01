# Deploy Hungry Minds to testnet

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

# a throwaway worker account (only calls respond + pays gas)
near create-account hm-worker.$ACC --masterAccount $ACC --initialBalance 5
```

## 3. Deploy

```bash
near deploy hungry-minds.$ACC <path-to>/hungry_minds_contract.wasm
```

No init call is needed — the contract initializes from `Default` on first use.

## 4. Hatch a demo Mind and pre-fund its thinking

```bash
# hatch (2 NEAR): 1.0 becomes the Mind's food, 0.75 treasury, 0.25 storage reserve
near call hungry-minds.$ACC hatch_mind '{"name":"Juno"}' \
  --accountId $ACC --deposit 2

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
near call hungry-minds.$ACC think '{"id":0,"prompt":"who are you?"}' --accountId $ACC --gas 100000000000000
near view hungry-minds.$ACC last_thought '{"id":0}'    # -> Juno's reply

# a stranger pays 0.01 to chat (70% feeds Juno, 20% to the owner, 10% treasury)
near call hungry-minds.$ACC chat '{"id":1,"prompt":"hello"}' --accountId someone.testnet --deposit 0.01 --gas 100000000000000

# feed, claim, drain-to-asleep, reap (demo-window build), sell — see README walkthrough
```

The worker account never touches a Mind's balance; it only calls `respond` and pays gas.
Keep the worker's and NEAR AI keys out of git (worker/.gitignore covers `.env`).
