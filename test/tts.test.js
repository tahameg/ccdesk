import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TtsManager } from "../src/main/tts/index.js";

function setup(fakeCheck = { supported: true, ready: true }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-tts-"));
  const prefs = { tts: { provider: "fake", sync: true, omnivoice: { voice: null, speed: 1, steps: 24 }, azure: { region: "westeurope", voiceTr: "tr-TR-EmelNeural", voiceEn: "en-US-JennyNeural" } } };
  const m = new TtsManager({ stateDir, readState: () => ({}), readPrefs: () => prefs, secrets: { get: () => null, set() {} } });
  const calls = [];
  m.providers.push({
    id: "fake", name: "Sahte", ext: "wav", rateRange: [0.5, 2], online: false,
    check: async () => fakeCheck,
    signature: (lang) => `v1|${lang}`,
    speak: async (a) => { calls.push(a); fs.writeFileSync(a.out, `audio ${a.text} ${a.rate} ${a.language}`); },
    cancel() {},
  });
  return { m, calls, prefs };
}

test("speak: the active provider makes it once, then it comes from the cache; rate clamped to 0.05 steps", async () => {
  const { m, calls } = setup();
  const a = await m.speak({ text: "Merhaba", language: "tr", rate: 1.234 });
  assert.equal(a.rate, 1.25);
  assert.equal(String(a.audio), "audio Merhaba 1.25 tr");
  await m.speak({ text: "Merhaba", language: "tr", rate: 1.24 });
  assert.equal(calls.length, 1, "cached");
  await m.speak({ text: "Merhaba", language: "en", rate: 9 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rate, 2);
});

test("a provider that isn't supported or ready refuses; none chosen = silent", async () => {
  const { m, prefs } = setup({ supported: false, ready: false, reason: "Bu bilgisayarda yok: GPU." });
  await assert.rejects(m.speak({ text: "x" }), /GPU/);
  assert.equal(await m.canChoose("fake"), false);
  assert.equal(await m.canChoose(null), true);
  prefs.tts.provider = null;
  await assert.rejects(m.speak({ text: "x" }), /seçilmedi/);
});

test("describe lists every provider with its check; Azure needs a key", async () => {
  const { m } = setup();
  const d = await m.describe();
  assert.deepEqual(d.providers.map((p) => p.id), ["omnivoice", "azure", "fake"]);
  const az = d.providers.find((p) => p.id === "azure");
  assert.equal(az.supported, true);
  assert.equal(az.ready, false);
  assert.ok(az.online);
  const ov = d.providers.find((p) => p.id === "omnivoice");
  assert.equal(typeof ov.supported, "boolean");
  if (!ov.supported) assert.match(ov.reason, /Bu bilgisayarda yok/);
});
