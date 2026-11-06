// The gateway calls URLs that Mind owners paste in, so every request goes through this
// fetch: public https hosts only (no localhost or private networks, no redirects), a
// timeout, a cap on how much an agent may send back, and the owner's auth header added.
// GATEWAY_ALLOW_LOCAL=1 lifts the address rules, for testing against agents on this PC.

const dns = require("dns").promises;
const net = require("net");

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

const allowLocal = () => process.env.GATEWAY_ALLOW_LOCAL === "1";

function privateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function privateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** Throws a readable error unless `raw` is a URL the gateway may call. */
async function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that is not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLocal())) throw new Error("the agent's URL must start with https://");
  if (url.username || url.password) throw new Error("put credentials in the API key field, not in the URL");
  if (allowLocal()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`can't resolve ${host}`);
  if (addrs.some((a) => privateIp(a.address))) throw new Error(`${host} is on a private network; the agent must be reachable on the internet`);
  return url;
}

/** A fetch that adds `headers` and enforces the rules above. */
function makeFetch(headers = {}, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  return async (input, init = {}) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await checkUrl(target);
    const h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const res = await fetch(target, {
      method: init.method || (input instanceof Request ? input.method : undefined),
      body: init.body,
      headers: h,
      signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`the agent redirected to ${res.headers.get("location") || "another address"}; paste its final URL`);
    if (!res.body) return res;
    let n = 0;
    const cap = new TransformStream({
      transform(chunk, c) {
        n += chunk.byteLength;
        if (n > maxBytes) c.error(new Error("the agent sent back more than 8 MB"));
        else c.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(cap), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

module.exports = { checkUrl, makeFetch, privateIp };
