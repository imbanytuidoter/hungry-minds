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

/** An IPv6 address as its eight 16-bit groups, or null if it doesn't parse. Handles "::",
 *  a trailing dotted IPv4 ("::ffff:127.0.0.1") and a zone ("fe80::1%eth0"). */
function v6Groups(ip) {
  let v = String(ip).toLowerCase().replace(/%.*$/, "");
  const dotted = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    v = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const part = (s) => (s ? s.split(":") : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 address an IPv6 address carries and would reach, if any: IPv4-mapped
 *  (::ffff:a.b.c.d, also written ::ffff:7f00:1 after URL normalisation), SIIT
 *  (::ffff:0:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96, 64:ff9b:1::/48),
 *  6to4 (2002::/16) and Teredo (2001::/32, client address inverted). */
function embeddedV4(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4Of(g[6], g[7]); // mapped
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Of(g[6], g[7]); // SIIT
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4Of(g[6], g[7]); // compatible (not :: or ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return v4Of(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4Of(g[1], g[2]); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return v4Of(g[6] ^ 0xffff, g[7] ^ 0xffff); // Teredo
  return null;
}

function privateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const g = v6Groups(ip);
  if (!g) return true; // not an address we understand: refuse rather than guess
  const v4 = embeddedV4(g);
  if (v4) return privateV4(v4);
  return (
    g.every((x) => x === 0) || // ::
    (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) || // ::1
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 old site local
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) || // 100::/64 discard
    (g[0] === 0x2001 && g[1] === 0xdb8) // documentation
  );
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

// Residual: the address is checked at checkUrl time and fetch resolves the name again when it
// connects, so a DNS-rebinding host (public answer first, private answer next, TTL 0) can still
// slip through between the two lookups. Pinning the checked address needs an undici Agent with
// a custom `connect.lookup`, and undici is not a dependency of the worker (Node's bundled copy
// isn't exposed). Redirects are refused, so the window is that one second lookup.

module.exports = { checkUrl, makeFetch, privateIp };
