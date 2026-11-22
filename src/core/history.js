// Version history: every revision's changes, so any two revisions can be compared.
//   <dir>/.ccdesk-history/log.jsonl       one line per revision: {rev, at, actor, ops: [{op, id, summary}], changes}
//   <dir>/.ccdesk-history/base-<rev>.json  the whole (normalized) project at a revision where the log (re)starts
// A change is {path: [...keys], from?, to?}; a missing `from` = it did not exist, a missing `to` = it was removed.
// The state is normalized (scripts and events keyed by id, the script order as a list, no derived or bookkeeping
// fields), so a diff says what really changed. A revision is rebuilt from the latest base at or before it plus the
// log's `to` values. If the log does not reach the project's revision (a project from before history, a hand edit),
// a new base is written and the chain restarts there; revisions before the first base cannot be rebuilt.
import fs from "node:fs";
import path from "node:path";
import { tokenize } from "./reading.js";
import { round1, formatTime } from "./time.js";

export const HISTORY_DIR = ".ccdesk-history";
const LOG = "log.jsonl";
const hdir = (dir) => path.join(dir, HISTORY_DIR);
const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// ---- the normalized state ----
const NOISE = new Set(["createdAt", "updatedAt", "updatedBy"]);
const keep = (o, drop = []) => Object.fromEntries(Object.entries(o).filter(([k]) => !NOISE.has(k) && !drop.includes(k)));

/** The project as compared: no revision/activity/timestamps, script times left out (they follow from order + text). */
export function normalize(p) {
  return {
    title: p.title,
    settings: clone(p.settings),
    scriptOrder: p.scripts.map((s) => s.id),
    scripts: Object.fromEntries(p.scripts.map((s) => [s.id, keep(s, ["id", "time"])])),
    events: Object.fromEntries(p.events.map((e) => [e.id, keep(clone(e), ["id"])])),
    suggestions: Object.fromEntries(p.suggestions.map((s) => [s.id, keep(clone(s), ["id"])])),
  };
}

/** Flat list of changes from a to b (objects compared key by key, arrays and values as a whole). */
export function diffStates(a, b, at = []) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const inA = a && k in a, inB = b && k in b, p = [...at, k];
    if (inA && inB) {
      if (isObj(a[k]) && isObj(b[k])) out.push(...diffStates(a[k], b[k], p));
      else if (!same(a[k], b[k])) out.push({ path: p, from: clone(a[k]), to: clone(b[k]) });
    } else if (inA) out.push({ path: p, from: clone(a[k]) });
    else out.push({ path: p, to: clone(b[k]) });
  }
  return out;
}

/** Applies changes forward (`to`) or backward (`from`) to a normalized state, in place. */
export function applyChanges(state, changes, side = "to") {
  for (const c of changes) {
    let o = state;
    for (const k of c.path.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
    const last = c.path.at(-1);
    if (side in c) o[last] = clone(c[side]); else delete o[last];
  }
  return state;
}

// ---- reading and writing the log ----
function lastLogLine(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let n = 4096; ; n *= 4) {
      const len = Math.min(n, size), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      if (lines.length > 1 || len === size) return lines.length ? JSON.parse(lines.at(-1)) : null;
    }
  } finally { fs.closeSync(fd); }
}
function readLog(dir) {
  try {
    return fs.readFileSync(path.join(hdir(dir), LOG), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const baseRevs = (dir) => {
  try { return fs.readdirSync(hdir(dir)).map((f) => /^base-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((x, y) => x - y); }
  catch { return []; }
};
function writeBase(dir, rev, state) {
  fs.mkdirSync(hdir(dir), { recursive: true });
  const file = path.join(hdir(dir), `base-${rev}.json`), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rev, at: new Date().toISOString(), state }));
  fs.renameSync(tmp, file);
}

/** Makes sure the history reaches revision `rev` whose normalized state is `state` (call inside the project lock). */
export function ensureHistory(dir, rev, state) {
  const last = lastLogLine(path.join(hdir(dir), LOG));
  const bases = baseRevs(dir);
  const reached = Math.max(last?.rev ?? -1, bases.at(-1) ?? -1);
  if (reached !== rev) writeBase(dir, rev, state);
}

/** Records one revision (call inside the project lock, after the project file is written). */
export function recordRevision(dir, { rev, actor, ops, before, after }) {
  ensureHistory(dir, rev - 1, before);
  const line = { rev, at: new Date().toISOString(), actor, ops, changes: diffStates(before, after) };
  fs.appendFileSync(path.join(hdir(dir), LOG), JSON.stringify(line) + "\n");
}

/** Revisions known to the history: [{rev, at, actor, ops, changeCount}] (+ `firstRev`, the oldest one that can be rebuilt). */
export function listRevisions(dir) {
  const bases = baseRevs(dir);
  const log = readLog(dir).map(({ rev, at, actor, ops, changes }) => ({ rev, at, actor, ops, changeCount: changes.length }));
  return { firstRev: bases[0] ?? null, revisions: log };
}

/** The normalized state at revision `rev` (throws if the history cannot rebuild it). */
export function stateAt(dir, rev) {
  const base = baseRevs(dir).filter((b) => b <= rev).at(-1);
  if (base === undefined) throw new Error(`Revision ${rev} is older than the history (it starts at ${baseRevs(dir)[0] ?? "the next change"})`);
  const { state } = JSON.parse(fs.readFileSync(path.join(hdir(dir), `base-${base}.json`), "utf8"));
  const log = readLog(dir).filter((l) => l.rev > base && l.rev <= rev).sort((x, y) => x.rev - y.rev);
  let expect = base + 1;
  for (const l of log) {
    if (l.rev !== expect) break; // a gap: a later base takes over (handled by choosing the latest base ≤ rev)
    applyChanges(state, l.changes, "to");
    expect++;
  }
  if (expect - 1 !== rev) throw new Error(`The history has a gap before revision ${rev}`);
  return state;
}

// ---- comparing two revisions ----
/** Script times and lengths of a normalized state (the flow: back to back from 0 in order). */
export function layout(state) {
  let t = 0;
  const out = {};
  for (const id of state.scriptOrder) {
    const s = state.scripts[id];
    if (!s) continue;
    const d = tokenize(s.text, state.settings).duration;
    out[id] = { start: t, end: round1(t + d), length: round1(d) };
    t = round1(t + d);
  }
  return { scripts: out, total: t };
}

/** Word-level diff of two texts: "[-removed-]{+added+}" around what changed. */
export function textDiff(a = "", b = "") {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  if (A.length * B.length > 4e6) return `[-${a}-]{+${b}+}`;
  const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const parts = [];
  const push = (kind, s) => { const l = parts.at(-1); if (l && l.kind === kind) l.s += s; else parts.push({ kind, s }); };
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("-", A[i++]);
    else push("+", B[j++]);
  }
  while (i < A.length) push("-", A[i++]);
  while (j < B.length) push("+", B[j++]);
  // long unchanged stretches are shortened so the change stands out
  return parts.map(({ kind, s }) => kind === "-" ? `[-${s}-]` : kind === "+" ? `{+${s}+}` :
    s.length > 120 ? `${s.slice(0, 50)} … ${s.slice(-50)}` : s).join("");
}

const who = (id) => (id === "mcp" ? "Claude" : "Taha");
const t = (s) => formatTime(s);
const short = (s, n = 90) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
const val = (v) => (typeof v === "string" ? `“${short(v, 120)}”` : JSON.stringify(v));

/** What changed between two revisions, as {from, to, revisions, changes, timing, text}. */
export function diffRevisions(dir, fromRev, toRev) {
  if (fromRev > toRev) [fromRev, toRev] = [toRev, fromRev];
  const A = stateAt(dir, fromRev), B = stateAt(dir, toRev);
  const changes = diffStates(A, B);
  const revisions = readLog(dir).filter((l) => l.rev > fromRev && l.rev <= toRev)
    .map(({ rev, at, actor, ops }) => ({ rev, at, actor, ops }));
  const la = layout(A), lb = layout(B);
  const timing = [];
  for (const id of new Set([...A.scriptOrder, ...B.scriptOrder])) {
    const x = la.scripts[id], y = lb.scripts[id];
    if (x && y && (x.start !== y.start || x.length !== y.length)) timing.push({ id, from: x, to: y });
  }

  const lines = [`# ccdesk diff: revision ${fromRev} → ${toRev}`];
  const byActor = {};
  for (const r of revisions) byActor[who(r.actor)] = (byActor[who(r.actor)] || 0) + 1;
  lines.push(`${revisions.length} revision(s)${Object.keys(byActor).length ? ` (${Object.entries(byActor).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}; ${changes.length} change(s) in the end result.`, "");
  if (revisions.length) {
    lines.push("## Revisions");
    for (const r of revisions) lines.push(`  ${r.rev}  ${r.at.slice(0, 19).replace("T", " ")}Z  ${who(r.actor)}: ${r.ops.map((o) => o.summary).join("; ")}`);
    lines.push("");
  }
  if (!changes.length) { lines.push("No difference in the result."); return { from: fromRev, to: toRev, revisions, changes, timing, text: lines.join("\n") }; }

  const group = (k) => changes.filter((c) => c.path[0] === k);
  const head = changes.filter((c) => c.path[0] === "title" || c.path[0] === "settings");
  if (head.length) {
    lines.push("## Title and settings");
    for (const c of head) lines.push(`  ${c.path.join(".")}: ${val(c.from)} → ${val(c.to)}`);
    lines.push("");
  }
  const items = (kind, label) => {
    const cs = group(kind);
    if (!cs.length) return;
    lines.push(`## ${label}`);
    const ids = [...new Set(cs.map((c) => c.path[1]))];
    for (const id of ids) {
      const mine = cs.filter((c) => c.path[1] === id);
      const whole = mine.find((c) => c.path.length === 2);
      if (whole && !("from" in whole)) {
        const x = whole.to;
        lines.push(`  + ${id} added${x.time != null ? ` at ${t(x.time)}` : ""}${kind === "scripts" && lb.scripts[id] ? ` at ${t(lb.scripts[id].start)} (${lb.scripts[id].length}s)` : ""}: ${x.title ? `“${short(x.title)}” ` : ""}${x.text || x.summary ? short(x.text || x.summary, 160) : ""}`);
      } else if (whole && !("to" in whole)) {
        const x = whole.from;
        lines.push(`  - ${id} removed: ${x.title ? `“${short(x.title)}” ` : ""}${short(x.text || x.summary, 160)}`);
      } else {
        const title = (kind === "events" ? (B.events[id]?.title) : null);
        lines.push(`  ~ ${id}${title ? ` “${short(title, 60)}”` : ""}`);
        for (const c of mine) {
          const field = c.path.slice(2).join(".");
          if (field === "text" && typeof c.from === "string" && typeof c.to === "string") lines.push(`      text: ${textDiff(c.from, c.to)}`);
          else if (field === "time") lines.push(`      time: ${t(c.from)} → ${t(c.to)}`);
          else if (field === "media") lines.push(`      media: ${(c.from || []).length} → ${(c.to || []).length} item(s) (${(c.to || []).map((m) => m.caption || m.name || m.url).join(", ")})`);
          else lines.push(`      ${field}: ${val(c.from)} → ${val(c.to)}`);
        }
      }
    }
    lines.push("");
  };
  items("scripts", "Scripts (what Buse says)");
  if (group("scriptOrder").length) {
    const a = A.scriptOrder.filter((id) => B.scriptOrder.includes(id)), b = B.scriptOrder.filter((id) => A.scriptOrder.includes(id));
    if (!same(a, b)) lines.push("## Script order", `  ${a.join(" → ")}`, `  becomes ${b.join(" → ")}`, "");
  }
  items("events", "Events (what happens on screen)");
  items("suggestions", "Suggestions");
  if (timing.length || la.total !== lb.total) {
    lines.push("## Timing (computed from order, text and reading speed)");
    lines.push(`  total spoken length: ${t(la.total)} → ${t(lb.total)}`);
    for (const { id, from, to } of timing) lines.push(`  ${id}: ${t(from.start)}–${t(from.end)} (${from.length}s) → ${t(to.start)}–${t(to.end)} (${to.length}s)`);
    lines.push("");
  }
  return { from: fromRev, to: toRev, revisions, changes, timing, text: lines.join("\n").trimEnd() };
}
