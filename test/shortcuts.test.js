import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-sc-"));
process.env.CCDESK_STATE_DIR = dir;
const sc = await import("../src/core/shortcuts.js");
const { readState, setCurrent } = await import("../src/core/state.js");

test("global shortcuts: defaults (claude, agy), saved list, empty stays empty, null restores", () => {
  assert.deepEqual(sc.readGlobalShortcuts().map((x) => x.id), ["claude", "agy"]);
  assert.match(sc.readGlobalShortcuts()[0].command, /\$CCDESK_MCP_CONFIG/);
  const saved = sc.setGlobalShortcuts([{ label: "ls", command: "ls -la\n" }, { label: "", command: "  " }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].command, "ls -la", "one line, trimmed");
  assert.ok(saved[0].id);
  setCurrent("/x");
  assert.equal(sc.readGlobalShortcuts().length, 1, "other state writes keep them");
  assert.deepEqual(sc.setGlobalShortcuts([]), []);
  assert.equal(sc.setGlobalShortcuts(null).length, 2);
  assert.equal(readState().terminalShortcuts, undefined);
});

test("sanitize: multi-line commands become one line, duplicate ids renamed, label from the command", () => {
  const out = sc.sanitizeShortcuts([{ id: "a", command: "cd x\nclaude" }, { id: "a", label: "  b  ", command: "b" }, null, "x"]);
  assert.equal(out[0].command, "cd x claude");
  assert.equal(out[0].label, "cd");
  assert.notEqual(out[1].id, "a");
  assert.equal(out[1].label, "b");
});

test("project shortcuts: a file in the project folder, removed when empty", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-scp-"));
  assert.deepEqual(sc.readProjectShortcuts(p), []);
  sc.setProjectShortcuts(p, [{ label: "render", command: "make render" }]);
  assert.equal(sc.readProjectShortcuts(p)[0].command, "make render");
  assert.ok(fs.existsSync(path.join(p, sc.PROJECT_SHORTCUTS_FILE)));
  sc.setProjectShortcuts(p, []);
  assert.ok(!fs.existsSync(path.join(p, sc.PROJECT_SHORTCUTS_FILE)));
});
