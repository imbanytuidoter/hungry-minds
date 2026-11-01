import type { MindState } from "@/lib/minds";
import { moodLabel } from "@/lib/minds";

export default function Mood({ state }: { state: MindState }) {
  return (
    <span className="mood">
      <span className="dot" />
      {moodLabel(state)}
    </span>
  );
}
