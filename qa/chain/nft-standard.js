// On chain: what a NEAR wallet or an outside marketplace sees of a Mind (NEP-171/177/181/199).
//   the collection has an icon; each token's media is her picture with her clothes on;
//   nft_payout gives the whole sale to the owner; nft_transfer_payout moves the token (and back).
const path = require("path");
const os = require("os");
const { connect, keyStores } = require("../../worker/node_modules/near-api-js");
const C = "hm-qa-q1103b.testnet";
const ok = (c, label, extra = "") => console.log(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + String(extra).slice(0, 160) : ""}`);
const svgOf = (media) => (media?.startsWith("data:image/svg+xml;base64,") ? Buffer.from(media.split(",")[1], "base64").toString() : "");
const paths = (svg) => (svg.match(/<path/g) || []).length;

(async () => {
  const near = await connect({ networkId: "testnet", nodeUrl: "https://near-testnet.drpc.org", keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials")) });
  const alice = await near.account("alice-q1103.testnet");
  const bob = await near.account("bob-q1103.testnet");
  const view = (m, a = {}) => alice.viewFunction({ contractId: C, methodName: m, args: a });
  const call = (acc, m, args) => acc.functionCall({ contractId: C, methodName: m, args, gas: "100000000000000", attachedDeposit: "1" });

  const meta = await view("nft_metadata");
  ok(svgOf(meta.icon).startsWith("<svg"), "the collection has an icon (wallets show it)", meta.name + " · " + meta.symbol);

  // every dressed, awake Mind: her token's picture has each colour of her hat and outfit, as the
  // site draws them (same parts, same contrast rule) — so a wallet shows what the game shows
  const { hats, outfits, onTone } = await import("../../web/lib/game/glossyParts.ts");
  const snap = await view("colony_snapshot");
  const dressed = snap.minds.filter((r) => r.live_state !== "ghost" && r.look && (r.look.hat > 0 || r.look.outfit > 0));
  const missing = [];
  for (const r of dressed) {
    const svg = svgOf((await view("nft_token", { token_id: String(r.id) })).metadata.media).toUpperCase();
    const want = [...onTone(hats(r.look.hat), r.look.tone), ...onTone(outfits(r.look.outfit), r.look.tone)]
      .flatMap((z) => [z.f, z.s])
      .filter((c) => /^#[0-9A-F]{6}$/i.test(c));
    const lost = [...new Set(want.map((c) => c.toUpperCase()))].filter((c) => !svg.includes(c));
    if (lost.length) missing.push(`#${r.id} (tone ${r.look.tone} hat ${r.look.hat} outfit ${r.look.outfit}) lacks ${lost.join(" ")}`);
  }
  ok(dressed.length > 0 && !missing.length, "each token's picture has her hat and outfit on, coloured as on the site", missing.join("; ") || `${dressed.length} dressed Minds checked`);

  const mine = await view("nft_tokens_for_owner", { account_id: alice.accountId, limit: 50 });
  const t = mine.find((x) => !/ghost/.test(x.metadata.description || "")) || mine[0];
  if (!t) return ok(false, "alice-q1103 owns a Mind to test payouts with");
  const p = await view("nft_payout", { token_id: t.token_id, balance: "1000", max_len_payout: 10 });
  ok(Object.keys(p.payout).length === 1 && p.payout[alice.accountId] === "1000", "nft_payout: the whole sale to the owner, no royalties", JSON.stringify(p.payout));

  const look = await view("get_look", { id: Number(t.token_id) });
  await call(alice, "nft_transfer_payout", { receiver_id: bob.accountId, token_id: t.token_id, balance: "1000", max_len_payout: 10 });
  // a load-balanced RPC node may still show the old owner for a moment
  let moved = await view("nft_token", { token_id: t.token_id });
  for (let i = 0; i < 10 && moved.owner_id !== bob.accountId; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    moved = await view("nft_token", { token_id: t.token_id });
  }
  const look2 = await view("get_look", { id: Number(t.token_id) });
  ok(moved.owner_id === bob.accountId && JSON.stringify(look) === JSON.stringify(look2), "nft_transfer_payout moves the Mind, her look goes with her", `#${t.token_id} → ${moved.owner_id}`);
  if (moved.owner_id === bob.accountId) await call(bob, "nft_transfer", { receiver_id: alice.accountId, token_id: t.token_id });
  let back = await view("nft_token", { token_id: t.token_id });
  for (let i = 0; i < 10 && back.owner_id !== alice.accountId; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    back = await view("nft_token", { token_id: t.token_id });
  }
  ok(back.owner_id === alice.accountId, "and back (QA state restored)");
})().catch((e) => console.log("ERROR", e.message));
