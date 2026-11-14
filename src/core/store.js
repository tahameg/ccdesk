// The project store: one folder = one project.
//   <dir>/kurgu.json      the whole state: scripts (what is said, from a moment on), events (what happens at a
//                         moment, with media), suggestions (Claude's proposed changes), activity
//   <dir>/medya/          files attached to events (copied in, so the folder is self-contained)
//   <dir>/.kurgu-ui.json  where the owner is looking (cursor, selection), written by the app for Claude
// The app and the MCP server change a project only through applyOps(): lock, read, apply, bump the revision,
// write atomically. Every op returns its inverse, so the app can undo and redo.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_SETTINGS, estimateReading, tokenize } from "./reading.js";
import { round1 } from "./time.js";

export const PROJECT_FILE = "kurgu.json";
export const UI_FILE = ".kurgu-ui.json";
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

export const projectFile = (dir) => path.join(dir, PROJECT_FILE);
export const isProjectDir = (dir) => fs.existsSync(projectFile(dir));

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
  let p = JSON.parse(fs.readFileSync(projectFile(dir), "utf8"));
  p = migrate(p);
  if (p.format !== FORMAT_VERSION) throw new Error(`Unknown project format ${p.format}`);
  p.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  for (const k of ["scripts", "events", "suggestions", "activity"]) p[k] ||= [];
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
  const lock = path.join(dir, ".kurgu.lock");
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
      need(Number.isFinite(Number(v)) && Number(v) >= 0, `${k} must be a number ≥ 0`);
      undo.settings[k] = p.settings[k];
      p.settings[k] = Number(v);
    }
    need(p.settings.syllablesPerSecond > 0, "syllablesPerSecond must be > 0");
    return { id: null, summary: "ayarları değiştirdi", undo: [undo] };
  },

  addScript(p, a, { time, text, id }) {
    need(typeof text === "string", "text is required");
    const s = stamp({ id: id || newId("s"), time: at(time), text }, a, true);
    need(!p.scripts.some((x) => x.id === s.id), "duplicate id");
    p.scripts.push(s);
    return { id: s.id, summary: `${s.time} sn'ye konuşma ekledi`, undo: [{ op: "deleteScript", id: s.id }] };
  },
  updateScript(p, a, o) {
    const s = find(p.scripts, o.id, "script");
    const undo = { op: "updateScript", id: s.id, ...pick(s, ITEM_KEYS.script) };
    if (o.time !== undefined) s.time = at(o.time);
    if (o.text !== undefined) s.text = String(o.text);
    stamp(s, a);
    return { id: s.id, summary: `${s.time} sn konuşmasını düzenledi`, undo: [undo] };
  },
  deleteScript(p, a, { id }) {
    const s = find(p.scripts, id, "script");
    p.scripts = p.scripts.filter((x) => x !== s);
    return { id, summary: `${s.time} sn konuşmasını sildi`, undo: [{ op: "putScript", item: clone(s) }] };
  },
  putScript(p, a, { item }) {
    need(item?.id && !p.scripts.some((x) => x.id === item.id), "putScript needs a new item with an id");
    p.scripts.push(stamp(clone(item), a));
    return { id: item.id, summary: `${item.time} sn konuşmasını geri getirdi`, undo: [{ op: "deleteScript", id: item.id }] };
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

  /** Move many items by `by` seconds (e.g. push everything after an overlap). */
  shiftItems(p, a, { scriptIds = [], eventIds = [], by }) {
    const d = round1(by);
    need(Number.isFinite(d) && d !== 0, "by must be a non-zero number of seconds");
    for (const id of scriptIds) { const s = find(p.scripts, id, "script"); s.time = at(s.time + d); stamp(s, a); }
    for (const id of eventIds) { const e = find(p.events, id, "event"); e.time = at(e.time + d); stamp(e, a); }
    return { id: null, summary: `${scriptIds.length + eventIds.length} öğeyi ${d} sn kaydırdı`, undo: [{ op: "shiftItems", scriptIds, eventIds, by: -d }] };
  },

  /** One script per paragraph (blank-line separated), back to back from `time`; a paragraph that is only a
   * [direction] becomes an event at the next script's start. */
  importScript(p, a, { text, time = 0, gap = 0.6 }) {
    need(typeof text === "string" && text.trim(), "text is required");
    let t = at(time);
    const undo = [];
    const pending = [];
    const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const addEv = (d, when) => {
      const body = d.replace(/^[^:]{1,20}:\s*/, ""); // "EKRAN: kartlar gelir" → title "kartlar gelir"
      const e = stamp({ id: newId("e"), time: when, title: body.length > 70 ? `${body.slice(0, 69)}…` : body, text: d, media: [] }, a, true);
      p.events.push(e);
      undo.push({ op: "deleteEvent", id: e.id });
    };
    for (const para of paras) {
      if (/^\[[^\]]*\]$/.test(para.replace(/\s+/g, " "))) { pending.push(para.slice(1, -1).trim()); continue; }
      const s = stamp({ id: newId("s"), time: t, text: para }, a, true);
      p.scripts.push(s);
      undo.push({ op: "deleteScript", id: s.id });
      for (const d of pending.splice(0)) addEv(d, t);
      t = round1(t + Math.max(1, tokenize(para, p.settings).duration) + gap);
    }
    for (const d of pending) addEv(d, t);
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

export const SUGGESTABLE = new Set(["addScript", "updateScript", "deleteScript", "addEvent", "updateEvent", "deleteEvent", "addMedia", "removeMedia", "shiftItems", "setSettings", "importScript"]);
export const OP_NAMES = Object.keys(OPS);

function run(p, actor, ops, dir, dry) {
  const results = [];
  let undo = [];
  for (const o of ops) {
    const fn = OPS[o.op];
    need(fn, `Unknown operation ${o.op}`);
    const r = fn(p, actor, o, dir, dry);
    results.push({ id: r.id, summary: r.summary });
    undo = [...r.undo, ...undo];
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
    const { results, undo } = run(p, actor, ops, dir, false);
    if (p.activity.length > 500) p.activity = p.activity.slice(-500);
    p.revision += 1;
    p.updatedAt = now();
    writeAtomic(projectFile(dir), p);
    return { project: p, results, undo };
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
