/** The Hungry Minds badge with the wordmark beside it: the original artwork redrawn as one vector
 *  (public/kit/brand/logo.svg), so it is sharp at every size, on every page and in every theme. */
export default function Logo({ size = 44, word = true, wordSize = 24, className }: { size?: number; word?: boolean; wordSize?: number; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a vector badge, nothing for next/image to optimise */}
      <img className="hm-logo-img" src="/kit/brand/logo.svg" alt={word ? "" : "Hungry Minds"} width={size} height={size} style={{ flex: "none", display: "block", borderRadius: "50%", filter: "drop-shadow(0 2px 6px rgba(46,28,42,.2))" }} />
      {word && (
        <span className="hm-logo-word" style={{ fontFamily: "var(--font-figtree), var(--font-sans), system-ui, sans-serif", fontWeight: 700, fontSize: wordSize, letterSpacing: "-.02em", lineHeight: 1, color: "#2E1C2A" }}>
          hungry minds
        </span>
      )}
    </span>
  );
}
