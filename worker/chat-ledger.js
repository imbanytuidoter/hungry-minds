// What players have used in off-chain chat and not yet paid for on chain. Kept on disk, so
// a restart never forgets usage, and moved into one numbered batch at a time for
// `settle_chats` (the contract settles each batch number once, so a retry is safe).

const fs = require("fs");
const crypto = require("crypto");

// Mirror the contract's bounds on one settlement (contract/src/chat.rs).
const MAX_ITEMS = 40;
const MAX_COUNT = 200;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

class Ledger {
  constructor(file) {
    this.file = file;
    this.state = { entries: {}, inflight: null };
    try {
      this.state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* first run */
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  /** Record one answered message. `digest` chains every prompt and reply of this payer and Mind. */
  add(mindId, payer, own, prompt, reply) {
    const key = `${mindId}|${payer}|${own ? 1 : 0}`;
    const e = this.state.entries[key] || { mind_id: mindId, payer, own, count: 0, last_reply: null, digest: "" };
    e.count += 1;
    e.last_reply = reply;
    e.digest = sha(`${e.digest}\n${prompt}\n${reply}`);
    this.state.entries[key] = e;
    this.save();
  }

  rows() {
    return [...Object.values(this.state.entries), ...(this.state.inflight?.items || [])];
  }

  /** Messages a Mind has answered its keeper and not yet charged to her food. */
  pendingOwn(mindId) {
    return this.rows().filter((r) => r.own && r.mind_id === mindId).reduce((n, r) => n + r.count, 0);
  }

  /** Messages a guest has used and not yet charged to their credits (across all Minds). */
  pendingGuest(payer) {
    return this.rows().filter((r) => !r.own && r.payer === payer).reduce((n, r) => n + r.count, 0);
  }

  hasWork() {
    return !!this.state.inflight || Object.keys(this.state.entries).length > 0;
  }

  get inflight() {
    return this.state.inflight;
  }

  /** Move up to one settlement's worth of usage into batch `batch` (or return the batch already in flight). */
  startBatch(batch) {
    if (this.state.inflight) return this.state.inflight;
    const items = [];
    for (const [key, e] of Object.entries(this.state.entries)) {
      if (items.length >= MAX_ITEMS) break;
      const count = Math.min(e.count, MAX_COUNT);
      items.push({ mind_id: e.mind_id, payer: e.payer, own: e.own, count, last_reply: e.last_reply, digest: e.digest });
      if (count === e.count) delete this.state.entries[key];
      else e.count -= count;
    }
    const digest = sha(items.map((i) => i.digest).join("\n"));
    this.state.inflight = { batch, items, digest };
    this.save();
    return this.state.inflight;
  }

  /** The batch landed on chain. */
  finishBatch() {
    this.state.inflight = null;
    this.save();
  }
}

module.exports = { Ledger, MAX_ITEMS, MAX_COUNT };
