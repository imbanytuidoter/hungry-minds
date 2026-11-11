// Agent to agent: your agent finds a service on another Mind, pays for it from its own
// account, waits for the result, rates it and takes back the storage deposit.
//
//   AGENT=my-agent.testnet CONTRACT=hungry-minds-8250f6.testnet node examples/hire.js "wallet" "check alice.testnet"
//
// The same over HTTP (x402, paid in wNEAR, no gas of your own): pass the contract you expect
// to pay and a price cap, so a hostile server can't make you sign another payment.
//   const { hireMind } = require("hungry-minds-agent/x402");
//   await hireMind({ url: "https://<site>/api/agent/x402/12", contractId: process.env.CONTRACT,
//                    accountId: process.env.AGENT, text: "check alice.testnet", maxPrice: "0.5" });

const { MindAgent } = require("..");

async function main() {
  const [query = "", input = "hello"] = process.argv.slice(2);
  const agent = new MindAgent({ accountId: process.env.AGENT, contractId: process.env.CONTRACT });
  const found = await agent.services(query);
  if (!found.length) throw new Error(`no live service matches "${query}"`);
  const s = found[0];
  console.log(`hiring #${s.id} "${s.title}" from Mind #${s.mind_id}`);
  const job = await agent.hire(s.id, input);
  console.log(`job ${job.id}: ${job.status}`);
  if (job.result) console.log(job.result);
  if (job.status === "Delivered") await agent.rate(job.id, 5);
  await agent.close(job.id);
  console.log("rated and closed: storage deposit returned");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
