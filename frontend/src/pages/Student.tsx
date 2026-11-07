import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Bookmark, BookOpenCheck, CheckCircle2, X, XCircle } from "lucide-react";
import { fmt, post, PublicState, SelfQuiz, SelfQuizResult, studentId } from "../api";
import { useLive } from "../hooks";
import { LiveWaveform, SignalBrand, ThemeToggle } from "../components/AmbientChrome";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export default function Student() {
  const { id = "" } = useParams();
  const sid = studentId();
  const { data: s, error } = useLive<PublicState>(`/api/lectures/${id}/public?student_id=${sid}`, id, 2000);
  const [toast, setToast] = useState("");
  const [ripples, setRipples] = useState<number[]>([]);

  // "Test myself": a personal quiz that only this student sees
  const [open, setOpen] = useState(false);
  const [quiz, setQuiz] = useState<SelfQuiz | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<SelfQuizResult | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const triggerRipple = () => {
    const key = Date.now();
    setRipples((prev) => [...prev, key]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((k) => k !== key));
    }, 850);
  };

  const bookmark = async () => {
    triggerRipple();
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
      const res = await post<SelfQuizResult>(`/api/lectures/${id}/quiz/self/answer`, {
        student_id: sid,
        quiz_id: quiz.id,
        choice: i,
      });
      setResult(res);
    } catch (e) {
      setChoice(null);
      flash((e as Error).message);
    }
  };

  if (error && !s) {
    return (
      <div className="page-shell">
        <div className="wrap narrow">
          <div className="err">Could not reach the lecture: {error}</div>
        </div>
      </div>
    );
  }

  const status = s?.status ?? "waiting";

  return (
    <div className="page-shell">
      <div className="wrap narrow student">
        <motion.header
          className="nav-bar compact-nav"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <SignalBrand />
          <span className="chip mono">Lecture {id}</span>
          <div className="spacer" />
          <span className="chip">
            <Bookmark size={12} /> {s?.my_bookmarks ?? 0} saved
          </span>
          <ThemeToggle />
        </motion.header>

        <div className="center">
          {status === "waiting" && (
            <motion.div className="status-banner" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <span className="pulse-dot" /> Waiting for the lecturer to start…
            </motion.div>
          )}

          {status === "live" && (
            <motion.div className="status-banner is-live" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <LiveWaveform active /> Live session · {fmt(s?.elapsed ?? 0)}
            </motion.div>
          )}

          {status === "ended" ? (
            <motion.div
              className="card ended-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="ended-icon-badge">
                <CheckCircle2 size={24} />
              </div>
              <h2>Lecture finished</h2>
              <p className="sub">Your bookmarked moments are explained clearly in your catch-up notes.</p>
              <div className="ended-actions">
                <Link to={`/digest/${id}`} className="btn primary btn-lg" style={{ textDecoration: "none" }}>
                  <span>Open my catch-up notes</span>
                  <ArrowRight size={16} />
                </Link>
                <button className="btn btn-lg" onClick={testMe}>
                  <BookOpenCheck size={16} />
                  <span>Test myself</span>
                </button>
              </div>
              <AnimatePresence>
                {toast && (
                  <motion.div
                    className="toast-pill"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    style={{ marginTop: 14 }}
                  >
                    {toast}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ) : (
            <>
              <div className="signal-orb-wrap">
                {ripples.map((rKey) => (
                  <motion.span
                    key={rKey}
                    className="orb-shockwave"
                    initial={{ scale: 0.96, opacity: 0.55 }}
                    animate={{ scale: 1.45, opacity: 0 }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                ))}

                <motion.button
                  type="button"
                  className="lost"
                  onClick={bookmark}
                  disabled={status !== "live"}
                  whileHover={status === "live" ? { scale: 1.02 } : undefined}
                  whileTap={status === "live" ? { scale: 0.95 } : undefined}
                  transition={{ type: "spring", stiffness: 420, damping: 26 }}
                >
                  <Bookmark size={24} className="lost-icon" />
                  <span className="lost-label">I'm lost</span>
                  <small>{status === "live" ? "tap to bookmark" : "waiting to start"}</small>
                </motion.button>
              </div>

              <div className="toast-slot">
                <AnimatePresence mode="wait">
                  {toast && (
                    <motion.div
                      key={toast}
                      className="toast-pill"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                    >
                      <span>{toast}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <motion.button
                type="button"
                className="quiz-trigger-card"
                onClick={testMe}
                disabled={status !== "live"}
                whileHover={status === "live" ? { y: -1 } : undefined}
                whileTap={status === "live" ? { scale: 0.99 } : undefined}
              >
                <span className="quiz-trigger-icon">
                  <BookOpenCheck size={19} />
                </span>
                <span className="quiz-trigger-copy">
                  <strong>Test myself</strong>
                  <small>Quick quiz from the last few minutes</small>
                </span>
                <ArrowRight size={16} className="quiz-trigger-arrow" />
              </motion.button>

              <p className="student-reassure">
                Lost? Tap the button above and carry on listening. We'll explain it after the lecture.
              </p>
            </>
          )}
        </div>

        {/* Personal Quiz Modal Overlay */}
        <AnimatePresence>
          {open && (
            <motion.div
              className="overlay-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="quiz-modal"
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 14, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
              >
                <div className="quiz-modal-header">
                  <div className="row">
                    <span className="quiz-kicker">Self-Check Quiz</span>
                    {quiz && <span className="chip">{quiz.concept || "Quick check"}</span>}
                  </div>
                  <button
                    type="button"
                    className="icon-close-btn"
                    onClick={() => setOpen(false)}
                    aria-label="Close quiz"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="quiz-modal-body">
                  {!quiz && (
                    <div className="quiz-loading">
                      <p className="sub" style={{ marginBottom: 14 }}>
                        Writing a question from the last few minutes…
                      </p>
                      <div className="skeleton" style={{ height: 60 }} />
                      <div className="skeleton" style={{ height: 50 }} />
                      <div className="skeleton" style={{ height: 50 }} />
                    </div>
                  )}

                  {quiz && (
                    <>
                      <div className="q">{quiz.question}</div>

                      <div className="choices-stack">
                        {quiz.options.map((o, i) => {
                          const isRight = result && i === result.correct_index;
                          const isWrong = result && !isRight && i === choice;
                          const cls = isRight ? " right" : isWrong ? " wrong" : choice === i ? " selected" : "";

                          return (
                            <motion.button
                              key={i}
                              type="button"
                              className={"choice" + cls}
                              onClick={() => answer(i)}
                              disabled={!!result}
                              whileTap={!result ? { scale: 0.99 } : undefined}
                            >
                              <span className="choice-letter">{LETTERS[i] ?? i + 1}</span>
                              <span className="choice-text">{o}</span>
                              {isRight && <CheckCircle2 size={19} className="choice-icon" />}
                              {isWrong && <XCircle size={19} className="choice-icon" />}
                            </motion.button>
                          );
                        })}
                      </div>

                      <AnimatePresence>
                        {result && (
                          <motion.div
                            className={"verdict-box " + (result.correct ? "is-correct" : "is-wrong")}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                          >
                            <div className="verdict">
                              {result.correct ? (
                                <>
                                  <CheckCircle2 size={18} /> Correct
                                </>
                              ) : (
                                <>
                                  <XCircle size={18} /> Not quite
                                </>
                              )}
                            </div>
                            <p className="verdict-exp">{result.explanation}</p>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="row" style={{ marginTop: 18 }}>
                        {result && (
                          <motion.button className="btn primary" onClick={testMe} whileTap={{ scale: 0.98 }}>
                            <span>Another question</span>
                          </motion.button>
                        )}
                        <button className="btn" onClick={() => setOpen(false)}>
                          {result ? "Back to the lecture" : "Close"}
                        </button>
                      </div>

                      {!result && (
                        <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
                          The lecture keeps going while you answer.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
