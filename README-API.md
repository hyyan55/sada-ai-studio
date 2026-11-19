# صَدَى — Transcription API

The static frontend calls `https://sada-ai-api.onrender.com/api/transcribe`.

## Render Web Service settings

- Repository: `hyyan55/sada-ai-studio`
- Branch: `main`
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Create a separate **Web Service** for this repository. Keep the existing Static Site unchanged.

## Render Environment variables

Add these in the Web Service's Environment tab:

- `GEMINI_API_KEY` — Google AI Studio API key.
- `GROQ_API_KEY` — Groq API key.
- `ALLOWED_ORIGINS` — optional comma-separated frontend origins. Set the exact public Sada frontend origin(s) after deployment. `*` is the default until configured.
- `GROQ_MODEL` — optional; defaults to `whisper-large-v3-turbo`.

Do not put either API key in `index.html`, frontend environment variables, or GitHub.

## Behaviour

1. Gemini 3.5 Transcribe is attempted first, with word timestamps.
2. If Gemini fails or the inline-audio limit is exceeded, Groq Whisper is attempted automatically.
3. The API returns a provider-neutral transcript and word timing structure.
4. The endpoint is rate-limited and accepts audio up to 24 MB and 30 minutes.

The frontend expects the Render service name `sada-ai-api`. If you choose a different service name in Render, update `SADA_API_URL` in `index.html` to that service's URL.
