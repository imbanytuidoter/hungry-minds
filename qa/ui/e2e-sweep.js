// Visit every tab in every language; report console errors and junk text on screen.
module.exports = async (b, [site, width = "1440"]) => {
  const out = [];
  const junk = /\bundefined\b|\bNaN\b|\[object Object\]|Infinity|\{\{|\}\}/;
  await b.js(`(() => { const w = ${+width}; return w; })()`);
  await b.goto(site + "/");
  await b.sleep(3000);
  const land = await b.text();
  const errsNow = () => b.logs().filter((l) => !/favicon|recaptcha|DevTools|Download the React DevTools/.test(l));
  out.push(`${junk.test(land) || errsNow().length ? "FAIL" : "PASS"}  landing: no junk text, no console errors${junk.test(land) ? "  — JUNK: " + land.match(junk)[0] : errsNow().length ? "  — " + errsNow().join(" / ").slice(0, 200) : ""}`);
  await b.goto(site + "/app");
  await b.until(`document.body.innerText.length > 200`, 20000);
  await b.sleep(2000);
  if (await b.js(`!!document.querySelector("[role=dialog]")`)) await b.click("Just look around");
  await b.sleep(500);
  if (!(await b.js(`!!document.querySelector("nav.hm-nav")`))) { await b.click("Shop"); await b.sleep(1200); }
  const langs = await b.js(`[...document.querySelectorAll('select[aria-label="Language"] option')].map(o => o.value)`);
  for (const lang of langs || ["en"]) {
    await b.js(`(() => { const s = document.querySelector('select[aria-label="Language"]'); if (!s) return; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(lang)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await b.sleep(500);
    const seen = [];
    for (const tab of ["Home", "Shop", "Chat", "Account"]) {
      // nav buttons are the 4 sidebar entries, in order, whatever the language
      await b.js(`(() => { const nav = [...document.querySelectorAll('nav button, aside button')].filter(x => x.offsetParent !== null); const i = ${["Home", "Shop", "Chat", "Account"].indexOf(tab)}; (nav[i] || [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(tab)}))?.click(); })()`);
      await b.sleep(900);
      const t = await b.text();
      const errs = errsNow();
      const w = await b.js(`document.documentElement.scrollWidth > window.innerWidth + 2 ? 'H-OVERFLOW ' + document.documentElement.scrollWidth : ''`);
      const bad = `${junk.test(t) ? " JUNK:" + t.match(junk)[0] : ""}${errs.length ? " ERR:" + errs.join(" / ").slice(0, 200) : ""}${w ? " " + w : ""}`;
      if (bad) seen.push(tab + bad);
    }
    out.push(`${seen.length ? "FAIL" : "PASS"}  ${lang}: every tab clean (no junk text, console errors or sideways scroll)${seen.length ? "  — " + seen.join(" | ") : ""}`);
  }
  // leave the shared browser profile in English for the next suite
  await b.js(`localStorage.removeItem("hm-lang"); "x"`);
  await b.shot(process.env.SHOT || "sweep.png");
  return out;
};
