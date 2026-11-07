"""The three AI agents: quiz writer, explainer, lecturer-insight.

Everything here returns plain dicts. If there is no ANTHROPIC_API_KEY (or MOCK_AI=1)
we return canned answers so the UI can be built and demoed without any API calls.
"""
import json
import os
import re

from anthropic import AsyncAnthropic

MOCK = os.getenv("MOCK_AI") == "1" or not os.getenv("ANTHROPIC_API_KEY")
FAST = os.getenv("MODEL_FAST", "claude-haiku-5-5")    # quizzes: speed matters
SMART = os.getenv("MODEL_SMART", "claude-sonnet-5-5")  # explanations + insights: quality matters
client = None if MOCK else AsyncAnthropic()


def _parse_json(text: str) -> dict:
    """Models sometimes wrap JSON in ```fences``` or add a sentence. Pull out the object."""
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in model output")
    return json.loads(text[start : end + 1])


async def _ask_json(model: str, system: str, user: str, max_tokens: int = 700) -> dict:
    last_err = None
    for _ in range(2):  # one retry on bad JSON
        resp = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system + "\n\nReturn ONLY a JSON object. No preface, no markdown.",
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        try:
            return _parse_json(text)
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"model returned invalid JSON: {last_err}")


# ---------------------------------------------------------------- quiz agent
QUIZ_SYSTEM = """You write ONE multiple-choice question that checks whether a student understood what a lecturer just said.
Rules:
- Use ONLY the transcript. The transcript is live speech-to-text, so it may be noisy.
- Test understanding (why / what happens if), not trivia or exact wording.
- Exactly 4 options, exactly one correct. Wrong options should be plausible misconceptions.
- Keep the question under 25 words and each option under 12 words.
JSON shape:
{"question": str, "options": [str, str, str, str], "correct_index": 0-3,
 "explanation": str (1-2 sentences on why the answer is right), "concept": str (2-4 words)}"""


MOCK_QUIZZES = [
    {
        "question": "Why do hash tables resize and rehash when the load factor gets too high?",
        "options": [
            "To keep chains/probe sequences short so lookups stay fast",
            "Because the hash function stops working on full arrays",
            "To sort the keys into alphabetical order",
            "To free memory that deleted keys were using",
        ],
        "correct_index": 0,
        "explanation": "A high load factor means more collisions, so resizing spreads keys out and keeps lookups close to O(1).",
        "concept": "load factor",
    },
    {
        "question": "Two different keys hash to the same slot. What is this called?",
        "options": ["A collision", "A rehash", "An overflow bug", "A load spike"],
        "correct_index": 0,
        "explanation": "There are far more possible keys than slots, so different keys sometimes land in the same slot. That is a collision.",
        "concept": "collisions",
    },
    {
        "question": "How does chaining handle two keys that land in the same slot?",
        "options": [
            "It keeps a list in that slot and appends both keys",
            "It moves the second key to the next free slot",
            "It deletes the older key",
            "It doubles the array immediately",
        ],
        "correct_index": 0,
        "explanation": "With chaining each slot holds a small list, so colliding keys are simply stored together and lookups walk that short list.",
        "concept": "chaining",
    },
]


async def make_quiz(transcript: str, seen: list[str] | None = None) -> dict:
    """One question for ONE student. `seen` = questions they already got, so we don't repeat them."""
    seen = seen or []
    if MOCK:
        return MOCK_QUIZZES[len(seen) % len(MOCK_QUIZZES)]
    user = f"Transcript of the last few minutes:\n\n{transcript}"
    if seen:
        user += "\n\nThis student has ALREADY been asked these. Do not repeat or lightly reword them, pick a different idea:\n" + "\n".join(f"- {q}" for q in seen)
    q = await _ask_json(FAST, QUIZ_SYSTEM, user, 500)
    opts = q.get("options")
    ci = q.get("correct_index")
    if not (isinstance(opts, list) and len(opts) == 4 and isinstance(ci, int) and 0 <= ci <= 3):
        raise RuntimeError("quiz agent returned a malformed question")
    return q


# ------------------------------------------------------------ explainer agent
EXPLAIN_SYSTEM = """A university student bookmarked this moment of a lecture because they got lost or zoned out.
Help them catch up. Use ONLY the transcript excerpt (it is noisy speech-to-text; ignore glitches).
Plain English. Define any jargon the first time you use it. Be warm but not chatty.
JSON shape:
{"title": str (max 6 words), "said": str (one sentence: what the lecturer was saying),
 "explanation": str (2-4 sentences, the concept explained simply),
 "example": str (one concrete example or analogy),
 "check_yourself": str (one question the student can answer to test they've got it)}"""


async def explain_moment(excerpt: str) -> dict:
    if MOCK:
        return {
            "title": "Handling hash collisions",
            "said": "The lecturer described two ways to deal with two keys landing in the same slot.",
            "explanation": "A collision is when two keys hash to the same array slot. Chaining keeps a small list in each slot. Open addressing instead hunts for the next free slot.",
            "example": "Think of a hotel where two guests are given room 7: chaining puts a second bed in room 7, probing sends the second guest to room 8.",
            "check_yourself": "If slot 7 is taken, where does each approach put the next key that hashes to 7?",
        }
    return await _ask_json(SMART, EXPLAIN_SYSTEM, f"Transcript excerpt (about 90 seconds):\n\n{excerpt}", 600)


# ------------------------------------------------------------- insight agent
INSIGHT_SYSTEM = """You advise a university lecturer using anonymous data on when students pressed a 'I'm lost / bookmark' button.
You get the most-bookmarked 30-second windows with what was being said. Be concrete and kind.
Only hypothesise about WHY a window was confusing - say 'likely' and stay grounded in the transcript. Never invent numbers.
JSON shape:
{"summary": str (2 sentences for the lecturer),
 "moments": [{"what_was_said": str (1 sentence), "why_confusing": str (1 sentence, hedged),
              "suggested_fix": str (1 concrete sentence the lecturer could do next lecture)}]}
Return one entry in "moments" per window given, in the same order."""


async def lecturer_insights(windows: list[dict]) -> dict:
    """windows: [{time: 'mm:ss', count: int, text: str}] sorted most-bookmarked first."""
    if MOCK:
        return {
            "summary": "Most students got lost while collisions and the load factor were introduced back to back.",
            "moments": [
                {
                    "what_was_said": "Chaining and open addressing were introduced within 30 seconds of each other.",
                    "why_confusing": "Two new collision strategies and their jargon likely arrived faster than students could absorb them.",
                    "suggested_fix": "Spend a minute on a worked example of chaining alone before introducing probing.",
                }
                for _ in windows
            ],
        }
    lines = [f"Window {i+1} (starts {w['time']}, {w['count']} students bookmarked): {w['text']}" for i, w in enumerate(windows)]
    return await _ask_json(SMART, INSIGHT_SYSTEM, "\n\n".join(lines), 900)


# ------------------------------------------------------- moment summary agent
MOMENT_SYSTEM = """You help a university lecturer see what to RE-EXPLAIN. Many students pressed an anonymous 'I'm lost' button
during one 30-second window of the lecture. You get that window's transcript (with timestamps), the lecture just before it,
and when in the window the presses happened (they often land just AFTER the confusing sentence).
Use ONLY the transcript (live speech-to-text, may be noisy). Be concrete and kind. Hypothesise about WHY with hedged wording
('likely'). Never invent numbers.
JSON shape:
{"summary": str (1-2 sentences: what students most likely did not follow),
 "reexplain": [str] (2-3 short items: the specific ideas or terms to go back over),
 "suggested_fix": str (one concrete way to re-explain it, e.g. a worked example or analogy)}"""


async def moment_summary(window: str, lead_in: str, press_times: list[str], students: int) -> dict:
    if MOCK:
        return {
            "summary": "Students likely lost the thread when two collision strategies were introduced back to back with new jargon.",
            "reexplain": [
                "What a collision is, with one concrete example (two keys, same slot)",
                "The difference between chaining and open addressing",
                "Why probing needs a consistent sequence for lookups",
            ],
            "suggested_fix": "Do chaining alone on the board with three keys, then show probing on the same keys so students can compare directly.",
        }
    user = (
        f"{students} students pressed the button in this window, at: {', '.join(press_times)}\n\n"
        f"Lecture just before the window:\n{lead_in or '(nothing, this is the start)'}\n\n"
        f"The window itself:\n{window}"
    )
    return await _ask_json(SMART, MOMENT_SYSTEM, user, 600)
