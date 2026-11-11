// What the gateway keeps on disk (worker dir, gitignored): each Mind's connected agent
// (its API key encrypted with AES-256-GCM under a key derived from the worker's secret),
// jobs waiting on the buyer's answer, chat contexts, and files moving in or out.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class Store {
  constructor(dir, contractId, secret) {
    this.file = path.join(dir, `.gateway-${contractId}.json`);
    this.filesDir = path.join(dir, `.gateway-files-${contractId}`);
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.key = crypto.createHash("sha256").update(`gateway|${secret}`).digest();
    try {
      this.s = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.s = {};
    }
    this.s.conns ||= {};
    this.s.jobs ||= {};
    this.s.chats ||= {};
    this.s.files ||= {};
    this.s.results ||= {};
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  seal(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
  }

  open(sealed) {
    if (!sealed) return "";
    const [iv, tag, body] = sealed.split(".").map((b) => Buffer.from(b, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  }

  // ── connections ──
  conn(mindId) {
    return this.s.conns[mindId] || null;
  }
  secretOf(mindId) {
    return this.open(this.s.conns[mindId]?.secret);
  }
  setConn(mindId, conn, secret) {
    this.s.conns[mindId] = { ...conn, secret: this.seal(secret) };
    this.save();
  }
  patchConn(mindId, patch) {
    if (!this.s.conns[mindId]) return;
    Object.assign(this.s.conns[mindId], patch);
    this.save();
  }
  dropConn(mindId) {
    delete this.s.conns[mindId];
    for (const k of Object.keys(this.s.chats)) if (k.startsWith(`${mindId}|`)) delete this.s.chats[k];
    this.save();
  }
  mindIds() {
    return Object.keys(this.s.conns).map(Number);
  }

  // ── jobs that wait on the buyer, and finished results ──
  job(id) {
    return this.s.jobs[id] || null;
  }
  setJob(id, v) {
    if (v) this.s.jobs[id] = v;
    else delete this.s.jobs[id];
    this.save();
  }
  result(id) {
    return this.s.results[id] || null;
  }
  setResult(id, v) {
    this.s.results[id] = v;
    this.save();
  }

  // ── chat contexts per Mind and person ──
  chat(mindId, who) {
    return this.s.chats[`${mindId}|${who}`] || { history: [] };
  }
  setChat(mindId, who, v) {
    this.s.chats[`${mindId}|${who}`] = v;
    this.save();
  }

  // ── files ──
  putFile({ name, mime, data, owner, mindId, jobId, result }) {
    const id = crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(path.join(this.filesDir, id), data);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    this.s.files[id] = { name: String(name || "file").slice(0, 120), mime: String(mime || "application/octet-stream").slice(0, 100), size: data.length, sha256, owner, mindId, jobId: jobId ?? null, result: !!result, ts: Date.now() };
    // bound the store: drop the oldest files past the cap, so the metadata JSON (rewritten on
    // each save) and the disk can't grow without limit
    const MAX_FILES = 2000;
    const ids = Object.keys(this.s.files);
    if (ids.length > MAX_FILES) {
      for (const old of ids.sort((a, b) => this.s.files[a].ts - this.s.files[b].ts).slice(0, ids.length - MAX_FILES)) {
        try {
          fs.rmSync(path.join(this.filesDir, old), { force: true });
        } catch {
          /* already gone */
        }
        delete this.s.files[old];
      }
    }
    this.save();
    return { id, ...this.s.files[id] };
  }
  fileMeta(id) {
    return /^[0-9a-f]{24}$/.test(id) ? this.s.files[id] || null : null;
  }
  fileData(id) {
    return fs.readFileSync(path.join(this.filesDir, id));
  }
  linkFile(id, jobId) {
    if (this.s.files[id]) {
      this.s.files[id].jobId = jobId;
      this.save();
    }
  }
}

module.exports = { Store };
