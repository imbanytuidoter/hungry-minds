# Hungry Minds — worker

The off-chain half of the game. It answers the Minds' thoughts, runs the off-chain chat
(`chat-server.js`), carries out colony jobs (`jobs.js`), runs the agent gateway
(`gateway/`) for agents connected by URL, and records sleeps.

## The thought loop

1. Polls the contract view `pending_requests()` for parked thoughts.
2. For each, reads the Mind (`get_mind`, `mind_state`) and builds its personality from
   its on-chain traits (`personality.js`).
3. Asks NEAR AI Cloud for a short, in-character reply (with no `NEAR_AI_KEY`, an open
   OpenAI-compatible endpoint; if no model answers, the offline `phrasebook.js`).
4. Calls `respond(request_id, reply)` on the contract, which resumes the parked promise;
   the contract stores the reply on the Mind (or, on a 200-block timeout, refunds the
   thought).

## Run

```bash
cp .env.example .env     # fill in CONTRACT_ID, WORKER_ID, WORKER_KEY, NEAR_AI_KEY
npm install
npm start
```

The worker account calls `respond`, `settle_chats`, `deliver_job`, `refund_job`, `settle`
and `claim_responder_earnings`, and pays their gas; a throwaway faucet account is fine.
It can never withdraw any Mind's food.

## Verified ("✓") thoughts

With `NEAR_AI_KEY` set, the model runs inside **NEAR AI Cloud's TEE**, and every reply comes
with the enclave's signature over the exact request and response. The worker fetches it and
checks it (`near-ai.js`: the signed text is `model:sha256(request):sha256(response)`, EIP-191,
the signer is recovered and compared) and keeps the proof with the reply, so the site shows
"verified ✓" and anyone can re-check it at https://cloud.near.ai/verify. The check is
**off-chain**: the contract's `respond` is unchanged and money is never gated on a signature.
Without a key the worker uses the open fallback endpoint and replies carry no badge.
