"""Signal backend: one FastAPI app, in-memory state, WebSocket 'something changed' pings.

Run:  uvicorn main:app --reload --port 8000
"""
import asyncio
import io
import json
import os
import random
import re
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pypdf import PdfReader
from pydantic import BaseModel

load_dotenv()
import agents  # noqa: E402  (must come after load_dotenv so it sees the env vars)

app = FastAPI(title="Signal")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BUCKET = 30          # heatmap bucket size in seconds
EXPLAIN_WINDOW = 45  # seconds either side of a bookmark sent to the explainer
QUIZ_LOOKBACK = 180  # seconds of transcript the quiz agent sees
SELF_QUIZ_COOLDOWN = 3  # seconds a student must wait between "test myself" requests
BASE_DIR = Path(__file__).parent
DEMO = json.loads((BASE_DIR / "demo_transcript.json").read_text(encoding="utf-8"))
LOGIC_AUDIO_DEMO = json.loads((BASE_DIR / "logic_audio_transcript.json").read_text(encoding="utf-8"))
SAMPLE_AUDIO_PATH = BASE_DIR / "sample_lecture_20m.mp3"
FALLBACK_AUDIO_PATH = BASE_DIR.parent / "presentation.mp3"


# ------------------------------------------------------------------ state
class Lecture:
    def __init__(self, lid: str):
        self.id = lid
        self.status = "waiting"  # waiting -> live -> ended
        self.started_at = 0.0
        self.ended_elapsed = 0.0
        self.speed = 1.0         # >1 only for fast demo replays
        self.segments: list[dict] = []   # {t_start, t_end, text, node_id?}
        self.bookmarks: list[dict] = []  # {student_id, t, simulated, explanation|None}
        self.self_quizzes: dict[str, dict] = {}  # quiz_id -> personal quiz (see self_quiz); only its student sees it
        self.last_self_quiz: dict[str, float] = {}  # student_id -> wall-clock time of their last request
        self.insights: tuple[int, dict] | None = None  # (bookmark_count_when_made, result)
        self.sockets: set[WebSocket] = set()
        self.explain_lock = asyncio.Lock()
        self.run_id = 0          # bumped whenever a demo replay starts/stops, so an old replay task knows to quit
        self.moments: dict[tuple, dict] = {}  # (start, end, students) -> cached moment summary
        # Optional Knowledge Graph + Sample Audio Lecture state (never alters existing flow when unused)
        self.knowledge_graph: dict | None = None
        self.seen_students: set[str] = set()
        self.simulated_room_size: int = 0
        self.audio_mode: bool = False
        self.audio_pos: float = 0.0
        self.audio_playing: bool = False
        self.audio_updated_at: float = 0.0
        self.max_audio_reached: float = 0.0
        self.audio_sim_schedule: list[tuple[str, float]] = []
        self.audio_sim_idx: int = 0
        self.audio_seg_idx: int = 0

    def reset(self) -> None:
        """Wipe everything from a previous run (and stop any demo replay that is still going).
        Note: `knowledge_graph` is intentionally preserved because slides are uploaded before starting!
        """
        self.run_id += 1
        self.segments.clear()
        self.bookmarks.clear()
        self.self_quizzes.clear()
        self.last_self_quiz.clear()
        self.insights = None
        self.moments.clear()
        self.ended_elapsed = 0.0
        self.simulated_room_size = 0
        self.audio_mode = False
        self.audio_pos = 0.0
        self.audio_playing = False
        self.audio_updated_at = 0.0
        self.max_audio_reached = 0.0
        self.audio_sim_schedule = []
        self.audio_sim_idx = 0
        self.audio_seg_idx = 0

    def playhead(self) -> float:
        """Current live timestamp into the lecture (used for bookmarks, quizzes, and live clock)."""
        if self.audio_mode:
            if self.status == "live" and self.audio_playing:
                return min(1200.0, self.audio_pos + max(0.0, time.time() - self.audio_updated_at))
            return self.audio_pos
        if self.status == "live":
            return (time.time() - self.started_at) * self.speed
        return self.ended_elapsed if self.status == "ended" else 0.0

    def elapsed(self) -> float:
        """Horizon covered so far (keeps scrubbed 20m heatmap bars visible even if rewinding audio)."""
        if self.audio_mode:
            return max(self.max_audio_reached, self.playhead())
        return self.playhead()

    def room_size(self) -> int:
        real_ids = set(self.seen_students) | {b["student_id"] for b in self.bookmarks if not b["simulated"]}
        return max(len(real_ids) + self.simulated_room_size, 1 if self.bookmarks else 0)

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


def match_bucket_to_node(lec: Lecture, t0: float, t1: float, bucket_text: str) -> str | None:
    """Deterministically map a 30s heatmap window to the Knowledge Graph concept node covered then."""
    kg = lec.knowledge_graph
    if not kg or not kg.get("nodes"):
        return None
    nodes = kg["nodes"]
    valid_ids = {n["id"] for n in nodes}

    # 1. Explicit segment node_id tag (e.g. from synced 20m Formal Logic audio transcript)
    overlapping = [s for s in lec.segments if s["t_end"] > t0 and s["t_start"] < t1]
    for s in overlapping:
        nid = s.get("node_id")
        if nid in valid_ids:
            return nid

    # 2. Keyword + label scoring against window transcript (with light 15s lead-in fallback)
    haystack = (bucket_text or lec.text_between(max(0.0, t0 - 15), t1)).lower()
    if not haystack.strip():
        return None

    best_id: str | None = None
    best_score = 0
    hay_words = set(re.findall(r"[a-z0-9]+", haystack))
    for n in nodes:
        score = 0
        for kw in n.get("keywords") or []:
            kw_l = kw.lower().strip()
            if kw_l and kw_l in haystack:
                score += 6 if " " in kw_l else 4
        lbl_words = [w for w in re.findall(r"[a-z0-9]+", n.get("label", "").lower()) if len(w) > 2]
        for lw in lbl_words:
            if lw in hay_words:
                score += 3
        sum_words = [w for w in re.findall(r"[a-z0-9]+", n.get("summary", "").lower()) if len(w) > 4]
        for sw in sum_words:
            if sw in hay_words:
                score += 1
        if n.get("category") == "core":
            score = max(0, score - 2)  # prefer specific leaf/branch topic over generic root title
        if score > best_score:
            best_score = score
            best_id = n["id"]

    return best_id if best_score >= 3 else None


def build_buckets(lec: Lecture) -> list[dict]:
    if lec.audio_mode:
        _materialize_audio_progress(lec, lec.elapsed())
    n = int(lec.elapsed() // BUCKET) + 1
    seen: list[set] = [set() for _ in range(n)]
    for b in lec.bookmarks:
        i = int(b["t"] // BUCKET)
        if i < n:
            seen[i].add(b["student_id"])
    buckets = []
    for i in range(n):
        t0, t1 = i * BUCKET, (i + 1) * BUCKET
        txt = lec.text_between(t0, t1)
        buckets.append(
            {
                "start": t0,
                "end": t1,
                "count": len(seen[i]),
                "text": txt,
                "node_id": match_bucket_to_node(lec, t0, t1, txt),
            }
        )
    return buckets


def add_segment(lec: Lecture, text: str, t_start: float | None = None, t_end: float | None = None, node_id: str | None = None) -> None:
    now = lec.playhead() if t_end is None else t_end
    if t_start is None:
        last_end = lec.segments[-1]["t_end"] if lec.segments else 0.0
        t_start = max(last_end, now - 20)
    seg = {"t_start": round(t_start, 1), "t_end": round(now, 1), "text": text.strip()}
    if node_id:
        seg["node_id"] = node_id
    lec.segments.append(seg)


def _build_logic_sim_schedule(seed: bool) -> list[tuple[str, float]]:
    """Realistic simulated confusion clusters across the 20-minute Formal Logic audio lecture."""
    if not seed:
        return []
    rng = random.Random(11120)
    events: list[tuple[str, float]] = []
    # Cluster 1 (02:00-02:30): empty left-hand side of turnstile ⊢
    for i in range(5):
        events.append((f"sim-s{i}", rng.uniform(122, 148)))
    # Cluster 2 (05:00-05:30): Implication Introduction backwards
    for i in range(6):
        events.append((f"sim-s{i+3}", rng.uniform(302, 328)))
    # Cluster 3 (06:30-07:00): atomic A on right -> must be Elimination rule
    for i in range(7):
        events.append((f"sim-s{i+6}", rng.uniform(392, 418)))
    # Peak Spike #1 (08:30-09:00): Or-Elimination 3-premise rule (15 of 32 = 47% of room!)
    for i in range(15):
        events.append((f"sim-s{i}", rng.uniform(512, 538)))
    # Follow-up on Or-Elim (12:30-13:00): copying goal A to both upper branches
    for i in range(8):
        events.append((f"sim-s{i+10}", rng.uniform(752, 778)))
    # Cluster 4 (14:30-15:00): Greek letter Gamma (Γ) & Weakening
    for i in range(9):
        events.append((f"sim-s{i+14}", rng.uniform(872, 898)))
    # Peak Spike #2 near 20th minute (18:30-19:00): Comma (,) vs ∧ & And-Elimination (14 of 32 = 44% of room!)
    for i in range(14):
        events.append((f"sim-s{i+16}", rng.uniform(1112, 1138)))
    # Closing branch (19:00-19:30): applying ∧-Elim backwards
    for i in range(6):
        events.append((f"sim-s{i+22}", rng.uniform(1142, 1168)))
    events.sort(key=lambda pair: pair[1])
    return events


def _materialize_audio_progress(lec: Lecture, up_to: float) -> bool:
    """Reveal all 20m audio transcript segments and scheduled simulated bookmarks up to `up_to` seconds."""
    changed = False
    lec.max_audio_reached = max(lec.max_audio_reached, min(1200.0, up_to))
    horizon = lec.max_audio_reached

    while lec.audio_seg_idx < len(LOGIC_AUDIO_DEMO):
        seg = LOGIC_AUDIO_DEMO[lec.audio_seg_idx]
        if seg["t_start"] > horizon:
            break
        add_segment(lec, seg["text"], seg["t_start"], seg["t_end"], seg.get("node_id"))
        lec.audio_seg_idx += 1
        changed = True

    while lec.audio_sim_idx < len(lec.audio_sim_schedule):
        sid, t_mark = lec.audio_sim_schedule[lec.audio_sim_idx]
        if t_mark > horizon:
            break
        lec.bookmarks.append({"student_id": sid, "t": round(t_mark, 1), "simulated": True, "explanation": None})
        lec.audio_sim_idx += 1
        changed = True

    return changed


# ----------------------------------------------------------------- models
class SegmentIn(BaseModel):
    text: str


class BookmarkIn(BaseModel):
    student_id: str


class SelfQuizIn(BaseModel):
    student_id: str


class SelfAnswerIn(BaseModel):
    student_id: str
    quiz_id: str
    choice: int


class DemoIn(BaseModel):
    speed: float = 1.0       # 1 = real time (3 min). 6 = a 30 second dry run.
    seed: bool = True        # add SIMULATED students so the heatmap has something to show


class MomentIn(BaseModel):
    start: float             # heatmap bucket start, seconds into the lecture
    end: float               # heatmap bucket end


class SlidePresetIn(BaseModel):
    preset: str = "logic"    # "logic" | "hashtables" | "dijkstra"


class AudioDemoStartIn(BaseModel):
    seed: bool = True
    auto_load_graph: bool = True
    initial_time: float = 0.0
    playing: bool = True


class AudioSyncIn(BaseModel):
    current_time: float
    playing: bool = False


# ---------------------------------------------------------------- routes
@app.get("/api/health")
async def health():
    return {"ok": True, "mock_ai": agents.MOCK, "has_elevenlabs_key": bool(os.getenv("ELEVENLABS_API_KEY"))}


@app.get("/api/sample-audio")
async def sample_audio():
    """Streams the 20-minute Formal Logic lecture audio chunk (supports HTTP Range seeking)."""
    target = SAMPLE_AUDIO_PATH if SAMPLE_AUDIO_PATH.exists() else FALLBACK_AUDIO_PATH
    if not target.exists():
        raise HTTPException(404, "sample lecture audio file not found")
    return FileResponse(target, media_type="audio/mpeg", filename="sample_lecture_20m.mp3")


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


@app.post("/api/lectures/{lid}/slides")
async def upload_slides(lid: str, file: UploadFile = File(...)):
    """Optional professor PDF/slide upload: extracts slide text and builds a React Flow Knowledge Graph."""
    lec = get_lecture(lid)
    filename = file.filename or "slides.pdf"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "uploaded file is empty")

    extracted_parts: list[str] = []
    if filename.lower().endswith(".pdf") or raw[:4] == b"%PDF":
        try:
            reader = PdfReader(io.BytesIO(raw))
            for idx, page in enumerate(reader.pages[:80]):
                txt = (page.extract_text() or "").strip()
                if txt:
                    extracted_parts.append(f"--- Slide {idx + 1} ---\n{txt}")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"could not read PDF slides: {e}")
    else:
        extracted_parts.append(raw.decode("utf-8", errors="ignore"))

    slide_text = "\n\n".join(extracted_parts).strip()
    if not slide_text:
        raise HTTPException(400, "no readable text found in uploaded slides")

    try:
        kg = await agents.build_knowledge_graph(slide_text, filename)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"knowledge graph builder failed: {e}")

    lec.knowledge_graph = kg
    await notify(lec)
    return kg


@app.post("/api/lectures/{lid}/slides/preset")
async def load_slide_preset(lid: str, body: SlidePresetIn):
    """One-click sample slide deck loader for quick demos."""
    lec = get_lecture(lid)
    p = body.preset.lower().strip()
    if p == "hashtables":
        lec.knowledge_graph = agents.preset_hashtables_graph()
    elif p == "dijkstra":
        lec.knowledge_graph = agents.preset_dijkstra_graph()
    else:
        lec.knowledge_graph = agents.preset_logic_graph("111_chapter3_logic (1).pdf")
    await notify(lec)
    return lec.knowledge_graph


@app.delete("/api/lectures/{lid}/slides")
async def clear_slides(lid: str):
    lec = get_lecture(lid)
    lec.knowledge_graph = None
    await notify(lec)
    return {"ok": True}


@app.post("/api/lectures/{lid}/audio-demo/start")
async def start_audio_demo(lid: str, body: AudioDemoStartIn):
    """Starts the optional 20-minute Formal Logic audio lecture synced with real transcripts & slides."""
    lec = get_lecture(lid)
    if body.auto_load_graph and lec.knowledge_graph is None:
        lec.knowledge_graph = agents.preset_logic_graph("111_chapter3_logic (1).pdf")
    lec.reset()
    lec.status = "live"
    lec.started_at = time.time()
    lec.speed = 1.0
    lec.audio_mode = True
    lec.audio_pos = max(0.0, min(1200.0, body.initial_time))
    lec.audio_playing = body.playing
    lec.audio_updated_at = time.time()
    lec.simulated_room_size = 32 if body.seed else 0
    lec.audio_sim_schedule = _build_logic_sim_schedule(body.seed)
    _materialize_audio_progress(lec, max(lec.audio_pos, 1.0))
    await notify(lec)
    return {"ok": True, "knowledge_graph": lec.knowledge_graph}


@app.post("/api/lectures/{lid}/audio-demo/sync")
async def sync_audio_demo(lid: str, body: AudioSyncIn):
    """Syncs backend transcript & simulated student bookmarks to the HTML5 <audio> playhead / scrubber."""
    lec = get_lecture(lid)
    if not lec.audio_mode:
        return {"ok": False}
    lec.audio_pos = max(0.0, min(1200.0, body.current_time))
    lec.audio_playing = body.playing and lec.status == "live"
    lec.audio_updated_at = time.time()
    changed = _materialize_audio_progress(lec, lec.audio_pos)
    if changed:
        await notify(lec)
    return {"ok": True, "elapsed": lec.elapsed(), "playhead": lec.playhead()}


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
        if lec.audio_mode:
            _materialize_audio_progress(lec, lec.elapsed())
            lec.audio_pos = lec.playhead()
            lec.audio_playing = False
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
    if lec.segments and lec.segments[-1]["text"] == body.text.strip() and lec.playhead() - lec.segments[-1]["t_end"] < 3 * lec.speed:
        return {"ok": False}  # duplicate delivery of the same sentence
    add_segment(lec, body.text)
    await notify(lec)
    return {"ok": True}


@app.post("/api/lectures/{lid}/bookmarks")
async def post_bookmark(lid: str, body: BookmarkIn):
    lec = get_lecture(lid)
    if lec.status != "live":
        raise HTTPException(409, "lecture is not live")
    if body.student_id:
        lec.seen_students.add(body.student_id)
    t = lec.playhead()
    mine = [b for b in lec.bookmarks if b["student_id"] == body.student_id]
    # a nervous double-tap should not count twice
    if mine and abs(t - mine[-1]["t"]) < 15:
        return {"t": mine[-1]["t"], "count": len(mine), "duplicate": True}
    lec.bookmarks.append({"student_id": body.student_id, "t": t, "simulated": False, "explanation": None})
    await notify(lec)
    return {"t": t, "count": len(mine) + 1, "duplicate": False}


@app.post("/api/lectures/{lid}/quiz/self")
async def self_quiz(lid: str, body: SelfQuizIn):
    """A student taps 'Test myself': write one question from the last few minutes, just for them."""
    lec = get_lecture(lid)
    if lec.status == "waiting":
        raise HTTPException(409, "the lecture hasn't started yet")
    if body.student_id:
        lec.seen_students.add(body.student_id)
    if time.time() - lec.last_self_quiz.get(body.student_id, 0.0) < SELF_QUIZ_COOLDOWN:
        raise HTTPException(429, "one moment, still writing your last question")
    if lec.audio_mode:
        _materialize_audio_progress(lec, lec.playhead())
    now = lec.playhead() or lec.elapsed()
    text = lec.text_between(now - QUIZ_LOOKBACK, now)
    if not text.strip():
        raise HTTPException(400, "nothing has been said yet, try again in a moment")
    lec.last_self_quiz[body.student_id] = time.time()
    seen = [q["question"] for q in lec.self_quizzes.values() if q["student_id"] == body.student_id][-6:]
    try:
        q = await agents.make_quiz(text, seen)
    except Exception as e:  # noqa: BLE001
        lec.last_self_quiz.pop(body.student_id, None)
        raise HTTPException(502, f"quiz agent failed: {e}")
    quiz = {
        "id": uuid.uuid4().hex[:6],
        "student_id": body.student_id,
        "created_t": now,
        "question": q["question"],
        "options": q["options"],
        "correct_index": q["correct_index"],
        "explanation": q.get("explanation", ""),
        "concept": q.get("concept", ""),
        "answer": None,  # the student's choice, once they answer
    }
    lec.self_quizzes[quiz["id"]] = quiz
    await notify(lec)
    # never send the correct answer until the student has answered
    return {"id": quiz["id"], "question": quiz["question"], "options": quiz["options"], "concept": quiz["concept"]}


@app.post("/api/lectures/{lid}/quiz/self/answer")
async def self_quiz_answer(lid: str, body: SelfAnswerIn):
    lec = get_lecture(lid)
    quiz = lec.self_quizzes.get(body.quiz_id)
    if not quiz or quiz["student_id"] != body.student_id:
        raise HTTPException(404, "quiz not found")
    if not 0 <= body.choice < len(quiz["options"]):
        raise HTTPException(400, "bad choice")
    if quiz["answer"] is None:  # first answer wins
        quiz["answer"] = body.choice
    await notify(lec)
    return {
        "correct": quiz["answer"] == quiz["correct_index"],
        "correct_index": quiz["correct_index"],
        "explanation": quiz["explanation"],
    }


def self_check_stats(lec: Lecture) -> dict:
    """Anonymous class-wide view of the students' self-tests, for the lecturer."""
    answered = [q for q in lec.self_quizzes.values() if q["answer"] is not None]
    right = sum(1 for q in answered if q["answer"] == q["correct_index"])
    by_concept: dict[str, dict] = {}
    for q in answered:
        name = q["concept"].strip() or "General"
        e = by_concept.setdefault(name.lower(), {"concept": name, "answered": 0, "missed": 0})
        e["answered"] += 1
        e["missed"] += 1 if q["answer"] != q["correct_index"] else 0
    missed = sorted((e for e in by_concept.values() if e["missed"]), key=lambda e: (-e["missed"], -e["answered"]))[:5]
    return {
        "requested": len(lec.self_quizzes),
        "answered": len(answered),
        "pct_correct": round(100 * right / len(answered)) if answered else None,
        "missed": missed,
    }


@app.get("/api/lectures/{lid}/public")
async def public_state(lid: str, student_id: str = ""):
    """What a student's phone needs."""
    lec = get_lecture(lid)
    if student_id:
        lec.seen_students.add(student_id)
    mine = sum(1 for b in lec.bookmarks if b["student_id"] == student_id)
    return {"id": lec.id, "status": lec.status, "elapsed": lec.playhead(), "my_bookmarks": mine}


@app.get("/api/lectures/{lid}/state")
async def lecturer_state(lid: str):
    lec = get_lecture(lid)
    buckets = build_buckets(lec)
    return {
        "id": lec.id,
        "status": lec.status,
        "elapsed": lec.playhead(),
        "horizon": lec.elapsed(),
        "speed": 0.0 if (lec.audio_mode and not lec.audio_playing) else lec.speed,
        "segments": lec.segments[-60:],
        "buckets": buckets,
        "bookmarks_total": len(lec.bookmarks),
        "simulated_total": sum(1 for b in lec.bookmarks if b["simulated"]),
        "room_size": lec.room_size(),
        "self_checks": self_check_stats(lec),
        "knowledge_graph": lec.knowledge_graph,
        "audio_mode": lec.audio_mode,
        "audio_playing": lec.audio_playing,
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
    lec.simulated_room_size = 24 if body.seed else 0
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
