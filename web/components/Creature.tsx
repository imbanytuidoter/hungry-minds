import type { MindState } from "@/lib/minds";
import { isAlive } from "@/lib/minds";

// Renders the contract's own SVG and brings it to life in the browser. Two nested
// layers: a one-shot hop (outer) composes with the continuous state-idle (inner)
// without fighting over `transform`. The markup is produced by our renderer (art.rs),
// not user input.
export default function Creature({
  svg,
  state,
  className = "",
  hop = false,
  lively = true,
}: {
  svg: string;
  state: MindState;
  className?: string;
  hop?: boolean;
  lively?: boolean;
}) {
  const idle = !lively
    ? ""
    : state === "ghost"
    ? "c-ghost"
    : state === "asleep"
    ? "c-sleep"
    : state === "hungry" || state === "starving"
    ? "c-weak"
    : "c-alive";
  const label = isAlive(state) ? `A ${state} Mind` : `A Mind, ${state}`;
  return (
    <div className={`creature ${className}`} role="img" aria-label={label}>
      <div className={`c-hop-layer ${hop ? "hopping" : ""}`}>
        <div
          className={`c-idle-layer ${idle}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
