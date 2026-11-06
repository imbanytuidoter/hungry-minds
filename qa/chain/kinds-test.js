// The "http" and "openai" connector kinds against a local HTTP agent and the real Pollinations
// OpenAI-compatible endpoint.
const http = require("http");
const { discover, run } = require("../../worker/gateway/connectors.js");
const out = [];
const ok = (c, l, x = "") => out.push(`${c ? "PASS" : "FAIL"}  ${l}${x ? "  — " + String(x).slice(0, 140) : ""}`);

const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    if (req.headers["x-api-key"] !== "k1") return res.writeHead(401).end("no");
    const j = JSON.parse(b);
    res.writeHead(200, { "content-type": "application/json" });
    if (j.input === "ping") return res.end(JSON.stringify({ result: "pong" }));
    if (!/\d/.test(j.input) && !j.history.length) return res.end(JSON.stringify({ question: "How many items?" }));
    const files = j.files.map((f) => ({ name: "echo-" + f.name, mime: f.mime, base64: f.base64 }));
    res.end(JSON.stringify({ result: `got "${j.input}" (skill ${j.skill}, ${j.history.length} earlier turns)`, files }));
  });
});

(async () => {
  process.env.GATEWAY_ALLOW_LOCAL = "1";
  await new Promise((r) => srv.listen(9922, "127.0.0.1", r));
  const conn = { kind: "http", url: "http://127.0.0.1:9922/run", authHeader: "X-API-Key", name: "Echo" };
  try {
    await discover(conn, "bad");
    ok(false, "http: wrong key refused");
  } catch (e) {
    ok(/401/.test(e.message), "http: wrong key refused", e.message);
  }
  const d = await discover(conn, "k1");
  ok(d.skills.length === 1, "http: connect probes it with ping", d.name);
  const q = await run(conn, "k1", { text: "make a list", skill: "default" });
  ok(q.state === "input-required" && q.text === "How many items?", "http: {question} asks the buyer", q.text);
  const r = await run(conn, "k1", { text: "3", history: [{ role: "user", content: "make a list" }, { role: "assistant", content: q.text }], files: [{ name: "a.txt", mime: "text/plain", data: Buffer.from("hello") }] });
  ok(r.state === "completed" && /1 earlier turns|2 earlier turns/.test(r.text) && r.files[0]?.data.toString() === "hello", "http: answer continues with history; files go both ways", r.text);
  srv.close();
  delete process.env.GATEWAY_ALLOW_LOCAL;

  const oa = { kind: "openai", url: "https://text.pollinations.ai/openai", model: "openai", name: "Pollinations" };
  for (let i = 0; i < 3; i++) {
    try {
      const d2 = await discover(oa, "");
      ok(true, "openai: connect works against a real endpoint", d2.name);
      const r2 = await run(oa, "", { text: "What is 2+2? Answer with the number only." });
      ok(/4/.test(r2.text), "openai: answers", r2.text);
      break;
    } catch (e) {
      if (i === 2 || !/402|429/.test(e.message)) {
        ok(false, "openai: real endpoint", e.message);
        break;
      }
      await new Promise((r) => setTimeout(r, 47_000)); // free tier: 1 reply / 45 s per IP
    }
  }
  console.log(out.join("\n"));
})();
