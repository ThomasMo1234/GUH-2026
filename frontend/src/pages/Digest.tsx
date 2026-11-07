import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, BookOpen, CheckCircle2, HelpCircle, Lightbulb, Quote } from "lucide-react";
import { api, DigestItem, studentId } from "../api";
import { SignalBrand, ThemeToggle } from "../components/AmbientChrome";

export default function Digest() {
  const { id = "" } = useParams();
  const [items, setItems] = useState<DigestItem[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ items: DigestItem[] }>(`/api/lectures/${id}/digest?student_id=${studentId()}`)
      .then((r) => setItems(r.items))
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  return (
    <div className="page-shell">
      <div className="wrap digest-wrap">
        <motion.header
          className="nav-bar compact-nav"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <SignalBrand subtitle="Catch-Up Notes" />
          <span className="chip mono">Lecture {id}</span>
          <div className="spacer" />
          <Link to={`/join/${id}`} className="btn btn-sm" style={{ textDecoration: "none" }}>
            <ArrowLeft size={14} />
            <span>Back</span>
          </Link>
          <ThemeToggle />
        </motion.header>

        <motion.section
          className="digest-hero card"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <div className="digest-hero-copy">
            <span className="eyebrow-pill" style={{ marginBottom: 10 }}>
              <BookOpen size={13} /> Personal Study Guide
            </span>
            <h2>Your catch-up notes</h2>
            <p className="sub" style={{ marginBottom: 0 }}>
              One short explanation for each moment you bookmarked during the lecture.
            </p>
          </div>
        </motion.section>

        {err && <div className="err">{err}</div>}

        {!items && !err && (
          <div className="stack" style={{ marginTop: 18 }}>
            <p className="sub" style={{ margin: "4px 4px 0" }}>
              Writing your explanations…
            </p>
            <div className="skeleton" style={{ height: 160 }} />
            <div className="skeleton" style={{ height: 160 }} />
          </div>
        )}

        {items && items.length === 0 && (
          <motion.div className="card empty-digest" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <CheckCircle2 size={28} className="good-icon" />
            <h3>All caught up</h3>
            <p className="sub" style={{ margin: 0 }}>
              You didn't bookmark anything, so you were with the lecturer the whole way. Nice.
            </p>
          </motion.div>
        )}

        <div className="digest-list">
          {items?.map((it, i) => (
            <motion.article
              className="card dcard"
              key={i}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.06 }}
            >
              <div className="dcard-top">
                <span className="chip accent-chip mono">{it.label} into the lecture</span>
                <span className="dcard-idx mono">#{String(i + 1).padStart(2, "0")}</span>
              </div>

              <h3>{it.title}</h3>

              {it.said && (
                <div className="said-quote">
                  <Quote size={15} className="quote-ic" />
                  <p className="said">{it.said}</p>
                </div>
              )}

              <div className="digest-blocks">
                <div className="blk blk-explain">
                  <b>Explained simply</b>
                  <div>{it.explanation}</div>
                </div>

                {it.example && (
                  <div className="blk blk-example">
                    <b>
                      <Lightbulb size={13} /> Example
                    </b>
                    <div>{it.example}</div>
                  </div>
                )}

                {it.check_yourself && (
                  <div className="blk blk-check">
                    <b>
                      <HelpCircle size={13} /> Check yourself
                    </b>
                    <div>{it.check_yourself}</div>
                  </div>
                )}
              </div>
            </motion.article>
          ))}
        </div>
      </div>
    </div>
  );
}
