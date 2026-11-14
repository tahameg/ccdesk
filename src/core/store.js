// The project store: one folder = one project.
//   <dir>/kurgu.json   the whole state (scripts, notes, comments, activity)
//   <dir>/medya/       files attached to notes (copied in, so the project folder is self-contained)
// The Electron app and the MCP server both change a project only through applyOps(): read the file under a
// lock, apply the operations, bump the revision, write atomically. So the two writers never lose each other's work.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_READING, estimateReading } from "./reading.js";
import { round1 } from "./time.js";

export const PROJECT_FILE = "kurgu.json";
export const MEDIA_DIR = "medya";
export const FORMAT_VERSION = 1;

export const ACTORS = {
  ui: { id: "ui", name: "Taha" },
  mcp: { id: "mcp", name: "Claude" },
};

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

export function projectFile(dir) {
  return path.join(dir, PROJECT_FILE);
}

export function isProjectDir(dir) {
  return fs.existsSync(projectFile(dir));
}

export function emptyProject(title = "Yeni kurgu", duration = 600) {
  const t = now();
  return {
    format: FORMAT_VERSION,
    title,
    duration,
    reading: { ...DEFAULT_READING },
    revision: 0,
    createdAt: t,
    updatedAt: t,
    scripts: [],
    notes: [],
    comments: [],
    activity: [],
  };
}

export function createProject(dir, { title, duration } = {}) {
  if (isProjectDir(dir)) throw new Error(`There is already a project in ${dir}`);
  fs.mkdirSync(path.join(dir, MEDIA_DIR), { recursive: true });
  const p = emptyProject(title || path.basename(dir), duration || 600);
  writeAtomic(projectFile(dir), p);
  return p;
}

export function loadProject(dir) {
  const raw = fs.readFileSync(projectFile(dir), "utf8");
  const p = JSON.parse(raw);
  if (p.format !== FORMAT_VERSION) throw new Error(`Unknown project format ${p.format}`);
  p.reading = { ...DEFAULT_READING, ...(p.reading || {}) };
  for (const k of ["scripts", "notes", "comments", "activity"]) p[k] ||= [];
  return p;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// ---- lock: a directory, created atomically; a stale lock (crashed writer) is taken after 10 s ----
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(dir, fn) {
  const lock = path.join(dir, ".kurgu.lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("The project is busy (locked); try again");
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---- operations ----
function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

function range(p, start, end, { allowPoint = false } = {}) {
  const s = round1(start);
  const e = round1(end ?? start);
  need(Number.isFinite(s) && Number.isFinite(e), "start/end must be numbers (seconds)");
  need(s >= 0, "start must be ≥ 0");
  need(allowPoint ? e >= s : e > s, allowPoint ? "end must be ≥ start" : "end must be after start");
  if (e > p.duration) p.duration = Math.ceil(e + 10); // the timeline grows to fit
  return [s, e];
}

function find(list, id, what) {
  const item = list.find((x) => x.id === id);
  need(item, `No ${what} with id ${id}`);
  return item;
}

function stamp(item, actor, created) {
  const t = now();
  if (created) {
    item.createdBy = actor.id;
    item.createdAt = t;
  }
  item.updatedBy = actor.id;
  item.updatedAt = t;
  return item;
}

function copyMedia(dir, src, id) {
  need(fs.existsSync(src), `File not found: ${src}`);
  need(fs.statSync(src).isFile(), `Not a file: ${src}`);
  const base = path.basename(src).replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const name = `${id}-${base}`;
  fs.mkdirSync(path.join(dir, MEDIA_DIR), { recursive: true });
  fs.copyFileSync(src, path.join(dir, MEDIA_DIR, name));
  return name;
}

function describeTarget(p, target) {
  if (!target || target.type === "project") return "projeye";
  if (target.type === "time") return `${target.time} sn anına`;
  const list = target.type === "script" ? p.scripts : p.notes;
  const item = list.find((x) => x.id === target.id);
  return item ? `${target.type === "script" ? "senaryo" : "not"} ${item.start}–${item.end} sn` : "silinmiş öğeye";
}

/** Each op returns the id it touched; summary() says it in Turkish for the activity log. */
const OPS = {
  setProject(p, a, { title, duration, reading }) {
    if (title !== undefined) p.title = String(title).slice(0, 200);
    if (duration !== undefined) {
      const last = Math.max(0, ...p.scripts.map((s) => s.end), ...p.notes.map((n) => n.end));
      need(Number(duration) >= last, `duration must cover the last item (${last} s)`);
      p.duration = round1(duration);
    }
    if (reading) {
      for (const k of Object.keys(DEFAULT_READING)) {
        if (reading[k] !== undefined) {
          need(Number(reading[k]) >= 0, `${k} must be ≥ 0`);
          p.reading[k] = Number(reading[k]);
        }
      }
      need(p.reading.syllablesPerSecond > 0, "syllablesPerSecond must be > 0");
    }
    return { id: null, summary: "proje ayarlarını değiştirdi" };
  },

  addScript(p, a, { start, end, text }) {
    need(typeof text === "string", "text is required");
    const e = end ?? start + Math.max(1, estimateReading(text, p.reading).seconds);
    const [s, en] = range(p, start, e);
    const item = stamp({ id: newId("s"), start: s, end: en, text: text.trim() }, a, true);
    p.scripts.push(item);
    return { id: item.id, summary: `senaryo ekledi (${s}–${en} sn)` };
  },
  updateScript(p, a, { id, start, end, text }) {
    const item = find(p.scripts, id, "script");
    const [s, en] = range(p, start ?? item.start, end ?? item.end);
    Object.assign(item, { start: s, end: en });
    if (text !== undefined) item.text = String(text);
    stamp(item, a);
    return { id, summary: `senaryoyu düzenledi (${s}–${en} sn)` };
  },
  deleteScript(p, a, { id }) {
    const item = find(p.scripts, id, "script");
    p.scripts = p.scripts.filter((x) => x !== item);
    detachComments(p, "script", item);
    return { id, summary: `senaryoyu sildi (${item.start}–${item.end} sn)` };
  },

  addNote(p, a, { start, end, title = "", text = "" }) {
    const [s, en] = range(p, start, end ?? start, { allowPoint: true });
    const item = stamp({ id: newId("n"), start: s, end: en, title: String(title), text: String(text), media: [] }, a, true);
    p.notes.push(item);
    return { id: item.id, summary: `${s === en ? "olay" : "not"} ekledi (${s === en ? s : `${s}–${en}`} sn)` };
  },
  updateNote(p, a, { id, start, end, title, text }) {
    const item = find(p.notes, id, "note");
    const [s, en] = range(p, start ?? item.start, end ?? item.end, { allowPoint: true });
    Object.assign(item, { start: s, end: en });
    if (title !== undefined) item.title = String(title);
    if (text !== undefined) item.text = String(text);
    stamp(item, a);
    return { id, summary: `notu düzenledi (${s}–${en} sn)` };
  },
  deleteNote(p, a, { id }, dir) {
    const item = find(p.notes, id, "note");
    p.notes = p.notes.filter((x) => x !== item);
    for (const m of item.media) if (m.file) fs.rmSync(path.join(dir, MEDIA_DIR, m.file), { force: true });
    detachComments(p, "note", item);
    return { id, summary: `notu sildi (${item.start}–${item.end} sn)` };
  },

  addMedia(p, a, { noteId, source, url, caption = "" }, dir) {
    const note = find(p.notes, noteId, "note");
    const id = newId("m");
    let m;
    if (url) {
      need(/^https?:\/\//i.test(url), "url must start with http:// or https://");
      m = { id, kind: "link", url, caption: String(caption) };
    } else {
      need(source, "source (a file path) or url is required");
      const file = copyMedia(dir, source, id);
      m = { id, kind: mediaKind(file), file, name: path.basename(source), caption: String(caption) };
    }
    stamp(m, a, true);
    note.media.push(m);
    stamp(note, a);
    return { id, summary: `nota ${m.kind === "link" ? "bağlantı" : "medya"} ekledi` };
  },
  updateMedia(p, a, { noteId, id, caption }) {
    const note = find(p.notes, noteId, "note");
    const m = find(note.media, id, "media");
    m.caption = String(caption ?? "");
    stamp(m, a);
    return { id, summary: "medya açıklamasını düzenledi" };
  },
  removeMedia(p, a, { noteId, id }, dir) {
    const note = find(p.notes, noteId, "note");
    const m = find(note.media, id, "media");
    note.media = note.media.filter((x) => x !== m);
    if (m.file) fs.rmSync(path.join(dir, MEDIA_DIR, m.file), { force: true });
    stamp(note, a);
    return { id, summary: "nottan medya kaldırdı" };
  },

  addComment(p, a, { target, text }) {
    need(String(text || "").trim(), "text is required");
    const t = normalizeTarget(p, target);
    const c = stamp({ id: newId("c"), target: t, text: String(text).trim(), resolved: false, replies: [] }, a, true);
    p.comments.push(c);
    return { id: c.id, summary: `${describeTarget(p, t)} yorum yazdı` };
  },
  replyComment(p, a, { id, text }) {
    const c = find(p.comments, id, "comment");
    need(String(text || "").trim(), "text is required");
    c.replies.push(stamp({ id: newId("r"), text: String(text).trim() }, a, true));
    stamp(c, a);
    return { id, summary: "yoruma cevap yazdı" };
  },
  resolveComment(p, a, { id, resolved = true }) {
    const c = find(p.comments, id, "comment");
    c.resolved = Boolean(resolved);
    c.resolvedBy = c.resolved ? a.id : undefined;
    stamp(c, a);
    return { id, summary: c.resolved ? "yorumu çözüldü olarak işaretledi" : "yorumu yeniden açtı" };
  },
  editComment(p, a, { id, text }) {
    const c = find(p.comments, id, "comment");
    need(c.createdBy === a.id, "Only the author can edit a comment");
    c.text = String(text).trim();
    stamp(c, a);
    return { id, summary: "yorumunu düzenledi" };
  },
  deleteComment(p, a, { id }) {
    const c = find(p.comments, id, "comment");
    need(c.createdBy === a.id, "Only the author can delete a comment");
    p.comments = p.comments.filter((x) => x !== c);
    return { id, summary: "yorumunu sildi" };
  },

  /** Lays a whole script out on the timeline: one script item per paragraph, back to back, each as long as its
   * reading estimate plus a gap; a paragraph that is only a [direction] becomes a note at that point. */
  importScript(p, a, { text, start = 0, gap = 0.5 }) {
    need(typeof text === "string" && text.trim(), "text is required");
    let t = round1(start);
    const ids = [];
    const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const pending = [];
    for (const para of paras) {
      const onlyDirection = /^\[[^\]]*\]$/.test(para.replace(/\s+/g, " "));
      if (onlyDirection) {
        pending.push(para.slice(1, -1).trim());
        continue;
      }
      const est = Math.max(1, estimateReading(para, p.reading).seconds);
      const [s, e] = range(p, t, t + est);
      const item = stamp({ id: newId("s"), start: s, end: e, text: para }, a, true);
      p.scripts.push(item);
      ids.push(item.id);
      for (const d of pending) {
        const n = stamp({ id: newId("n"), start: s, end: e, title: d.split(":")[0].slice(0, 60), text: d, media: [] }, a, true);
        p.notes.push(n);
        ids.push(n.id);
      }
      pending.length = 0;
      t = round1(e + gap);
    }
    for (const d of pending) {
      const n = stamp({ id: newId("n"), start: t, end: t, title: d.split(":")[0].slice(0, 60), text: d, media: [] }, a, true);
      p.notes.push(n);
      ids.push(n.id);
    }
    return { id: null, ids, summary: `senaryo içe aktardı (${paras.length} paragraf, ${formatEnd(t)} sn)` };
  },
};

const formatEnd = (t) => round1(t);

function normalizeTarget(p, target) {
  const t = target || { type: "project" };
  if (t.type === "script") find(p.scripts, t.id, "script");
  else if (t.type === "note") find(p.notes, t.id, "note");
  else if (t.type === "time") need(Number.isFinite(Number(t.time)) && t.time >= 0, "time must be ≥ 0");
  else need(t.type === "project", `Unknown comment target ${t.type}`);
  return t.type === "time" ? { type: "time", time: round1(t.time) } : t.type === "project" ? { type: "project" } : { type: t.type, id: t.id };
}

/** Comments on a deleted item stay, pinned to where it started. */
function detachComments(p, type, item) {
  for (const c of p.comments) {
    if (c.target.type === type && c.target.id === item.id) c.target = { type: "time", time: item.start, deleted: type };
  }
}

export const OP_NAMES = Object.keys(OPS);

/** Applies ops [{op, ...args}] as one change. Returns {project, results}. Throws (and writes nothing) on any error. */
export function applyOps(dir, actorId, ops) {
  const actor = ACTORS[actorId];
  need(actor, `Unknown actor ${actorId}`);
  return withLock(dir, () => {
    const p = loadProject(dir);
    const results = [];
    for (const o of ops) {
      const fn = OPS[o.op];
      need(fn, `Unknown operation ${o.op}`);
      const r = fn(p, actor, o, dir);
      results.push(r);
      p.activity.push({ at: now(), actor: actor.id, op: o.op, id: r.id, summary: r.summary });
    }
    if (p.activity.length > 500) p.activity = p.activity.slice(-500);
    p.revision += 1;
    p.updatedAt = now();
    writeAtomic(projectFile(dir), p);
    return { project: p, results };
  });
}

// ---- derived views ----
export function unresolvedCount(p) {
  return p.comments.filter((c) => !c.resolved).length;
}

export function scriptFit(p, s) {
  const est = estimateReading(s.text, p.reading).seconds;
  const len = round1(s.end - s.start);
  return { estimate: est, length: len, over: round1(est - len) };
}
