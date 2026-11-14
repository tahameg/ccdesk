// Shared app state: which project is open in the app, and recent projects.
// The MCP server reads it, so Claude works on the project the owner has open unless told otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = process.env.KURGU_STATE_DIR || path.join(os.homedir(), ".config", "kurgu-masasi");
const FILE = path.join(STATE_DIR, "state.json");

export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { current: s.current || null, recent: Array.isArray(s.recent) ? s.recent : [] };
  } catch {
    return { current: null, recent: [] };
  }
}

export function setCurrent(dir) {
  const s = readState();
  s.current = dir;
  s.recent = [dir, ...s.recent.filter((d) => d !== dir)].slice(0, 10);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 1));
  return s;
}
