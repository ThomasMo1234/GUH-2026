import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BookOpen,
  Compass,
  FileUp,
  Lightbulb,
  Maximize2,
  Minimize2,
  Network,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import {
  api,
  Bucket,
  fmt,
  KnowledgeGraph,
  KnowledgeNode,
  MomentSummary,
  post,
  uploadSlides,
} from "../api";

/* ==========================================================================
   8-Octant Perimeter Handles so Circular Ontology Arrows Radiate Cleanly 360°
   ========================================================================== */

const COMPASS = [
  { key: "e", left: "100%", top: "50%", pos: Position.Right },
  { key: "se", left: "85.35%", top: "85.35%", pos: Position.Right },
  { key: "s", left: "50%", top: "100%", pos: Position.Bottom },
  { key: "sw", left: "14.65%", top: "85.35%", pos: Position.Left },
  { key: "w", left: "0%", top: "50%", pos: Position.Left },
  { key: "nw", left: "14.65%", top: "14.65%", pos: Position.Left },
  { key: "n", left: "50%", top: "0%", pos: Position.Top },
  { key: "ne", left: "85.35%", top: "14.65%", pos: Position.Right },
] as const;

function pickOctant(dx: number, dy: number): string {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  const idx = Math.round(deg / 45) % 8;
  return COMPASS[idx].key;
}

const CATEGORY_COLORS: Record<string, string> = {
  core: "#285e8e",
  syntax: "#2b7574",
  deduction: "#a67622",
  rules: "#2d6f50",
  semantics: "#585382",
  applications: "#8a5a3c",
};

type NodeVisualState = "normal" | "alert" | "inspected" | "dimmed";

type TopicNodeData = {
  label: string;
  category: string;
  slideRef?: string;
  visualState: NodeVisualState;
  lostCount: number;
  pctRoom: number;
  isCore: boolean;
};

type TopicFlowNode = Node<TopicNodeData, "topic">;

function TopicCircleNode({ data }: NodeProps<TopicFlowNode>) {
  const baseColor = CATEGORY_COLORS[data.category] ?? "#3a6680";
  const isAlert = data.visualState === "alert";
  const isInspected = data.visualState === "inspected";
  const isDimmed = data.visualState === "dimmed";
  const size = data.isCore ? 132 : 108;

  return (
    <div
      className={
        "kg-circle-node" +
        (isAlert ? " is-alert" : "") +
        (isInspected ? " is-inspected" : "") +
        (isDimmed ? " is-dimmed" : "") +
        (data.isCore ? " is-core" : "")
      }
      style={{
        width: size,
        height: size,
        backgroundColor: isAlert ? "#c84628" : baseColor,
      }}
    >
      {COMPASS.map((c) => (
        <span key={c.key}>
          <Handle
            id={`src-${c.key}`}
            type="source"
            position={c.pos}
            style={{
              left: c.left,
              top: c.top,
              width: 4,
              height: 4,
              opacity: 0,
              border: "none",
              background: "transparent",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
            }}
          />
          <Handle
            id={`tgt-${c.key}`}
            type="target"
            position={c.pos}
            style={{
              left: c.left,
              top: c.top,
              width: 4,
              height: 4,
              opacity: 0,
              border: "none",
              background: "transparent",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
            }}
          />
        </span>
      ))}

      {isAlert && <span className="kg-alert-halo" aria-hidden="true" />}

      {isAlert && data.lostCount > 0 && (
        <span className="kg-node-badge alert-badge mono">
          {data.pctRoom > 0 ? `${data.pctRoom}% lost` : `${data.lostCount} lost`}
        </span>
      )}

      {!isAlert && isInspected && (
        <span className="kg-node-badge inspect-badge">Active topic</span>
      )}

      {!isAlert && !isInspected && data.lostCount > 0 && (
        <span className="kg-node-badge subtle-count-badge mono">{data.lostCount}</span>
      )}

      <span className="kg-circle-label">{data.label}</span>
    </div>
  );
}

const NODE_TYPES = { topic: TopicCircleNode };

/** Smoothly frames the graph on load and gently pans toward the active red/inspected node when heatmap selection changes. */
function ViewportController({
  graphKey,
  focusCoords,
  focusTrigger,
  fitTrigger,
}: {
  graphKey: string;
  focusCoords: { x: number; y: number } | null;
  focusTrigger: string;
  fitTrigger: number;
}) {
  const rf = useReactFlow();

  useEffect(() => {
    const t = setTimeout(() => {
      rf.fitView({ padding: 0.2, duration: 420 });
    }, 60);
    return () => clearTimeout(t);
  }, [graphKey, fitTrigger, rf]);

  useEffect(() => {
    if (!focusCoords || !focusTrigger) return;
    const t = setTimeout(() => {
      rf.setCenter(focusCoords.x + 54, focusCoords.y + 54, { zoom: 0.86, duration: 520 });
    }, 40);
    return () => clearTimeout(t);
  }, [focusTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

/** Fallback client-side keyword matcher if a bucket didn't already carry node_id */
function matchBucketClient(bucket: Bucket, graph: KnowledgeGraph): string | null {
  if (bucket.node_id && graph.nodes.some((n) => n.id === bucket.node_id)) {
    return bucket.node_id;
  }
  const text = (bucket.text || "").toLowerCase();
  if (!text.trim()) return null;
  let bestId: string | null = null;
  let best = 0;
  for (const n of graph.nodes) {
    let sc = 0;
    for (const kw of n.keywords || []) {
      if (kw && text.includes(kw.toLowerCase())) sc += 4;
    }
    for (const w of n.label.toLowerCase().split(/\W+/)) {
      if (w.length > 2 && text.includes(w)) sc += 2;
    }
    if (n.category === "core") sc = Math.max(0, sc - 2);
    if (sc > best) {
      best = sc;
      bestId = n.id;
    }
  }
  return best >= 3 ? bestId : null;
}

export default function KnowledgeGraphCard({
  lectureId,
  status,
  graph,
  buckets,
  selectedBucketIdx,
  onSelectBucket,
  roomSize,
  hasSimulated,
  audioMode,
  momentSummary,
  onRefresh,
  onClearLocalResults,
}: {
  lectureId: string;
  status: "waiting" | "live" | "ended";
  graph: KnowledgeGraph | null | undefined;
  buckets: Bucket[];
  selectedBucketIdx: number | null;
  onSelectBucket: (idx: number | null) => void;
  roomSize: number;
  hasSimulated: boolean;
  audioMode: boolean;
  momentSummary?: MomentSummary;
  onRefresh: () => Promise<unknown>;
  onClearLocalResults: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSyncRef = useRef<number>(0);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [localErr, setLocalErr] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [clickedNodeId, setClickedNodeId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  // Initialize node positions whenever a new slide deck graph arrives
  useEffect(() => {
    if (!graph) {
      setPositions({});
      setClickedNodeId(null);
      return;
    }
    const next: Record<string, { x: number; y: number }> = {};
    for (const n of graph.nodes) {
      next[n.id] = { x: n.x, y: n.y };
    }
    setPositions(next);
    setClickedNodeId(null);
    setFitTrigger((c) => c + 1);
  }, [graph?.title, graph?.source, graph?.nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close projector fullscreen on Escape
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Pause HTML5 audio if lecture ends
  useEffect(() => {
    if (status === "ended" && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [status]);

  const handleNodesChange = useCallback((changes: NodeChange<TopicFlowNode>[]) => {
    setPositions((prev) => {
      let updated: Record<string, { x: number; y: number }> | null = null;
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          if (!updated) updated = { ...prev };
          updated[ch.id] = ch.position;
        }
      }
      return updated ?? prev;
    });
  }, []);

  // Aggregate confusion stats per node across all buckets
  const nodeStats = useMemo(() => {
    const stats: Record<string, { peakCount: number; peakBucketIdx: number; firstBucketIdx: number; totalCount: number }> = {};
    if (!graph) return stats;
    buckets.forEach((b, idx) => {
      const nid = matchBucketClient(b, graph);
      if (!nid) return;
      const cur = stats[nid] ?? { peakCount: 0, peakBucketIdx: idx, firstBucketIdx: idx, totalCount: 0 };
      cur.totalCount += b.count;
      if (b.count > cur.peakCount) {
        cur.peakCount = b.count;
        cur.peakBucketIdx = idx;
      }
      stats[nid] = cur;
    });
    return stats;
  }, [buckets, graph]);

  // Determine which node is currently highlighted (from selected heatmap bar, clicked node, or live confusion spike)
  const highlight = useMemo(() => {
    if (!graph) return null;
    const denom = Math.max(1, roomSize);

    // 1. Professor clicked a specific bar on the Heatmap
    if (selectedBucketIdx !== null && buckets[selectedBucketIdx]) {
      const b = buckets[selectedBucketIdx];
      const nid = matchBucketClient(b, graph);
      const node = graph.nodes.find((n) => n.id === nid) ?? null;
      if (node) {
        const isAlert = b.count > 0;
        const pct = isAlert ? Math.min(100, Math.round((b.count / denom) * 100)) : 0;
        return {
          node,
          bucket: b,
          bucketIdx: selectedBucketIdx,
          mode: (isAlert ? "alert" : "inspected") as "alert" | "inspected",
          count: b.count,
          pct,
          source: "heatmap" as const,
        };
      }
    }

    // 2. Professor clicked directly on a node in the Knowledge Graph
    if (clickedNodeId) {
      const node = graph.nodes.find((n) => n.id === clickedNodeId) ?? null;
      if (node) {
        const st = nodeStats[node.id];
        const b = st ? buckets[st.peakBucketIdx] : undefined;
        const count = st?.peakCount ?? 0;
        const isAlert = count > 0;
        return {
          node,
          bucket: b ?? null,
          bucketIdx: st?.peakBucketIdx ?? null,
          mode: (isAlert ? "alert" : "inspected") as "alert" | "inspected",
          count,
          pct: isAlert ? Math.min(100, Math.round((count / denom) * 100)) : 0,
          source: "node" as const,
        };
      }
    }

    // 3. Automatic live confusion alert: highlight the peak confused node when >= 3 students get lost on it
    let bestNode: KnowledgeNode | null = null;
    let bestCount = 0;
    let bestIdx = -1;
    for (const n of graph.nodes) {
      const st = nodeStats[n.id];
      if (st && st.peakCount >= 3 && st.peakCount > bestCount) {
        bestCount = st.peakCount;
        bestNode = n;
        bestIdx = st.peakBucketIdx;
      }
    }
    if (bestNode && bestIdx >= 0) {
      return {
        node: bestNode,
        bucket: buckets[bestIdx],
        bucketIdx: bestIdx,
        mode: "alert" as const,
        count: bestCount,
        pct: Math.min(100, Math.round((bestCount / denom) * 100)),
        source: "auto" as const,
      };
    }

    return null;
  }, [graph, selectedBucketIdx, buckets, clickedNodeId, nodeStats, roomSize]);

  // Build React Flow nodes & straight perimeter-anchored edges
  const { rfNodes, rfEdges } = useMemo(() => {
    if (!graph) return { rfNodes: [] as TopicFlowNode[], rfEdges: [] as Edge[] };
    const activeId = highlight?.node.id ?? null;
    const denom = Math.max(1, roomSize);

    const connectedIds = new Set<string>();
    if (activeId) {
      connectedIds.add(activeId);
      for (const e of graph.edges) {
        if (e.source === activeId) connectedIds.add(e.target);
        if (e.target === activeId) connectedIds.add(e.source);
      }
    }

    const builtNodes: TopicFlowNode[] = graph.nodes.map((n) => {
      const p = positions[n.id] ?? { x: n.x, y: n.y };
      const st = nodeStats[n.id];
      const peakLost = st?.peakCount ?? 0;
      let visualState: NodeVisualState = "normal";
      if (activeId === n.id) {
        visualState = highlight?.mode === "alert" ? "alert" : "inspected";
      } else if (activeId && !connectedIds.has(n.id)) {
        visualState = "dimmed";
      }

      const lostForBadge = activeId === n.id ? (highlight?.count ?? peakLost) : peakLost;
      const pctRoom = lostForBadge > 0 ? Math.min(100, Math.round((lostForBadge / denom) * 100)) : 0;

      return {
        id: n.id,
        type: "topic",
        position: p,
        data: {
          label: n.label,
          category: n.category,
          slideRef: n.slide_ref,
          visualState,
          lostCount: lostForBadge,
          pctRoom,
          isCore: n.category === "core",
        },
      };
    });

    const centerOf = (nid: string) => {
      const p = positions[nid] ?? graph.nodes.find((x) => x.id === nid) ?? { x: 0, y: 0 };
      const isCore = graph.nodes.find((x) => x.id === nid)?.category === "core";
      const r = isCore ? 66 : 54;
      return { cx: p.x + r, cy: p.y + r };
    };

    const builtEdges: Edge[] = graph.edges.map((e) => {
      const a = centerOf(e.source);
      const b = centerOf(e.target);
      const srcOct = pickOctant(b.cx - a.cx, b.cy - a.cy);
      const tgtOct = pickOctant(a.cx - b.cx, a.cy - b.cy);
      const touchesActive = activeId !== null && (e.source === activeId || e.target === activeId);
      const isAlertEdge = touchesActive && highlight?.mode === "alert";

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: `src-${srcOct}`,
        targetHandle: `tgt-${tgtOct}`,
        type: "straight",
        label: e.label,
        animated: isAlertEdge,
        style: {
          stroke: isAlertEdge ? "#c84628" : touchesActive ? "#191918" : "#b5b1a6",
          strokeWidth: touchesActive ? 2.2 : 1.4,
          opacity: activeId && !touchesActive ? 0.36 : 1,
        },
        labelStyle: {
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.06em",
          fill: isAlertEdge ? "#c84628" : "#65635d",
          fontFamily: "var(--sans)",
        },
        labelBgStyle: {
          fill: "var(--card)",
          fillOpacity: 0.9,
        },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 15,
          height: 15,
          color: isAlertEdge ? "#c84628" : touchesActive ? "#191918" : "#9c988d",
        },
      };
    });

    return { rfNodes: builtNodes, rfEdges: builtEdges };
  }, [graph, positions, highlight, nodeStats, roomSize]);

  // Actions
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setLocalErr("");
    try {
      await uploadSlides(lectureId, file);
      await onRefresh();
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const loadPreset = async (preset: "logic" | "hashtables") => {
    setUploading(true);
    setLocalErr("");
    try {
      await post(`/api/lectures/${lectureId}/slides/preset`, { preset });
      await onRefresh();
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const startSampleAudioLecture = async (autoLoadGraph: boolean) => {
    if (
      status === "live" &&
      !window.confirm("Start the 20-minute sample audio lecture? This clears the current transcript and bookmarks.")
    ) {
      return;
    }
    setUploading(true);
    setLocalErr("");
    try {
      onClearLocalResults();
      await post(`/api/lectures/${lectureId}/audio-demo/start`, {
        seed: true,
        auto_load_graph: autoLoadGraph,
        initial_time: 0,
        playing: true,
      });
      await onRefresh();
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(() => {});
        }
      }, 120);
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const syncAudioToServer = async (currentTime: number, playing: boolean, immediate = false) => {
    const now = Date.now();
    if (!immediate && now - lastSyncRef.current < 1100) return;
    lastSyncRef.current = now;
    try {
      await post(`/api/lectures/${lectureId}/audio-demo/sync`, {
        current_time: currentTime,
        playing,
      });
      if (immediate) await onRefresh();
    } catch {
      /* ignore transient sync errors */
    }
  };

  const jumpAudioTo = async (seconds: number, selectBucket = true) => {
    const el = audioRef.current;
    if (el) {
      el.currentTime = seconds;
      if (status === "live") {
        el.play().catch(() => {});
      }
    }
    await syncAudioToServer(seconds, status === "live", true);
    if (selectBucket) {
      const targetIdx = Math.floor(seconds / 30);
      onSelectBucket(targetIdx);
    }
  };

  const revealFull20mHeatmap = async () => {
    const cur = audioRef.current?.currentTime ?? 0;
    const isPlaying = audioRef.current ? !audioRef.current.paused : false;
    // Materialize up to 20:00 (1200s) and restore current playhead so professor can click any bar up to 20m immediately
    await post(`/api/lectures/${lectureId}/audio-demo/sync`, { current_time: 1198, playing: isPlaying });
    await post(`/api/lectures/${lectureId}/audio-demo/sync`, { current_time: cur, playing: isPlaying });
    await onRefresh();
  };

  const clearGraph = async () => {
    setLocalErr("");
    try {
      await api(`/api/lectures/${lectureId}/slides`, { method: "DELETE" });
      await onRefresh();
    } catch (e) {
      setLocalErr((e as Error).message);
    }
  };

  const onNodeClick = (_: React.MouseEvent, node: TopicFlowNode) => {
    setClickedNodeId(node.id);
    const st = nodeStats[node.id];
    if (st !== undefined) {
      onSelectBucket(st.peakCount > 0 ? st.peakBucketIdx : st.firstBucketIdx);
    }
  };

  const focusCoords = useMemo(() => {
    if (!highlight?.node) return null;
    return positions[highlight.node.id] ?? { x: highlight.node.x, y: highlight.node.y };
  }, [highlight?.node, positions]);

  const focusTrigger =
    highlight && highlight.source === "heatmap"
      ? `${highlight.node.id}-${selectedBucketIdx}`
      : "";

  const isLogicDeck = !!graph && (graph.title.toLowerCase().includes("logic") || graph.source.toLowerCase().includes("logic"));

  const cardContent = (
    <div className={"card kg-card" + (expanded ? " kg-card-fullscreen" : "")}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.md"
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <div className="row card-header-row" style={{ marginBottom: graph ? 12 : 14 }}>
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 3 }}>
            <h2 style={{ marginBottom: 0 }}>
              {graph ? graph.title : "Lecture knowledge graph"}
            </h2>
            <span className="chip">{graph ? `${graph.nodes.length} concepts` : "Optional"}</span>
          </div>
          <p className="sub" style={{ marginBottom: 0 }}>
            {graph
              ? `Source: ${graph.source} · Click any bar on the heatmap to highlight the exact topic node.`
              : "Upload lecture slides (PDF) to build a NotebookLM-style concept map linked to the live confusion heatmap."}
          </p>
        </div>

        <div className="spacer" />

        {graph && (
          <div className="row" style={{ gap: 6 }}>
            {isLogicDeck && !audioMode && (
              <button
                type="button"
                className="btn btn-sm primary"
                onClick={() => startSampleAudioLecture(false)}
                disabled={uploading}
                title="Play the 20-minute Formal Logic lecture audio synced to this graph"
              >
                <Volume2 size={14} />
                <span>Play 20m lecture audio</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Upload a different PDF slide deck"
            >
              <FileUp size={14} />
              <span>{uploading ? "Building…" : "Upload PDF"}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFitTrigger((c) => c + 1)}
              title="Reset zoom to fit all nodes"
            >
              <Compass size={14} />
              <span>Fit</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setExpanded((v) => !v);
                setTimeout(() => setFitTrigger((c) => c + 1), 80);
              }}
              title={expanded ? "Exit projector view" : "Expand for lecture hall screen"}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              <span>{expanded ? "Exit projector" : "Projector view"}</span>
            </button>
            {!expanded && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={clearGraph}
                title="Remove knowledge graph"
                aria-label="Remove knowledge graph"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {localErr && (
        <div className="err" style={{ marginBottom: 12 }}>
          <AlertTriangle size={15} />
          <span>{localErr}</span>
        </div>
      )}

      {/* Optional compact upload state when no PDF is loaded */}
      {!graph ? (
        <div
          className={"kg-dropzone" + (dragOver ? " is-dragover" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <div className="kg-drop-main">
            <div className="kg-drop-icon">
              <Network size={20} />
            </div>
            <div>
              <strong>Drop lecture slides PDF here, or choose a deck</strong>
              <p className="sub" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
                Extracts slide concepts into an interactive graph. Confusion spikes glow red with a suggested teaching pivot.
              </p>
            </div>
          </div>

          <div className="row kg-drop-actions">
            <motion.button
              type="button"
              className="btn primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              whileTap={{ scale: 0.98 }}
            >
              <FileUp size={15} />
              <span>{uploading ? "Building mindmap…" : "Upload lecture PDF"}</span>
            </motion.button>

            <motion.button
              type="button"
              className="btn"
              onClick={() => startSampleAudioLecture(true)}
              disabled={uploading}
              whileTap={{ scale: 0.98 }}
              title="Loads COMP11120 Formal Logic slides + plays 20-minute real lecture audio with transcripts"
            >
              <Volume2 size={15} />
              <span>Sample PDF + 20m Audio</span>
            </motion.button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => loadPreset("hashtables")}
              disabled={uploading}
              title="Build concept map for the 3-minute Hash Tables demo"
            >
              <BookOpen size={14} />
              <span>Map Hash Tables demo</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Synced 20-minute real lecture audio player (shown when sample audio mode is active) */}
          {audioMode && (
            <div className="kg-audio-bar">
              <div className="kg-audio-top">
                <div className="kg-audio-title">
                  <Volume2 size={15} />
                  <span>Sample Lecture Audio (COMP11120 Formal Logic · 20m chunk)</span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={revealFull20mHeatmap}
                  title="Populate all 40 heatmap bars across the full 20-minute lecture right away"
                >
                  <Sparkles size={13} />
                  <span>Load full 20m heatmap</span>
                </button>
              </div>

              <audio
                ref={audioRef}
                className="kg-audio-player"
                controls
                preload="metadata"
                src="/api/sample-audio"
                onTimeUpdate={(e) => {
                  const el = e.currentTarget;
                  syncAudioToServer(el.currentTime, !el.paused, false);
                }}
                onPlay={(e) => syncAudioToServer(e.currentTarget.currentTime, true, true)}
                onPause={(e) => syncAudioToServer(e.currentTarget.currentTime, false, true)}
                onSeeked={(e) => syncAudioToServer(e.currentTarget.currentTime, !e.currentTarget.paused, true)}
              />

              <div className="kg-jump-row">
                <span className="kg-jump-label">Jump to moment:</span>
                <button type="button" className="kg-jump-pill" onClick={() => jumpAudioTo(125)}>
                  02:05 Turnstile ⊢
                </button>
                <button type="button" className="kg-jump-pill" onClick={() => jumpAudioTo(305)}>
                  05:05 → Intro
                </button>
                <button type="button" className="kg-jump-pill is-spike" onClick={() => jumpAudioTo(515)}>
                  08:35 ∨-Elim Spike
                </button>
                <button type="button" className="kg-jump-pill" onClick={() => jumpAudioTo(875)}>
                  14:35 Context Γ
                </button>
                <button type="button" className="kg-jump-pill is-spike" onClick={() => jumpAudioTo(1115)}>
                  18:35 (20m) Comma vs ∧
                </button>
              </div>
            </div>
          )}

          {/* Professor Red Confusion Alert Banner / Active Window Topic Banner */}
          <AnimatePresence mode="wait">
            {highlight && highlight.mode === "alert" && (
              <motion.div
                key={`alert-${highlight.node.id}-${highlight.bucketIdx}`}
                className="kg-alert-banner"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
              >
                <div className="kg-alert-head">
                  <span className="kg-alert-pulse" />
                  <AlertTriangle size={16} className="kg-alert-ic" />
                  <div className="kg-alert-headline">
                    <strong>
                      Warning: {highlight.pct}% of the room ({highlight.count}{" "}
                      {highlight.count === 1 ? "student" : "students"}
                      {hasSimulated ? ", incl. simulated" : ""}) got lost on “{highlight.node.label}”
                    </strong>
                    {highlight.bucket && (
                      <span className="kg-alert-time mono">
                        {fmt(highlight.bucket.start)}–{fmt(highlight.bucket.end)}
                      </span>
                    )}
                  </div>
                  {highlight.source === "auto" && highlight.bucketIdx !== null && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onSelectBucket(highlight.bucketIdx)}
                    >
                      Inspect bar
                    </button>
                  )}
                </div>

                <div className="kg-alert-pivot">
                  <Lightbulb size={15} />
                  <span>
                    <strong>Suggested pivot:</strong>{" "}
                    {momentSummary?.suggested_fix || highlight.node.pivot}
                  </span>
                </div>
              </motion.div>
            )}

            {highlight && highlight.mode === "inspected" && (
              <motion.div
                key={`inspect-${highlight.node.id}-${highlight.bucketIdx}`}
                className="kg-inspect-banner"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
              >
                <Compass size={15} />
                <span>
                  {highlight.bucket ? (
                    <>
                      Covered at <b className="mono">{fmt(highlight.bucket.start)}–{fmt(highlight.bucket.end)}</b>:{" "}
                      <b>{highlight.node.label}</b> — 0 confusion bookmarks in this window.
                    </>
                  ) : (
                    <>
                      Selected concept: <b>{highlight.node.label}</b> ({highlight.node.slide_ref || "Slide concept"})
                    </>
                  )}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Interactive React Flow Canvas */}
          <div className={"kg-canvas-wrap" + (expanded ? " is-expanded" : "")}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={NODE_TYPES}
                onNodesChange={handleNodesChange}
                onNodeClick={onNodeClick}
                onPaneClick={() => setClickedNodeId(null)}
                fitView
                minZoom={0.32}
                maxZoom={1.75}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={20} size={1} color="var(--line-strong)" />
                <Controls showInteractive={false} />
                <ViewportController
                  graphKey={`${graph.title}-${graph.nodes.length}`}
                  focusCoords={focusCoords}
                  focusTrigger={focusTrigger}
                  fitTrigger={fitTrigger}
                />
              </ReactFlow>
            </ReactFlowProvider>

            <div className="kg-legend" aria-hidden="true">
              <span>
                <i style={{ background: "#285e8e" }} /> Core
              </span>
              <span>
                <i style={{ background: "#2b7574" }} /> Syntax
              </span>
              <span>
                <i style={{ background: "#a67622" }} /> Deduction
              </span>
              <span>
                <i style={{ background: "#2d6f50" }} /> Rules
              </span>
              <span>
                <i style={{ background: "#585382" }} /> Semantics
              </span>
              <span className="kg-legend-alert">
                <i style={{ background: "#c84628" }} /> Confusion spike
              </span>
            </div>
          </div>

          {/* Compact concept detail footer when a node is active */}
          {highlight && (
            <div className="kg-node-detail">
              <div className="kg-node-detail-top">
                <strong>{highlight.node.label}</strong>
                {highlight.node.slide_ref && <span className="chip">{highlight.node.slide_ref}</span>}
              </div>
              <p className="sub" style={{ margin: 0 }}>
                {highlight.node.summary}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (expanded) {
    return (
      <div className="kg-fullscreen-backdrop" onClick={(e) => e.target === e.currentTarget && setExpanded(false)}>
        {cardContent}
      </div>
    );
  }

  return cardContent;
}
