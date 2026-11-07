import { Bucket, fmt } from "../api";

/** One bar per 30 seconds of lecture. Taller + darker = more students bookmarked that window. */
export default function Heatmap({
  buckets,
  selected,
  onSelect,
  nowT,
}: {
  buckets: Bucket[];
  selected: number | null;
  onSelect: (i: number) => void;
  /** current lecture time in seconds; the matching bar gets a marker */
  nowT?: number;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const every = Math.max(1, Math.ceil(buckets.length / 10)); // don't crowd the x-axis labels
  return (
    <div className="heat-wrap">
      <div className="heat">
        {buckets.map((b, i) => {
          const r = b.count / max;
          const isNow = nowT !== undefined && nowT >= b.start && nowT < b.end;
          return (
            <button
              key={i}
              className={"bar" + (selected === i ? " sel" : "") + (isNow ? " now" : "")}
              onClick={() => onSelect(i)}
              title={`${fmt(b.start)} - ${b.count} bookmarked`}
            >
              <span
                className="fill"
                style={{
                  height: b.count === 0 ? "4px" : `${Math.max(8, r * 100)}%`,
                  // one colour, darker = more students lost
                  background: b.count === 0 ? "var(--line)" : `hsl(10 72% ${84 - 42 * r}%)`,
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
