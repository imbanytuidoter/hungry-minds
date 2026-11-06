# Integration tests

End-to-end tests that run the **compiled contract wasm in a real NEAR sandbox** (via
[`near-workspaces`](https://github.com/near/near-workspaces-js)). The unit tests in
`contract/src` mock the VM; these prove what a mock can't:

- real attached deposits and the **90/10** (guest chat: owner / treasury, nothing into her
  food) and **95/5** (feed) splits moving real balances between accounts,
- NEP-171 ownership transfer carrying balance + traits + memory, NEP-178 approvals, NEP-199
  payouts,
- the **yield/resume "brain"**: `think`/`chat` park a yielded promise, the worker (played by
  `root`, approved with `add_responder`) calls `respond`, and the reply lands on-chain.

On Windows, run it under WSL (near-sandbox ships no Windows binary).

## Run it (Linux / macOS)

```bash
# 1. build the contract wasm
cd ../contract
cargo build --target wasm32-unknown-unknown --release

# 2. run the sandbox tests
cd ../integration
npm install        # downloads the neard sandbox binary on first install
npm test
```

The test finds the wasm at `../contract/target/wasm32-unknown-unknown/release/hungry_minds_contract.wasm`,
or wherever `CONTRACT_WASM` points.

## Windows

These **cannot run on Windows** — `near-sandbox` ships no Windows binary (its install throws
`Unsupported platform: Windows_NT`). Develop them on Windows if you like, but run them in CI
or on Linux/macOS. CI (`.github/workflows/ci.yml`) runs them on `ubuntu-latest`.
