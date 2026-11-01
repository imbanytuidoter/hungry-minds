# Hungry Minds — thinking worker

The off-chain half of a Mind's brain. The contract parks each thought as a yielded
promise; this worker makes the Mind actually think.

## What it does

1. Polls the contract view `pending_requests()` for parked thoughts.
2. For each, reads the Mind (`get_mind`, `mind_state`) and builds its personality from
   its on-chain traits (`personality.js`).
3. Asks NEAR AI Cloud for a short, in-character reply.
4. Calls `respond(request_id, reply)` on the contract, which resumes the parked promise;
   the contract stores the reply on the Mind (or, on a 200-block timeout, refunds the
   thought).

## Run

```bash
cp .env.example .env     # fill in CONTRACT_ID, WORKER_ID, WORKER_KEY, NEAR_AI_KEY
npm install
npm start
```

The worker account only calls `respond` and pays gas — a throwaway faucet account is
fine. It never touches any Mind's balance.

## Verified ("✓") thoughts — the OutLayer upgrade

This worker is the **functional** brain: it produces real, in-character replies, but you
trust that the worker ran the model honestly. The **verified** path runs the exact same
step — build prompt → call NEAR AI → return reply — inside an **OutLayer TEE enclave**
(Intel TDX). The enclave signs the reply with an attestation, so the "verified ✓" badge in
the UI is a cryptographic proof rather than trust. On-chain nothing changes: OutLayer calls
the same `respond`; the signature is verified **off-chain** (EIP-191), and money is never
gated on a signature. Building the OutLayer WASM skill (`wasm32-wasip2`, the `outlayer`
crate) against the live testnet ABI is the remaining step.
