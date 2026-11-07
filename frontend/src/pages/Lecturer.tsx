import { useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useScribe } from "@elevenlabs/react";
import { api, fmt, Insights, LecturerState, post } from "../api";
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
  // The QR code must contain a URL phones can reach. Paste your tunnel URL here (see README).
  const [base, setBase] = useState(localStorage.getItem("signal_join_base") || window.location.origin);

  // Live speech-to-text: mic -> ElevenLabs Scribe v2 Realtime. Each finished sentence goes to our backend.
  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    onCommittedTranscript: (d) => {
      if (d.text && d.text.trim()) post(`/api/lectures/${id}/segments`, { text: d.text }).catch(() => {});
    },
  });

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
      await post(`/api/lectures/${id}/demo`, { speed, seed: true });
    });

  const quizNow = () => run("quiz", () => post(`/api/lectures/${id}/quiz`));
  const getInsights = () => run("insights", async () => setInsights(await api<Insights>(`/api/lectures/${id}/insights`)));

  const joinUrl = `${base.replace(/\/$/, "")}/join/${id}`;
  const status = s?.status ?? "waiting";
  const bucket = sel !== null && s ? s.buckets[sel] : null;
  const quiz = s && s.quizzes.length ? s.quizzes[s.quizzes.length - 1] : null;

  return (
    <div className="wrap">
      <div className="top">
        <div className="logo">
          <i /> Signal
        </div>
        <span className="chip">Code {id}</span>
        <span className={"chip" + (status === "live" ? " live" : "")}>{status === "live" ? "● LIVE" : status}</span>
        <span className="chip">{fmt(s?.elapsed ?? 0)}</span>
        {scribe.isConnected && <span className="chip">🎙 mic on</span>}
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
            {s && s.buckets.length > 0 ? <Heatmap buckets={s.buckets} selected={sel} onSelect={setSel} /> : <p className="sub">Start the lecture to begin.</p>}
            {bucket && (
              <div className="bucket-text">
                <b>
                  {fmt(bucket.start)}-{fmt(bucket.end)} · {bucket.count} bookmarked
                </b>
                <br />
                {bucket.text || "Nothing was said in this window."}
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
              {s?.segments.length === 0 && !scribe.partialTranscript && <span className="sub">Waiting for speech…</span>}
              {s?.segments.map((g, i) => (
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
