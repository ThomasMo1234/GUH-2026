export type Bucket = { start: number; end: number; count: number; text: string };

export type QuizStat = {
  id: string;
  created_t: number;
  question: string;
  options: string[];
  correct_index: number;
  concept: string;
  counts: number[];
  total: number;
  pct_correct: number | null;
  open: boolean;
};

export type LecturerState = {
  id: string;
  status: "waiting" | "live" | "ended";
  elapsed: number;
  segments: { t_start: number; t_end: number; text: string }[];
  buckets: Bucket[];
  bookmarks_total: number;
  simulated_total: number;
  quizzes: QuizStat[];
};

export type PublicState = {
  id: string;
  status: "waiting" | "live" | "ended";
  elapsed: number;
  active_quiz: null | { id: string; question: string; options: string[]; seconds_left: number };
  my_bookmarks: number;
};

export type DigestItem = {
  t: number;
  label: string;
  excerpt: string;
  title: string;
  said: string;
  explanation: string;
  example: string;
  check_yourself: string;
};

export type Insights = {
  summary: string;
  moments: { time: string; students_lost: number; what_was_said: string; why_confusing: string; suggested_fix: string }[];
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail ?? msg;
    } catch {
      /* body was not JSON */
    }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.json();
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** Anonymous per-browser id. No accounts, nothing personal. */
export function studentId(): string {
  let id = localStorage.getItem("signal_student_id");
  if (!id) {
    id = "s-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("signal_student_id", id);
  }
  return id;
}
