import { test } from "node:test";
import assert from "node:assert/strict";
import { turkishNumber, spokenWord, scriptChunks, speechPlan } from "../src/core/speech.js";
import { DEFAULT_SETTINGS } from "../src/core/reading.js";

test("numbers are spelled in Turkish", () => {
  assert.equal(turkishNumber(2026), "iki bin yirmi altı");
  assert.equal(turkishNumber(1001), "bin bir");
  assert.equal(turkishNumber(1234567), "bir milyon iki yüz otuz dört bin beş yüz altmış yedi");
  assert.equal(spokenWord("%40"), "yüzde kırk");
  assert.equal(spokenWord("3,5"), "üç virgül beş");
  assert.equal(spokenWord("10.000"), "on bin");
});

test("chunks: sentences, no [directions], /n breaks, times from the reading model", () => {
  const c = scriptChunks("Merhaba, ben Buse ve bugün size kanalı tanıtıyorum. [gülümse] İkinci cümle de burada duruyor. /2 Sonra.", DEFAULT_SETTINGS);
  assert.equal(c.length, 3);
  assert.ok(!c.some((x) => x.text.includes("gülümse") || x.text.includes("/")));
  assert.ok(c[1].start > c[0].end && c[2].start - c[1].end >= 1, "the silence sits between chunks");
  const long = scriptChunks(Array(60).fill("kelime").join(" "), DEFAULT_SETTINGS);
  assert.ok(long.length > 1 && long.every((x) => x.text.length <= 250), "no chunk too long for one generation");
});

test("plan from a moment: the chunk under the playhead first, with how far into it", () => {
  const p = { settings: DEFAULT_SETTINGS, scripts: [{ id: "a", time: 0, text: "Birinci cümle burada, biraz uzunca bir cümle olsun diye." }, { id: "b", time: 6, text: "İkinci konuşma." }] };
  const all = speechPlan(p, 0);
  assert.deepEqual(all.map((x) => x.scriptId), ["a", "b"]);
  const mid = speechPlan(p, all[0].start + (all[0].end - all[0].start) / 2);
  assert.equal(mid[0].key, all[0].key);
  assert.ok(mid[0].offset > 0.4 && mid[0].offset < 0.6);
  assert.deepEqual(speechPlan(p, 100), []);
});

test("English content: numbers in English, chunks follow settings.language", async () => {
  const { englishNumber } = await import("../src/core/speech.js");
  assert.equal(englishNumber(2026), "two thousand twenty-six");
  assert.equal(englishNumber(115), "one hundred fifteen");
  assert.equal(spokenWord("40%", "en"), "forty percent");
  assert.equal(spokenWord("3.5", "en"), "three point five");
  assert.equal(spokenWord("10,000", "en"), "ten thousand");
  assert.equal(spokenWord("40%"), "yüzde kırk");
  const c = scriptChunks("It was 2026 and we grew 40%.", { ...DEFAULT_SETTINGS, language: "en" });
  assert.equal(c[0].text, "It was two thousand twenty-six and we grew forty percent.");
});
