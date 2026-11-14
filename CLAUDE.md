# Kurgu Masası — notes for agents

Electron app (UI Turkish, code English) + an MCP server over the same project files.

- `src/core/` — pure Node, no Electron: `store.js` (project folder, ops, lock, atomic write), `reading.js` (Turkish reading time: syllables = vowels; defaults measured on Buse), `export.js` (HTML), `time.js`, `state.js` (`~/.config/kurgu-masasi/state.json`: the project open in the app = the MCP default).
- **Every change is an op through `applyOps(dir, actor, ops)`** (actor `ui` or `mcp`): lock → read → apply → revision+1 → atomic write. Never write `kurgu.json` another way. A new op = a function in `OPS` (validate, stamp, return a Turkish `summary` for the activity log) + a test.
- `src/main/` — Electron main (ESM) + `preload.cjs` (sandboxed bridge `window.kurgu`). Media is served by the `medya://` protocol from the open project's `medya/`. The main process watches `kurgu.json` and pushes other writers' revisions to the window.
- `src/renderer/` — vanilla JS, no build step; imports `core/reading.js` and `core/time.js` directly (keep those two free of Node imports).
- `src/mcp/server.js` — stdio MCP server, tools `kurgu_*`; registered for the channel workspace in `~/Workspace/youtube kanal planı/.mcp.json`.
- Rules from the owner: scripts hold only spoken text (`[directions]` for the AI allowed); notes hold anything (media); comments are separate; items may overlap; unresolved comment count always visible.
- Check: `npm test`; UI: `npm run smoke -- <project dir> <out.png> [item id] [pps]` then look at the PNG.
