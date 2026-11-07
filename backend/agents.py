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


async def make_quiz(transcript: str) -> dict:
    if MOCK:
        return {
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
        }
    q = await _ask_json(FAST, QUIZ_SYSTEM, f"Transcript of the last few minutes:\n\n{transcript}", 500)
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
