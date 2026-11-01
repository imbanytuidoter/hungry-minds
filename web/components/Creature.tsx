import type { MindState } from "@/lib/minds";
import { isAlive } from "@/lib/minds";

// Renders the contract's own SVG. The markup is produced by our renderer (art.rs),
// not user input. Living Minds breathe; a ghost drifts; a sleeper lies still.
export default function Creature({
  svg,
  state,
  className = "",
}: {
  svg: string;
  state: MindState;
  className?: string;
}) {
  const motion =
    state === "ghost" ? "drift" : state === "asleep" ? "still" : "breathe";
  const label = isAlive(state) ? `A ${state} Mind` : `A Mind, ${state}`;
  return (
    <div
      className={`${motion} ${className}`}
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
