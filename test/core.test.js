import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateReading, stripDirections, directions } from "../src/core/reading.js";
import { createProject, loadProject, applyOps, unresolvedCount, scriptFit, MEDIA_DIR } from "../src/core/store.js";
import { renderHtml, exportHtml } from "../src/core/export.js";
import { formatTime, parseTime } from "../src/core/time.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kurgu-"));

test("reading estimate matches Buse's measured paragraph (29.0 s)", () => {
  const para = "Polis şefi Rick Grimes bir çatışmada yaralanır ve gözlerini hastanede açar. Hastane odasında yalnızdır. Kimsecikler yoktur, bir şeyler doğru görünmemektedir. Yatağından yorgun argın kalkıp hastane koridorlarında gezinmeye başlar. Ortada büyük bir felaket yaşandığına dair birçok işaret vardır ama ne olduğunu anlayamaz. Bölümün devamında ise anlar ki, artık o bildiği dünya tamamen gitmiş, geriye yeni kuralları olan yeni bir dünya kalmıştır.";
  const r = estimateReading(para);
  assert.ok(Math.abs(r.seconds - 29.0) < 2, `got ${r.seconds}`);
});

test("directions in brackets are not read", () => {
  assert.equal(estimateReading("[EKRAN: kartlar gelir]").seconds, 0);
  assert.equal(estimateReading("Merhaba [yavaş söyle] dünya").syllables, estimateReading("Merhaba dünya").syllables);
  assert.deepEqual(directions("a [x] b [ y ]"), ["x", "y"]);
  assert.equal(stripDirections("a [x] b").replace(/\s+/g, " "), "a b");
});

test("acronyms without vowels are spelled", () => {
  assert.equal(estimateReading("HTML").syllables, 4);
});

test("time format and parse", () => {
  assert.equal(formatTime(83.4), "1:23.4");
  assert.equal(formatTime(60), "1:00");
  assert.equal(parseTime("1:23.4"), 83.4);
  assert.equal(parseTime("12,5"), 12.5);
});

test("ops: scripts, notes, media, comments, both actors", () => {
  const dir = tmp();
  createProject(dir, { title: "Deneme", duration: 60 });
  const { results } = applyOps(dir, "ui", [{ op: "addScript", start: 2, text: "Merhaba, ben Buse." }]);
  const sid = results[0].id;
  let p = loadProject(dir);
  assert.equal(p.scripts[0].createdBy, "ui");
  assert.ok(p.scripts[0].end > 2, "end defaults to the reading estimate");

  const img = path.join(dir, "ref.png");
  fs.writeFileSync(img, "png");
  const r2 = applyOps(dir, "mcp", [
    { op: "addNote", start: 3, end: 8, title: "Panel", text: "Sağda panel" },
  ]);
  const nid = r2.results[0].id;
  applyOps(dir, "mcp", [{ op: "addMedia", noteId: nid, source: img, caption: "örnek" }]);
  p = loadProject(dir);
  assert.equal(p.notes[0].media.length, 1);
  assert.ok(fs.existsSync(path.join(dir, MEDIA_DIR, p.notes[0].media[0].file)));
  assert.equal(p.notes[0].updatedBy, "mcp");

  const c = applyOps(dir, "ui", [{ op: "addComment", target: { type: "script", id: sid }, text: "Daha kısa?" }]).results[0].id;
  applyOps(dir, "mcp", [{ op: "replyComment", id: c, text: "Kısalttım." }]);
  assert.equal(unresolvedCount(loadProject(dir)), 1);
  assert.throws(() => applyOps(dir, "mcp", [{ op: "deleteComment", id: c }]), /Only the author/);
  applyOps(dir, "ui", [{ op: "resolveComment", id: c }]);
  assert.equal(unresolvedCount(loadProject(dir)), 0);

  // deleting the script keeps its comments, pinned to its time
  applyOps(dir, "ui", [{ op: "deleteScript", id: sid }]);
  p = loadProject(dir);
  assert.deepEqual(p.comments[0].target, { type: "time", time: 2, deleted: "script" });
  assert.ok(p.revision >= 6);
  assert.ok(p.activity.some((a) => a.actor === "mcp"));
});

test("a failing op writes nothing", () => {
  const dir = tmp();
  createProject(dir);
  const before = fs.readFileSync(path.join(dir, "kurgu.json"), "utf8");
  assert.throws(() => applyOps(dir, "ui", [{ op: "addScript", start: 1, end: 3, text: "a" }, { op: "updateScript", id: "nope" }]));
  assert.equal(fs.readFileSync(path.join(dir, "kurgu.json"), "utf8"), before);
});

test("overlapping items and events are allowed; the timeline grows", () => {
  const dir = tmp();
  createProject(dir, { duration: 10 });
  applyOps(dir, "ui", [
    { op: "addScript", start: 0, end: 5, text: "bir" },
    { op: "addScript", start: 3, end: 8, text: "iki" },
    { op: "addNote", start: 4, end: 4, title: "kesme" },
    { op: "addNote", start: 2, end: 30, title: "müzik" },
  ]);
  const p = loadProject(dir);
  assert.equal(p.notes[0].start, p.notes[0].end);
  assert.ok(p.duration >= 30);
});

test("importScript lays paragraphs out and turns [directions] into notes", () => {
  const dir = tmp();
  createProject(dir);
  applyOps(dir, "mcp", [{ op: "importScript", text: "Birinci paragraf burada.\n\n[EKRAN: kartlar gelir]\n\nİkinci paragraf da burada." }]);
  const p = loadProject(dir);
  assert.equal(p.scripts.length, 2);
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0].start, p.scripts[1].start);
  assert.ok(p.scripts[1].start > p.scripts[0].end);
});

test("export: html with times, warnings and media", () => {
  const dir = tmp();
  createProject(dir, { title: "İlk Video" });
  const img = path.join(dir, "a.png");
  fs.writeFileSync(img, "x");
  const { results } = applyOps(dir, "ui", [
    { op: "addScript", start: 0, end: 1, text: "Bu metin bir saniyeye sığmayacak kadar uzun bir cümle." },
    { op: "addNote", start: 0, end: 5, title: "Ekran ikiye bölünür" },
  ]);
  applyOps(dir, "ui", [{ op: "addMedia", noteId: results[1].id, source: img }]);
  const p = loadProject(dir);
  assert.ok(scriptFit(p, p.scripts[0]).over > 0);
  const html = renderHtml(p);
  assert.match(html, /Ekran ikiye bölünür/);
  assert.match(html, /uzun<\/span>/);
  const file = exportHtml(dir, p);
  assert.ok(file.endsWith("ilk-video.html"));
  assert.ok(fs.readdirSync(path.join(dir, "disa-aktarim", "medya")).length === 1);
});

test("two writers do not lose each other's changes", async () => {
  const dir = tmp();
  createProject(dir);
  const { spawn } = await import("node:child_process");
  const worker = `import { applyOps } from ${JSON.stringify(path.resolve("src/core/store.js"))};
for (let i = 0; i < 20; i++) applyOps(process.argv[1], process.argv[2], [{ op: "addNote", start: i, title: process.argv[2] + i }]);`;
  const run = (actor) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", worker, dir, actor], { stdio: "inherit" });
    c.on("exit", (code) => (code ? rej(new Error(`exit ${code}`)) : res()));
  });
  await Promise.all([run("ui"), run("mcp")]);
  assert.equal(loadProject(dir).notes.length, 40);
});
