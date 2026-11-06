const test = require("node:test");
const assert = require("node:assert/strict");
const { fitsSchema } = require("./gateway/connectors");

const wiki = { properties: { repoName: { type: "string" } }, required: ["repoName"] };

test("the router's arguments are used only when they match the tool's schema", () => {
  assert.equal(fitsSchema({ repoName: "near/near-sdk-rs" }, wiki), true);
  assert.equal(fitsSchema({ repo: "near/near-sdk-rs" }, wiki), false, "a guessed argument name is refilled");
  assert.equal(fitsSchema({}, wiki), false, "a missing required field is refilled");
  assert.equal(fitsSchema({ repoName: "" }, wiki), false);
  assert.equal(fitsSchema(undefined, wiki), false);
  assert.equal(fitsSchema([], wiki), false);
  assert.equal(fitsSchema({}, {}), true, "a tool with no arguments");
});
