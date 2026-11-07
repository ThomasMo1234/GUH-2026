"""The AI agents: quiz writer, explainer, lecturer-insight, moment-summary, and slide knowledge-graph builder.

Everything here returns plain dicts. If there is no ANTHROPIC_API_KEY (or MOCK_AI=1)
we return deterministic, context-aware answers so the UI can be built and demoed without any API calls.
"""
import json
import math
import os
import re

from anthropic import AsyncAnthropic

MOCK = os.getenv("MOCK_AI") == "1" or not os.getenv("ANTHROPIC_API_KEY")
FAST = os.getenv("MODEL_FAST", "claude-haiku-5-5")    # quizzes: speed matters
SMART = os.getenv("MODEL_SMART", "claude-sonnet-5-5")  # explanations + insights + graph: quality matters
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


def _is_logic_text(text: str) -> bool:
    t = text.lower()
    logic_terms = ("tautology", "turnstile", "sideways t", "deduction", "or-elim", "elim rule", "implies-intro", "axiom rule", "boolean semantics", "weakening", "conjunction")
    return any(k in t for k in logic_terms)


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

MOCK_LOGIC_QUIZZES = [
    {
        "question": "In backward natural deduction, why does Or-Elimination require proving three premises?",
        "options": [
            "Prove the OR holds, then prove the same goal in both cases",
            "Prove both sides of the OR are true simultaneously",
            "Convert the OR into three truth-table rows",
            "Eliminate all variables from Gamma first",
        ],
        "correct_index": 0,
        "explanation": "Since P ∨ Q doesn't tell you which disjunct holds, you must establish P ∨ Q and show your target conclusion follows from P and from Q.",
        "concept": "or-elimination",
    },
    {
        "question": "Why can't the Axiom rule directly prove A from the assumption list 'A ∨ (A ∧ B), A ∧ B'?",
        "options": [
            "Axiom only copies a whole comma-separated item, not inside ∧",
            "Gamma is not allowed to contain more than one formula",
            "And-Introduction must always be used before Axiom",
            "The variable B makes the assumption a contradiction",
        ],
        "correct_index": 0,
        "explanation": "Axiom matches an entire top-level assumption in Gamma; to extract A from inside A ∧ B you need And-Elimination first.",
        "concept": "comma vs ∧",
    },
    {
        "question": "What does proving '⊢ F' with nothing on the left of the turnstile mean?",
        "options": [
            "F is derivable with zero assumptions (a tautology)",
            "F is false under every valuation",
            "F requires Weakening before any rule applies",
            "F has no logical connectives",
        ],
        "correct_index": 0,
        "explanation": "An empty assumption list on the left of ⊢ means F holds purely from the laws of logic without needing any extra hypotheses.",
        "concept": "tautology & turnstile",
    },
]


async def make_quiz(transcript: str, seen: list[str] | None = None) -> dict:
    """One question for ONE student. `seen` = questions they already got, so we don't repeat them."""
    seen = seen or []
    if MOCK:
        bank = MOCK_LOGIC_QUIZZES if _is_logic_text(transcript) else MOCK_QUIZZES
        return bank[len(seen) % len(bank)]
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
        if _is_logic_text(excerpt):
            low = excerpt.lower()
            if "comma" in low or "and-elimination" in low or "extract" in low:
                return {
                    "title": "Comma vs. AND (∧) in proofs",
                    "said": "The lecturer explained why the Axiom rule cannot pull A directly out of A ∧ B.",
                    "explanation": "On the left of the turnstile (⊢), commas separate independent facts you already have loose on the table. An AND symbol (∧) glues two facts inside one compound package, so Axiom isn't allowed to reach inside—you use And-Elimination first to unpack it.",
                    "example": "Think of a comma as two separate keys in your pocket, while A ∧ B is two keys taped inside a sealed box: And-Elimination cuts the tape so Axiom can pick up key A.",
                    "check_yourself": "In 'P, Q ∧ R ⊢ Q', why do you need And-Elimination before Axiom, whereas 'P, Q ⊢ Q' finishes in one step?",
                }
            if "or-elim" in low or "socks" in low or "three" in low or "disjunction" in low:
                return {
                    "title": "Proof by cases (Or-Elimination)",
                    "said": "The lecturer walked through why Or-Elimination needs three subproofs above the line.",
                    "explanation": "When an assumption says 'X or Y', you don't know which side is true. To guarantee your goal A still holds, you show X ∨ Y is available, prove A assuming X, and prove that exact same goal A assuming Y.",
                    "example": "If your flat floods and your socks are either in the basket or the drawer, showing both spots are soaked proves your socks are wet without knowing where they are.",
                    "check_yourself": "When setting up the two case branches of Or-Elimination to prove goal A, what formula goes on the right of ⊢ in both branches?",
                }
            return {
                "title": "Working backwards with turnstile (⊢)",
                "said": "The lecturer showed how to build a natural deduction proof upwards from the goal.",
                "explanation": "Writing '⊢ Formula' with nothing on the left means proving the formula is a tautology with zero starting assumptions. Working backwards, the main connective on the right tells you which Intro rule to apply, or if it's just a single letter like A, you unpack an assumption on the left with an Elim rule.",
                "example": "To prove '(If it rains, bring a coat)' in English, you assume 'it rains' on the left and prove 'bring a coat' on the right—that is Implies-Introduction.",
                "check_yourself": "Why can't any Introduction rule produce a single atomic letter 'A' on the right-hand side of ⊢?",
            }
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
        combined = " ".join(w.get("text", "") for w in windows)
        if _is_logic_text(combined):
            moments = []
            for w in windows:
                low = w.get("text", "").lower()
                if "comma" in low or "and-elim" in low or "cannot use the axiom" in low:
                    moments.append({
                        "what_was_said": "Distinguishing comma-separated assumptions in Gamma from conjunction (A ∧ B) on the final branch.",
                        "why_confusing": "Students likely read both ',' and '∧' as 'and' in English, making it unclear why Axiom fails on A ∧ B.",
                        "suggested_fix": "Draw boxes around each comma-separated item on the board so students visually see A ∧ B is sealed inside one box until ∧-Elim opens it.",
                    })
                elif "gamma" in low or "weakening" in low:
                    moments.append({
                        "what_was_said": "Introducing context variable Gamma (Γ) inside the Axiom rule alongside Weakening.",
                        "why_confusing": "Greek meta-variables (Γ) mixed with object variables (A, B) likely felt abstract mid-derivation.",
                        "suggested_fix": "Label Γ in colour as 'unused extra facts' before mentioning Weakening so core students know Axiom handles leftovers automatically.",
                    })
                else:
                    moments.append({
                        "what_was_said": "Setting up the three premises of Or-Elimination and copying goal A into both case subproofs.",
                        "why_confusing": "Jumping from one goal line to three simultaneous subgoals above the bar likely overloaded working memory.",
                        "suggested_fix": "Lead with the 'Flooded Flat & Wet Socks' analogy first, then label the three branches (1: OR holds, 2: Case Left, 3: Case Right) before filling symbols.",
                    })
            return {
                "summary": "Confusion clustered on the 3-premise Or-Elimination split and on why comma-separated assumptions in Γ differ from conjunction (∧).",
                "moments": moments,
            }
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
        combined = f"{lead_in}\n{window}".lower()
        if _is_logic_text(combined):
            if "comma" in window.lower() or "and-elim" in window.lower() or "cannot use the axiom" in window.lower():
                return {
                    "summary": "Students likely blurred the meta-level comma (,) separating assumptions with the logical connective AND (∧) inside A ∧ B.",
                    "reexplain": [
                        "Why Axiom (Γ, A ⊢ A) only matches a whole comma-separated item, never a subformula",
                        "How ',' lists separate assumptions while '∧' locks A and B inside one compound formula",
                        "Using ∧-Elimination backwards to unpack A from A ∧ B in one step",
                    ],
                    "suggested_fix": "Use the 'Sealed Gift Box' analogy: draw a box around each comma-separated item so students see A ∧ B must be unboxed with ∧-Elim before Axiom can grab A.",
                }
            if "gamma" in window.lower() or "weakening" in window.lower():
                return {
                    "summary": "Students likely got tripped up by the Greek letter Gamma (Γ) and whether extra unused assumptions invalidate the Axiom rule.",
                    "reexplain": [
                        "What Γ stands for (any comma-separated list of extra assumptions, even empty)",
                        "Why Γ, A ⊢ A lets you ignore leftover assumptions without needing Weakening",
                    ],
                    "suggested_fix": "Circle the unused assumption in grey and call Γ 'the backpack of extra facts you don't need right now'.",
                }
            if "or-elim" in combined or "three" in window.lower() or "socks" in combined or "case" in combined:
                return {
                    "summary": "Students likely lost track when Or-Elimination split the proof into three separate premises and kept the same goal A on both branches.",
                    "reexplain": [
                        "Why an OR assumption requires proving the target conclusion holds under BOTH disjuncts",
                        "Why the right-hand goal stays A (not A ∧ B) in the second case branch",
                        "The 3-slot template of ∨-Elim before filling in any subproofs",
                    ],
                    "suggested_fix": "Lead with the 'Flooded Flat & Wet Socks' analogy: write 'Socks are wet' on both branches first, then swap in 'A'.",
                }
            if "signature" in combined or "atomic" in combined or "stuck" in combined:
                return {
                    "summary": "Students likely didn't see why having a bare variable A on the right of ⊢ rules out every Introduction rule.",
                    "reexplain": [
                        "How every Intro rule leaves its connective (∧, ∨, →) on the right of ⊢",
                        "Why an atomic goal A forces us to look left and pick an Elimination rule",
                    ],
                    "suggested_fix": "Point to the right of ⊢ and ask 'Where is the connective footprint?'—no footprint means an Elim rule unpacked an assumption.",
                }
            return {
                "summary": "Students likely found the jump from truth-table tautologies to assumption-free turnstile derivations (⊢ F) unfamiliar.",
                "reexplain": [
                    "What the turnstile (⊢) separates: assumptions on the left, goal on the right",
                    "Why an empty left-hand side means the formula is true with zero assumptions",
                    "Why working backwards from the main connective is easier than guessing forwards",
                ],
                "suggested_fix": "Show a 4-row truth table of all 1s right next to '⊢ Formula' and draw an equals sign between both ideas.",
            }
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


# ------------------------------------------------ knowledge graph slide agent
GRAPH_SYSTEM = """You convert university lecture slides into an interactive concept Knowledge Graph for the professor's live dashboard.
Rules:
- Create between 10 and 15 nodes: 1 central root node (category "core") for the lecture's overarching subject, 4-5 major section nodes, and 5-9 specific concept/rule/algorithm nodes.
- Keep each node `label` concise (2-5 words, max 32 chars) so it fits cleanly inside a circular mindmap node.
- `category` MUST be one of: "core", "syntax", "deduction", "rules", "semantics", "applications".
- `keywords`: 4-7 lowercase terms/phrases likely spoken aloud when the lecturer covers this node (used to match live 30s transcript buckets to this node).
- `pivot`: ONE concrete teaching analogy or 60-second whiteboard pivot if 40%+ of students get lost on this node (e.g. "Use the 'Traffic Jam' analogy to show greedy edge relaxation.").
- `edges`: 11-18 directed relationships connecting nodes (`source` id, `target` id, `label` 1-3 uppercase words like "DEFINES", "REQUIRES", "USES RULE", "EXTENDS"). Every node must be reachable.
JSON shape:
{"title": str,
 "nodes": [{"id": str, "label": str, "category": str, "summary": str, "slide_ref": str, "keywords": [str], "pivot": str}],
 "edges": [{"source": str, "target": str, "label": str}]}"""


def _assign_radial_layout(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Compute clean, non-overlapping circular ontology coordinates if not already set."""
    if all("x" in n and "y" in n for n in nodes):
        return nodes
    if not nodes:
        return nodes

    id_map = {n["id"]: n for n in nodes}
    root = next((n for n in nodes if n.get("category") == "core"), nodes[0])
    adj: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for e in edges:
        s, t = e.get("source", ""), e.get("target", "")
        if s in adj and t in adj and s != t:
            adj[s].append(t)
            adj[t].append(s)

    # BFS depth from root
    depth: dict[str, int] = {root["id"]: 0}
    q = [root["id"]]
    parent: dict[str, str] = {}
    while q:
        cur = q.pop(0)
        for nxt in adj.get(cur, []):
            if nxt not in depth:
                depth[nxt] = depth[cur] + 1
                parent[nxt] = cur
                q.append(nxt)
    for n in nodes:
        depth.setdefault(n["id"], 2)

    ring1 = [n for n in nodes if depth[n["id"]] == 1]
    ring2 = [n for n in nodes if depth[n["id"]] >= 2]

    pos: dict[str, list[float]] = {root["id"]: [0.0, 0.0]}
    parent_angles: dict[str, float] = {}
    for idx, n in enumerate(ring1):
        ang = (2 * math.pi * idx / max(1, len(ring1))) - math.pi / 2
        parent_angles[n["id"]] = ang
        pos[n["id"]] = [330.0 * math.cos(ang), 290.0 * math.sin(ang)]

    # Group outer nodes near their parent's angle
    by_parent: dict[str, list[dict]] = {}
    for n in ring2:
        p = parent.get(n["id"], root["id"])
        while p not in parent_angles and p in parent:
            p = parent[p]
        by_parent.setdefault(p, []).append(n)

    fallback_idx = 0
    for p_id, children in by_parent.items():
        base_ang = parent_angles.get(p_id, (2 * math.pi * fallback_idx / max(1, len(by_parent))))
        fallback_idx += 1
        spread = min(0.95, 0.34 * max(1, len(children)))
        for j, ch in enumerate(children):
            offset = 0.0 if len(children) == 1 else -spread / 2 + spread * (j / (len(children) - 1))
            ang = base_ang + offset
            r = 610.0 if depth[ch["id"]] == 2 else 790.0
            pos[ch["id"]] = [r * math.cos(ang), r * 0.88 * math.sin(ang)]

    # Gentle repulsion pass so no two circles ever collide
    ids = [n["id"] for n in nodes]
    min_dist = 205.0
    for _ in range(32):
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                dx = pos[b][0] - pos[a][0]
                dy = pos[b][1] - pos[a][1]
                d = math.hypot(dx, dy) or 0.01
                if d < min_dist:
                    push = (min_dist - d) * 0.5
                    ux, uy = dx / d, dy / d
                    if a != root["id"]:
                        pos[a][0] -= ux * push
                        pos[a][1] -= uy * push
                    if b != root["id"]:
                        pos[b][0] += ux * push
                        pos[b][1] += uy * push

    out = []
    for n in nodes:
        xy = pos.get(n["id"], [0.0, 0.0])
        out.append({**n, "x": round(xy[0], 1), "y": round(xy[1], 1)})
    return out


def preset_logic_graph(source: str = "111_chapter3_logic (1).pdf") -> dict:
    """Rich ontology Knowledge Graph for COMP11120 Ch. 3 Formal Logic Systems + 20m lecture audio."""
    nodes = [
        {
            "id": "logic-root",
            "label": "Formal Logic Systems",
            "category": "core",
            "slide_ref": "Ch. 3 Overview (pp. 1–3)",
            "summary": "Formal syntax, natural deduction proof trees, Boolean truth semantics, equivalences, normal forms, and first-order logic.",
            "keywords": ["formal logic", "logic systems", "chapter 3"],
            "pivot": "Frame logic as two complementary lenses on truth: symbol-pushing derivations (⊢) vs. truth-value tables ({0,1}).",
            "x": 0,
            "y": 0,
        },
        {
            "id": "prop-logic",
            "label": "Propositional Connectives",
            "category": "syntax",
            "slide_ref": "§3.1 Syntax (pp. 4–11)",
            "summary": "Atomic variables (A, B) combined with ¬, ∧, ∨, →, ↔ and binding precedence (¬ tightest, → and ↔ loosest).",
            "keywords": ["propositional formula", "connectives", "brackets", "(a or (a and b)) implies a", "subformulas"],
            "pivot": "Draw the formula's parse tree so students immediately spot which connective sits at the outermost root.",
            "x": -340,
            "y": -210,
        },
        {
            "id": "nat-deduction",
            "label": "Backward Natural Deduction",
            "category": "deduction",
            "slide_ref": "§3.2 Proofs (pp. 12–19)",
            "summary": "Building formal derivations upwards from the bottom goal rather than guessing forward steps blindly.",
            "keywords": ["natural deduction", "simplest cases", "working backwards", "copying and pasting", "derivation"],
            "pivot": "Use the 'Maze From the Exit' analogy: starting at the bottom goal narrows 10 possible rules down to 1.",
            "x": 20,
            "y": -320,
        },
        {
            "id": "implies-intro",
            "label": "Implication Intro (→ Intro)",
            "category": "rules",
            "slide_ref": "§3.2 Intro Rules (pp. 15–17)",
            "summary": "To prove Γ ⊢ P → Q backwards, move the 'if' hypothesis P onto the left of ⊢ and prove the 'then' goal Q on the right.",
            "keywords": ["implies-introduction", "implies intro", "if-part", "then-part", "left-hand side a or", "outer level"],
            "pivot": "Colour-code the 'IF' part green and slide it across the turnstile ⊢ into the assumptions column live on the board.",
            "x": 360,
            "y": -250,
        },
        {
            "id": "elim-strategy",
            "label": "Intro Signatures vs. Elim",
            "category": "deduction",
            "slide_ref": "§3.2 Strategy (pp. 20–23)",
            "summary": "Every Intro rule leaves its connective on the right of ⊢; when the right side is an atomic letter A, an Elim rule is guaranteed.",
            "keywords": ["atomic a", "signature", "elimination rule", "elim rule", "double-negation", "stuck"],
            "pivot": "Use the 'Crime-Scene Footprint' analogy: Intro rules always leave a connective footprint on the right; bare 'A' has none.",
            "x": 420,
            "y": -20,
        },
        {
            "id": "or-elim",
            "label": "Or-Elim (∨ Elim) & Cases",
            "category": "rules",
            "slide_ref": "§3.2 Case Split (pp. 21–24)",
            "summary": "The 3-premise rule: establish P ∨ Q, then prove the exact same target conclusion A holds under case P and under case Q.",
            "keywords": ["or-elimination", "or-elim", "three separate premises", "socks", "flooded", "washing basket", "case branch", "downstairs"],
            "pivot": "Use the 'Flooded Flat & Wet Socks' analogy: if socks are in the basket OR drawer and BOTH are soaked, the socks must be wet.",
            "x": 580,
            "y": 210,
        },
        {
            "id": "axiom-gamma",
            "label": "Axiom Rule & Context Γ",
            "category": "rules",
            "slide_ref": "§3.2 Structural (pp. 13, 25)",
            "summary": "Γ, A ⊢ A closes a proof branch immediately whenever the whole goal formula A appears as a comma-separated item in Γ.",
            "keywords": ["axiom rule", "gamma", "greek letter", "entire comma-separated", "standalone", "left subproof"],
            "pivot": "Call Γ 'the backpack of extra facts'—Axiom grabs a whole item loose in the backpack and ignores leftovers.",
            "x": 270,
            "y": 310,
        },
        {
            "id": "weakening",
            "label": "Weakening & Context Match",
            "category": "rules",
            "slide_ref": "§3.2 Weakening (pp. 25–26)",
            "summary": "Inserts missing extra assumptions into Γ so two separately proved branches share identical assumption lists when combined.",
            "keywords": ["weakening", "gammas must be identical", "plug them together", "extension exercises"],
            "pivot": "Compare Weakening to adding a blank guest pass so two group tickets list the exact same party names.",
            "x": 40,
            "y": 480,
        },
        {
            "id": "and-elim",
            "label": "Comma (,) vs. ∧ & And-Elim",
            "category": "rules",
            "slide_ref": "§3.2 Conjunction (pp. 14, 24)",
            "summary": "Commas separate loose assumptions in Γ whereas ∧ binds formulas together; ∧-Elimination is required to unpack A from A ∧ B.",
            "keywords": ["comma behaves differently", "and-elimination", "cannot use the axiom", "friendly one", "extract a piece", "∧ elim"],
            "pivot": "Use the 'Sealed Gift Box' analogy: a comma means two separate items on the table; A ∧ B is taped inside one box needing ∧-Elim scissors.",
            "x": 490,
            "y": 470,
        },
        {
            "id": "tautology",
            "label": "Tautology & Turnstile (⊢ A)",
            "category": "semantics",
            "slide_ref": "§3.2–3.3 Validity (pp. 18, 31)",
            "summary": "A formula is a tautology if its truth-table column is all 1s—equivalently, ⊢ A is provable with zero assumptions on the left.",
            "keywords": ["tautology", "sideways t", "turnstile", "no assumptions on the left", "proof-theoretic"],
            "pivot": "Write 'All 1s in Truth Table = Empty Left Side of ⊢' side-by-side on a 2-variable example so both definitions click.",
            "x": -230,
            "y": 240,
        },
        {
            "id": "semantics",
            "label": "Boolean Semantics & Tables",
            "category": "semantics",
            "slide_ref": "§3.3 Semantics (pp. 27–38)",
            "summary": "Valuations map variables to {0, 1}; truth tables, power-set semantics, and logic gates evaluate compound formulas.",
            "keywords": ["boolean semantics", "truth table", "only ones", "valuation", "manageable"],
            "pivot": "Walk one row of a truth table like an electrical circuit with 0/1 switches feeding AND/OR gates.",
            "x": -520,
            "y": 90,
        },
        {
            "id": "equivalence",
            "label": "Equivalence & De Morgan",
            "category": "semantics",
            "slide_ref": "§3.4 Equivalence (pp. 39–45)",
            "summary": "Semantic equivalence (A ≡ B), De Morgan's laws ¬(A ∧ B) ≡ ¬A ∨ ¬B, distributivity, and subformula replacement.",
            "keywords": ["equivalence", "de morgan", "distributive", "replacement"],
            "pivot": "Demonstrate De Morgan's law with everyday English: 'Not (both rain and snow)' means 'Either no rain, or no snow'.",
            "x": -560,
            "y": 350,
        },
        {
            "id": "normal-forms",
            "label": "CNF & DNF Normal Forms",
            "category": "applications",
            "slide_ref": "§3.5 Normal Forms (pp. 46–52)",
            "summary": "Four-step algebraic normalisation into Conjunctive Normal Form (AND of ORs) and Disjunctive Normal Form (OR of ANDs).",
            "keywords": ["cnf", "dnf", "conjunctive normal", "disjunctive normal", "normalisation"],
            "pivot": "Relate DNF directly to picking the '1' rows of a truth table—each '1' row gives one AND clause!",
            "x": -290,
            "y": 490,
        },
        {
            "id": "fol-quantifiers",
            "label": "First-Order Quantifiers (∀, ∃)",
            "category": "applications",
            "slide_ref": "§3.6 First-Order (pp. 53–61)",
            "summary": "Predicates, terms, functions, universal (∀x) and existential (∃x) quantifiers, and quantifier negation duality.",
            "keywords": ["first-order", "quantifier", "forall", "exists", "predicate"],
            "pivot": "Treat ∀x as a giant AND over everyone in the room, and ∃x as a giant OR over everyone in the room.",
            "x": -620,
            "y": -180,
        },
    ]
    edges = [
        {"id": "e1", "source": "logic-root", "target": "prop-logic", "label": "DEFINES SYNTAX"},
        {"id": "e2", "source": "logic-root", "target": "nat-deduction", "label": "PROOF SYSTEM"},
        {"id": "e3", "source": "logic-root", "target": "semantics", "label": "INTERPRETS"},
        {"id": "e4", "source": "logic-root", "target": "tautology", "label": "VALIDATES"},
        {"id": "e5", "source": "prop-logic", "target": "fol-quantifiers", "label": "EXTENDS TO"},
        {"id": "e6", "source": "prop-logic", "target": "implies-intro", "label": "OUTER →"},
        {"id": "e7", "source": "nat-deduction", "target": "implies-intro", "label": "BACKWARD STEP"},
        {"id": "e8", "source": "implies-intro", "target": "elim-strategy", "label": "LEAVES ATOMIC A"},
        {"id": "e9", "source": "elim-strategy", "target": "or-elim", "label": "UNPACKS ∨"},
        {"id": "e10", "source": "or-elim", "target": "axiom-gamma", "label": "LEFT CASE"},
        {"id": "e11", "source": "or-elim", "target": "and-elim", "label": "RIGHT CASE"},
        {"id": "e12", "source": "and-elim", "target": "axiom-gamma", "label": "CLOSES BY"},
        {"id": "e13", "source": "axiom-gamma", "target": "weakening", "label": "ABSORBS Γ"},
        {"id": "e14", "source": "semantics", "target": "tautology", "label": "ALL 1s COLUMN"},
        {"id": "e15", "source": "tautology", "target": "nat-deduction", "label": "EMPTY Γ ⊢ A"},
        {"id": "e16", "source": "semantics", "target": "equivalence", "label": "SAME TABLE"},
        {"id": "e17", "source": "equivalence", "target": "normal-forms", "label": "REWRITES TO"},
    ]
    return {"title": "COMP11120 Ch. 3 — Formal Logic Systems", "source": source, "nodes": nodes, "edges": edges}


def preset_hashtables_graph(source: str = "Hash Tables Lecture Slides") -> dict:
    """Ontology Knowledge Graph matching the bundled 3-minute Hash Tables demo lecture."""
    nodes = [
        {
            "id": "ht-root",
            "label": "Hash Tables",
            "category": "core",
            "slide_ref": "Slide 1–2",
            "summary": "Key-value data structure mapping keys to array slots via a hash function for fast average O(1) dictionary operations.",
            "keywords": ["hash tables", "data structures", "look things up by a key", "recap"],
            "pivot": "Compare a hash table to numbered pigeonholes labelled by surname initials rather than one giant unsorted pile.",
            "x": 0,
            "y": 0,
        },
        {
            "id": "ht-func",
            "label": "Hash Functions & Slots",
            "category": "syntax",
            "slide_ref": "Slide 3–5",
            "summary": "Deterministic function turning a key (like 'alice') into an integer slot index uniformly across the backing array.",
            "keywords": ["hash function", "slot 7", "alice", "deterministic", "uniformly", "dict", "hashmap"],
            "pivot": "Walk 'alice' -> number -> modulo array size on a 10-slot whiteboard array so the jump feels concrete.",
            "x": -330,
            "y": -200,
        },
        {
            "id": "ht-o1",
            "label": "Average O(1) Lookup",
            "category": "semantics",
            "slide_ref": "Slide 6",
            "summary": "Computing the slot directly avoids scanning the array, achieving constant-time lookup on average.",
            "keywords": ["constant time", "o of 1 on average", "jump to it", "without scanning"],
            "pivot": "Contrast walking 1,000 lockers one-by-one O(n) vs. walking straight to locker #7 O(1).",
            "x": -370,
            "y": 130,
        },
        {
            "id": "ht-collision",
            "label": "Hash Collisions",
            "category": "deduction",
            "slide_ref": "Slide 7–8",
            "summary": "Occurs inevitably (Pigeonhole Principle) when two distinct keys hash to the exact same array slot.",
            "keywords": ["collision", "same slot", "more possible keys than slots"],
            "pivot": "Use the 'Birthday Paradox / Hotel Room 7' analogy: two guests assigned Room 7 forces a clear tie-break rule.",
            "x": 270,
            "y": -210,
        },
        {
            "id": "ht-chaining",
            "label": "Separate Chaining",
            "category": "rules",
            "slide_ref": "Slide 9–10",
            "summary": "Each array slot stores a short linked list (bucket); colliding keys append to that slot's list.",
            "keywords": ["chaining", "linked list", "appended to the list", "lab this week"],
            "pivot": "Hotel Room 7 analogy (Part 1): Chaining puts a bunk bed inside Room 7 so both guests stay at #7.",
            "x": 560,
            "y": -270,
        },
        {
            "id": "ht-probing",
            "label": "Open Addressing & Probing",
            "category": "rules",
            "slide_ref": "Slide 11–13",
            "summary": "Keeps all items in the array itself; on collision, probes for the next open slot (linear, quadratic, or double hashing).",
            "keywords": ["open addressing", "probe", "linear probing", "quadratic probing", "double hashing"],
            "pivot": "Hotel Room 7 analogy (Part 2): Probing sends the second guest down the hall to check Room 8, then Room 9.",
            "x": 580,
            "y": -20,
        },
        {
            "id": "ht-load",
            "label": "Load Factor (α = n / m)",
            "category": "semantics",
            "slide_ref": "Slide 14–15",
            "summary": "Ratio of stored items n to array slots m; keeping α ≤ 0.7 bounds chain length and probe clustering.",
            "keywords": ["load factor", "alpha", "0.7", "divided by the number of slots"],
            "pivot": "Use the 'Motorway Traffic Density' analogy: at 50% capacity cars cruise freely; past 80% tiny collisions cause tailbacks.",
            "x": 280,
            "y": 230,
        },
        {
            "id": "ht-rehash",
            "label": "Resize & Rehash (2×)",
            "category": "applications",
            "slide_ref": "Slide 16–17",
            "summary": "When α crosses threshold, allocate a 2× larger array and recompute every key's slot (since index mod m changes).",
            "keywords": ["resize", "doubling the array", "rehash every key"],
            "pivot": "Show why `hash % 4` vs `hash % 8` moves key 5 from slot 1 to slot 5—copying without rehashing loses the key!",
            "x": 530,
            "y": 380,
        },
        {
            "id": "ht-amortised",
            "label": "Amortised O(1) Insert",
            "category": "applications",
            "slide_ref": "Slide 18",
            "summary": "Although one rehash costs O(n), doubling capacity spreads that cost across n cheap inserts for O(1) amortised time.",
            "keywords": ["amortised", "rehash costs o of n", "spread out"],
            "pivot": "Piggy-bank analogy: drop 2 coins on every cheap insert so the piggy bank already pays for the rare 2× move.",
            "x": 140,
            "y": 460,
        },
        {
            "id": "ht-worst",
            "label": "Worst-Case O(n) Pitfall",
            "category": "semantics",
            "slide_ref": "Slide 19",
            "summary": "A poor or adversarial hash function dumping all n keys into one slot degrades lookups to linear O(n) list scans.",
            "keywords": ["worst case", "degrades to o of n", "every key lands in the same slot"],
            "pivot": "Sketch all 6 keys piled into slot 0—your hash table has secretly turned back into a plain linked list.",
            "x": -220,
            "y": 390,
        },
    ]
    edges = [
        {"id": "h1", "source": "ht-root", "target": "ht-func", "label": "INDEXED BY"},
        {"id": "h2", "source": "ht-func", "target": "ht-o1", "label": "ENABLES"},
        {"id": "h3", "source": "ht-root", "target": "ht-collision", "label": "INEVITABLE"},
        {"id": "h4", "source": "ht-collision", "target": "ht-chaining", "label": "RESOLVED BY"},
        {"id": "h5", "source": "ht-collision", "target": "ht-probing", "label": "RESOLVED BY"},
        {"id": "h6", "source": "ht-collision", "target": "ht-load", "label": "GOVERNED BY"},
        {"id": "h7", "source": "ht-load", "target": "ht-rehash", "label": "α > 0.7 TRIGGERS"},
        {"id": "h8", "source": "ht-rehash", "target": "ht-amortised", "label": "YIELDS"},
        {"id": "h9", "source": "ht-func", "target": "ht-worst", "label": "BAD HASH CAUSES"},
        {"id": "h10", "source": "ht-worst", "target": "ht-o1", "label": "CONTRASTS"},
    ]
    return {"title": "Hash Tables & Collision Resolution", "source": source, "nodes": nodes, "edges": edges}


def preset_dijkstra_graph(source: str = "Shortest Paths Slides.pdf") -> dict:
    """Ontology Knowledge Graph if a user uploads a Dijkstra / Shortest-Paths slide deck."""
    nodes = [
        {"id": "sp-root", "label": "Shortest Path Algorithms", "category": "core", "slide_ref": "Slides 1–3", "summary": "Finding minimum-weight paths in weighted directed and undirected graphs.", "keywords": ["shortest path", "weighted graph", "pathfinding"], "pivot": "Frame as GPS route planning where edge weights are travel minutes, not hop counts."},
        {"id": "sp-weights", "label": "Weighted Graphs & Non-Negativity", "category": "syntax", "slide_ref": "Slides 4–7", "summary": "Adjacency lists with non-negative edge weights w(u, v) ≥ 0.", "keywords": ["edge weight", "non-negative", "adjacency"], "pivot": "Show one negative toll-rebate edge breaking greedy finality so w ≥ 0 feels essential."},
        {"id": "sp-relax", "label": "Edge Relaxation", "category": "rules", "slide_ref": "Slides 8–12", "summary": "Testing whether going via u improves the best-known distance d[v] > d[u] + w(u, v).", "keywords": ["relax", "relaxation", "tentative distance", "d[v]"], "pivot": "Call d[v] a 'price tag in pencil'—relaxation erases it whenever a cheaper connecting flight appears."},
        {"id": "sp-dijkstra", "label": "Dijkstra's Algorithm", "category": "deduction", "slide_ref": "Slides 13–24", "summary": "Greedy frontier expansion repeatedly locking in the unvisited vertex with minimum tentative distance.", "keywords": ["dijkstra", "greedy", "visited set", "frontier"], "pivot": "Use the 'Traffic Jam' analogy: expanding waves of cars reach the nearest uncongested intersections first."},
        {"id": "sp-pq", "label": "Min-Heap Priority Queue", "category": "applications", "slide_ref": "Slides 25–32", "summary": "Using extract-min and decrease-key on a binary/Fibonacci heap for O((V + E) log V) runtime.", "keywords": ["priority queue", "min-heap", "decrease-key", "log v"], "pivot": "Trace a 4-item min-heap table alongside the graph so students see why linear scan O(V²) is avoided."},
        {"id": "sp-invariant", "label": "Greedy Correctness Proof", "category": "semantics", "slide_ref": "Slides 33–40", "summary": "Proof by contradiction that when u is extracted with min d[u], no detour via unvisited nodes can be shorter.", "keywords": ["correctness", "invariant", "detour", "contradiction"], "pivot": "Draw the settled cloud S and ask: if every road leaving S costs ≥ 0, how could leaving S and coming back ever save time?"},
        {"id": "sp-bellman", "label": "Bellman-Ford Contrast", "category": "applications", "slide_ref": "Slides 41–50", "summary": "Handles negative weights in O(VE) time by relaxing all edges V − 1 times and detecting negative cycles.", "keywords": ["bellman-ford", "negative cycle", "negative weight"], "pivot": "Contrast fast greedy GPS (Dijkstra) vs. cautious accountant re-checking every ledger row (Bellman-Ford)."},
    ]
    edges = [
        {"id": "d1", "source": "sp-root", "target": "sp-weights", "label": "MODELS"},
        {"id": "d2", "source": "sp-root", "target": "sp-dijkstra", "label": "SOLVED BY"},
        {"id": "d3", "source": "sp-weights", "target": "sp-dijkstra", "label": "REQUIRES w ≥ 0"},
        {"id": "d4", "source": "sp-dijkstra", "target": "sp-relax", "label": "REPEATEDLY RUNS"},
        {"id": "d5", "source": "sp-dijkstra", "target": "sp-pq", "label": "ACCELERATED BY"},
        {"id": "d6", "source": "sp-dijkstra", "target": "sp-invariant", "label": "JUSTIFIED BY"},
        {"id": "d7", "source": "sp-weights", "target": "sp-bellman", "label": "IF NEGATIVE"},
    ]
    return {"title": "Graph Shortest Paths & Dijkstra", "source": source, "nodes": _assign_radial_layout(nodes, edges), "edges": edges}


def _extract_dynamic_graph_from_pdf_text(slide_text: str, filename: str) -> dict:
    """Fallback under MOCK_AI=1 for ANY arbitrary uploaded PDF: parses real slide headings & terms."""
    clean_title = re.sub(r"\.(pdf|txt|md)$", "", filename, flags=re.I).replace("_", " ").strip() or "Lecture Slides"
    chunks = [c.strip() for c in re.split(r"---\s*Slide\s+\d+\s*---|\n{2,}", slide_text) if len(c.strip()) > 25]

    categories = ["syntax", "deduction", "rules", "semantics", "applications"]
    seen_labels: set[str] = set()
    extracted: list[dict] = []

    stop = {"the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "have", "has", "not", "can", "will", "what", "when", "where", "which", "slide", "page", "chapter", "section", "lecture", "university", "example", "exercise"}

    for idx, ch in enumerate(chunks):
        lines = [ln.strip(" •-*#\t") for ln in ch.splitlines() if ln.strip()]
        if not lines:
            continue
        heading = lines[0]
        if len(heading) > 42:
            heading = " ".join(heading.split()[:5])
        if len(heading) < 4 or heading.lower() in seen_labels or heading.isdigit():
            continue
        seen_labels.add(heading.lower())
        words = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9\-]{3,}", ch) if w.lower() not in stop]
        freq: dict[str, int] = {}
        for w in words:
            freq[w] = freq.get(w, 0) + 1
        kws = [w for w, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:6]]
        body_preview = " ".join(lines[1:3])[:160] or heading
        extracted.append({
            "id": f"topic-{len(extracted)+1}",
            "label": heading[:32],
            "category": categories[len(extracted) % len(categories)],
            "slide_ref": f"Section {idx + 1}",
            "summary": body_preview,
            "keywords": kws or [heading.lower()],
            "pivot": f"Pause for a 60-second concrete worked example on '{heading[:28]}' before introducing the next slide's notation.",
        })
        if len(extracted) >= 11:
            break

    if not extracted:
        return preset_logic_graph(filename)

    root = {
        "id": "root-0",
        "label": clean_title[:32],
        "category": "core",
        "slide_ref": "Overview",
        "summary": f"Interactive concept map generated from {filename} ({len(extracted)} key topics).",
        "keywords": [w.lower() for w in clean_title.split() if len(w) > 2][:5],
        "pivot": f"Anchor '{clean_title[:24]}' to a real-world mental model before diving into formal definitions.",
    }
    all_nodes = [root] + extracted
    edges: list[dict] = []
    primary_count = min(5, len(extracted))
    for i in range(primary_count):
        edges.append({"id": f"de-{i}", "source": "root-0", "target": extracted[i]["id"], "label": "COVERS"})
    for i in range(primary_count, len(extracted)):
        parent_node = extracted[(i - primary_count) % primary_count]
        edges.append({"id": f"de-{i}", "source": parent_node["id"], "target": extracted[i]["id"], "label": "BUILDS ON"})

    return {
        "title": clean_title,
        "source": filename,
        "nodes": _assign_radial_layout(all_nodes, edges),
        "edges": edges,
    }


async def build_knowledge_graph(slide_text: str, filename: str = "slides.pdf") -> dict:
    """Build a React Flow knowledge graph from extracted lecture slide text."""
    low = f"{filename}\n{slide_text[:12000]}".lower()
    if MOCK:
        if any(k in low for k in ("propositional", "natural deduction", "turnstile", "tautology", "111_chapter3", "renate schmidt", "razavi")):
            return preset_logic_graph(filename)
        if any(k in low for k in ("dijkstra", "shortest path", "bellman-ford", "edge relaxation")):
            return preset_dijkstra_graph(filename)
        if any(k in low for k in ("hash table", "open addressing", "separate chaining", "load factor")):
            return preset_hashtables_graph(filename)
        return _extract_dynamic_graph_from_pdf_text(slide_text, filename)

    excerpt = slide_text[:34000]
    raw = await _ask_json(SMART, GRAPH_SYSTEM, f"Filename: {filename}\n\nExtracted slide text:\n{excerpt}", 2400)
    nodes = raw.get("nodes") or []
    edges_in = raw.get("edges") or []
    if len(nodes) < 3:
        return _extract_dynamic_graph_from_pdf_text(slide_text, filename)
    valid_ids = {str(n.get("id")) for n in nodes if n.get("id")}
    edges = [
        {"id": f"ce-{i}", "source": str(e["source"]), "target": str(e["target"]), "label": str(e.get("label", "RELATES TO"))[:22].upper()}
        for i, e in enumerate(edges_in)
        if str(e.get("source")) in valid_ids and str(e.get("target")) in valid_ids
    ]
    cleaned_nodes = [
        {
            "id": str(n["id"]),
            "label": str(n.get("label", n["id"]))[:34],
            "category": n.get("category") if n.get("category") in {"core", "syntax", "deduction", "rules", "semantics", "applications"} else "syntax",
            "slide_ref": str(n.get("slide_ref", "")),
            "summary": str(n.get("summary", "")),
            "keywords": [str(k).lower() for k in (n.get("keywords") or [])][:8],
            "pivot": str(n.get("pivot", "Walk through one concrete example on the board before continuing.")),
        }
        for n in nodes
        if n.get("id")
    ]
    return {
        "title": str(raw.get("title") or filename),
        "source": filename,
        "nodes": _assign_radial_layout(cleaned_nodes, edges),
        "edges": edges,
    }
