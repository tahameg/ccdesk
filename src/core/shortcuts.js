// Terminal shortcuts: named commands the app pastes into its terminal (never runs them: the owner presses Enter).
// Global ones live in state.json (`terminalShortcuts`; missing = the defaults below, an empty list stays empty),
// a project's own in <project>/.ccdesk-shortcuts.json (not part of the edit, so no op and no history).
// The terminal exports what the defaults need: CCDESK_MCP_CONFIG, CCDESK_AGENT_PROMPT, CCDESK_MCP_COMMAND,
// CCDESK_MCP_SERVER (see main.js startTerminal).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readState, patchState } from "./state.js";

export const PROJECT_SHORTCUTS_FILE = ".ccdesk-shortcuts.json";
const MAX = 40;

export const DEFAULT_SHORTCUTS = Object.freeze([
  { id: "claude", label: "Claude Code",
    command: 'claude --mcp-config "$CCDESK_MCP_CONFIG" --append-system-prompt-file "$CCDESK_AGENT_PROMPT"' },
  // agy has no per-session MCP flag: register (or update) the ccdesk server, which follows the app's open
  // project, then start with the same note as the first message.
  { id: "agy", label: "Antigravity (agy)",
    command: 'agy mcp add -e ELECTRON_RUN_AS_NODE=1 ccdesk -- "$CCDESK_MCP_COMMAND" "$CCDESK_MCP_SERVER" >/dev/null && agy -i "$(cat "$CCDESK_AGENT_PROMPT")"' },
].map(Object.freeze));

/** Keeps well-formed entries: {id, label, command}; one line each (a pasted newline would run it). */
export function sanitizeShortcuts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const command = String(x.command ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 4000);
    if (!command) continue;
    const label = String(x.label ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || command.split(" ")[0].slice(0, 40);
    let id = typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) ? x.id : "";
    if (!id || seen.has(id)) id = crypto.randomBytes(4).toString("hex");
    seen.add(id);
    out.push({ id, label, command });
    if (out.length >= MAX) break;
  }
  return out;
}

export function readGlobalShortcuts() {
  const s = readState().terminalShortcuts;
  return Array.isArray(s) ? sanitizeShortcuts(s) : DEFAULT_SHORTCUTS.map((x) => ({ ...x }));
}
/** null = back to the defaults. */
export function setGlobalShortcuts(list) {
  patchState({ terminalShortcuts: list === null ? undefined : sanitizeShortcuts(list) });
  return readGlobalShortcuts();
}

export function readProjectShortcuts(dir) {
  try { return sanitizeShortcuts(JSON.parse(fs.readFileSync(path.join(dir, PROJECT_SHORTCUTS_FILE), "utf8"))); } catch { return []; }
}
/** An empty list removes the file. */
export function setProjectShortcuts(dir, list) {
  const file = path.join(dir, PROJECT_SHORTCUTS_FILE);
  const clean = sanitizeShortcuts(list);
  if (!clean.length) { fs.rmSync(file, { force: true }); return []; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 1));
  fs.renameSync(tmp, file);
  return clean;
}
