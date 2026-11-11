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

/** The agent's address as shown publicly: scheme + host only. Owners sometimes put a key in
 *  the userinfo, the query, the fragment, or a path segment, so none of those is ever shown.
 *  An official agent's "url" is its id and has no scheme, so it is shown as is. */
function publicUrl(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return String(raw || "").split(/[/?#]/).slice(0, 3).join("/");
  }
}

/** An error text with every URL in it cut to scheme + host (no userinfo, path, query or
 *  fragment, any of which can carry a key), and any of `secrets` (the owner's API key) masked.
 *  Agent SDKs and fetch put the full address in their errors; those end up in the public
 *  /status and in chat replies. */
function scrubUrls(text, secrets = []) {
  let s = String(text ?? "").replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => {
    try {
      return new URL(u).origin;
    } catch {
      return u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/i, "$1").replace(/[/?#].*$/, "");
    }
  });
  for (const k of secrets) if (typeof k === "string" && k.length >= 4) s = s.split(k).join("***");
  return s;
}

module.exports = { makeRateLimiter, publicUrl, scrubUrls };
