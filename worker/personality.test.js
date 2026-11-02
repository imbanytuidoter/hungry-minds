// Unit tests for the personality prompt builder. Pure, no network — runs anywhere with
// `npm test` in worker/. Guards the voice contract: the right trait dials map to the right
// temperament/passion/speech, indices wrap, state colours the mood, and the creature never
// breaks character as an "AI".

const test = require("node:test");
const assert = require("node:assert/strict");
const { systemPrompt, TEMPERAMENT, PASSION, SPEECH } = require("./personality");

test("names the Mind and uses the temperament/passion/speech dials", () => {
  // traits = [temperament, passion, speech, body, eyes, accessory, pattern]
  const p = systemPrompt({ name: "Juno", traits: [2, 0, 3, 0, 0, 0, 0], state: "full", thought_count: 7 });
  assert.match(p, /"Juno"/);
  assert.ok(p.includes(TEMPERAMENT[2]), "temperament from traits[0]");
  assert.ok(p.includes(PASSION[0]), "passion from traits[1]");
  assert.ok(p.includes(SPEECH[3]), "speech from traits[2]");
  assert.match(p, /7 thoughts/);
});

test("trait indices wrap with modulo (dials are 0..255 on-chain)", () => {
  const base = systemPrompt({ name: "A", traits: [0, 0, 0, 0, 0, 0, 0], state: "full", thought_count: 0 });
  const wrapped = systemPrompt({
    name: "A",
    traits: [TEMPERAMENT.length, PASSION.length, SPEECH.length, 0, 0, 0, 0],
    state: "full",
    thought_count: 0,
  });
  assert.equal(wrapped, base, "index == length wraps back to 0");
});

test("state colours the mood", () => {
  const starving = systemPrompt({ name: "A", traits: [0, 0, 0, 0, 0, 0, 0], state: "starving", thought_count: 0 });
  assert.match(starving, /starving/i);
  // an unknown/absent state simply omits the mood line (no crash, no empty "undefined")
  const unknown = systemPrompt({ name: "A", traits: [0, 0, 0, 0, 0, 0, 0], state: "ghost", thought_count: 0 });
  assert.ok(!unknown.includes("undefined"));
});

test("stays in character — never an assistant", () => {
  const p = systemPrompt({ name: "A", traits: [0, 0, 0, 0, 0, 0, 0], state: "full", thought_count: 0 });
  assert.match(p, /never say you are an AI/i);
  assert.match(p, /1 to 3 sentences/);
});

test("survives missing traits without throwing", () => {
  const p = systemPrompt({ name: "A", state: "full", thought_count: 0 });
  assert.ok(p.includes(TEMPERAMENT[0]));
  assert.ok(!p.includes("undefined"));
});
