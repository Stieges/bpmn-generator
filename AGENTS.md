# BPMN Generator for Agents & opencode

This repository provides tools for autonomous agents to generate, validate, and manipulate BPMN 2.0 XML files.

## Demo

Run the BPMN Copilot demo:

```bash
cd scripts
npm install   # one-time, ~30s
npm run demo
```

This starts the HTTP server on `http://localhost:3000` and serves the frontend.
Open your browser to that URL.

### API key

For the LLM chat to work, you need an OpenAI-compatible API key. The frontend will
prompt you for it when you first click "Custom Text". The key is stored in
`localStorage` (browser only — never sent to disk on the server side).

If you prefer to pre-configure the key, set `OPENAI_API_KEY` in your shell before
running `npm run demo`. The server then uses it as a fallback for all LLM calls,
so requests work even without a key entered in the browser. (The backend also
exposes `GET /api/v1/config`, reporting `envKeyConfigured`, so a frontend can
detect this and skip the modal — wiring that into the UI is a separate step.)

### Pre-loaded examples

Click any of the four example cards on the start screen — no key needed. The
BPMN is pre-generated and rendered instantly.
