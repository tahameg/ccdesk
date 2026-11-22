import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-state-"));
process.env.CCDESK_STATE_DIR = dir;
const { readPrefs, setPrefs, setCurrent, readState } = await import("../src/core/state.js");

test("preferences: defaults, deep merge, values kept in range", () => {
  fs.rmSync(path.join(dir, "state.json"), { force: true });
  const p = readPrefs();
  assert.deepEqual(p.appearance, { theme: "light", uiFont: "roboto", scriptFont: "courier-prime" });
  assert.equal(p.tts.provider, null);
  assert.equal(p.tts.sync, true);
  const n = setPrefs({ appearance: { theme: "dark" }, tts: { omnivoice: { speed: 9 } }, junk: 1 });
  assert.equal(n.appearance.theme, "dark");
  assert.equal(n.appearance.uiFont, "roboto", "the rest is kept");
  assert.equal(n.tts.omnivoice.speed, 1.5, "clamped");
  assert.equal(readState().junk, undefined);
  assert.equal(setPrefs({ appearance: { theme: "pink" } }).appearance.theme, "light");
  setCurrent("/x");
  assert.equal(readPrefs().appearance.theme, "light", "setCurrent keeps preferences");
});

test("an older state file (voice at the top) means OmniVoice with that voice", () => {
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ current: null, recent: [], voice: "buse", voiceSpeed: 1.1 }));
  const p = readPrefs();
  assert.equal(p.tts.provider, "omnivoice");
  assert.deepEqual(p.tts.omnivoice, { voice: "buse", speed: 1.1, steps: 24 });
  setPrefs({ tts: { sync: false } });
  const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(s.voice, undefined, "the old keys are folded in");
  assert.equal(s.tts.omnivoice.voice, "buse");
});
