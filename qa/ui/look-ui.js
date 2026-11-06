// Look checks on the QA site (:3001):
//   draft: pick a look on the hatch screen, reload, the pick is still there
//   restyle <account> <mindName>: change her outfit/hat in Account, Save look, check get_look on chain
const os = require("os");
const SITE = "http://localhost:3001/app";
const C = "hm-qa-q1103b.testnet";
const view = async (method, args = {}) => {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await (await fetch("https://near-testnet.drpc.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: C, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) })).json();
      if (r.result?.result) return JSON.parse(Buffer.from(r.result.result).toString());
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("view failed " + method);
};
const pressed = (label) => `(() => { const rows = [...document.querySelectorAll("button.chip[aria-pressed=true]")].map(b => b.textContent.trim()); return rows.includes(${JSON.stringify(label)}); })()`;
const chip = (label) => `(() => { const b = [...document.querySelectorAll("button.chip")].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return "NO CHIP " + ${JSON.stringify(label)}; b.click(); return "picked " + ${JSON.stringify(label)}; })()`;

module.exports = async (b, [role, account, mindName]) => {
  const out = [];
  const ok = (c, label, extra = "") => out.push(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 150) : ""}`);
  if (role === "draft") {
    await b.goto(SITE);
    await b.js(`localStorage.removeItem("hm-burner"); sessionStorage.removeItem("hm-hatch-draft"); "ok"`);
    await b.goto(SITE);
    out.push("  " + (await b.click("Just look around")));
    await b.until(`[...document.querySelectorAll("button.chip")].some(x => x.textContent.trim() === "Hoodie")`, 20000);
    out.push("  " + (await b.type('input[aria-label="Name"]', "DraftQa")));
    for (const c of ["Hoodie", "Crown", "Hearts"]) out.push("  " + (await b.js(chip(c))));
    await b.sleep(500);
    await b.goto(SITE); // a reload, like coming back from a wallet redirect
    out.push("  " + (await b.click("Just look around")));
    await b.until(`[...document.querySelectorAll("button.chip")].some(x => x.textContent.trim() === "Hoodie")`, 20000);
    await b.sleep(800);
    const kept = (await b.js(pressed("Hoodie"))) && (await b.js(pressed("Crown"))) && (await b.js(pressed("Hearts")));
    const nm = await b.js(`document.querySelector('input[aria-label="Name"]').value`);
    ok(kept && nm === "DraftQa", "the picked look and name survive a reload", `name=${nm}`);
    await b.js(`sessionStorage.removeItem("hm-hatch-draft"); "ok"`);
    return out;
  }
  if (role === "restyle") {
    const k = require(`${os.homedir()}/.near-credentials/testnet/${account}.json`);
    await b.goto(SITE);
    await b.js(`localStorage.setItem("hm-burner", JSON.stringify({ accountId: ${JSON.stringify(account)}, key: ${JSON.stringify(k.private_key)} })); "ok"`);
    await b.goto(SITE);
    ok(!!(await b.until(`document.body.innerText.includes(${JSON.stringify(account)})`, 30000)), "signed in", account);
    const mind = (await view("colony_snapshot")).minds.find((r) => r.mind.owner === account && r.mind.name === mindName);
    // pick the Mind in the header selector, then open Account
    await b.js(`(() => { const s = [...document.querySelectorAll("select")].find(x => [...x.options].some(o => o.text.startsWith(${JSON.stringify(mindName)}))); if (!s) return "no selector"; const o = [...s.options].find(o => o.text.startsWith(${JSON.stringify(mindName)})); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return "selected"; })()`);
    out.push("  " + (await b.click("/^Account$/")));
    await b.until(`document.body.innerText.includes("Restyle her")`, 15000);
    const before = await view("get_look", { id: mind.id });
    const target = before?.outfit === 5 ? ["Scarf", 1] : ["Hoodie", 5];
    const hat = before?.hat === 3 ? ["Beanie", 1] : ["Crown", 3];
    out.push("  " + (await b.js(chip(target[0]))));
    out.push("  " + (await b.js(chip(hat[0]))));
    out.push("  " + (await b.click("/^Save look$/")));
    let after = before;
    for (let i = 0; i < 30 && (after?.outfit !== target[1] || after?.hat !== hat[1]); i++) { await b.sleep(1500); after = await view("get_look", { id: mind.id }); }
    ok(after?.outfit === target[1] && after?.hat === hat[1] && after?.tone === before?.tone && after?.eyes === before?.eyes, "Save look stores outfit + hat on chain, keeps colour and eyes", JSON.stringify(after));
    const tok = await view("nft_token", { token_id: String(mind.id) });
    ok(tok.metadata.media.startsWith("data:image/svg+xml"), "the NFT picture is regenerated on chain from the new look", `${tok.metadata.media.length} chars`);
    await b.shot(process.env.SHOT_DIR + "/look-restyle.png");
    return out;
  }
  return ["unknown role"];
};
