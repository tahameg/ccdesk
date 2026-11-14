import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateReading, tokenize, tokenAt, directions } from "../src/core/reading.js";
import { createProject, loadProject, applyOps, checkOps, scriptEnd, overlaps, pendingCount, MEDIA_DIR, writeUiState, readUiState } from "../src/core/store.js";
import { renderHtml, exportHtml } from "../src/core/export.js";
import { describeOps } from "../src/core/describe.js";
import { formatTime, parseTime } from "../src/core/time.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kurgu-"));
const PARA = "Polis şefi Rick Grimes bir çatışmada yaralanır ve gözlerini hastanede açar. Hastane odasında yalnızdır. Kimsecikler yoktur, bir şeyler doğru görünmemektedir. Yatağından yorgun argın kalkıp hastane koridorlarında gezinmeye başlar. Ortada büyük bir felaket yaşandığına dair birçok işaret vardır ama ne olduğunu anlayamaz. Bölümün devamında ise anlar ki, artık o bildiği dünya tamamen gitmiş, geriye yeni kuralları olan yeni bir dünya kalmıştır.";

test("reading estimate matches Buse's measured paragraph (29.0 s)", () => {
  const r = estimateReading(PARA);
  assert.ok(Math.abs(r.seconds - 29.0) < 2, `got ${r.seconds}`);
});

test("silences: /4 = four units, / alone = one; directions are not read", () => {
  const s = { silenceUnit: 0.5 };
  const base = estimateReading("Merhaba dünya", s).seconds;
  assert.equal(estimateReading("Merhaba /4 dünya", s).seconds, Math.round((base + 2) * 10) / 10);
  assert.equal(estimateReading("Merhaba / dünya", s).seconds, Math.round((base + 0.5) * 10) / 10);
  assert.equal(estimateReading("dosya/klasör", s).silence, 0, "a slash inside a word is not a silence");
  assert.equal(estimateReading("[EKRAN: kartlar] Merhaba").seconds, estimateReading("Merhaba").seconds);
  assert.deepEqual(directions("a [x] b [ y ]"), ["x", "y"]);
  assert.equal(estimateReading("HTML").syllables, 4);
});

test("tokens carry times; tokenAt finds the word being spoken", () => {
  const { tokens, duration } = tokenize("Bir iki. /2 Üç", { silenceUnit: 1 });
  const words = tokens.filter((k) => k.type === "word");
  assert.equal(words.length, 3);
  const sil = tokens.find((k) => k.type === "silence");
  assert.equal(sil.end - sil.start, 2);
  assert.equal(tokenAt(tokens, words[1].start + 0.01).token.text, "iki.");
  assert.equal(tokenAt(tokens, sil.start + 0.5).token.type, "silence");
  assert.equal(duration, words[2].end);
});

test("time format and parse", () => {
  assert.equal(formatTime(83.4), "1:23.4");
  assert.equal(parseTime("1:23.4"), 83.4);
  assert.equal(parseTime("12,5"), 12.5);
});

test("scripts and events at moments; undo and redo", () => {
  const dir = tmp();
  createProject(dir, { title: "Deneme" });
  const a = applyOps(dir, "ui", [{ op: "addScript", time: 2, text: "Merhaba, ben Buse." }]);
  const sid = a.results[0].id;
  let p = loadProject(dir);
  assert.ok(scriptEnd(p, p.scripts[0]) > 2);

  const img = path.join(dir, "ref.png");
  fs.writeFileSync(img, "png");
  const e = applyOps(dir, "mcp", [{ op: "addEvent", time: 3, title: "Ekran ikiye bölünür", media: [{ source: img, caption: "örnek" }] }]);
  p = loadProject(dir);
  assert.equal(p.events[0].media.length, 1);
  assert.ok(fs.existsSync(path.join(dir, MEDIA_DIR, p.events[0].media[0].file)));
  assert.equal(p.events[0].createdBy, "mcp");

  // edit, undo, redo
  const u = applyOps(dir, "ui", [{ op: "updateScript", id: sid, text: "Selam." , time: 4 }]);
  const redo = applyOps(dir, "ui", u.undo).undo;
  assert.equal(loadProject(dir).scripts[0].text, "Merhaba, ben Buse.");
  applyOps(dir, "ui", redo);
  assert.equal(loadProject(dir).scripts[0].time, 4);

  // delete + undo brings the same item (and its media) back
  const d = applyOps(dir, "ui", [{ op: "deleteEvent", id: e.results[0].id }]);
  assert.equal(loadProject(dir).events.length, 0);
  applyOps(dir, "ui", d.undo);
  assert.equal(loadProject(dir).events[0].media.length, 1);

  // shift + undo
  const s = applyOps(dir, "ui", [{ op: "shiftItems", scriptIds: [sid], eventIds: [e.results[0].id], by: 1.5 }]);
  assert.equal(loadProject(dir).scripts[0].time, 5.5);
  applyOps(dir, "ui", s.undo);
  assert.equal(loadProject(dir).scripts[0].time, 4);
});

test("overlaps are found", () => {
  const dir = tmp();
  createProject(dir);
  applyOps(dir, "ui", [{ op: "addScript", time: 0, text: PARA }, { op: "addScript", time: 10, text: "Araya girdim." }]);
  const o = overlaps(loadProject(dir));
  assert.equal(o.length, 1);
  assert.ok(o[0].by > 15);
});

test("suggestions: Claude proposes, the owner accepts or rejects; accept can be undone", () => {
  const dir = tmp();
  createProject(dir);
  const sid = applyOps(dir, "ui", [{ op: "addScript", time: 0, text: "Eski metin." }]).results[0].id;
  const ops = [{ op: "updateScript", id: sid, text: "Yeni metin." }, { op: "addEvent", time: 1, title: "Kart gelir" }];
  assert.ok(checkOps(dir, "mcp", ops));
  assert.throws(() => checkOps(dir, "mcp", [{ op: "updateScript", id: "yok", text: "x" }]), /No script/);
  const g = applyOps(dir, "mcp", [{ op: "addSuggestion", summary: "Metni sadeleştir, kart ekle", ops }]).results[0].id;
  let p = loadProject(dir);
  assert.equal(pendingCount(p), 1);
  assert.equal(p.scripts[0].text, "Eski metin.", "nothing changes until accepted");
  const lines = describeOps(p, ops);
  assert.match(lines[0].text, /Eski metin/);

  const acc = applyOps(dir, "ui", [{ op: "decideSuggestion", id: g, accept: true }]);
  p = loadProject(dir);
  assert.equal(p.scripts[0].text, "Yeni metin.");
  assert.equal(p.events[0].createdBy, "mcp");
  assert.equal(p.suggestions[0].status, "accepted");
  const re = applyOps(dir, "ui", acc.undo);
  p = loadProject(dir);
  assert.equal(p.scripts[0].text, "Eski metin.");
  assert.equal(p.events.length, 0);
  assert.equal(p.suggestions[0].status, "pending");
  applyOps(dir, "ui", re.undo);
  p = loadProject(dir);
  assert.equal(p.scripts[0].text, "Yeni metin.");
  assert.equal(p.suggestions[0].status, "accepted");

  const g2 = applyOps(dir, "mcp", [{ op: "addSuggestion", summary: "Sil", ops: [{ op: "deleteScript", id: sid }] }]).results[0].id;
  applyOps(dir, "ui", [{ op: "decideSuggestion", id: g2, accept: false }]);
  p = loadProject(dir);
  assert.equal(p.scripts.length, 1);
  assert.equal(p.suggestions[1].status, "rejected");
});

test("a failing op writes nothing", () => {
  const dir = tmp();
  createProject(dir);
  const before = fs.readFileSync(path.join(dir, "kurgu.json"), "utf8");
  assert.throws(() => applyOps(dir, "ui", [{ op: "addScript", time: 1, text: "a" }, { op: "updateScript", id: "nope" }]));
  assert.equal(fs.readFileSync(path.join(dir, "kurgu.json"), "utf8"), before);
});

test("importScript lays paragraphs out and turns [directions] into events", () => {
  const dir = tmp();
  createProject(dir);
  applyOps(dir, "mcp", [{ op: "importScript", text: "Birinci paragraf burada.\n\n[EKRAN: kartlar gelir]\n\nİkinci paragraf da burada." }]);
  const p = loadProject(dir);
  assert.equal(p.scripts.length, 2);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].time, p.scripts[1].time);
  assert.ok(p.scripts[1].time > scriptEnd(p, p.scripts[0]));
});

test("format 1 projects are converted (ranges → moments, notes → events, comments dropped)", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "kurgu.json"), JSON.stringify({ format: 1, title: "Eski", duration: 60, reading: { syllablesPerSecond: 6 }, revision: 3,
    scripts: [{ id: "s_1", start: 1, end: 5, text: "a" }], notes: [{ id: "n_1", start: 2, end: 7, title: "Panel", text: "", media: [] }], comments: [{ id: "c" }], activity: [] }));
  const p = loadProject(dir);
  assert.equal(p.format, 2);
  assert.equal(p.scripts[0].time, 1);
  assert.equal(p.events[0].id, "e_1");
  assert.match(p.events[0].text, /5 sn sürecek/);
  assert.equal(p.settings.syllablesPerSecond, 6);
  assert.equal(p.comments, undefined);
});

test("ui state for Claude", () => {
  const dir = tmp();
  createProject(dir);
  writeUiState(dir, { playhead: 12.3, selected: null });
  assert.equal(readUiState(dir).playhead, 12.3);
});

test("export: html with times, silences and media", () => {
  const dir = tmp();
  createProject(dir, { title: "İlk Video" });
  const img = path.join(dir, "a.png");
  fs.writeFileSync(img, "x");
  applyOps(dir, "ui", [{ op: "addScript", time: 0, text: "Bir /4 iki [gülümse]" }, { op: "addEvent", time: 0, title: "Ekran ikiye bölünür", media: [{ source: img }] }]);
  const html = renderHtml(loadProject(dir));
  assert.match(html, /Ekran ikiye bölünür/);
  assert.match(html, /⏸ 2 sn/);
  assert.match(html, /class="dir">\[gülümse\]/);
  const file = exportHtml(dir, loadProject(dir));
  assert.ok(file.endsWith("ilk-video.html"));
  assert.equal(fs.readdirSync(path.join(dir, "disa-aktarim", "medya")).length, 1);
});

test("two writers do not lose each other's changes", async () => {
  const dir = tmp();
  createProject(dir);
  const { spawn } = await import("node:child_process");
  const worker = `import { applyOps } from ${JSON.stringify(path.resolve("src/core/store.js"))};
for (let i = 0; i < 20; i++) applyOps(process.argv[1], process.argv[2], [{ op: "addEvent", time: i, title: process.argv[2] + i }]);`;
  const run = (actor) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", worker, dir, actor], { stdio: "inherit" });
    c.on("exit", (code) => (code ? rej(new Error(`exit ${code}`)) : res()));
  });
  await Promise.all([run("ui"), run("mcp")]);
  assert.equal(loadProject(dir).events.length, 40);
});
