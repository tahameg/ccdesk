# Kurgu Masası — notes for agents

Electron app (UI Turkish, code English) + an MCP server over the same project folders. A desk for deciding a video edit, not a video editor (owner, 2026-11-14).

Model (format 2): **scripts** `{id, time, text}` — spoken text from a moment; length = `tokenize(text, settings).duration` (never stored); `[…]` = direction for the AI (not read), `/n` = n silence units (`/` alone = 1). **events** `{id, time, title, text, media[]}` — moments. **suggestions** `{id, summary, ops, status}` — Claude proposes, the owner decides in the app. No comments, no ranges (format 1 projects are converted on load).

- `src/core/` — `reading.js` (tokens with times; Turkish syllables = vowels; defaults measured on Buse) and `time.js`, `describe.js` are pure (the window imports them: keep them free of Node imports). `store.js`: project folder, ops, lock, atomic write, `.kurgu-ui.json` (where the owner is looking). `export.js` (HTML), `state.js` (`~/.config/kurgu-masasi/state.json`).
- **Every change is an op through `applyOps(dir, actor, ops)`**; each op returns its inverse (`undo`), which the app uses for undo/redo (the inverse of the inverse is the redo). A new op = a function in `OPS` returning `{id, summary (Turkish), undo}` + `describeOp` + a test; add it to `SUGGESTABLE` if Claude may propose it.
- `src/main/` — Electron main (ESM), `preload.cjs` (sandboxed bridge `window.kurgu`), `pty-helper.py` (the terminal: a Python pty bridge, no native module; resize lines on fd 3). The terminal starts the login shell in the project folder and types `claude --mcp-config <generated> --append-system-prompt-file <generated>` (files in the state dir; the MCP server runs on Electron's Node via `ELECTRON_RUN_AS_NODE`).
- `src/renderer/` — vanilla JS, no build step; xterm.js from `node_modules`.
- `src/mcp/server.js` — `kurgu_*` tools; `kurgu_cursor` reads `.kurgu-ui.json`; `kurgu_suggest` stores media first, dry-runs the ops (`checkOps`), then adds the suggestion.
- Check: `npm test`; UI: `npm run smoke -- <dir> <out.png> [id] [pps] [time]`, `KURGU_SMOKE_JS=<file>` runs a script in the window first (see git history for examples), then look at the PNG.
