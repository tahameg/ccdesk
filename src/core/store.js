// The project store: one folder = one project.
//   <dir>/ccdesk.json     the whole state: scripts (what is said, one flow: in array order, back to back from 0,
//                         each as long as its text), events (what happens at a moment, with media), suggestions
//                         (Claude's proposed changes), activity
//   <dir>/medya/          files attached to events (copied in, so the folder is self-contained)
//   <dir>/.ccdesk-ui.json where the owner is looking (cursor, selection), written by the app for Claude
// Projects made before the rename (kurgu.json, .kurgu-ui.json) are renamed in place when first seen.
// The app and the MCP server change a project only through applyOps(): lock, read, apply, bump the revision,
// write atomically, record the revision's changes in the history (history.js). Every op returns its inverse, so the app can undo and redo.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_SETTINGS, LANGUAGES, estimateReading, tokenize } from "./reading.js";
import { round1 } from "./time.js";
import { normalize, recordRevision, ensureHistory } from "./history.js";

export const PROJECT_FILE = "ccdesk.json";
export const UI_FILE = ".ccdesk-ui.json";
const LEGACY = { [PROJECT_FILE]: "kurgu.json", [UI_FILE]: ".kurgu-ui.json" }; // before the app was called ccdesk
export const MEDIA_DIR = "medya";
export const FORMAT_VERSION = 2;

export const ACTORS = { ui: { id: "ui", name: "Taha" }, mcp: { id: "mcp", name: "Claude" } };

const MEDIA_KINDS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"],
  video: ["mp4", "webm", "mov", "mkv", "m4v"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"],
  pdf: ["pdf"],
};

export function mediaKind(name) {
  if (/^https?:\/\//i.test(name)) return "link";
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA_KINDS)) if (exts.includes(ext)) return kind;
  return "file";
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const now = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A project from before the rename: its files take the new names (once; the app and the MCP server may race). */
function adoptLegacy(dir) {
  if (fs.existsSync(path.join(dir, PROJECT_FILE))) return;
  for (const [now, old] of Object.entries(LEGACY)) {
    try { if (fs.existsSync(path.join(dir, old))) fs.renameSync(path.join(dir, old), path.join(dir, now)); } catch {}
  }
}
export const projectFile = (dir) => path.join(dir, PROJECT_FILE);
export const isProjectDir = (dir) => { adoptLegacy(dir); return fs.existsSync(projectFile(dir)); };

export function emptyProject(title = "Yeni kurgu") {
  const t = now();
  return { format: FORMAT_VERSION, title, settings: { ...DEFAULT_SETTINGS }, revision: 0, createdAt: t, updatedAt: t,
    scripts: [], events: [], suggestions: [], activity: [] };
}

export function createProject(dir, { title } = {}) {
  if (isProjectDir(dir)) throw new Error(`There is already a project in ${dir}`);
  fs.mkdirSync(path.join(dir, MEDIA_DIR), { recursive: true });
  const p = emptyProject(title || path.basename(dir));
  writeAtomic(projectFile(dir), p);
  return p;
}

/** Format 1 (ranges, notes, comments) → 2 (moments, events, suggestions). Comments are dropped (owner's call). */
function migrate(p) {
  if (p.format === 1) {
    const d = { ...emptyProject(p.title), createdAt: p.createdAt, revision: p.revision, activity: p.activity || [] };
    d.settings = { ...DEFAULT_SETTINGS, ...(p.reading || {}) };
    d.scripts = (p.scripts || []).map(({ id, start, text, createdBy, createdAt, updatedBy, updatedAt }) => ({ id, time: start, text, createdBy, createdAt, updatedBy, updatedAt }));
    d.events = (p.notes || []).map((n) => ({
      id: n.id.replace(/^n_/, "e_"), time: n.start, title: n.title || "", media: n.media || [],
      text: n.end > n.start ? `${n.text || ""}${n.text ? "\n" : ""}(${round1(n.end - n.start)} sn sürecek)` : n.text || "",
      createdBy: n.createdBy, createdAt: n.createdAt, updatedBy: n.updatedBy, updatedAt: n.updatedAt,
    }));
    return d;
  }
  return p;
}

export function loadProject(dir) {
  adoptLegacy(dir);
  let p = JSON.parse(fs.readFileSync(projectFile(dir), "utf8"));
  p = migrate(p);
  if (p.format !== FORMAT_VERSION) throw new Error(`Unknown project format ${p.format}`);
  p.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  for (const k of ["scripts", "events", "suggestions", "activity"]) p[k] ||= [];
  // older projects have free start times (gaps, overlaps): the flow keeps their order and closes them
  p.scripts.sort((x, y) => x.time - y.time);
  reflow(p, eventOwners(p));
  return p;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// ---- lock: a directory created atomically; a stale lock (crashed writer) is taken after 10 s ----
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
export function withLock(dir, fn) {
  const lock = path.join(dir, ".ccdesk.lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() > deadline) throw new Error("The project is busy (locked); try again");
      sleep(25);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// ---- derived ----
export function scriptDuration(p, s) {
  return tokenize(s.text, p.settings).duration;
}
export function scriptEnd(p, s) {
  return round1(s.time + scriptDuration(p, s));
}
export function lastTime(p) {
  return Math.max(0, ...p.scripts.map((s) => scriptEnd(p, s)), ...p.events.map((e) => e.time));
}
/** Scripts that start before the previous one has finished. */
export function overlaps(p) {
  const list = [...p.scripts].sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const prevEnd = scriptEnd(p, list[i - 1]);
    if (list[i].time < prevEnd - 0.05) out.push({ first: list[i - 1].id, second: list[i].id, by: round1(prevEnd - list[i].time) });
  }
  return out;
}

// ---- the flow ----
/** Scripts are one flow: in array order, each starts where the previous one ends, the first at 0. */
function layScripts(p) {
  let t = 0;
  for (const s of p.scripts) { s.time = t; t = scriptEnd(p, s); }
}
/** Which script each event goes with: the one being said at it (the earliest, if older data overlaps), else
 * the one before it: an event in a gap goes to that script's end, one after the last script keeps its offset. */
function eventOwners(p) {
  const seq = [...p.scripts].sort((x, y) => x.time - y.time);
  return p.events.map((e) => {
    const rec = { e, t0: e.time };
    const inside = seq.find((s) => s.time <= e.time && e.time < scriptEnd(p, s));
    if (inside) return { ...rec, s: inside, off: e.time - inside.time };
    const k = seq.findLastIndex((s) => s.time <= e.time);
    if (k < 0) return seq.length ? { ...rec, s: seq[0], off: e.time - seq[0].time } : rec;
    return k < seq.length - 1 ? { ...rec, s: seq[k], atEnd: true } : { ...rec, s: seq[k], off: e.time - seq[k].time };
  });
}
/** Lays the scripts out again and carries each event with its script (unless something set its time meanwhile).
 * Returns the ops that put the events back. */
function reflow(p, owners) {
  layScripts(p);
  const undo = [];
  for (const { e, t0, s, off, atEnd } of owners) {
    if (!s || !p.scripts.includes(s) || !p.events.includes(e) || e.time !== t0) continue;
    const nt = round1(Math.max(0, atEnd ? scriptEnd(p, s) : s.time + off));
    if (nt === e.time) continue;
    undo.push({ op: "updateEvent", id: e.id, time: e.time });
    e.time = nt;
  }
  return undo;
}
/** Puts s into the flow before the first other script that starts at or after t (at the end if none). */
function placeAt(p, s, t) {
  const before = p.scripts.find((x) => x !== s && x.time >= t - 1e-9);
  p.scripts = p.scripts.filter((x) => x !== s);
  const i = before ? p.scripts.indexOf(before) : p.scripts.length;
  p.scripts.splice(i, 0, s);
}
function placeIndex(p, s, index) {
  p.scripts = p.scripts.filter((x) => x !== s);
  p.scripts.splice(Math.max(0, Math.min(Number(index) || 0, p.scripts.length)), 0, s);
}

export const pendingCount = (p) => p.suggestions.filter((s) => s.status === "pending").length;

// ---- operations ----
function need(cond, msg) { if (!cond) throw new Error(msg); }
function at(t) {
  const x = round1(t);
  need(Number.isFinite(x) && x >= 0, "time must be a number of seconds ≥ 0");
  return x;
}
function find(list, id, what) {
  const item = list.find((x) => x.id === id);
  need(item, `No ${what} with id ${id}`);
  return item;
}
function stamp(item, actor, created) {
  const t = now();
  if (created) { item.createdBy = actor.id; item.createdAt = t; }
  item.updatedBy = actor.id;
  item.updatedAt = t;
  return item;
}
export function storeMediaFile(dir, src) {
  need(fs.existsSync(src) && fs.statSync(src).isFile(), `File not found: ${src}`);
  const id = newId("m");
  const name = `${id}-${path.basename(src).replace(/[^\p{L}\p{N}._-]+/gu, "-")}`;
  fs.mkdirSync(path.join(dir, MEDIA_DIR), { recursive: true });
  fs.copyFileSync(src, path.join(dir, MEDIA_DIR, name));
  return { id, file: name, name: path.basename(src) };
}
function makeMedia(dir, m, actor) {
  if (m.url) {
    need(/^https?:\/\//i.test(m.url), "url must start with http:// or https://");
    return stamp({ id: newId("m"), kind: "link", url: m.url, caption: String(m.caption || "") }, actor, true);
  }
  const stored = m.stored ? { id: m.mediaId || newId("m"), file: m.stored, name: m.name || m.stored } : storeMediaFile(dir, m.source);
  need(fs.existsSync(path.join(dir, MEDIA_DIR, stored.file)), `Media file missing: ${stored.file}`);
  return stamp({ id: stored.id, kind: mediaKind(stored.file), file: stored.file, name: stored.name, caption: String(m.caption || "") }, actor, true);
}

const ITEM_KEYS = { script: ["time", "text"], event: ["time", "title", "text"] };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Each op mutates p and returns {id, summary, undo: [ops]}. `dry` = validate only, touch no files. */
const OPS = {
  setSettings(p, a, { title, settings }) {
    const undo = { op: "setSettings", settings: {} };
    if (title !== undefined) { undo.title = p.title; p.title = String(title).slice(0, 200); }
    for (const [k, v] of Object.entries(settings || {})) {
      need(k in DEFAULT_SETTINGS, `Unknown setting ${k}`);
      if (k === "language") { // the content language
        need(v in LANGUAGES, `language must be one of ${Object.keys(LANGUAGES).join(", ")}`);
        undo.settings[k] = p.settings[k];
        p.settings[k] = v;
        continue;
      }
      need(Number.isFinite(Number(v)) && Number(v) >= 0, `${k} must be a number ≥ 0`);
      undo.settings[k] = p.settings[k];
      p.settings[k] = Number(v);
    }
    need(p.settings.syllablesPerSecond > 0, "syllablesPerSecond must be > 0");
    layScripts(p);
    return { id: null, summary: "ayarları değiştirdi", undo: [undo] };
  },

  /** Into the flow at `time`: before the script starting there, after the one being said there; at the end
   * without a time. */
  addScript(p, a, { time, text, id }) {
    const s = stamp({ id: id || newId("s"), time: time === undefined ? Infinity : at(time), text: String(text ?? "") }, a, true);
    need(!p.scripts.some((x) => x.id === s.id), "duplicate id");
    placeAt(p, s, s.time);
    layScripts(p);
    return { id: s.id, summary: `${s.time} sn'ye konuşma ekledi`, undo: [{ op: "deleteScript", id: s.id }] };
  },
  /** text: new words (the flow after it moves by the length change); time: move it in the flow (as addScript);
   * index: its place in the flow (what undo uses). */
  updateScript(p, a, o) {
    const s = find(p.scripts, o.id, "script");
    const undo = { op: "updateScript", id: s.id };
    if (o.text !== undefined) { undo.text = s.text; s.text = String(o.text); }
    if (o.time !== undefined || o.index !== undefined) {
      undo.index = p.scripts.indexOf(s);
      if (o.index !== undefined) placeIndex(p, s, o.index); else placeAt(p, s, at(o.time));
    }
    layScripts(p);
    stamp(s, a);
    return { id: s.id, summary: `${s.time} sn konuşmasını düzenledi`, undo: [undo] };
  },
  deleteScript(p, a, { id }) {
    const s = find(p.scripts, id, "script");
    const index = p.scripts.indexOf(s);
    p.scripts = p.scripts.filter((x) => x !== s);
    layScripts(p);
    return { id, summary: `${s.time} sn konuşmasını sildi`, undo: [{ op: "putScript", item: clone(s), index }] };
  },
  putScript(p, a, { item, index }) {
    need(item?.id && !p.scripts.some((x) => x.id === item.id), "putScript needs a new item with an id");
    const s = stamp(clone(item), a);
    if (index !== undefined) placeIndex(p, s, index); else placeAt(p, s, at(item.time));
    layScripts(p);
    return { id: item.id, summary: `${item.time} sn konuşmasını geri getirdi`, undo: [{ op: "deleteScript", id: item.id }] };
  },
  /** Two scripts trade places in the flow. */
  swapScripts(p, a, { a: idA, b: idB }) {
    need(idA !== idB, "swapScripts needs two different scripts");
    const x = find(p.scripts, idA, "script"), y = find(p.scripts, idB, "script");
    const i = p.scripts.indexOf(x), j = p.scripts.indexOf(y);
    const [tx, ty] = [x.time, y.time];
    p.scripts[i] = y; p.scripts[j] = x;
    layScripts(p);
    stamp(x, a); stamp(y, a);
    return { id: null, summary: `${Math.min(tx, ty)} sn ve ${Math.max(tx, ty)} sn konuşmalarının yerini değiştirdi`, undo: [{ op: "swapScripts", a: idA, b: idB }] };
  },

  addEvent(p, a, { time, title = "", text = "", media = [], id }, dir, dry) {
    const e = stamp({ id: id || newId("e"), time: at(time), title: String(title), text: String(text), media: [] }, a, true);
    need(!p.events.some((x) => x.id === e.id), "duplicate id");
    if (!dry) for (const m of media) e.media.push(makeMedia(dir, m, a));
    p.events.push(e);
    return { id: e.id, summary: `${e.time} sn'ye olay ekledi`, undo: [{ op: "deleteEvent", id: e.id }] };
  },
  updateEvent(p, a, o) {
    const e = find(p.events, o.id, "event");
    const undo = { op: "updateEvent", id: e.id, ...pick(e, ITEM_KEYS.event) };
    if (o.time !== undefined) e.time = at(o.time);
    if (o.title !== undefined) e.title = String(o.title);
    if (o.text !== undefined) e.text = String(o.text);
    stamp(e, a);
    return { id: e.id, summary: `${e.time} sn olayını düzenledi`, undo: [undo] };
  },
  deleteEvent(p, a, { id }) {
    const e = find(p.events, id, "event");
    p.events = p.events.filter((x) => x !== e); // media files stay on disk, so undo can bring them back
    return { id, summary: `${e.time} sn olayını sildi`, undo: [{ op: "putEvent", item: clone(e) }] };
  },
  putEvent(p, a, { item }) {
    need(item?.id && !p.events.some((x) => x.id === item.id), "putEvent needs a new item with an id");
    p.events.push(stamp(clone(item), a));
    return { id: item.id, summary: `${item.time} sn olayını geri getirdi`, undo: [{ op: "deleteEvent", id: item.id }] };
  },

  addMedia(p, a, o, dir, dry) {
    const e = find(p.events, o.eventId, "event");
    need(o.url || o.source || o.stored, "source (a file path), stored or url is required");
    if (dry) return { id: null, summary: "", undo: [] };
    const m = makeMedia(dir, o, a);
    e.media.push(m);
    stamp(e, a);
    return { id: m.id, summary: `olaya ${m.kind === "link" ? "bağlantı" : "medya"} ekledi`, undo: [{ op: "removeMedia", eventId: e.id, id: m.id }] };
  },
  updateMedia(p, a, { eventId, id, caption }) {
    const m = find(find(p.events, eventId, "event").media, id, "media");
    const undo = { op: "updateMedia", eventId, id, caption: m.caption };
    m.caption = String(caption ?? "");
    stamp(m, a);
    return { id, summary: "medya açıklamasını düzenledi", undo: [undo] };
  },
  removeMedia(p, a, { eventId, id }) {
    const e = find(p.events, eventId, "event");
    const i = e.media.findIndex((x) => x.id === id);
    need(i >= 0, `No media with id ${id}`);
    const [m] = e.media.splice(i, 1);
    stamp(e, a);
    return { id, summary: "olaydan medya kaldırdı", undo: [{ op: "putMedia", eventId, item: clone(m), index: i }] };
  },
  putMedia(p, a, { eventId, item, index }) {
    const e = find(p.events, eventId, "event");
    need(!e.media.some((x) => x.id === item.id), "media already there");
    e.media.splice(Math.min(index ?? e.media.length, e.media.length), 0, clone(item));
    return { id: item.id, summary: "medyayı geri getirdi", undo: [{ op: "removeMedia", eventId, id: item.id }] };
  },

  /** Move many events by `by` seconds. Scripts don't move: they flow back to back (reorder with swapScripts). */
  shiftItems(p, a, { scriptIds = [], eventIds = [], by }) {
    const d = round1(by);
    need(Number.isFinite(d) && d !== 0, "by must be a non-zero number of seconds");
    need(!scriptIds.length, "Scripts flow back to back from 0 and can't be shifted; reorder them with swapScripts");
    for (const id of eventIds) { const e = find(p.events, id, "event"); e.time = at(e.time + d); stamp(e, a); }
    return { id: null, summary: `${scriptIds.length + eventIds.length} öğeyi ${d} sn kaydırdı`, undo: [{ op: "shiftItems", scriptIds, eventIds, by: -d }] };
  },

  /** One script per paragraph (blank-line separated), into the flow at `time` (as addScript); a paragraph that
   * is only a [direction] becomes an event at the next script's start. */
  importScript(p, a, { text, time }) {
    need(typeof text === "string" && text.trim(), "text is required");
    const undo = [];
    const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const at0 = time === undefined ? Infinity : at(time);
    const before = p.scripts.find((x) => x.time >= at0 - 1e-9);
    let i = before ? p.scripts.indexOf(before) : p.scripts.length;
    const plan = []; // [script | null (end), directions before it]
    let pending = [];
    for (const para of paras) {
      if (/^\[[^\]]*\]$/.test(para.replace(/\s+/g, " "))) { pending.push(para.slice(1, -1).trim()); continue; }
      const s = stamp({ id: newId("s"), time: 0, text: para }, a, true);
      p.scripts.splice(i++, 0, s);
      undo.push({ op: "deleteScript", id: s.id });
      plan.push([s, pending]);
      pending = [];
    }
    plan.push([p.scripts[i] || null, pending]); // directions after the last paragraph: where the flow goes on
    layScripts(p);
    const last = p.scripts.at(-1);
    for (const [s, ds] of plan) for (const d of ds) {
      const body = d.replace(/^[^:]{1,20}:\s*/, ""); // "EKRAN: kartlar gelir" → title "kartlar gelir"
      const when = s ? s.time : last ? scriptEnd(p, last) : 0;
      const e = stamp({ id: newId("e"), time: when, title: body.length > 70 ? `${body.slice(0, 69)}…` : body, text: d, media: [] }, a, true);
      p.events.push(e);
      undo.push({ op: "deleteEvent", id: e.id });
    }
    return { id: null, summary: `senaryo yerleştirdi (${paras.length} paragraf)`, undo: undo.reverse() };
  },

  // ---- suggestions (Claude proposes, the owner decides) ----
  addSuggestion(p, a, { summary, ops, id }) {
    need(String(summary || "").trim(), "summary is required");
    need(Array.isArray(ops) && ops.length, "ops are required");
    for (const o of ops) need(SUGGESTABLE.has(o.op), `${o.op} can't be suggested`);
    const sg = stamp({ id: id || newId("g"), summary: String(summary).trim(), ops: clone(ops), status: "pending" }, a, true);
    p.suggestions.push(sg);
    return { id: sg.id, summary: `öneri yaptı: ${sg.summary.slice(0, 60)}`, undo: [{ op: "withdrawSuggestion", id: sg.id }] };
  },
  decideSuggestion(p, a, { id, accept, _restore }, dir, dry) {
    const sg = find(p.suggestions, id, "suggestion");
    need(sg.status === "pending", "This suggestion was already decided");
    if (_restore) { // redo of an undone decision: the content ops are redone separately
      sg.status = _restore;
      return { id, summary: "öneri kararını yeniden uyguladı", undo: [{ op: "reopenSuggestion", id }] };
    }
    let undo = [];
    if (accept) {
      const author = ACTORS.mcp; // the content is Claude's; the owner accepted it
      for (const o of sg.ops) {
        const fn = OPS[o.op];
        const r = fn(p, sg.createdBy === "ui" ? a : author, o, dir, dry);
        layScripts(p); // the next op finds the flow laid out (events are carried once, after the decision)
        undo = [...r.undo, ...undo];
      }
    }
    sg.status = accept ? "accepted" : "rejected";
    sg.decidedBy = a.id;
    sg.decidedAt = now();
    return { id, summary: accept ? `öneriyi uyguladı: ${sg.summary.slice(0, 50)}` : `öneriyi reddetti: ${sg.summary.slice(0, 50)}`,
      undo: [...undo, { op: "reopenSuggestion", id }] };
  },
  reopenSuggestion(p, a, { id }) {
    const sg = find(p.suggestions, id, "suggestion");
    const was = sg.status;
    sg.status = "pending";
    delete sg.decidedBy;
    delete sg.decidedAt;
    return { id, summary: "öneriyi yeniden açtı", undo: was === "pending" ? [] : [{ op: "decideSuggestion", id, accept: false, _restore: was }] };
  },
  withdrawSuggestion(p, a, { id }) {
    const sg = find(p.suggestions, id, "suggestion");
    need(sg.status === "pending", "Only a pending suggestion can be withdrawn");
    sg.status = "withdrawn";
    return { id, summary: "önerisini geri çekti", undo: [{ op: "reopenSuggestion", id }] };
  },
};

export const SUGGESTABLE = new Set(["addScript", "updateScript", "deleteScript", "addEvent", "updateEvent", "deleteEvent", "addMedia", "removeMedia", "shiftItems", "swapScripts", "setSettings", "importScript"]);
export const OP_NAMES = Object.keys(OPS);

function run(p, actor, ops, dir, dry) {
  const results = [];
  let undo = [];
  for (const o of ops) {
    const fn = OPS[o.op];
    need(fn, `Unknown operation ${o.op}`);
    const owners = eventOwners(p);
    const r = fn(p, actor, o, dir, dry);
    const carried = reflow(p, owners);
    results.push({ id: r.id, summary: r.summary });
    undo = [...r.undo, ...carried, ...undo];
    if (!dry) p.activity.push({ at: now(), actor: actor.id, op: o.op, id: r.id, summary: r.summary });
  }
  return { results, undo };
}

/** Applies ops [{op, ...}] as one change. Returns {project, results, undo}. Throws (and writes nothing) on error. */
export function applyOps(dir, actorId, ops) {
  const actor = ACTORS[actorId];
  need(actor, `Unknown actor ${actorId}`);
  return withLock(dir, () => {
    const p = loadProject(dir);
    const before = normalize(p);
    const { results, undo } = run(p, actor, ops, dir, false);
    if (p.activity.length > 500) p.activity = p.activity.slice(-500);
    p.revision += 1;
    p.updatedAt = now();
    writeAtomic(projectFile(dir), p);
    try {
      recordRevision(dir, { rev: p.revision, actor: actor.id, before, after: normalize(p),
        ops: ops.map((o, i) => ({ op: o.op, id: results[i]?.id ?? null, summary: results[i]?.summary ?? "" })) });
    } catch (e) { console.error(`ccdesk: history not recorded for revision ${p.revision}: ${e.message}`); }
    return { project: p, results, undo };
  });
}

/** Starts the version history at the current revision if it doesn't reach it yet (opening a project calls this). */
export function startHistory(dir) {
  return withLock(dir, () => {
    const p = loadProject(dir);
    ensureHistory(dir, p.revision, normalize(p));
    return p.revision;
  });
}

/** Checks that ops would apply to the current project (no files touched, nothing written). */
export function checkOps(dir, actorId, ops) {
  const p = loadProject(dir);
  run(p, ACTORS[actorId], clone(ops), dir, true);
  return true;
}

// ---- the owner's view, for Claude ----
export function writeUiState(dir, state) {
  fs.writeFileSync(path.join(dir, UI_FILE), JSON.stringify({ ...state, at: now() }));
}
export function readUiState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, UI_FILE), "utf8")); } catch { return null; }
}

export { estimateReading };
