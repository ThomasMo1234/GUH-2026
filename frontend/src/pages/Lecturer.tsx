import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useScribe } from "@elevenlabs/react";
import { api, fmt, Insights, LecturerState, MomentSummary, post } from "../api";
import { useLive } from "../hooks";
import Heatmap from "../components/Heatmap";

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
      } catch (e) {
        setErr(`Lecture started, but the mic failed (${(e as Error).message}). Use "Run demo" instead.`);
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
      if (status === "live" && !window.confirm("Restart the demo? This clears the current transcript and bookmarks.")) return;
      clearResults();
      await post(`/api/lectures/${id}/demo`, { speed, seed: true });
    });

  const quizNow = () => run("quiz", () => post(`/api/lectures/${id}/quiz`));
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
        [start]: { error: m === "Not Found" ? "The backend doesn't have the moment-summary endpoint yet (restart uvicorn so it picks up the new main.py)." : m },
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
  const quiz = s && s.quizzes.length ? s.quizzes[s.quizzes.length - 1] : null;

  return (
    <div className="wrap">
      <div className="top">
        <div className="logo">
          <i /> Signal
        </div>
        <span className="chip">Code {id}</span>
        <span className={"chip" + (status === "live" ? " live" : "")}>{status === "live" ? "● LIVE" : status}</span>
        <span className="clock" title="Time into the lecture">{fmt(clock)}</span>
        {scribe.isConnected && <span className="chip">Mic on</span>}
        <div className="spacer" />
        <div className="row">
          <button className="btn primary" onClick={startLecture} disabled={status === "live" || !!busy}>
            Start lecture + mic
          </button>
          <button className="btn" onClick={quizNow} disabled={status !== "live" || !!busy}>
            {busy === "quiz" ? "Writing quiz…" : "Quiz now"}
          </button>
          <button className="btn danger" onClick={endLecture} disabled={status !== "live" || !!busy}>
            End lecture
          </button>
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="grid">
        <div className="stack">
          <div className="card">
            <div className="row">
              <h2>Where the room got lost</h2>
              <div className="spacer" />
              <span className="chip">{s?.bookmarks_total ?? 0} bookmarks</span>
              {!!s?.simulated_total && <span className="chip warn">includes {s.simulated_total} simulated students</span>}
            </div>
            <p className="sub">One bar per 30 seconds. Click a bar to see what was being said.</p>
            {s && s.buckets.length > 0 ? <Heatmap buckets={s.buckets} selected={sel} onSelect={setSel} nowT={status === "live" ? clock : undefined} /> : <p className="sub">Start the lecture to begin.</p>}
            {bucket && (
              <div className="bucket-text">
                <b>
                  {fmt(bucket.start)}-{fmt(bucket.end)} · {bucket.count} bookmarked
                </b>
                <br />
                {bucket.text || "Nothing was said in this window."}
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn"
                    onClick={() => summarise(bucket.start, bucket.end)}
                    disabled={bucket.count === 0 || summaryBusy !== null}
                  >
                    {summaryBusy === bucket.start ? "Reading the bookmarks…" : moment && !("error" in moment) ? "Refresh summary" : "What should I re-explain?"}
                  </button>
                  {bucket.count === 0 && <span className="sub" style={{ marginLeft: 10 }}>No bookmarks here yet.</span>}
                </div>
                {moment && "error" in moment && <div className="err" style={{ marginTop: 12, marginBottom: 0 }}>{moment.error}</div>}
                {moment && !("error" in moment) && (
                  <div className="summary">
                    <div className="h">Re-explain this ({moment.students_lost} students lost)</div>
                    <p>{moment.summary}</p>
                    {(moment.reexplain ?? []).length > 0 && (
                      <ul>
                        {moment.reexplain.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    )}
                    {moment.suggested_fix && <p className="fix">Try: {moment.suggested_fix}</p>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div className="row">
              <h2>Live quiz</h2>
              <div className="spacer" />
              {s?.quizzes.map((q, i) => (
                <span key={q.id} className="chip">
                  Q{i + 1}: {q.pct_correct === null ? "…" : `${q.pct_correct}%`}
                </span>
              ))}
            </div>
            {!quiz && <p className="sub">Press "Quiz now" to generate a question from the last few minutes of lecture. Students have 25 seconds.</p>}
            {quiz && (
              <>
                <p className="sub">
                  {quiz.concept} · {quiz.total} answered {quiz.open && "· open"}
                </p>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{quiz.question}</div>
                {quiz.options.map((o, i) => (
                  <div key={i} className={"opt" + (i === quiz.correct_index ? " right" : "")}>
                    <div className="meter" style={{ width: `${quiz.total ? (100 * quiz.counts[i]) / quiz.total : 0}%` }} />
                    <span>
                      <em style={{ fontStyle: "normal" }}>{o}</em>
                      <b>{quiz.counts[i]}</b>
                    </span>
                  </div>
                ))}
                {quiz.pct_correct !== null && (
                  <div style={{ marginTop: 14 }}>
                    <span className="big">{quiz.pct_correct}%</span> <span className="sub">got it right</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <div className="row">
              <h2>Lecturer insights</h2>
              <div className="spacer" />
              <button className="btn" onClick={getInsights} disabled={!s?.bookmarks_total || !!busy}>
                {busy === "insights" ? "Analysing…" : "Analyse top moments"}
              </button>
            </div>
            {!insights && <p className="sub">An AI agent reads the most-bookmarked moments and suggests how to re-explain them.</p>}
            {insights && (
              <>
                <p style={{ margin: "8px 0", lineHeight: 1.5 }}>{insights.summary}</p>
                {insights.moments.map((m, i) => (
                  <div className="moment" key={i}>
                    <div className="h">
                      {m.time} · {m.students_lost} students lost
                    </div>
                    <div>{m.what_was_said}</div>
                    <div style={{ color: "var(--dim)" }}>{m.why_confusing}</div>
                    <div className="fix">→ {m.suggested_fix}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card" style={{ textAlign: "center" }}>
            <h2>Students join here</h2>
            <p className="sub">Scan to join anonymously.</p>
            <div style={{ background: "#fff", padding: 12, borderRadius: 14, display: "inline-block" }}>
              <QRCodeSVG value={joinUrl} size={190} />
            </div>
            <div className="big" style={{ fontSize: 34, marginTop: 10 }}>
              {id}
            </div>
            <input
              style={{ marginTop: 10, fontSize: 12 }}
              value={base}
              onChange={(e) => {
                setBase(e.target.value);
                localStorage.setItem("signal_join_base", e.target.value);
              }}
              aria-label="Public URL used in the QR code"
            />
            <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
              Paste your tunnel URL above so phones can reach it.
            </p>
          </div>

          <div className="card">
            <h2>Demo mode</h2>
            <p className="sub">Replays a bundled 3-minute lecture with simulated students. No mic or Wi-Fi risk.</p>
            <div className="row">
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={1}>Real time (3 min)</option>
                <option value={3}>3× faster</option>
                <option value={6}>6× (dry run)</option>
              </select>
              <button className="btn" onClick={runDemo} disabled={!!busy}>
                Run demo
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Live transcript</h2>
            <p className="sub">Text only. Raw audio is never stored.</p>
            <div className="transcript">
              {segments.length === 0 && !scribe.partialTranscript && <span className="sub">Waiting for speech…</span>}
              {segments.map((g, i) => (
                <div key={i}>
                  <span className="t">{fmt(g.t_start)}</span>
                  {g.text}
                </div>
              ))}
              {scribe.partialTranscript && <div className="partial">{scribe.partialTranscript}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
