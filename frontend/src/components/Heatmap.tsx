import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bucket, fmt } from "../api";

/** One bar per 30 seconds of lecture. Taller + deeper terracotta = more students bookmarked that window. */
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
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const every = Math.max(1, Math.ceil(buckets.length / 8));

  const barColor = (count: number, r: number) => {
    if (count === 0) return "var(--bar-empty)";
    if (r < 0.38) return "var(--heat-low)";
    if (r < 0.72) return "var(--heat-mid)";
    return "var(--heat-high)";
  };

  return (
    <div className="heat-shell">
      <div className="heat-legend">
        <span className="legend-item">
          <i className="legend-dot calm" /> Few bookmarks
        </span>
        <span className="legend-item">
          <i className="legend-dot mid" /> Moderate
        </span>
        <span className="legend-item">
          <i className="legend-dot peak" /> Peak confusion
        </span>
      </div>

      <div className="heat-wrap">
        <div className="heat-gridlines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="heat">
          {buckets.map((b, i) => {
            const r = b.count / max;
            const isNow = nowT !== undefined && nowT >= b.start && nowT < b.end;
            const isSel = selected === i;
            const isHov = hovered === i;
            const targetHeight = b.count === 0 ? "6%" : `${Math.max(16, r * 100)}%`;

            return (
              <button
                key={i}
                type="button"
                className={"bar" + (isSel ? " sel" : "") + (isNow ? " now" : "")}
                onClick={() => onSelect(i)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((prev) => (prev === i ? null : prev))}
                title={`${fmt(b.start)}–${fmt(b.end)} · ${b.count} bookmarked`}
              >
                <AnimatePresence>
                  {isHov && (
                    <motion.div
                      className="heat-tooltip"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 3 }}
                      transition={{ duration: 0.12 }}
                    >
                      <span className="mono">{fmt(b.start)}</span>
                      <span className="dot-sep">·</span>
                      <span>
                        {b.count} {b.count === 1 ? "bookmark" : "bookmarks"}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {isSel && (
                  <motion.span
                    layoutId="heatmap-active-backdrop"
                    className="bar-sel-bg"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}

                <div className="bar-track">
                  <motion.span
                    className="fill"
                    initial={{ height: "6%" }}
                    animate={{ height: targetHeight }}
                    transition={{ type: "spring", stiffness: 250, damping: 26 }}
                    style={{ background: barColor(b.count, r) }}
                  />
                </div>

                {isNow && (
                  <span className="now-pill" title="Current lecture window">
                    <span className="now-dot" />
                  </span>
                )}

                {i % every === 0 && <span className="lbl mono">{fmt(b.start)}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
