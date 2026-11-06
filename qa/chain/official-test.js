// Every official agent skill against its real data source, through the connector (as jobs run).
const { discover, run } = require("../../worker/gateway/connectors.js");
const cases = [
  ["polymarket-pulse", "hot-markets", '{"limit":3}'],
  ["polymarket-pulse", "hot-markets", "bitcoin"],
  ["polymarket-pulse", "smart-wallets", '{"period":"WEEK","limit":3}'],
  ["polymarket-pulse", "wallet-report", "0xe9b710551dd82a44e79203c2394a2b10163ace7b"],
  ["near-whale-watch", "top-holders", "wrap.near"],
  ["near-whale-watch", "portfolio", "root.near"],
  ["near-market-data", "prices", "NEAR, ETH, USDC"],
  ["near-market-data", "swap-quote", '{"from":"NEAR","to":"USDC","amount":10}'],
  ["rhea-yield-scout", "lending-rates", "{}"],
  ["rhea-yield-scout", "top-pools", "NEAR"],
  ["burrow-risk-guard", "health-factor", "tmp-owner.main.burrow.near"],
  ["token-check", "token-dd", "token.burrow.near"],
  ["near-whale-watch", "portfolio", "not a valid account!!"],
];
(async () => {
  let pass = 0;
  for (const [agent, skill, text] of cases) {
    const conn = { kind: "official", url: `official:${agent}` };
    const t0 = Date.now();
    try {
      if (agent === cases[0][0] && skill === "hot-markets" && text.startsWith("{")) console.log("card:", (await discover(conn)).skills.map((s) => s.id).join(","));
      const r = await run(conn, "", { text, skill }, null);
      const good = r.state === "completed" ? r.text.length > 40 : r.state === "input-required";
      if (good) pass++;
      console.log(`\n== ${good ? "PASS" : "FAIL"} ${agent}/${skill} "${text}" → ${r.state} in ${Date.now() - t0} ms, files: ${r.files.map((f) => `${f.name} ${f.data.length}B`).join(",")}\n${r.text.slice(0, 520)}`);
    } catch (e) {
      console.log(`\n== FAIL ${agent}/${skill} "${text}" → ERROR ${e.message}`);
    }
  }
  console.log(`\n${pass}/${cases.length} passed`);
})();
