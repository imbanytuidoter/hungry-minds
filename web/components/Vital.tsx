// The Mind's life, drawn as how full it is. Balance is its food.
export default function Vital({
  percent,
  balanceNear,
  low = false,
}: {
  percent: number;
  balanceNear: string;
  low?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Food left</span>
        <span style={{ fontSize: 13, color: "var(--text-mid)" }}>
          {balanceNear} NEAR
        </span>
      </div>
      <div className={`vital ${low ? "low" : ""}`}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
