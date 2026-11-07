import { Bucket, fmt } from "../api";

/** One bar per 30 seconds of lecture. Taller + redder = more students bookmarked that window. */
export default function Heatmap({
  buckets,
  selected,
  onSelect,
}: {
  buckets: Bucket[];
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const every = Math.max(1, Math.ceil(buckets.length / 10)); // don't crowd the x-axis labels
  return (
    <div className="heat-wrap">
      <div className="heat">
        {buckets.map((b, i) => {
          const r = b.count / max;
          const hue = 170 - 170 * r; // teal (calm) -> red (lost)
          return (
            <button
              key={i}
              className={"bar" + (selected === i ? " sel" : "")}
              onClick={() => onSelect(i)}
              title={`${fmt(b.start)} - ${b.count} bookmarked`}
            >
              <span
                className="fill"
                style={{
                  height: b.count === 0 ? "4px" : `${Math.max(8, r * 100)}%`,
                  background: b.count === 0 ? "rgba(255,255,255,0.12)" : `hsl(${hue} 85% 56%)`,
                  boxShadow: r > 0.55 ? `0 0 20px hsl(${hue} 90% 55% / 0.7)` : undefined,
                }}
              />
              {i % every === 0 && <span className="lbl">{fmt(b.start)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
