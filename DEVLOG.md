# DEVLOG: Signal (GreatUniHack 2026)

**Read this first.** The team works on this repo one person at a time, each with their own AI agent. This file is the shared memory.

## Rules for whoever works next (human or agent)
1. Read "Current state" and the last few log entries before touching code.
2. When you finish a session, **append an entry to the Log at the bottom** (date, who, what changed, what's next) and update "Current state" and "Next tasks" so they stay true.
3. Don't claim something works unless you actually ran it. Mark things TESTED or UNTESTED.
4. Test with `MOCK_AI=1` first (no API keys needed), then with real keys.
5. Keep it simple: in-memory state, no database, no accounts, one lecture per code. Hackathon scope.

## What this is
Students tap **"I'm lost"** to bookmark a confusing moment in a lecture. The lecturer sees a live heatmap of where the room got lost. Students can quiz themselves at any time ("Test myself" button), with a question generated from the live transcript; the lecturer sees anonymous class results. After the lecture each student gets a personal catch-up page, and the lecturer gets AI-suggested fixes for the most-bookmarked moments.

## Hackathon context
- Event: GreatUniHack 2026 (7 Nov 2026). Team of 5. About 3.5 hours to build.
- Sponsor track chosen: **Reply, "AI on Campus"**. Judged on three levels: (1) the idea, pitched in 60 seconds, a real problem in teaching, learning or assessment; (2) a working AI agent prototype; (3) optional "go further" (multi-agent system, knowledge graph, launch campaign).
- Also entered in the **Overall** challenge, which automatically judges for the **ElevenLabs** and **n8n** prizes too (same project, no second submission).
- Our "go further" story: three cooperating agents (quiz writer, explainer, lecturer-insight advisor).
- Pitch line: "Students get lost silently and lecturers never find out when. We show the lecturer exactly when, and every student catches up afterwards without missing the next five minutes."

## Architecture
- `backend/main.py`: FastAPI. All state in memory (`LECTURES` dict). REST endpoints plus one WebSocket per lecture that only sends `{"type":"changed"}` pings; clients refetch on ping and also poll every 2-2.5s as a fallback.
- `backend/agents.py`: three agents, each returns a dict. Quiz uses `MODEL_FAST` (default `claude-haiku-5-5`); explainer and insights use `MODEL_SMART` (default `claude-sonnet-5-5`). If `ANTHROPIC_API_KEY` is missing or `MOCK_AI=1`, canned answers are returned.
- `backend/demo_transcript.json`: bundled 3-minute lecture (hash tables) used by the demo replay (`POST /api/lectures/{id}/demo`), which also adds clearly **simulated** students.
- `frontend/`: Vite + React + TypeScript. Routes: `/` home, `/lecturer/:id`, `/join/:id` (student), `/digest/:id` (catch-up notes). Vite proxies `/api` and `/ws` to port 8000, so one tunnel URL serves everything.
- Live transcription: lecturer browser -> ElevenLabs Scribe v2 Realtime (`useScribe` from `@elevenlabs/react`) using a single-use token from `GET /api/scribe-token` -> each committed sentence posted to `/api/lectures/{id}/segments`.
- Time model: `elapsed` = seconds since the lecture started (`Lecture.elapsed()`, scaled by `speed` for fast demo replays). Heatmap buckets are 30 s. Bookmarks store `t` = elapsed at tap.

## Design decisions (and why)
- **Bookmark, don't recap live.** The explanation arrives after the lecture so students never read while the lecturer moves on.
- **Transcript text only, no raw audio stored.** Simpler and a stronger privacy story.
- **Quizzes are student-triggered only (no lecturer quiz button).** `POST /quiz/self` writes one personal question for that student; the correct answer is only returned by `POST /quiz/self/answer`. A student can only answer their own quiz, first answer wins, 3 s cooldown between requests, and the agent is told which questions that student already saw.
- **True bookmark counts come from the server, never the model.** Insights overwrite `students_lost` with real counts.
- **Simulated students are always labelled** in the lecturer UI (`simulated_total` chip). Don't remove that: the demo must not pass fake data off as real.
- Double-tap protection: a student's bookmarks within 15 s of their previous one are ignored.

## Current state (update me)
TESTED (sandbox, Nov 2026):
- Backend end to end with `MOCK_AI=1`: create lecture, demo replay (including running the demo twice in a row: no duplicate lines), bookmark, student self-quiz and answer, state/heatmap buckets, digest, insights, and the new `POST /api/lectures/{id}/moments/summary` (normal call, empty window -> 400, bad range -> 400).
- Frontend `npm run build` (TypeScript strict type-check passes) and the Vite dev server proxying `/api` to the backend, including the new endpoint.

UNTESTED:
- Live mic transcription with a real `ELEVENLABS_API_KEY` (Scribe).
- Real Claude calls for the four agents (prompts and JSON parsing are written but unproven on real output; this includes the new moment-summary prompt).
- The UI in an actual browser (the flat restyle, the live clock, the heatmap "now" marker, the moment-summary panel), especially the student page on a phone through a tunnel.
- Behaviour on venue Wi-Fi.

## Known gaps and risks
- State is in memory: restarting the backend loses the lecture.
- "Test myself" needs transcript text first; it shows an error toast if nothing has been said yet. It also works after the lecture ends (uses the last 3 minutes).
- Heatmap counts unique students per 30 s bucket; very long lectures make many thin bars.
- Single lecturer per lecture; no auth. Anyone with the code can join.
- Demo replay at real time takes 3 minutes; use the 6x option for dry runs. The demo does NOT end the lecture by itself (so students can still bookmark and take a quiz at the end); press End lecture.
- Starting a lecture or a demo now wipes the previous transcript, bookmarks, self-quizzes and summaries for that code.
- Moment summary is cached per (window, number of students); it refreshes when more students bookmark that window.

## Next tasks (priority order)
1. Run it with real keys. Fix whatever breaks (see UNTESTED above). Check the moment-summary output on the real demo transcript.
2. Test with 2-3 phones through a tunnel (`cloudflared tunnel --url http://localhost:5173`, then paste the URL in the box under the QR code).
3. Look at the new UI in a real browser and on a phone; tweak colours in `:root` of `styles.css` if needed.
4. Tune agent prompts on the real demo transcript until quizzes, explanations and summaries are consistently good.
5. Pitch: write the 60-second script, rehearse 3 times, record a backup demo video.
6. Submit on Devpost with 20+ minutes to spare; opt in to the GreatUniHack challenge.
7. Stretch (only after the above): n8n webhook on lecture end that emails each student their digest (cheap shot at the n8n prize); ElevenLabs text-to-speech to read the digest aloud.

## Log
(Newest at the bottom. Format: `### YYYY-MM-DD HH:MM, who/agent`, then what changed, what's next.)

### 2026-11-07, Claude (initial scaffold)
- Created the whole project from scratch: FastAPI backend with three agents and demo replay; React/Vite frontend with lecturer, student and digest pages; README with run steps.
- Verified in a sandbox as listed under "Current state" (TESTED). Did not test mic, real API calls or phones.
- Dev environment note: team uses WSL2 Ubuntu; Node/npm must be installed first (see README).
- Next: someone runs it with real keys (task 1 above).

### 2026-11-07, human (first run on WSL2)
   - Set up WSL2 + node via nvm. Backend runs (uvicorn on 8000). Frontend runs.
    - Not tested: anything with real API keys, mic, phones.
    next is to fix things: To fix: Lecturer should have some way to see a summary of what needs reexplaining about when  students bookmarked. So when the professor clicks on one of the charts, the AI will look at all the bookmarks related to that chart and will create a summary for professor on exactly what to “re-explain” for that specific segment.
    UI looks too ai generated and ugly right now
   - The transcript lines are duplicated  once (displayed twice) right now for every time stamp sometimes. Maybe only when you click run demo twice
   - There needs to be  a live timer somewhere to display the current time of the lecture and show what time of the lecture we are at. 

    - make sure next developer knows all the steps to set up app on their machine too

### 2026-11-07, Claude (first-run fixes: clock, UI, moment summary, duplicate lines, setup docs)
- **Duplicate transcript lines (root cause):** `/demo` cleared the lecture but never stopped the previous `_replay` task, so running the demo twice ran two replays that both appended segments. Added `Lecture.run_id` and `Lecture.reset()`; `/demo`, `/start` and `/end` bump it and a replay quits if its id is stale. `/segments` also ignores an exact repeat of the previous line within 3 s. The frontend still hides exact duplicates as a safety net.
- **Moment summary:** new `POST /api/lectures/{id}/moments/summary` (body `{start, end}`) in `main.py` plus a `moment_summary` agent in `agents.py` (SMART model, mock answer under `MOCK_AI=1`). It uses the bookmarks in that window (unique students, true count from the server) and timestamped transcript for the window and the 45 s before it. Returns `{students_lost, summary, reexplain[], suggested_fix}`. Lecturer page: click a bar, then "What should I re-explain?".
- **Live clock:** the backend now also returns `speed` in the lecturer state; the lecturer header clock ticks locally at that speed and re-syncs on every poll (so it stays right after a page refresh during a 3x/6x demo). The heatmap marks the current bucket.
- **UI:** restyled (`styles.css`, `Heatmap.tsx`): flat, one accent colour, serif headings, no gradients/glow/emoji. Class names unchanged.
- Starting a lecture or demo now clears the old local results too; "Run demo" while live asks for confirmation before restarting.
- **README:** added first-time setup for WSL2/Ubuntu (python3, venv, nvm, cloudflared) and a troubleshooting table.
- Tested: see "Current state". NOT tested: real API keys, real mic, a real browser, phones.
- Next: tasks 1 and 2 above.


### 2026-11-07, Claude (student-only quizzes)
- Removed the lecturer's "Quiz now" button and the lecturer-fired shared quiz entirely (backend routes `POST /quiz` and `POST /answers`, `quizzes` in lecturer state, `active_quiz` in student state, the student quiz overlay with the 25 s timer).
- New student button **Test myself**, beside the big "I'm lost" button on the student page (also on the "Lecture finished" card). It opens a personal quiz overlay: question, 4 options, then right/wrong plus explanation, with "Another question" and "Back to the lecture".
- Backend: `POST /api/lectures/{id}/quiz/self` (body `{student_id}`; returns `{id, question, options, concept}` with no answer) and `POST /api/lectures/{id}/quiz/self/answer` (body `{student_id, quiz_id, choice}`; returns `{correct, correct_index, explanation}`). `make_quiz(transcript, seen)` in `agents.py` now takes the questions that student already got so it doesn't repeat them; the mock cycles through 3 questions.
- Lecturer page: the "Live quiz" card is now **Student self-checks**: anonymous % correct plus the concepts students miss most. Backend field `self_checks` in the lecturer state: `{requested, answered, pct_correct, missed[{concept, answered, missed}]}`.
- Tested: backend with `MOCK_AI=1` (before the lecture starts -> 409, answer not leaked, 3 s cooldown -> 429, another student can't answer your quiz -> 404, second answer ignored, a second question differs, class stats correct, old quiz routes -> 404, bookmark/digest/insights/moment-summary still work, works after End). Frontend `npm run build` passes. NOT tested: a real browser or phone (so the button layout beside "I'm lost" on a small screen is unchecked), real Claude calls.
- Next: same as before (real keys, phones). Also eyeball the "Test myself" button width on a small phone.
