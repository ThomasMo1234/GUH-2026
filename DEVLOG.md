# DEVLOG: Signal (GreatUniHack 2026)

**Read this first.** The team works on this repo one person at a time, each with their own AI agent. This file is the shared memory.

## Rules for whoever works next (human or agent)
1. Read "Current state" and the last few log entries before touching code.
2. When you finish a session, **append an entry to the Log at the bottom** (date, who, what changed, what's next) and update "Current state" and "Next tasks" so they stay true.
3. Don't claim something works unless you actually ran it. Mark things TESTED or UNTESTED.
4. Test with `MOCK_AI=1` first (no API keys needed), then with real keys.
5. Keep it simple: in-memory state, no database, no accounts, one lecture per code. Hackathon scope.

## What this is
Students tap **"I'm lost"** to bookmark a confusing moment in a lecture. The lecturer sees a live heatmap of where the room got lost. The lecturer can fire a quiz generated from the live transcript. After the lecture each student gets a personal catch-up page, and the lecturer gets AI-suggested fixes for the most-bookmarked moments.

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
- **Quiz answers never go to students until they answer.** `/public` omits `correct_index` and `explanation`.
- **True bookmark counts come from the server, never the model.** Insights overwrite `students_lost` with real counts.
- **Simulated students are always labelled** in the lecturer UI (`simulated_total` chip). Don't remove that: the demo must not pass fake data off as real.
- Double-tap protection: a student's bookmarks within 15 s of their previous one are ignored.

## Current state (update me)
TESTED (in a sandbox, Nov 2026):
- Backend end to end with `MOCK_AI=1`: create lecture, demo replay, bookmark, quiz, answer, state/heatmap buckets, digest, insights.
- Frontend `npm run build` (TypeScript type-check passes).
- WebSocket ping passes through the Vite proxy.

UNTESTED:
- Live mic transcription with a real `ELEVENLABS_API_KEY` (Scribe).
- Real Claude calls for the three agents (prompts and JSON parsing are written but unproven on real output).
- The UI in an actual browser, especially the student page on a phone through a tunnel.
- Behaviour on venue Wi-Fi.

## Known gaps and risks
- State is in memory: restarting the backend loses the lecture.
- Quiz needs transcript text first; "Quiz now" returns an error if nothing has been said yet.
- Heatmap counts unique students per 30 s bucket; very long lectures make many thin bars.
- Single lecturer per lecture; no auth. Anyone with the code can join.
- Demo replay at real time takes 3 minutes; use the 6x option for dry runs.

## Next tasks (priority order)
1. Run it with real keys. Fix whatever breaks (see UNTESTED above).
2. Test with 2-3 phones through a tunnel (`cloudflared tunnel --url http://localhost:5173`, then paste the URL in the box under the QR code).
3. Tune agent prompts on the real demo transcript until quizzes and explanations are consistently good.
4. Pitch: write the 60-second script, rehearse 3 times, record a backup demo video.
5. Submit on Devpost with 20+ minutes to spare; opt in to the GreatUniHack challenge.
6. Stretch (only after the above): n8n webhook on lecture end that emails each student their digest (cheap shot at the n8n prize); ElevenLabs text-to-speech to read the digest aloud.

## Log
(Newest at the bottom. Format: `### YYYY-MM-DD HH:MM, who/agent`, then what changed, what's next.)

### 2026-11-07, Claude (initial scaffold)
- Created the whole project from scratch: FastAPI backend with three agents and demo replay; React/Vite frontend with lecturer, student and digest pages; README with run steps.
- Verified in a sandbox as listed under "Current state" (TESTED). Did not test mic, real API calls or phones.
- Dev environment note: team uses WSL2 Ubuntu; Node/npm must be installed first (see README).
- Next: someone runs it with real keys (task 1 above).

### first log
   - Set up WSL2 + node via nvm. Backend runs (uvicorn on 8000). Frontend runs.
    - Not tested: anything with real API keys, mic, phones.
    next is to fix things: To fix: Lecturer should have some way to see a summary of what needs reexplaining about when  students bookmarked. So when the professor clicks on one of the charts, the AI will look at all the bookmarks related to that chart and will create a summary for professor on exactly what to “re-explain” for that specific segment.
    UI looks too ai generated and ugly right now
    Duplicated transcript lines
    - make sure next developer knows all the steps to set up app on their machine too