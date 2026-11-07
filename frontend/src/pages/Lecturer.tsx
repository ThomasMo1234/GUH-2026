import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useScribe } from "@elevenlabs/react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Lightbulb,
  Mic,
  Play,
  QrCode,
  Sparkles,
  Square,
  Users,
} from "lucide-react";
import { api, fmt, Insights, LecturerState, MomentSummary, post } from "../api";
import { useLive } from "../hooks";
import Heatmap from "../components/Heatmap";
import KnowledgeGraphCard from "../components/KnowledgeGraphCard";
import { LiveWaveform, SignalBrand, ThemeToggle } from "../components/AmbientChrome";

export default function Lecturer() {
  const { id = "" } = useParams();
  const { data: s, refetch } = useLive<LecturerState>(`/api/lectures/${id}/state`, id, 2000);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [insights, setInsights] = useState<Insights | null>(null);
  // AI "what to re-explain" summaries, keyed by the bucket's start time
  const [summaries, setSummaries] = useState<Record<number, MomentSummary | { error: string }>>({});
  const [summaryBusy, setSummaryBusy] = useState<number | null>(null);
  // Live clock: the server only tells us `elapsed` every ~2s, so we tick locally in between,
  // at the speed the server reports (1 for a real lecture, 3 or 6 for a fast demo replay).
  const [sync, setSync] = useState({ base: 0, at: Date.now() });
  const [tick, setTick] = useState(Date.now());
  // The QR code must contain a URL phones can reach. Paste your tunnel URL here (see README).
  const [base, setBase] = useState(localStorage.getItem("signal_join_base") || window.location.origin);
  const [copied, setCopied] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Live speech-to-text: mic -> ElevenLabs Scribe v2 Realtime. Each finished sentence goes to our backend.
  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    onCommittedTranscript: (d) => {
      if (d.text && d.text.trim()) post(`/api/lectures/${id}/segments`, { text: d.text }).catch(() => {});
    },
  });

  useEffect(() => {
    if (s) setSync({ base: s.elapsed, at: Date.now() });
  }, [s?.elapsed, s?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Safety net: if the backend ever sends the same line twice, only show it once.
  const segments = useMemo(() => {
    const seen = new Set<string>();
    return (s?.segments ?? []).filter((g) => {
      const k = `${Math.round(g.t_start)}|${g.text.trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [s?.segments]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [segments.length, scribe.partialTranscript]);

  // The backend wipes everything on start/demo, so drop the old local results too.
  const clearResults = () => {
    setInsights(null);
    setSummaries({});
    setSel(null);
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr("");
    try {
      await fn();
      await refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const startLecture = () =>
    run("start", async () => {
      clearResults();
      await post(`/api/lectures/${id}/start`);
      try {
        const { token } = await api<{ token: string }>("/api/scribe-token");
        await scribe.connect({ token, microphone: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        // Optional live mic transcription skipped when ELEVENLABS_API_KEY is not configured
      }
    });

  const endLecture = () =>
    run("end", async () => {
      scribe.disconnect();
      await post(`/api/lectures/${id}/end`);
    });

  const runDemo = () =>
    run("demo", async () => {
      scribe.disconnect();
      if (status === "live" && !window.confirm("Restart the demo? This clears the current transcript and bookmarks."))
        return;
      clearResults();
      await post(`/api/lectures/${id}/demo`, { speed, seed: true });
    });

  const getInsights = () => run("insights", async () => setInsights(await api<Insights>(`/api/lectures/${id}/insights`)));

  const summarise = async (start: number, end: number) => {
    setSummaryBusy(start);
    try {
      const r = await post<MomentSummary>(`/api/lectures/${id}/moments/summary`, { start, end });
      setSummaries((prev) => ({ ...prev, [start]: r }));
    } catch (e) {
      const m = (e as Error).message;
      setSummaries((prev) => ({
        ...prev,
        [start]: {
          error:
            m === "Not Found"
              ? "The backend doesn't have the moment-summary endpoint yet (restart uvicorn so it picks up the new main.py)."
              : m,
        },
      }));
    } finally {
      setSummaryBusy(null);
    }
  };

  const joinUrl = `${base.replace(/\/$/, "")}/join/${id}`;
  const status = s?.status ?? "waiting";
  const clock = status === "live" ? sync.base + ((tick - sync.at) / 1000) * (s?.speed ?? 1) : s?.elapsed ?? 0;
  const bucket = sel !== null && s ? s.buckets[sel] : null;
  const moment = bucket ? summaries[bucket.start] : undefined;
  const checks = s?.self_checks;

  const peakInfo = useMemo(() => {
    if (!s?.buckets?.length) return null;
    let bestIdx = -1;
    let bestCount = 0;
    s.buckets.forEach((b, idx) => {
      if (b.count > bestCount) {
        bestCount = b.count;
        bestIdx = idx;
      }
    });
    if (bestIdx === -1 || bestCount === 0) return null;
    return { idx: bestIdx, bucket: s.buckets[bestIdx] };
  }, [s?.buckets]);

  const nodeLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const n of s?.knowledge_graph?.nodes ?? []) {
      m[n.id] = n.label;
    }
    return m;
  }, [s?.knowledge_graph]);

  const copyJoinLink = () => {
    navigator.clipboard?.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const accuracyPct = checks?.pct_correct ?? 0;
  const ringCircumference = 2 * Math.PI * 26;
  const ringOffset = ringCircumference - (accuracyPct / 100) * ringCircumference;

  return (
    <div className="page-shell">
      <div className="wrap">
        <motion.header
          className="nav-bar studio-bar"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <SignalBrand subtitle="Lecturer View" />

          <div className="studio-badges">
            <span className="chip code-chip mono">Code {id}</span>
            <span className={"chip status-chip " + status}>
              {status === "live" ? (
                <>
                  <span className="live-dot" /> LIVE
                </>
              ) : status === "ended" ? (
                "Ended"
              ) : (
                "Waiting"
              )}
            </span>

            <div className="clock-capsule" title="Time into the lecture">
              <Clock size={14} className="clock-icon" />
              <span className="clock mono">{fmt(clock)}</span>
              {status === "live" && (s?.speed ?? 1) > 1 && <span className="speed-tag">{s?.speed}×</span>}
              {status === "live" && <LiveWaveform active />}
            </div>

            {scribe.isConnected && (
              <span className="chip mic-chip">
                <Mic size={13} /> Mic on
              </span>
            )}
          </div>

          <div className="spacer" />

          <div className="row studio-actions">
            <ThemeToggle />
            <motion.button
              className="btn primary"
              onClick={startLecture}
              disabled={status === "live" || !!busy}
              whileTap={{ scale: 0.98 }}
            >
              <Mic size={15} />
              <span>Start lecture + mic</span>
            </motion.button>
            <motion.button
              className="btn danger"
              onClick={endLecture}
              disabled={status !== "live" || !!busy}
              whileTap={{ scale: 0.98 }}
            >
              <Square size={14} />
              <span>End lecture</span>
            </motion.button>
          </div>
        </motion.header>

        <AnimatePresence>
          {err && (
            <motion.div
              className="err"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
            >
              <AlertCircle size={16} />
              <span>{err}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top KPI Strip */}
        <motion.div
          className="kpi-strip"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.04 }}
        >
          <div className="kpi-tile">
            <div className="kpi-head">
              <Clock size={14} /> Session Time
            </div>
            <div className="kpi-val mono">{fmt(clock)}</div>
            <div className="kpi-foot">
              {status === "live" ? "Live session active" : status === "ended" ? "Lecture concluded" : "Ready to start"}
            </div>
          </div>

          <div className="kpi-tile">
            <div className="kpi-head">
              <Users size={14} /> Bookmarks
            </div>
            <div className="kpi-val">{s?.bookmarks_total ?? 0}</div>
            <div className="kpi-foot">
              {s?.simulated_total ? `Includes ${s.simulated_total} simulated` : "Student taps recorded"}
            </div>
          </div>

          <button
            type="button"
            className={"kpi-tile kpi-interactive" + (peakInfo ? " has-peak" : "")}
            onClick={() => peakInfo && setSel(peakInfo.idx)}
            disabled={!peakInfo}
            title={peakInfo ? "Click to inspect peak confusion window" : "No bookmarks yet"}
          >
            <div className="kpi-head">
              <Activity size={14} /> Peak Window
            </div>
            <div className="kpi-val mono">{peakInfo ? fmt(peakInfo.bucket.start) : "—"}</div>
            <div className="kpi-foot">
              {peakInfo ? `${peakInfo.bucket.count} lost · Click to view` : "No spikes yet"}
            </div>
          </button>

          <div className="kpi-tile">
            <div className="kpi-head">
              <Sparkles size={14} /> Self-Checks
            </div>
            <div className="kpi-val">{checks && checks.answered > 0 ? `${checks.pct_correct}%` : "—"}</div>
            <div className="kpi-foot">{checks?.answered ?? 0} quiz answers</div>
          </div>
        </motion.div>

        <div className="grid">
          <div className="stack">
            {/* Heatmap Card */}
            <motion.div
              className="card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
            >
              <div className="row card-header-row">
                <div>
                  <h2>Where the room got lost</h2>
                  <p className="sub" style={{ marginBottom: 0 }}>
                    One bar per 30 seconds. Click a bar to see what was being said.
                  </p>
                </div>
                <div className="spacer" />
                <div className="row">
                  <span className="chip">{s?.bookmarks_total ?? 0} bookmarks</span>
                  {!!s?.simulated_total && (
                    <span className="chip warn">includes {s.simulated_total} simulated students</span>
                  )}
                </div>
              </div>

              {s && s.buckets.length > 0 ? (
                <Heatmap
                  buckets={s.buckets}
                  selected={sel}
                  onSelect={setSel}
                  nowT={status === "live" ? clock : undefined}
                  nodeLabels={nodeLabels}
                />
              ) : (
                <div className="empty-stage">
                  <div className="empty-stage-icon">
                    <BarChart3 size={22} />
                  </div>
                  <div>
                    <h3>Start the lecture to begin</h3>
                    <p className="sub" style={{ marginBottom: 0 }}>
                      Click <b>Start lecture + mic</b> above, or use <b>Run demo</b> on the right to replay a 3-minute
                      sample lecture.
                    </p>
                  </div>
                </div>
              )}

              <AnimatePresence mode="wait">
                {bucket && (
                  <motion.div
                    key={bucket.start}
                    className="bucket-inspector"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="inspector-head">
                      <span className="inspector-window mono">
                        {fmt(bucket.start)} – {fmt(bucket.end)}
                      </span>
                      <span className={"chip" + (bucket.count > 0 ? " accent-chip" : "")}>
                        {bucket.count} bookmarked
                      </span>
                    </div>

                    <p className="inspector-quote">
                      {bucket.text ? `“${bucket.text}”` : "Nothing was said in this window."}
                    </p>

                    <div className="row" style={{ marginTop: 14 }}>
                      <motion.button
                        className="btn primary"
                        onClick={() => summarise(bucket.start, bucket.end)}
                        disabled={bucket.count === 0 || summaryBusy !== null}
                        whileTap={{ scale: 0.98 }}
                      >
                        <Sparkles size={15} />
                        <span>
                          {summaryBusy === bucket.start
                            ? "Reading the bookmarks…"
                            : moment && !("error" in moment)
                              ? "Refresh summary"
                              : "What should I re-explain?"}
                        </span>
                      </motion.button>
                      {bucket.count === 0 && (
                        <span className="sub" style={{ margin: 0 }}>
                          No bookmarks here yet.
                        </span>
                      )}
                    </div>

                    {moment && "error" in moment && (
                      <div className="err" style={{ marginTop: 12, marginBottom: 0 }}>
                        <AlertCircle size={15} />
                        <span>{moment.error}</span>
                      </div>
                    )}

                    {moment && !("error" in moment) && (
                      <motion.div
                        className="summary-box"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                      >
                        <div className="summary-badge">
                          Re-explain this ({moment.students_lost} students lost)
                        </div>
                        <p className="summary-body">{moment.summary}</p>
                        {(moment.reexplain ?? []).length > 0 && (
                          <ul className="summary-list">
                            {moment.reexplain.map((x, i) => (
                              <li key={i}>{x}</li>
                            ))}
                          </ul>
                        )}
                        {moment.suggested_fix && (
                          <div className="fix-callout">
                            <Lightbulb size={16} />
                            <div>
                              <strong>Try:</strong> {moment.suggested_fix}
                            </div>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Optional Slide Knowledge Graph & Sample Audio Sync Card */}
            <KnowledgeGraphCard
              lectureId={id}
              status={status}
              graph={s?.knowledge_graph}
              buckets={s?.buckets ?? []}
              selectedBucketIdx={sel}
              onSelectBucket={setSel}
              roomSize={s?.room_size ?? Math.max(1, s?.bookmarks_total ?? 1)}
              hasSimulated={!!s?.simulated_total}
              audioMode={!!s?.audio_mode}
              momentSummary={moment && !("error" in moment) ? moment : undefined}
              onRefresh={refetch}
              onClearLocalResults={clearResults}
            />

            {/* Student Self-Checks Card */}
            <motion.div
              className="card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.12 }}
            >
              <div className="row card-header-row">
                <div>
                  <h2>Student self-checks</h2>
                  <p className="sub" style={{ marginBottom: 0 }}>
                    Students tap "Test myself" on their phone whenever they like. Results are anonymous.
                  </p>
                </div>
                <div className="spacer" />
                <span className="chip">{checks?.answered ?? 0} answered</span>
              </div>

              {!checks || checks.answered === 0 ? (
                <div className="subtle-empty">No self-checks yet.</div>
              ) : (
                <div className="checks-layout">
                  <div className="score-ring-box">
                    <svg width="64" height="64" viewBox="0 0 68 68" className="score-ring">
                      <circle cx="34" cy="34" r="26" className="ring-bg" />
                      <motion.circle
                        cx="34"
                        cy="34"
                        r="26"
                        className="ring-fg"
                        strokeDasharray={ringCircumference}
                        initial={{ strokeDashoffset: ringCircumference }}
                        animate={{ strokeDashoffset: ringOffset }}
                        transition={{ duration: 0.7, ease: "easeOut" }}
                      />
                    </svg>
                    <div>
                      <span className="big">{checks.pct_correct}%</span>
                      <span className="sub" style={{ display: "block", margin: 0 }}>
                        answered correctly
                      </span>
                    </div>
                  </div>

                  {checks.missed.length > 0 && (
                    <div className="missed-list">
                      <p className="sub" style={{ margin: "0 0 8px", fontWeight: 600 }}>
                        Concepts students are getting wrong
                      </p>
                      {checks.missed.map((m) => {
                        const pct = (100 * m.missed) / Math.max(1, m.answered);
                        return (
                          <div className="opt" key={m.concept}>
                            <motion.div
                              className="meter"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.45, ease: "easeOut" }}
                            />
                            <span>
                              <em style={{ fontStyle: "normal", fontWeight: 500 }}>{m.concept}</em>
                              <b>
                                {m.missed} of {m.answered} missed
                              </b>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </motion.div>

            {/* Lecturer Insights Card */}
            <motion.div
              className="card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.16 }}
            >
              <div className="row card-header-row">
                <div>
                  <h2>Lecturer insights</h2>
                  {!insights && (
                    <p className="sub" style={{ marginBottom: 0 }}>
                      An AI agent reads the most-bookmarked moments and suggests how to re-explain them.
                    </p>
                  )}
                </div>
                <div className="spacer" />
                <motion.button
                  className="btn"
                  onClick={getInsights}
                  disabled={!s?.bookmarks_total || !!busy}
                  whileTap={{ scale: 0.98 }}
                >
                  <BarChart3 size={15} />
                  <span>{busy === "insights" ? "Analysing…" : "Analyse top moments"}</span>
                </motion.button>
              </div>

              {insights && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="insights-results">
                  <p className="insights-lead">{insights.summary}</p>
                  <div className="moments-timeline">
                    {insights.moments.map((m, i) => (
                      <motion.div
                        className="moment-card"
                        key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.06 }}
                      >
                        <div className="moment-top">
                          <span className="mono chip accent-chip">{m.time}</span>
                          <span className="chip">{m.students_lost} students lost</span>
                        </div>
                        <div className="moment-said">“{m.what_was_said}”</div>
                        <div className="moment-why">{m.why_confusing}</div>
                        <div className="fix-callout compact">
                          <Lightbulb size={15} />
                          <span>{m.suggested_fix}</span>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
            </motion.div>
          </div>

          {/* Right Sidebar */}
          <div className="stack">
            <motion.div
              className="card qr-pass-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.1 }}
            >
              <div className="qr-pass-header">
                <QrCode size={16} />
                <span>Students join here</span>
              </div>
              <p className="sub">Scan to join anonymously.</p>

              <div className="qr-frame">
                <QRCodeSVG value={joinUrl} size={184} level="M" />
              </div>

              <div className="pass-code mono">{id}</div>

              <div className="pass-actions">
                <button type="button" className="btn btn-sm" onClick={copyJoinLink}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? "Copied link" : "Copy link"}</span>
                </button>
                <a
                  href={`/join/${id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-sm"
                  style={{ textDecoration: "none" }}
                >
                  <ExternalLink size={14} />
                  <span>Student tab</span>
                </a>
              </div>

              <div className="tunnel-box">
                <input
                  value={base}
                  onChange={(e) => {
                    setBase(e.target.value);
                    localStorage.setItem("signal_join_base", e.target.value);
                  }}
                  aria-label="Public URL used in the QR code"
                />
                <p className="sub" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
                  Paste your tunnel URL above so phones can reach it.
                </p>
              </div>
            </motion.div>

            <motion.div
              className="card demo-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.14 }}
            >
              <h2>Demo mode</h2>
              <p className="sub">Replays a bundled 3-minute lecture with simulated students. No mic or Wi-Fi risk.</p>
              <div className="row">
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  <option value={1}>Real time (3 min)</option>
                  <option value={3}>3× faster</option>
                  <option value={6}>6× (dry run)</option>
                </select>
                <motion.button className="btn primary" onClick={runDemo} disabled={!!busy} whileTap={{ scale: 0.98 }}>
                  <Play size={14} />
                  <span>{busy === "demo" ? "Starting…" : "Run demo"}</span>
                </motion.button>
              </div>
            </motion.div>

            <motion.div
              className="card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.18 }}
            >
              <div className="row" style={{ marginBottom: 4 }}>
                <h2>Live transcript</h2>
                <div className="spacer" />
                {status === "live" && <LiveWaveform active />}
              </div>
              <p className="sub">Text only. Raw audio is never stored.</p>
              <div className="transcript">
                {segments.length === 0 && !scribe.partialTranscript && (
                  <span className="sub" style={{ margin: 0 }}>
                    Waiting for speech…
                  </span>
                )}
                {segments.map((g, i) => (
                  <motion.div
                    className="transcript-line"
                    key={`${Math.round(g.t_start)}-${i}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <span className="t mono">{fmt(g.t_start)}</span>
                    <span className="transcript-txt">{g.text}</span>
                  </motion.div>
                ))}
                {scribe.partialTranscript && <div className="partial">{scribe.partialTranscript}</div>}
                <div ref={transcriptEndRef} />
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
