import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fmt, post, PublicState, SelfQuiz, SelfQuizResult, studentId } from "../api";
import { useLive } from "../hooks";

export default function Student() {
  const { id = "" } = useParams();
  const sid = studentId();
  const { data: s, error } = useLive<PublicState>(`/api/lectures/${id}/public?student_id=${sid}`, id, 2000);
  const [toast, setToast] = useState("");

  // "Test myself": a personal quiz that only this student sees
  const [open, setOpen] = useState(false); // is the quiz overlay on screen?
  const [quiz, setQuiz] = useState<SelfQuiz | null>(null); // null while the question is being written
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<SelfQuizResult | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const bookmark = async () => {
    try {
      const r = await post<{ t: number; duplicate: boolean }>(`/api/lectures/${id}/bookmarks`, { student_id: sid });
      navigator.vibrate?.(30);
      flash(r.duplicate ? `Already saved at ${fmt(r.t)}` : `Saved at ${fmt(r.t)}. We'll explain it after the lecture.`);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const testMe = async () => {
    setOpen(true);
    setQuiz(null);
    setChoice(null);
    setResult(null);
    try {
      setQuiz(await post<SelfQuiz>(`/api/lectures/${id}/quiz/self`, { student_id: sid }));
    } catch (e) {
      setOpen(false);
      flash((e as Error).message);
    }
  };

  const answer = async (i: number) => {
    if (!quiz || result) return;
    setChoice(i);
    try {
      setResult(await post<SelfQuizResult>(`/api/lectures/${id}/quiz/self/answer`, { student_id: sid, quiz_id: quiz.id, choice: i }));
    } catch (e) {
      setChoice(null);
      flash((e as Error).message);
    }
  };

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
            <div className="row">
              <Link to={`/digest/${id}`} className="btn primary" style={{ textDecoration: "none", display: "inline-block" }}>
                Open my catch-up notes
              </Link>
              <button className="btn" onClick={testMe}>Test myself</button>
            </div>
            <div className="toast" style={{ marginTop: 10 }}>{toast}</div>
          </div>
        )}
        {status !== "ended" && (
          <>
            <div className="pair">
              <button className="lost" onClick={bookmark} disabled={status !== "live"}>
                I'm lost
                <small>tap to bookmark</small>
              </button>
              <button className="side" onClick={testMe} disabled={status !== "live"}>
                Test myself
                <small>quick quiz</small>
              </button>
            </div>
            <div className="toast">{toast}</div>
            <p className="sub" style={{ maxWidth: 320 }}>
              Lost? Tap the big button and carry on listening. We'll explain it after the lecture. Want to check you've got it? Tap "Test myself" any time.
            </p>
          </>
        )}
      </div>

      {open && (
        <div className="overlay">
          {!quiz && (
            <>
              <p className="sub">Writing a question from the last few minutes…</p>
              <div className="skeleton" />
            </>
          )}
          {quiz && (
            <>
              <span className="chip">{quiz.concept || "Quick check"}</span>
              <div className="q">{quiz.question}</div>
              {quiz.options.map((o, i) => {
                const cls = result ? (i === result.correct_index ? " right" : i === choice ? " wrong" : "") : "";
                return (
                  <button key={i} className={"choice" + cls} onClick={() => answer(i)} disabled={!!result}>
                    {o}
                  </button>
                );
              })}
              {result && (
                <>
                  <p className="verdict">{result.correct ? "Correct" : "Not quite"}</p>
                  <p style={{ margin: "0 0 16px", lineHeight: 1.5 }}>{result.explanation}</p>
                </>
              )}
              <div className="row" style={{ marginTop: 16 }}>
                {result && <button className="btn primary" onClick={testMe}>Another question</button>}
                <button className="btn" onClick={() => setOpen(false)}>{result ? "Back to the lecture" : "Close"}</button>
              </div>
              {!result && <p className="sub" style={{ marginTop: 12 }}>The lecture keeps going while you answer.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
