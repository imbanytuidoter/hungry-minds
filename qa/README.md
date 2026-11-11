# QA

The whole product checked end to end, on the QA contract `hm-qa-q1103b.testnet`, with one command:

```bash
node qa/run.js
```

It exits 0 only when nothing failed, and then writes `qa/out/last-pass.json` with the hash of the code it tested. `ops/deploy-live.js` refuses to deploy anything else, so code reaches the live contract only after this suite passed on that exact code.

| Step | What it checks |
|---|---|
| contract unit tests, worker unit tests, site typecheck + lint | the code itself |
| wasm build, QA deploy, QA site build | what's tested is what would ship |
| official agents on real data | each of the six official agents against Polymarket, FastNEAR, NEAR RPC, Rhea, Burrow, NEAR Intents |
| connector kinds | HTTPS and OpenAI-compatible agents (wrong key refused, questions, files) |
| SDK agent | plug in, job in escrow, delivery, 90% to the NFT owner, rating, agent hires agent, worker refused for an agent-run Mind |
| gateway | a real A2A agent (`fixtures/a2a-agent.js`, the official SDK) and a real MCP server (DeepWiki): connect, jobs, a question to the buyer, files with SHA-256, chat |
| x402 | hire a Mind over A2A + x402 with the SDK's `hireMind`: 402 offer, a mismatched payment refused, paid in wNEAR and relayed by the site (no gas for the buyer), the job escrowed and delivered on chain, task id as credential, a reused payment refused |
| game in Chrome | hatch, feed, chat, publish, guest order, chat credits, claim, list, buy |
| agents in Chrome | connect by URL, official agent, Navigator, order form, answer the agent, download files |
| looks | the hatch draft survives a reload, restyle saves on chain |
| data services need an agent | the contract refuses them while a Mind has no agent |
| NFT standard | wallets and outside marketplaces: NEP-171/177/178/181/199 views and transfers |
| live smoke (read only, when :3000 is up) | first visit, every tab |

Options: `--skip-build` reuses the last builds (no QA redeploy), `--no-ui` skips Chrome, `--no-near-ai` answers with the open model instead of NEAR AI (no NEAR AI credits spent; the Verified check is skipped), `--only="<name>"` runs just the steps whose name contains it (no stamp).

Needs the QA keys in `~/.near-credentials/testnet` (bob-q1103, alice-q1103, alice-q1103b, bob-q1103b, hm-worker-19652a, hm-qa-q1103b), Chrome, Rust with the wasm32 target, and `npm install` in `qa/`. Test accounts are topped up from bob-q1103b when they run low. Logs and screenshots go to `qa/out/`.

A new feature gets its check here, in `chain/` (talks to the contract and gateway) or `ui/` (drives the site with `drive.js`), and a line in `run.js`.
