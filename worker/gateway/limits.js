// Small helpers shared by the gateway and the chat server: a per-account rate limiter, and
// the scrubbing that keeps an owner's API key out of anything shown to other people.

/** A sliding-window limiter: `take(key)` is true (and counts) while `key` made fewer than
 *  `perWindow` calls in the last `windowMs`, false (and does not count) after that. */
function makeRateLimiter(perWindow, windowMs = 60_000) {
  const calls = new Map(); // key -> times of its calls in the window
  return function take(key) {
    const t = Date.now();
    const recent = (calls.get(key) || []).filter((x) => x > t - windowMs);
    if (recent.length >= perWindow) {
      calls.set(key, recent);
      return false;
    }
    recent.push(t);
    calls.set(key, recent);
    if (calls.size > 5000) for (const [k, v] of calls) if (!v.some((x) => x > t - windowMs)) calls.delete(k);
    return true;
  };
}

/** The agent's address as shown publicly: no user:password@, no ?query or #fragment (owners
 *  sometimes put a key there). An official agent's "url" is its id and is shown as is. */
function publicUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return String(raw || "").split(/[?#]/)[0];
  }
}

/** An error text with every URL in it cut down the same way (no user:pass@, nothing from the
 *  first ? or #), and any of `secrets` (the owner's API key) masked. Agent SDKs and fetch put
 *  the full address in their errors; those end up in the public /status and in chat replies. */
function scrubUrls(text, secrets = []) {
  let s = String(text ?? "").replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/i, "$1").replace(/[?#].*$/, ""));
  for (const k of secrets) if (typeof k === "string" && k.length >= 4) s = s.split(k).join("***");
  return s;
}

module.exports = { makeRateLimiter, publicUrl, scrubUrls };
