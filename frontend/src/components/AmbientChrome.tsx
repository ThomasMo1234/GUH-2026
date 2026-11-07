import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";

export type UiTheme = "light" | "dark";

export function useUiTheme(): [UiTheme, () => void] {
  const [theme, setTheme] = useState<UiTheme>(() => {
    const saved = localStorage.getItem("signal_ui_theme");
    return saved === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("signal_ui_theme", theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  return [theme, toggle];
}

export function SignalBrand({ subtitle }: { subtitle?: string }) {
  return (
    <Link to="/" className="brand-link" aria-label="Signal Home">
      <span className="brand-mark">
        <span className="brand-wave w1" />
        <span className="brand-wave w2" />
        <span className="brand-wave w3" />
      </span>
      <span className="brand-text-wrap">
        <span className="brand-name">Signal</span>
        {subtitle && <span className="brand-sub">{subtitle}</span>}
      </span>
    </Link>
  );
}

export function ThemeToggle() {
  const [theme, toggle] = useUiTheme();
  return (
    <motion.button
      type="button"
      className="theme-pill"
      onClick={toggle}
      whileTap={{ scale: 0.96 }}
      title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      aria-label="Toggle color theme"
    >
      {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
      <span className="theme-pill-label">{theme === "light" ? "Dark" : "Light"}</span>
    </motion.button>
  );
}

export function LiveWaveform({ active = true }: { active?: boolean }) {
  return (
    <span className={"eq-bars" + (active ? " is-active" : "")} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="eq-bar"
          animate={
            active
              ? {
                  scaleY: [0.35, 1, 0.45, 0.8, 0.35],
                }
              : { scaleY: 0.3 }
          }
          transition={
            active
              ? {
                  duration: 1.2,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.18,
                }
              : { duration: 0.3 }
          }
        />
      ))}
    </span>
  );
}
