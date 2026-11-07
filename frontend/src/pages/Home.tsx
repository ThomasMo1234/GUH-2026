import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, Variants } from "framer-motion";
import { ArrowRight, BarChart3, BookOpenCheck, GraduationCap, Mic, Presentation, Radio, Users } from "lucide-react";
import { post } from "../api";
import { SignalBrand, ThemeToggle } from "../components/AmbientChrome";

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Home() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setErr("");
    try {
      const { id } = await post<{ id: string }>("/api/lectures");
      nav(`/lecturer/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <div className="page-shell">
      <div className="wrap">
        <motion.header
          className="nav-bar"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <SignalBrand subtitle="Lecture Clarity" />
          <div className="spacer" />
          <ThemeToggle />
        </motion.header>

        <section className="hero-modern">
          <motion.div className="eyebrow-pill" custom={0} initial="hidden" animate="show" variants={fadeUp}>
            <span className="pulse-dot" /> Live classroom feedback
          </motion.div>

          <motion.h1 className="hero-title" custom={1} initial="hidden" animate="show" variants={fadeUp}>
            Find the moment the room got lost.
          </motion.h1>

          <motion.p className="hero-lead" custom={2} initial="hidden" animate="show" variants={fadeUp}>
            Students bookmark confusing moments with one quiet tap. Lecturers see exactly when it happened, and everyone
            gets clear catch-up notes afterwards.
          </motion.p>
        </section>

        {err && (
          <motion.div className="err" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            {err}
          </motion.div>
        )}

        <div className="bento-two">
          <motion.div
            className="bento-role role-lecturer"
            custom={3}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            whileHover={{ y: -2 }}
            transition={{ type: "spring", stiffness: 360, damping: 28 }}
          >
            <div className="role-top">
              <div>
                <span className="role-kicker">For Lecturers</span>
                <h2>I'm lecturing</h2>
              </div>
              <div className="role-icon-badge">
                <Presentation size={22} />
              </div>
            </div>

            <p className="role-desc">
              Start a session, show the room QR code, and watch the 30-second heatmap fill in as students follow along.
            </p>

            <div className="feature-tags">
              <span>
                <Mic size={13} /> Live transcription
              </span>
              <span>
                <BarChart3 size={13} /> 30s confusion chart
              </span>
            </div>

            <div className="role-footer">
              <motion.button
                className="btn primary btn-lg"
                onClick={create}
                disabled={creating}
                whileTap={{ scale: 0.98 }}
              >
                <span>{creating ? "Starting…" : "Start a lecture"}</span>
                <ArrowRight size={16} />
              </motion.button>
            </div>
          </motion.div>

          <motion.div
            className="bento-role role-student"
            custom={4}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            whileHover={{ y: -2 }}
            transition={{ type: "spring", stiffness: 360, damping: 28 }}
          >
            <div className="role-top">
              <div>
                <span className="role-kicker">For Students</span>
                <h2>I'm a student</h2>
              </div>
              <div className="role-icon-badge sage">
                <GraduationCap size={22} />
              </div>
            </div>

            <p className="role-desc">
              Enter the 4-letter code on your lecturer's screen (or scan their QR code) to bookmark tricky moments and
              check your understanding.
            </p>

            <div className="feature-tags">
              <span>
                <Radio size={13} /> One-tap bookmark
              </span>
              <span>
                <BookOpenCheck size={13} /> Quick self-quiz
              </span>
              <span>
                <Users size={13} /> Anonymous
              </span>
            </div>

            <form
              className="join-code-bar"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 4) nav(`/join/${code}`);
              }}
            >
              <input
                className="code-input mono"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD"
                maxLength={4}
                aria-label="4-letter lecture code"
              />
              <motion.button
                type="submit"
                className="btn primary btn-lg"
                disabled={code.length < 4}
                whileTap={code.length === 4 ? { scale: 0.98 } : undefined}
              >
                <span>Join</span>
                <ArrowRight size={16} />
              </motion.button>
            </form>
          </motion.div>
        </div>

        <motion.section className="workflow-strip" custom={5} initial="hidden" animate="show" variants={fadeUp}>
          <div className="workflow-step">
            <span className="step-num">1</span>
            <div>
              <strong>Bookmark quietly</strong>
              <p>Tap once when lost and keep listening without falling further behind.</p>
            </div>
          </div>
          <div className="workflow-step">
            <span className="step-num">2</span>
            <div>
              <strong>See confusion live</strong>
              <p>Lecturers spot spikes immediately and see what needs re-explaining.</p>
            </div>
          </div>
          <div className="workflow-step">
            <span className="step-num">3</span>
            <div>
              <strong>Review after class</strong>
              <p>Every student receives clear notes tailored to their bookmarked timestamps.</p>
            </div>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
