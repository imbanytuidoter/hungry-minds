// The contract measures text in UTF-8 bytes (name ≤ 32, service title ≤ 60, description ≤ 200,
// unit ≤ 16, message ≤ 500), while an <input maxLength> counts characters. A Cyrillic letter
// is 2 bytes and an emoji 4, so inputs clip by bytes here instead — what the player can type
// is exactly what the contract accepts.

const enc = new TextEncoder();

export const utf8Len = (s: string) => enc.encode(s).length;

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, cut on a whole character. */
export function clipBytes(s: string, max: number): string {
  if (utf8Len(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8Len(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/** Contract limits (contract.rs / colony.rs). */
export const LIMITS = { name: 32, title: 60, desc: 200, unit: 16, message: 500 } as const;
