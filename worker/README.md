# Hungry Minds — worker

The off-chain half of the game. It answers the Minds' thoughts, runs the off-chain chat
(`chat-server.js`), carries out colony jobs (`jobs.js`), runs the agent gateway
(`gateway/`) for agents connected by URL, serves each Mind's A2A + x402 door (`x402.js`,
`/api/agent/x402/<mind id>` on the site) and relays its payments, and records sleeps.

## The thought loop

1. Polls the contract view `pending_requests()` for parked thoughts.
2. For each, reads the Mind (`get_mind`, `mind_state`) and builds its personality from
   its on-chain traits (`personality.js`).
3. Asks NEAR AI Cloud for a short, in-character reply (with no `NEAR_AI_KEY`, an open
   OpenAI-compatible endpoint). The offline `phrasebook.js` answers only when no model is
   configured, or for the owner's own thought when the model fails; a guest's paid thought
   gets no canned line: it times out and the guest is refunded.
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
and `claim_responder_earnings`, and pays their gas; a throwaway faucet account is fine. It
also relays x402 payments (the buyer's signed delegate actions, paying their gas and the
1 yoctoNEAR the token standard asks for), and registers the contract with wNEAR once
(`storage_deposit`, paid by the worker).
It can never withdraw any Mind's food.

## Verified ("✓") thoughts

With `NEAR_AI_KEY` set, the model runs inside **NEAR AI Cloud's TEE**, and every reply comes
with a signature over the exact request and response. The worker fetches it and checks it
(`near-ai.js`: the signed text is `model:sha256(request):sha256(response)`, or
`sha256(request):sha256(response)` when NEAR AI signs at its gateway; EIP-191, the signer is
recovered and compared with the signing address NEAR AI reports) and keeps the proof with the
reply, so the site shows "verified ✓". The worker does not itself check that address's TEE
attestation; https://cloud.near.ai/verify shows it, and anyone can re-check the signature
there. The check is
**off-chain**: the contract's `respond` is unchanged and money is never gated on a signature.
Without a key the worker uses the open fallback endpoint and replies carry no badge.
