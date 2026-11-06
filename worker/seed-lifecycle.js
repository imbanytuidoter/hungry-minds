// Give the live colony real sleepers and ghosts, through ordinary contract calls:
//   1. a keeper hatches two Minds;
//   2. the contract account (admin) briefly raises thought_cost to its 0.1 NEAR ceiling;
//   3. each Mind thinks 10 times (its own 1 NEAR of food) and falls asleep — this script
//      answers those thoughts itself from the offline phrasebook (a keeper may answer its own Mind);
//   4. prices are restored (thought_cost first, so guest > thought holds at every step);
//   5. after the ghost window, the first Mind is reaped into a ghost; the second stays asleep.
//
//   node seed-lifecycle.js <contract>.testnet <suffix> [keeper] [sleep-only:Name]
// With a 4th arg like "sleep-only:Juno" it hatches just that one Mind for [keeper] and
// leaves it asleep (no reap).

const { utils } = require("near-api-js");
const { ensureAccount } = require("./testnet-account");
const { phrasebookReply } = require("./phrasebook");
const [, , CONTRACT, SUF, KEEPER = "oleh", MODE = ""] = process.argv;
const SLEEP_ONLY = MODE.startsWith("sleep-only:") ? MODE.slice(11) : null;
const NEAR = (n) => utils.format.parseNearAmount(String(n));
const GAS = "100000000000000";
const GAS_THINK = "300000000000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const admin = await ensureAccount(CONTRACT);
  const keeper = await ensureAccount(`${KEEPER}-${SUF}.testnet`);
  const view = (m, a = {}) => keeper.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const call = (acc, methodName, args, deposit = "0", gas = GAS) => acc.functionCall({ contractId: CONTRACT, methodName, args, gas, attachedDeposit: deposit });

  const before = await view("params");
  const ids = [];
  const toHatch = SLEEP_ONLY
    ? [[SLEEP_ONLY, { tone: 9, eyes: 5, hat: 7, outfit: 0, natures: [1, 4] }]]
    : [
        ["Bram", { tone: 10, eyes: 5, hat: 0, outfit: 3, natures: [3] }],
        ["Ash", { tone: 8, eyes: 7, hat: 0, outfit: 1, natures: [7] }],
      ];
  for (const [name, look] of toHatch) {
    const r = await call(keeper, "hatch_mind", { name, look }, NEAR(1));
    ids.push(JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString()));
    console.log(`hatched ${name} #${ids[ids.length - 1]}`);
  }

  await call(admin, "set_guest_min_price", { yocto: NEAR(0.2) });
  await call(admin, "set_thought_cost", { yocto: NEAR(0.1) });
  console.log("thought_cost temporarily 0.1 NEAR");
  try {
    for (const id of ids) {
      for (let k = 0; k < 10; k++) {
        const thinking = call(keeper, "think", { id, prompt: "Tell me something about your day." }, "0", GAS_THINK).catch(() => {});
        // answer it as soon as it is parked
        for (let i = 0; i < 20; i++) {
          await sleep(1200);
          const reqs = await view("pending_requests", {});
          const r = reqs.find((x) => x.mind_id === id);
          if (r) {
            const mind = await view("get_mind", { id });
            await call(keeper, "respond", { request_id: r.request_id, reply: phrasebookReply({ ...mind, state: "content" }, r.prompt, r.request_id) }, "0", "60000000000000").catch(() => {});
            break;
          }
        }
        await thinking;
      }
      console.log(`#${id} state:`, await view("live_state", { id }));
    }
  } finally {
    await call(admin, "set_thought_cost", { yocto: before.thought_cost });
    await call(admin, "set_guest_min_price", { yocto: before.guest_min_price });
    console.log("prices restored:", JSON.stringify(await view("params")));
  }

  if (SLEEP_ONLY) return;
  const windowMs = await view("ghost_window_ms");
  console.log(`waiting ${Math.round(windowMs / 1000) + 20}s for the ghost window…`);
  await sleep(windowMs + 20_000);
  await call(keeper, "reap", { id: ids[0] });
  console.log(`#${ids[0]} ghost:`, (await view("get_mind", { id: ids[0] })).ghost, "| #" + ids[1], await view("live_state", { id: ids[1] }));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
