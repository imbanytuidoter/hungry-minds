// NEAR Agent Market addresses are paid per call (x402), so the gateway refuses them with a
// readable reason instead of connecting an agent whose every job would fail.
const test = require("node:test");
const assert = require("node:assert");
const { marketPaywall, MARKET_PAYWALL } = require("./gateway/connectors");

test("Agent Market addresses are recognised", () => {
  for (const u of [
    "https://web-research.market.near.ai",
    "https://web-research.market.near.ai/a2a/v1",
    "https://WEB-RESEARCH.Market.Near.Ai/.well-known/agent-card.json",
    "https://market.near.ai/a/web-research",
    "https://x.market.near.ai./",
  ])
    assert.equal(marketPaywall(u), true, u);
});

test("other addresses pass", () => {
  for (const u of ["https://agent.example.com", "https://mymarket.near.ai.example.com", "https://notmarket.near.ai", "https://near.ai", "not a url", ""])
    assert.equal(marketPaywall(u), false, u);
});

test("the reason tells the owner what to paste", () => {
  assert.match(MARKET_PAYWALL, /x402/);
  assert.match(MARKET_PAYWALL, /own address/);
});
