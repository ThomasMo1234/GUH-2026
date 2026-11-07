import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fmt, post, PublicState, studentId } from "../api";
import { useLive } from "../hooks";

type Result = { correct: boolean; correct_index: number; explanation: string; choice: number; question: string; options: string[] };

export default function Student() {
  const { id = "" } = useParams();
  const sid = studentId();
  const { data: s, error } = useLive<PublicState>(`/api/lectures/${id}/public?student_id=${sid}`, id, 2000);
  const [toast, setToast] = useState("");
  const [results, setResults] = useState<Record<string, Result>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [deadline, setDeadline] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const q = s?.active_quiz ?? null;
  // The phone's clock may differ from the server's, so we only trust "seconds left" and count down locally.
  useEffect(() => {
    if (q && deadline?.id !== q.id) setDeadline({ id: q.id, at: Date.now() + q.seconds_left * 1000 });
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const bookmark = async () => {
    try {
      const r = await post<{ t: number; duplicate: boolean }>(`/api/lectures/${id}/bookmarks`, { student_id: sid });
      navigator.vibrate?.(30);
      setToast(r.duplicate ? `Already saved at ${fmt(r.t)}` : `Saved at ${fmt(r.t)}. We'll explain it after the lecture.`);
    } catch (e) {
      setToast((e as Error).message);
    }
    setTimeout(() => setToast(""), 3500);
  };

  const answer = async (choice: number) => {
    if (!q) return;
    const r = await post<{ correct: boolean; correct_index: number; explanation: string }>(`/api/lectures/${id}/answers`, {
      student_id: sid,
      quiz_id: q.id,
      choice,
    });
    setResults((prev) => ({ ...prev, [q.id]: { ...r, choice, question: q.question, options: q.options } }));
  };

  // which quiz (if any) should be on screen?
  const answeredPending = Object.entries(results).find(([qid]) => !dismissed.includes(qid));
  const showQuiz = q && !results[q.id];
  const secondsLeft = deadline && q && deadline.id === q.id ? Math.max(0, (deadline.at - now) / 1000) : 0;

  if (error && !s) return <div className="wrap narrow"><div className="err">Could not reach the lecture: {error}</div></div>;

  const status = s?.status ?? "waiting";

  return (
    <div className="wrap narrow student">
      <div className="top">
        <div className="logo"><i /> Signal</div>
        <span className="chip">Lecture {id}</span>
        <div className="spacer" />
        <span className="chip">{s?.my_bookmarks ?? 0} saved</span>
      </div>

      <div className="center">
        {status === "waiting" && <p className="sub">Waiting for the lecturer to start…</p>}
        {status === "ended" && (
          <div className="card">
            <h2>Lecture finished</h2>
            <p className="sub">Your bookmarked moments are explained here.</p>
            <Link to={`/digest/${id}`} className="btn primary" style={{ textDecoration: "none", display: "inline-block" }}>
              Open my catch-up notes
            </Link>
          </div>
        )}
        {status !== "ended" && (
          <>
            <button className="lost" onClick={bookmark} disabled={status !== "live"}>
              I'm lost
              <small>tap to bookmark this moment</small>
            </button>
            <div className="toast">{toast}</div>
            <p className="sub" style={{ maxWidth: 320 }}>
              Keep listening. Just tap and carry on. We save this moment and explain it after the lecture.
            </p>
          </>
        )}
      </div>

      {showQuiz && q && (
        <div className="overlay">
          <div className="timer"><i style={{ width: `${Math.min(100, (secondsLeft / 25) * 100)}%` }} /></div>
          <div className="q">{q.question}</div>
          {q.options.map((o, i) => (
            <button key={i} className="choice" onClick={() => answer(i)}>{o}</button>
          ))}
        </div>
      )}

      {!showQuiz && answeredPending && (
        <div className="overlay">
          {(() => {
            const [qid, r] = answeredPending;
            return (
              <>
                <div className="q">{r.correct ? "✅ Nice, that's right" : "❌ Not quite"}</div>
                <p className="sub">{r.question}</p>
                {r.options.map((o, i) => (
                  <div key={i} className={"choice" + (i === r.correct_index ? " right" : i === r.choice ? " wrong" : "")}>{o}</div>
                ))}
                <p style={{ margin: "16px 0", lineHeight: 1.5 }}>{r.explanation}</p>
                <button className="btn primary" onClick={() => setDismissed((d) => [...d, qid])}>Back to the lecture</button>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
