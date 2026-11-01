import Link from "next/link";
import type { Mind } from "@/lib/minds";
import { vitalPercent } from "@/lib/minds";
import Creature from "./Creature";
import Mood from "./Mood";

// A card in the gallery. It recolours itself to the Mind's own temperament.
export default function MindCard({ mind }: { mind: Mind }) {
  return (
    <Link
      href={`/mind/${mind.id}`}
      className="card"
      style={
        {
          "--accent": mind.accent,
          display: "block",
          padding: 14,
          transition: "border-color .15s ease, transform .15s ease",
        } as React.CSSProperties
      }
    >
      <div
        style={{
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid var(--line)",
        }}
      >
        <Creature svg={mind.svgs[mind.state]} state={mind.state} lively={false} />
      </div>
      <div className="flex items-center justify-between mt-3">
        <span style={{ fontWeight: 600, fontSize: 16 }}>{mind.name}</span>
        <Mood state={mind.state} />
      </div>
      <div
        className="vital mt-3"
        aria-hidden
        style={{ height: 6 }}
      >
        <span style={{ width: `${vitalPercent(mind.state)}%` }} />
      </div>
    </Link>
  );
}
