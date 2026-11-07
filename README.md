# Signal

Students tap **"I'm lost"** to bookmark a confusing moment. Lecturers see a live heatmap of where the room got lost.
Students can quiz themselves any time with a question generated from the live transcript, and every student gets a personal catch-up digest at the end.

Stack: FastAPI + WebSockets · React + Vite + TypeScript · ElevenLabs Scribe v2 Realtime (live transcription) · Claude (quiz, explainer, lecturer insights).

## 0. First-time setup on a fresh machine

Written for **WSL2 Ubuntu** (what the team uses). On Windows PowerShell or macOS, swap in your own installers.

```bash
# Python 3 + venv support (Ubuntu has no plain `python`, only `python3`)
sudo apt update && sudo apt install -y python3 python3-venv python3-pip

# Node via nvm (get the current install one-liner from https://github.com/nvm-sh/nvm)
# then, in a NEW terminal:
nvm install --lts
node -v && npm -v

# Optional, only for phones/judges joining from their own devices (step 3)
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

Then clone the repo and `cd` into it. You need **two terminals** (three if you want phones).

## 1. Backend (Terminal 1)

```bash
cd backend
python3 -m venv .venv            # use `python` on Windows
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then fill in the keys (see "API keys")
uvicorn main:app --reload --port 8000
```

Your prompt shows `(.venv)` when the venv is active. **Every new terminal needs `source .venv/bin/activate` again.**

No API keys yet? Set `MOCK_AI=1` in `.env` and the AI agents return canned answers, so everyone can build UI straight away.

## 2. Frontend (Terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 **on the lecturer's laptop**. Use `localhost`, not the LAN IP: browsers only allow microphone access on `localhost` or `https`.

## 3. Let phones join (Terminal 3)

Phones can't reach `localhost`, and venue Wi-Fi often blocks device-to-device traffic. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:5173
```

Copy the `https://....trycloudflare.com` URL it prints and **paste it into the box under the QR code** on the lecturer page. The QR code then points at it. (A phone hotspot with your laptop's local IP also works.)

## 4. Demo flow (3 minutes)

1. Lecturer page: **Run demo** (real time). A bundled lecture replays and *simulated* students fill the heatmap (the UI labels them as simulated). The clock in the header shows lecture time.
2. Judges scan the QR code and tap **I'm lost** at moments that confuse them. Their taps appear on the heatmap in real time.
3. Click a bar on the heatmap, then **What should I re-explain?**. An agent reads every bookmark in that 30-second window plus the transcript and says what to re-teach.
4. On a phone, tap **Test myself** (the button beside "I'm lost") for a personal quiz question from the last few minutes. The lecturer page shows anonymous class results under **Student self-checks**.
5. Press **End lecture**, then **Analyse top moments**. On a phone, open **my catch-up notes**.

For real use: **Start lecture + mic** streams the lecturer's microphone to Scribe. Test this in the venue beforehand and keep the demo replay as your fallback.

## API keys

- `ANTHROPIC_API_KEY`: quiz, explainer and insight agents (`MODEL_FAST` / `MODEL_SMART` in `.env` override the models).
- `ELEVENLABS_API_KEY`: only needed for live mic transcription. The backend mints a short-lived single-use token, so the key never reaches the browser.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `python: command not found` | Use `python3` (Ubuntu/WSL) |
| `externally-managed-environment` when pip installing | The venv isn't active. `python3 -m venv .venv && source .venv/bin/activate`, then pip install. Don't use `--break-system-packages` |
| `uvicorn: command not found` | Same cause: activate the venv first |
| `.venv/bin/activate: No such file` | venv creation failed. `sudo apt install python3-venv python3-full`, then recreate |
| Frontend loads but every call fails | Backend isn't running on port 8000 |
| "backend doesn't have the moment-summary endpoint" | uvicorn is running an old `main.py`; stop it and start it again |
| Mic fails on the lecturer page | Open it via `localhost:5173`, allow mic permission, check `ELEVENLABS_API_KEY` |
| Phones can't open the QR link | Paste the tunnel URL into the box under the QR code |

## Layout

```
backend/
  main.py                 routes, in-memory state, WebSocket pings, demo replay, moment summary route
  agents.py               quiz / explainer / insight / moment-summary agents + mock mode
  demo_transcript.json    the bundled demo lecture
frontend/src/
  pages/Lecturer.tsx      dashboard: clock, mic, heatmap, moment summary, student self-checks, insights, QR
  pages/Student.tsx       "I'm lost" button, "Test myself" button + quiz overlay
  pages/Digest.tsx        personal catch-up notes
  components/Heatmap.tsx  the 30-second heatmap bars
  api.ts  hooks.ts        types, fetch helpers, live-refresh hook
  styles.css              all styling (flat, one accent colour)
```

## Privacy

Transcript text only: raw audio is never stored. Students are anonymous random IDs. State lives in memory and disappears when the server stops.
