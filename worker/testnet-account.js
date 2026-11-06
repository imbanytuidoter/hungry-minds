// Create (or reuse) a testnet account funded by the public testnet faucet helper, the same
// service near-cli's "sponsor-by-faucet-service" uses. The key is written where near-cli
// expects it: ~/.near-credentials/testnet/<account>.json — never into this repo.
//
//   node testnet-account.js <name>.testnet

const fs = require("fs");
const os = require("os");
const path = require("path");
const { KeyPair, connect, keyStores, utils } = require("near-api-js");

const CRED_DIR = path.join(os.homedir(), ".near-credentials", "testnet");
const HELPER = process.env.NEAR_HELPER_URL || "https://helper.testnet.near.org/account";

async function ensureAccount(accountId) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  const file = path.join(CRED_DIR, `${accountId}.json`);
  if (!fs.existsSync(file)) {
    const kp = KeyPair.fromRandom("ed25519");
    const res = await fetch(HELPER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
    });
    if (!res.ok) throw new Error(`faucet helper ${res.status}: ${await res.text()}`);
    fs.writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    console.log(`created ${accountId}`);
  }
  const near = await connect({ networkId: "testnet", keyStore: new keyStores.UnencryptedFileSystemKeyStore(path.dirname(CRED_DIR)), nodeUrl: process.env.NEAR_RPC || "https://test.rpc.fastnear.com" });
  const acc = await near.account(accountId);
  for (let i = 0; i < 20; i++) {
    try {
      const b = await acc.getAccountBalance();
      console.log(`${accountId}: ${utils.format.formatNearAmount(b.available, 3)} NEAR available`);
      return acc;
    } catch {
      await new Promise((r) => setTimeout(r, 1500)); // account creation is still landing
    }
  }
  throw new Error(`${accountId} did not appear on chain`);
}

module.exports = { ensureAccount, CRED_DIR };

if (require.main === module) {
  ensureAccount(process.argv[2]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
