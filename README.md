# Signal

Students tap **"I'm lost"** to bookmark a confusing moment. Lecturers see a live heatmap of where the room got lost.
Quizzes are generated from the live transcript, and every student gets a personal catch-up digest at the end.

Stack: FastAPI + WebSockets · React + Vite + TypeScript · ElevenLabs Scribe v2 Realtime (live transcription) · Claude (quiz, explainer, lecturer insights).

## 1. Backend (Terminal 1)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then fill in the keys (see below)
uvicorn main:app --reload --port 8000
```

No API keys yet? Set `MOCK_AI=1` in `.env` and the AI agents return canned answers, so everyone can build UI straight away.

## 2. Frontend (Terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 on the lecturer's laptop.

## 3. Let phones join (Terminal 3)

Phones can't reach `localhost`, and venue Wi-Fi often blocks device-to-device traffic. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:5173
```

Copy the `https://....trycloudflare.com` URL it prints and **paste it into the box under the QR code** on the lecturer page. The QR code then points at it. (A phone hotspot with your laptop's local IP also works.)

## 4. Demo flow (3 minutes)

1. Lecturer page: **Run demo** (real time). A bundled lecture replays and *simulated* students fill the heatmap (the UI labels them as simulated).
2. Judges scan the QR code and tap **I'm lost** at moments that confuse them. Their taps appear on the heatmap in real time.
3. Press **Quiz now** around 1:50. Phones show a 25-second question and the lecturer sees live results.
4. Press **End lecture**, then **Analyse top moments**. On a phone, open **my catch-up notes**.

For real use: **Start lecture + mic** streams the lecturer's microphone to Scribe. Test this in the venue beforehand and keep the demo replay as your fallback.

## API keys

- `ANTHROPIC_API_KEY`: quiz, explainer and insight agents (`MODEL_FAST` / `MODEL_SMART` in `.env` override the models).
- `ELEVENLABS_API_KEY`: only needed for live mic transcription. The backend mints a short-lived single-use token, so the key never reaches the browser.

## Layout

```
backend/
  main.py                 routes, in-memory state, WebSocket pings, demo replay
  agents.py               quiz / explainer / insight agents + mock mode
  demo_transcript.json    the bundled demo lecture
frontend/src/
  pages/Lecturer.tsx      dashboard: mic, heatmap, quiz, insights, QR
  pages/Student.tsx       "I'm lost" button + quiz overlay
  pages/Digest.tsx        personal catch-up notes
  components/Heatmap.tsx  the 30-second heatmap bars
  api.ts  hooks.ts        types, fetch helpers, live-refresh hook
```

## Privacy

Transcript text only: raw audio is never stored. Students are anonymous random IDs. State lives in memory and disappears when the server stops.
