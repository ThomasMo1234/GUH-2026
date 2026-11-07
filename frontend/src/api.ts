export type Bucket = { start: number; end: number; count: number; text: string };

/** Anonymous class-wide summary of the students' own "Test myself" quizzes. */
export type SelfChecks = {
  requested: number;
  answered: number;
  pct_correct: number | null;
  missed: { concept: string; answered: number; missed: number }[];
};

/** A personal quiz question. The correct answer only arrives after the student answers. */
export type SelfQuiz = { id: string; question: string; options: string[]; concept: string };
export type SelfQuizResult = { correct: boolean; correct_index: number; explanation: string };

export type LecturerState = {
  id: string;
  status: "waiting" | "live" | "ended";
  elapsed: number;
  speed?: number; // lecture seconds per real second (1 live, 3 or 6 in a fast demo)
  segments: { t_start: number; t_end: number; text: string }[];
  buckets: Bucket[];
  bookmarks_total: number;
  simulated_total: number;
  self_checks: SelfChecks;
};

export type PublicState = {
  id: string;
  status: "waiting" | "live" | "ended";
  elapsed: number;
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

/** AI "what should I re-explain?" summary for one 30-second window. Backend: POST /api/lectures/{id}/moments/summary */
export type MomentSummary = {
  students_lost: number;
  summary: string;
  reexplain: string[];
  suggested_fix: string;
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
