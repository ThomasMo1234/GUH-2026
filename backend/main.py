"""Signal backend: one FastAPI app, in-memory state, WebSocket 'something changed' pings.

Run:  uvicorn main:app --reload --port 8000
"""
import asyncio
import json
import os
import random
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()
import agents  # noqa: E402  (must come after load_dotenv so it sees the env vars)

app = FastAPI(title="Signal")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BUCKET = 30          # heatmap bucket size in seconds
EXPLAIN_WINDOW = 45  # seconds either side of a bookmark sent to the explainer
QUIZ_LOOKBACK = 180  # seconds of transcript the quiz agent sees
QUIZ_SECONDS = 25    # how long students have to answer
DEMO = json.loads((Path(__file__).parent / "demo_transcript.json").read_text())


# ------------------------------------------------------------------ state
class Lecture:
    def __init__(self, lid: str):
        self.id = lid
        self.status = "waiting"  # waiting -> live -> ended
        self.started_at = 0.0
        self.ended_elapsed = 0.0
        self.speed = 1.0         # >1 only for fast demo replays
        self.segments: list[dict] = []   # {t_start, t_end, text}
        self.bookmarks: list[dict] = []  # {student_id, t, simulated, explanation|None}
        self.quizzes: list[dict] = []    # see create_quiz
        self.insights: tuple[int, dict] | None = None  # (bookmark_count_when_made, result)
        self.sockets: set[WebSocket] = set()
        self.explain_lock = asyncio.Lock()
        self.run_id = 0          # bumped whenever a demo replay starts/stops, so an old replay task knows to quit
        self.moments: dict[tuple, dict] = {}  # (start, end, students) -> cached moment summary

    def reset(self) -> None:
        """Wipe everything from a previous run (and stop any demo replay that is still going)."""
        self.run_id += 1
        self.segments.clear()
        self.bookmarks.clear()
        self.quizzes.clear()
        self.insights = None
        self.moments.clear()
        self.ended_elapsed = 0.0

    def elapsed(self) -> float:
        if self.status == "live":
            return (time.time() - self.started_at) * self.speed
        return self.ended_elapsed if self.status == "ended" else 0.0

    def text_between(self, t0: float, t1: float) -> str:
        return " ".join(s["text"] for s in self.segments if s["t_end"] >= t0 and s["t_start"] <= t1)

    def lines_between(self, t0: float, t1: float) -> str:
        """Same as text_between but each segment is prefixed with its timestamp, e.g. '[01:12] ...'."""
        return "\n".join(f"[{mmss(s['t_start'])}] {s['text']}" for s in self.segments if s["t_end"] >= t0 and s["t_start"] <= t1)


LECTURES: dict[str, Lecture] = {}


def get_lecture(lid: str) -> Lecture:
    lec = LECTURES.get(lid.upper())
    if not lec:
        raise HTTPException(404, "lecture not found")
    return lec


async def notify(lec: Lecture) -> None:
    """Tell every connected browser 'refetch your state'. Clients also poll as a fallback."""
    dead = []
    for ws in list(lec.sockets):
        try:
            await ws.send_text('{"type":"changed"}')
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        lec.sockets.discard(ws)


def mmss(t: float) -> str:
    t = int(max(0, t))
    return f"{t // 60:02d}:{t % 60:02d}"


def build_buckets(lec: Lecture) -> list[dict]:
    n = int(lec.elapsed() // BUCKET) + 1
    seen: list[set] = [set() for _ in range(n)]
    for b in lec.bookmarks:
        i = int(b["t"] // BUCKET)
        if i < n:
            seen[i].add(b["student_id"])
    return [
        {
            "start": i * BUCKET,
            "end": (i + 1) * BUCKET,
            "count": len(seen[i]),
            "text": lec.text_between(i * BUCKET, (i + 1) * BUCKET),
        }
        for i in range(n)
    ]


def add_segment(lec: Lecture, text: str, t_start: float | None = None, t_end: float | None = None) -> None:
    now = lec.elapsed() if t_end is None else t_end
    if t_start is None:
        last_end = lec.segments[-1]["t_end"] if lec.segments else 0.0
        t_start = max(last_end, now - 20)
    lec.segments.append({"t_start": round(t_start, 1), "t_end": round(now, 1), "text": text.strip()})


# ----------------------------------------------------------------- models
class SegmentIn(BaseModel):
    text: str


class BookmarkIn(BaseModel):
    student_id: str


class AnswerIn(BaseModel):
    student_id: str
    quiz_id: str
    choice: int


class DemoIn(BaseModel):
    speed: float = 1.0       # 1 = real time (3 min). 6 = a 30 second dry run.
    seed: bool = True        # add SIMULATED students so the heatmap has something to show


class MomentIn(BaseModel):
    start: float             # heatmap bucket start, seconds into the lecture
    end: float               # heatmap bucket end


# ---------------------------------------------------------------- routes
@app.get("/api/health")
async def health():
    return {"ok": True, "mock_ai": agents.MOCK, "has_elevenlabs_key": bool(os.getenv("ELEVENLABS_API_KEY"))}


@app.get("/api/scribe-token")
async def scribe_token():
    """Single-use token so the browser can talk to ElevenLabs Scribe without seeing our API key."""
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(500, "ELEVENLABS_API_KEY is not set in backend/.env")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
            headers={"xi-api-key": key},
        )
    if r.status_code != 200:
        raise HTTPException(502, f"ElevenLabs said: {r.text}")
    return {"token": r.json()["token"]}


@app.post("/api/lectures")
async def create_lecture():
    lid = uuid.uuid4().hex[:4].upper()
    LECTURES[lid] = Lecture(lid)
    return {"id": lid}


@app.post("/api/lectures/{lid}/start")
async def start_lecture(lid: str):
    lec = get_lecture(lid)
    lec.reset()
    lec.status, lec.started_at, lec.speed = "live", time.time(), 1.0
    await notify(lec)
    return {"ok": True}


@app.post("/api/lectures/{lid}/end")
async def end_lecture(lid: str):
    lec = get_lecture(lid)
    if lec.status == "live":
        lec.ended_elapsed = lec.elapsed()
        lec.status = "ended"
        lec.run_id += 1  # stops a demo replay that is still running
    await notify(lec)
    return {"ok": True}


@app.post("/api/lectures/{lid}/segments")
async def post_segment(lid: str, body: SegmentIn):
    lec = get_lecture(lid)
    if lec.status != "live" or not body.text.strip():
        return {"ok": False}
    if lec.segments and lec.segments[-1]["text"] == body.text.strip() and lec.elapsed() - lec.segments[-1]["t_end"] < 3 * lec.speed:
        return {"ok": False}  # duplicate delivery of the same sentence
    add_segment(lec, body.text)
    await notify(lec)
    return {"ok": True}


@app.post("/api/lectures/{lid}/bookmarks")
async def post_bookmark(lid: str, body: BookmarkIn):
    lec = get_lecture(lid)
    if lec.status != "live":
        raise HTTPException(409, "lecture is not live")
    t = lec.elapsed()
    mine = [b for b in lec.bookmarks if b["student_id"] == body.student_id]
    # a nervous double-tap should not count twice
    if mine and t - mine[-1]["t"] < 15:
        return {"t": mine[-1]["t"], "count": len(mine), "duplicate": True}
    lec.bookmarks.append({"student_id": body.student_id, "t": t, "simulated": False, "explanation": None})
    await notify(lec)
    return {"t": t, "count": len(mine) + 1, "duplicate": False}


@app.post("/api/lectures/{lid}/quiz")
async def create_quiz(lid: str):
    lec = get_lecture(lid)
    if lec.status != "live":
        raise HTTPException(409, "lecture is not live")
    now = lec.elapsed()
    text = lec.text_between(now - QUIZ_LOOKBACK, now)
    if not text.strip():
        raise HTTPException(400, "no transcript yet - speak for a bit first")
    try:
        q = await agents.make_quiz(text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"quiz agent failed: {e}")
    quiz = {
        "id": uuid.uuid4().hex[:6],
        "created_t": now,
        "expires_at": time.time() + QUIZ_SECONDS,
        "question": q["question"],
        "options": q["options"],
        "correct_index": q["correct_index"],
        "explanation": q.get("explanation", ""),
        "concept": q.get("concept", ""),
        "answers": {},  # student_id -> choice
    }
    lec.quizzes.append(quiz)
    await notify(lec)
    return {"id": quiz["id"]}


@app.post("/api/lectures/{lid}/answers")
async def post_answer(lid: str, body: AnswerIn):
    lec = get_lecture(lid)
    quiz = next((q for q in lec.quizzes if q["id"] == body.quiz_id), None)
    if not quiz:
        raise HTTPException(404, "quiz not found")
    if not 0 <= body.choice < len(quiz["options"]):
        raise HTTPException(400, "bad choice")
    quiz["answers"].setdefault(body.student_id, body.choice)  # first answer wins
    await notify(lec)
    return {
        "correct": quiz["answers"][body.student_id] == quiz["correct_index"],
        "correct_index": quiz["correct_index"],
        "explanation": quiz["explanation"],
    }


@app.get("/api/lectures/{lid}/public")
async def public_state(lid: str, student_id: str = ""):
    """What a student's phone needs. Never includes the correct answer."""
    lec = get_lecture(lid)
    active = None
    if lec.quizzes:
        q = lec.quizzes[-1]
        left = q["expires_at"] - time.time()
        if left > 0:
            active = {"id": q["id"], "question": q["question"], "options": q["options"], "seconds_left": round(left, 1)}
    mine = sum(1 for b in lec.bookmarks if b["student_id"] == student_id)
    return {"id": lec.id, "status": lec.status, "elapsed": lec.elapsed(), "active_quiz": active, "my_bookmarks": mine}


@app.get("/api/lectures/{lid}/state")
async def lecturer_state(lid: str):
    lec = get_lecture(lid)
    quizzes = []
    for q in lec.quizzes:
        counts = [0] * len(q["options"])
        for c in q["answers"].values():
            counts[c] += 1
        total = sum(counts)
        quizzes.append(
            {
                "id": q["id"],
                "created_t": q["created_t"],
                "question": q["question"],
                "options": q["options"],
                "correct_index": q["correct_index"],
                "concept": q["concept"],
                "counts": counts,
                "total": total,
                "pct_correct": round(100 * counts[q["correct_index"]] / total) if total else None,
                "open": q["expires_at"] > time.time(),
            }
        )
    return {
        "id": lec.id,
        "status": lec.status,
        "elapsed": lec.elapsed(),
        "speed": lec.speed,
        "segments": lec.segments[-60:],
        "buckets": build_buckets(lec),
        "bookmarks_total": len(lec.bookmarks),
        "simulated_total": sum(1 for b in lec.bookmarks if b["simulated"]),
        "quizzes": quizzes,
    }


@app.get("/api/lectures/{lid}/digest")
async def digest(lid: str, student_id: str):
    """Personal catch-up notes: one explanation per bookmark. Generated on demand, then cached."""
    lec = get_lecture(lid)
    mine = [b for b in lec.bookmarks if b["student_id"] == student_id]
    sem = asyncio.Semaphore(4)

    async def fill(b: dict):
        if b["explanation"] is not None:
            return
        excerpt = lec.text_between(b["t"] - EXPLAIN_WINDOW, b["t"] + EXPLAIN_WINDOW)
        async with sem:
            try:
                b["explanation"] = await agents.explain_moment(excerpt)
            except Exception as e:  # noqa: BLE001
                b["explanation"] = {"title": "Could not explain this moment", "said": excerpt[:200], "explanation": f"({e})", "example": "", "check_yourself": ""}

    await asyncio.gather(*(fill(b) for b in mine))
    return {
        "items": [{"t": b["t"], "label": mmss(b["t"]), "excerpt": lec.text_between(b["t"] - 10, b["t"] + 10), **b["explanation"]} for b in mine]
    }


@app.get("/api/lectures/{lid}/insights")
async def insights(lid: str):
    lec = get_lecture(lid)
    n = len(lec.bookmarks)
    if lec.insights and lec.insights[0] == n:
        return lec.insights[1]
    top = sorted((b for b in build_buckets(lec) if b["count"] > 0), key=lambda b: -b["count"])[:3]
    if not top:
        return {"summary": "No bookmarks yet, so there is nothing to analyse.", "moments": []}
    wins = [{"time": mmss(b["start"]), "count": b["count"], "text": lec.text_between(b["start"] - 15, b["end"] + 15)} for b in top]
    try:
        res = await agents.lecturer_insights(wins)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"insight agent failed: {e}")
    moments = res.get("moments", [])
    for w, m in zip(wins, moments):  # true counts come from us, never from the model
        m["time"], m["students_lost"] = w["time"], w["count"]
    res["moments"] = moments
    lec.insights = (n, res)
    return res


@app.post("/api/lectures/{lid}/moments/summary")
async def moment_summary(lid: str, body: MomentIn):
    """Lecturer clicked one heatmap bar: read every bookmark in that window and say what to re-explain."""
    lec = get_lecture(lid)
    t0, t1 = body.start, body.end
    if t1 <= t0:
        raise HTTPException(400, "end must be after start")
    # same rule as the heatmap: one vote per student per window
    ts = sorted(b["t"] for b in lec.bookmarks if t0 <= b["t"] < t1)
    students = {b["student_id"] for b in lec.bookmarks if t0 <= b["t"] < t1}
    if not students:
        raise HTTPException(400, "nobody bookmarked this window")
    key = (t0, t1, len(students))
    if key in lec.moments:
        return lec.moments[key]
    window = lec.lines_between(t0, t1)
    lead_in = lec.lines_between(t0 - 45, t0 - 0.1)
    if not window.strip():
        raise HTTPException(400, "no transcript for this window yet")
    try:
        res = await agents.moment_summary(window, lead_in, [mmss(t) for t in ts], len(students))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"summary agent failed: {e}")
    res["students_lost"] = len(students)  # true count comes from us, never from the model
    res["reexplain"] = [str(x) for x in res.get("reexplain", [])][:4]
    res.setdefault("summary", "")
    res.setdefault("suggested_fix", "")
    lec.moments[key] = res
    return res


@app.post("/api/lectures/{lid}/demo")
async def start_demo(lid: str, body: DemoIn):
    """Replays the bundled lecture transcript so you can demo with no mic and no Wi-Fi risk."""
    lec = get_lecture(lid)
    lec.reset()  # also bumps run_id, which makes any earlier replay task stop (that was the duplicate-lines bug)
    lec.status, lec.started_at, lec.speed = "live", time.time(), max(0.5, body.speed)
    asyncio.create_task(_replay(lec, body.seed, lec.run_id))
    await notify(lec)
    return {"ok": True}


async def _replay(lec: Lecture, seed: bool, run_id: int) -> None:
    rng = random.Random(7)
    # simulated classmates: a cluster on the hard bit (collisions / load factor) and a smaller one later
    sims = sorted([rng.uniform(70, 98) for _ in range(14)] + [rng.uniform(98, 115) for _ in range(6)] + [rng.uniform(132, 150) for _ in range(4)]) if seed else []
    sim_i = 0
    for seg in DEMO:
        wait = (seg["t_end"] - lec.elapsed()) / lec.speed
        if wait > 0:
            await asyncio.sleep(wait)
        if lec.status != "live" or lec.run_id != run_id:
            return  # lecture ended, or a newer demo/lecture took over
        add_segment(lec, seg["text"], seg["t_start"], seg["t_end"])
        while sim_i < len(sims) and sims[sim_i] <= seg["t_end"]:
            lec.bookmarks.append({"student_id": f"sim-{sim_i}", "t": sims[sim_i], "simulated": True, "explanation": None})
            sim_i += 1
        await notify(lec)


@app.websocket("/ws/{lid}")
async def ws_endpoint(ws: WebSocket, lid: str):
    lec = LECTURES.get(lid.upper())
    await ws.accept()
    if not lec:
        await ws.close()
        return
    lec.sockets.add(ws)
    try:
        while True:
            await ws.receive_text()  # we never need messages from clients; this just detects disconnects
    except WebSocketDisconnect:
        pass
    finally:
        lec.sockets.discard(ws)
