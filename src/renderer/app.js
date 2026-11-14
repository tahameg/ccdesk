// Kurgu Masası window. The project file is the state; every change is an op applied by the main process
// (window.kurgu.apply) which returns the new project and the ops that undo it. Claude's changes arrive via onChanged.
import { tokenize, tokenAt } from "../core/reading.js";
import { formatTime, parseTime } from "../core/time.js";
import { describeOps } from "../core/describe.js";
import { Terminal } from "../../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";

const K = window.kurgu;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r1 = (x) => Math.round(x * 10) / 10;
const fmtS = (x) => String(r1(x)).replace(".", ",");
const WHO = { ui: "Taha", mcp: "Claude" };
const ROW = 54, RULER = 26, PAD_END = 240;

const S = {
  dir: null, project: null,
  sel: null, // {type: "script" | "event", id} — id null = composing a new one at sel.time
  pps: 24, playhead: 0, hover: null,
  playing: null, // {t0, from}
  undo: [], redo: [],
  hotSuggestion: null, showDecided: false,
  inspectorKey: null, saving: 0, smoke: null,
  term: null, termStarted: false,
};

// ---------- small helpers ----------
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "az önce";
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return new Date(iso).toLocaleDateString("tr-TR");
}
function toast(msg, kind = "error") {
  const el = Object.assign(document.createElement("div"), { className: `toast ${kind}`, textContent: msg });
  document.body.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 5000 : 3000);
}
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
const list = (type) => (type === "script" ? S.project.scripts : S.project.events);
const getSel = () => (S.sel?.id ? list(S.sel.type).find((x) => x.id === S.sel.id) : null);

const tokCache = new Map();
function toks(s) {
  const key = `${s.text}|${JSON.stringify(S.project.settings)}`;
  let v = tokCache.get(s.id);
  if (!v || v.key !== key) { v = { key, ...tokenize(s.text, S.project.settings) }; tokCache.set(s.id, v); }
  return v;
}
const dur = (s) => toks(s).duration;
const endOf = (s) => r1(s.time + dur(s));
const sortedScripts = () => [...S.project.scripts].sort((a, b) => a.time - b.time);
const lastTime = () => Math.max(0, ...S.project.scripts.map(endOf), ...S.project.events.map((e) => e.time));
const duration = () => Math.max(60, lastTime() + 30);

// ---------- applying changes ----------
async function apply(ops, { record = true, quiet = false } = {}) {
  S.saving++;
  renderSaved();
  try {
    const r = await K.apply(ops);
    S.project = r.project;
    if (record && r.undo?.length) { S.undo.push(r.undo); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
    renderAll();
    return r;
  } catch (e) {
    if (!quiet) toast(e.message);
    throw e;
  } finally {
    S.saving--;
    renderSaved();
  }
}
async function undoRedo(from, to, label) {
  const ops = from.pop();
  if (!ops) return toast(`${label} için bir şey yok`, "info");
  flushAll();
  try {
    const r = await apply(ops, { record: false });
    to.push(r.undo);
  } catch { toast(`${label} yapılamadı (Claude bu arada değiştirmiş olabilir)`); }
}
const undo = () => undoRedo(S.undo, S.redo, "Geri alma");
const redo = () => undoRedo(S.redo, S.undo, "Yineleme");

// debounced text edits
const pending = new Map();
function later(key, op, ms = 500) {
  clearTimeout(pending.get(key)?.t);
  pending.set(key, { op, t: setTimeout(() => flush(key), ms) });
}
function flush(key) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.t);
  pending.delete(key);
  apply([p.op]).catch(() => {});
}
const flushAll = () => [...pending.keys()].forEach(flush);

// ---------- top bar ----------
function renderTop() {
  const p = S.project;
  if (document.activeElement !== $("#title")) $("#title").value = p.title;
  $("#stat-length").innerHTML = `Süre <b>${formatTime(lastTime())}</b>`;
  for (const [id, k] of [["#set-speed", "syllablesPerSecond"], ["#set-unit", "silenceUnit"], ["#set-sentence", "sentencePause"], ["#set-comma", "commaPause"]]) {
    if (document.activeElement !== $(id)) $(id).value = p.settings[k];
  }
  const n = p.suggestions.filter((s) => s.status === "pending").length;
  const b = $("#badge-sugg");
  b.textContent = n ? `✦ ${n} öneri bekliyor` : "✦ öneri yok";
  b.classList.toggle("has", n > 0);
}
function renderSaved() {
  $("#stat-saved").textContent = S.saving ? "kaydediliyor…" : S.project ? `kaydedildi · rev ${S.project.revision}` : "";
}

// ---------- the screen: what is said and shown at a moment ----------
function scriptAt(t) {
  for (const s of sortedScripts()) if (t >= s.time && t < s.time + dur(s)) return s;
  return null;
}
function renderScreen() {
  if (!S.project) return;
  const t = S.hover ?? S.playhead;
  const evs = [...S.project.events].sort((a, b) => a.time - b.time);
  const active = evs.filter((e) => e.time <= t + 0.05).at(-1);
  const s = scriptAt(t);
  const vis = active?.media.find((m) => m.kind === "image" || m.kind === "video");
  let mon = "";
  if (vis) mon += vis.kind === "image" ? `<img src="${K.mediaUrl(vis.file)}" alt="">` : `<video src="${K.mediaUrl(vis.file)}" muted preload="metadata"></video>`;
  else mon += `<div class="card-title">${active ? esc(active.title || active.text.split("\n")[0]) : '<span class="empty">Bu anda bir olay yok</span>'}</div>`;
  if (active) mon += `<div class="chip">⚑ ${formatTime(active.time)} · ${esc(active.title || "olay")}</div>`;
  mon += `<div class="tc">${formatTime(t)}</div>`;
  let sub = "", state = "", text = "";
  if (s) {
    const { tokens } = toks(s);
    const { token } = tokenAt(tokens, t - s.time);
    const words = tokens.filter((k) => k.type !== "direction");
    let i = token ? words.indexOf(token) : words.findIndex((k) => k.start > t - s.time);
    if (i < 0) i = words.length;
    const from = Math.max(0, i - 6), to = Math.min(words.length, i + 9);
    sub = words.slice(from, to).map((k, j) => {
      const idx = from + j;
      if (k.type === "silence") return idx === i ? `<span class="silence">⏸ ${fmtS(k.end - k.start)} sn</span>` : `<span class="${idx < i ? "past" : "next"}">⏸</span>`;
      return `<span class="${idx < i ? "past" : idx === i ? "cur" : "next"}">${esc(k.text)}</span>`;
    }).join(" ");
    state = token?.type === "silence" ? `Sessizlik (${fmtS(token.end - token.start)} sn)` : `Konuşuyor · ${formatTime(s.time)}–${formatTime(endOf(s))}`;
    let pos = 0;
    for (const k of tokens) {
      text += esc(s.text.slice(pos, k.index));
      const raw = esc(s.text.slice(k.index, k.index + k.length));
      if (k.type === "direction") text += `<span class="dir">${raw}</span>`;
      else if (k.type === "silence") text += `<span class="${k === token ? "silence-cur" : "sil"}">${raw}</span>`;
      else text += `<span class="${k === token ? "cur" : k.end <= t - s.time ? "done" : ""}">${raw}</span>`;
      pos = k.index + k.length;
    }
    text += esc(s.text.slice(pos));
  } else {
    const next = sortedScripts().find((x) => x.time > t);
    state = next ? `Konuşma yok · sonraki ${fmtS(next.time - t)} sn sonra` : "Konuşma yok";
    text = next ? `<span class="faint">Sonraki: ${esc(next.text.slice(0, 160))}</span>` : '<span class="faint">Konuşma şeridinde bir ana tıklayıp yazmaya başlayın.</span>';
  }
  if (sub) mon += `<div class="sub">${sub}</div>`;
  $("#monitor").innerHTML = mon;
  const near = evs.filter((e) => e !== active && e.time > t && e.time - t <= 10);
  $("#now").innerHTML = `<div class="now-head"><span class="now-time">${formatTime(t)}</span><span class="now-state">${state}${S.hover != null && !S.playing ? " · fareyle bakılıyor" : ""}</span></div>
    <div class="faint" style="font-size:12px">${active ? `Ekranda: <b style="color:var(--event)">${esc(active.title || active.text.split("\n")[0])}</b> (${formatTime(active.time)}'dan beri)` : "Henüz bir olay yok"}</div>
    <div class="now-text" id="now-text">${text}</div>
    <div class="now-events">${near.map((e) => `<span class="ev" data-goto-event="${e.id}">⚑ ${fmtS(e.time - t)} sn sonra · ${esc(e.title || e.text.split("\n")[0] || "olay")}</span>`).join("")}</div>`;
  $("#now-text .cur, #now-text .silence-cur")?.scrollIntoView({ block: "nearest" });
}

// ---------- timeline ----------
const X = (t) => t * S.pps;
const T = (x) => Math.max(0, r1(x / S.pps));

function stack(items, startOf, endOfItem) {
  const rows = [], pos = new Map();
  for (const it of [...items].sort((a, b) => startOf(a) - startOf(b))) {
    let r = rows.findIndex((end) => end <= startOf(it) + 1e-6);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = endOfItem(it);
    pos.set(it.id, r);
  }
  return { rows: Math.max(1, rows.length), pos };
}

function pendingGhosts() {
  const out = { scripts: [], events: [], touched: new Map() };
  for (const sg of S.project.suggestions.filter((x) => x.status === "pending")) {
    for (const o of sg.ops) {
      if (o.op === "addScript") out.scripts.push({ sg: sg.id, time: o.time, text: o.text, d: tokenize(o.text, S.project.settings).duration });
      else if (o.op === "addEvent") out.events.push({ sg: sg.id, time: o.time, title: o.title || o.text });
      else if (o.op === "shiftItems") for (const id of [...(o.scriptIds || []), ...(o.eventIds || [])]) out.touched.set(id, sg.id);
      else if (o.eventId) out.touched.set(o.eventId, sg.id);
      else if (o.id) out.touched.set(o.id, sg.id);
    }
  }
  return out;
}

function renderTimeline() {
  const p = S.project;
  const inner = $("#tl-inner");
  const D = duration();
  const scripts = sortedScripts();
  const st = stack(scripts, (s) => s.time, (s) => s.time + Math.max(dur(s), 0.3));
  const evs = [...p.events].sort((a, b) => a.time - b.time);
  const labelW = (e) => (Math.min(40, (e.title || e.text.split("\n")[0] || "olay").length) * 6.6 + 40) / S.pps;
  const se = stack(evs, (e) => e.time, (e) => e.time + labelW(e));
  const evRows = Math.min(3, se.rows);
  const hS = st.rows * ROW, hE = Math.max(1, evRows) * 26 + 10;
  const ghosts = pendingGhosts();
  const hot = (sgId) => (S.hotSuggestion === sgId ? " hot" : "");

  const step = S.pps >= 60 ? 1 : S.pps >= 20 ? 5 : S.pps >= 6 ? 10 : 30;
  let ticks = "";
  for (let t = 0; t <= D + 1e-6; t += step) ticks += `<div class="tick" style="left:${X(t)}px">${formatTime(t, false)}</div>`;
  const minor = step / 5;
  if (S.pps * minor >= 7) for (let t = minor; t <= D; t += minor) if (Math.abs(t / step - Math.round(t / step)) > 1e-6) ticks += `<div class="tick minor" style="left:${X(t)}px"></div>`;

  const clashes = [];
  for (let i = 1; i < scripts.length; i++) {
    const e = endOf(scripts[i - 1]);
    if (scripts[i].time < e - 0.05) clashes.push({ id: scripts[i].id, from: scripts[i].time, to: Math.min(e, endOf(scripts[i])) });
  }
  const clashIds = new Set(clashes.map((c) => c.id));

  const beams = scripts.map((s) => {
    const { tokens, duration: d } = toks(s);
    const w = Math.max(3, X(d));
    let segs = "", runStart = null, runEnd = null;
    const flushRun = () => { if (runStart != null) segs += `<span class="seg lit" style="left:${X(runStart)}px;width:${Math.max(1, X(runEnd - runStart))}px"></span>`; runStart = null; };
    for (const k of tokens) {
      if (k.type === "word") { if (runStart == null) runStart = k.start; runEnd = k.end; }
      else if (k.type === "silence") {
        if (runStart != null) runEnd = Math.max(runEnd, k.start);
        flushRun();
        segs += `<span class="seg sil" style="left:${X(k.start)}px;width:${Math.max(1, X(k.end - k.start))}px">${X(k.end - k.start) > 24 ? "<span>⏸</span>" : ""}</span>`;
      }
    }
    flushRun();
    if (!tokens.length) segs = `<span class="seg lit" style="left:0;width:3px"></span>`;
    const touched = ghosts.touched.get(s.id);
    return `<div class="beam ${S.sel?.id === s.id ? "sel" : ""} ${clashIds.has(s.id) ? "clash" : ""} ${touched ? `touched${hot(touched)}` : ""}" data-type="script" data-id="${s.id}"
      style="left:${X(s.time)}px;width:${w}px;top:${st.pos.get(s.id) * ROW + 4}px" title="${esc(s.text)}\n\n${formatTime(s.time)}–${formatTime(endOf(s))} · ${fmtS(d)} sn">
      ${segs}<span class="start"></span><span class="label">${esc(s.text.replace(/\s+/g, " ").slice(0, 200)) || "<i>(boş)</i>"}</span>${s.createdBy === "mcp" ? '<span class="by">C</span>' : ""}</div>`;
  }).join("");
  const clashEls = clashes.map((c) => `<div class="clash-zone" style="left:${X(c.from)}px;width:${Math.max(2, X(c.to - c.from))}px;top:0;height:${hS}px"></div>`).join("");
  const sGhosts = ghosts.scripts.map((g) => `<div class="ghost${hot(g.sg)}" style="left:${X(g.time)}px;width:${Math.max(30, X(g.d))}px;top:${hS - ROW + 8}px;height:${ROW - 16}px">✦ ${esc(g.text.slice(0, 80))}</div>`).join("");

  const events = evs.map((e) => {
    const r = Math.min(evRows - 1, se.pos.get(e.id));
    const touched = ghosts.touched.get(e.id);
    return `<div class="evline" style="left:${X(e.time)}px"></div><div class="diamond ${S.sel?.id === e.id ? "sel" : ""} ${touched ? `touched${hot(touched)}` : ""}" data-type="event" data-id="${e.id}" style="left:${X(e.time)}px;top:${r * 26 + 8}px" title="${esc(e.title)}\n${esc(e.text)}"></div><div class="evlabel" style="left:${X(e.time)}px;top:${r * 26 + 5}px">${esc(e.title || e.text.split("\n")[0] || "olay")}${e.media.length ? `<span class="m">📎${e.media.length}</span>` : ""}${e.createdBy === "mcp" ? '<span class="m" style="color:var(--claude)">C</span>' : ""}</div>`;
  }).join("");
  const eGhosts = ghosts.events.map((g) => `<div class="ghost ev${hot(g.sg)}" style="left:${X(g.time)}px;top:8px" title="Öneri: ${esc(g.title)}"></div>`).join("");

  $("#app").style.setProperty("--tl-h", `${RULER + hS + hE + 18}px`);
  inner.style.width = `${X(D) + PAD_END}px`;
  inner.style.height = `${RULER + hS + hE}px`;
  inner.innerHTML = `<div class="ruler" data-lane="ruler">${ticks}</div>
    <div class="lane speech" data-lane="speech" style="height:${hS}px">${clashEls}${beams}${sGhosts}</div>
    <div class="lane events" data-lane="events" style="height:${hE}px">${events}${eGhosts}</div>
    <div class="playhead" id="playhead" style="left:${X(S.playhead)}px"></div>
    <div class="hoverline" id="hoverline" style="left:${X(S.hover ?? 0)}px" ${S.hover == null ? "hidden" : ""}></div>
    <div class="hovertime" id="hovertime" style="left:${X(S.hover ?? 0)}px" ${S.hover == null ? "hidden" : ""}>${formatTime(S.hover ?? 0)}</div>`;
  $("#labels").innerHTML = `<div class="l-speech" style="height:${hS}px">Konuşma</div><div class="l-event" style="height:${hE}px">Olaylar</div>`;
}

function movePlayhead(t, { scroll = false } = {}) {
  S.playhead = Math.max(0, r1(t));
  const ph = $("#playhead");
  if (ph) ph.style.left = `${X(S.playhead)}px`;
  $("#clock").textContent = formatTime(S.playhead);
  if (scroll) {
    const sc = $("#tl-scroll");
    const x = X(S.playhead);
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
  }
  renderScreen();
  reportUi();
}
function setHover(t) {
  S.hover = t;
  const hl = $("#hoverline"), ht = $("#hovertime");
  if (hl) { hl.hidden = t == null; ht.hidden = t == null; if (t != null) { hl.style.left = ht.style.left = `${X(t)}px`; ht.textContent = formatTime(t); } }
  renderScreen();
  reportUi();
}

// tell Claude where the owner is looking (debounced)
let uiTimer = null;
function reportUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const sc = $("#tl-scroll");
    K.uiState({ playhead: S.playhead, hover: S.hover, selected: S.sel?.id ? { type: S.sel.type, id: S.sel.id } : null,
      view: [T(sc.scrollLeft), T(sc.scrollLeft + sc.clientWidth)], playing: !!S.playing });
  }, S.playing ? 250 : 150);
}

function select(sel, { scroll = false } = {}) {
  if (S.sel?.id !== sel?.id || (sel && !sel.id)) flushAll();
  S.sel = sel;
  renderTimeline();
  renderInspector();
  reportUi();
  if (scroll && sel) {
    const it = getSel();
    const sc = $("#tl-scroll");
    const x = X(it ? it.time : sel.time);
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 100) sc.scrollLeft = Math.max(0, x - 140);
  }
}

function snap(t, ignoreId) {
  const cands = [S.playhead, 0];
  for (const s of S.project.scripts) if (s.id !== ignoreId) cands.push(s.time, endOf(s));
  for (const e of S.project.events) if (e.id !== ignoreId) cands.push(e.time);
  let best = r1(t), bd = 7 / S.pps;
  for (const c of cands) if (Math.abs(c - t) < bd) { best = c; bd = Math.abs(c - t); }
  return Math.max(0, r1(best));
}
const evTime = (e) => T(e.clientX - $("#tl-inner").getBoundingClientRect().left);

function onTimelineDown(e) {
  if (e.button !== 0) return;
  const lane = e.target.closest("[data-lane]")?.dataset.lane;
  const itemEl = e.target.closest("[data-id]");
  if (S.playing) stopPlay();
  if (lane === "ruler") {
    movePlayhead(evTime(e));
    const move = (ev) => movePlayhead(evTime(ev));
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    return;
  }
  if (itemEl) {
    const { type, id } = itemEl.dataset;
    const it = list(type).find((x) => x.id === id);
    if (S.sel?.id !== id) select({ type, id });
    const t0 = evTime(e), orig = it.time;
    let moved = false, next = orig;
    const move = (ev) => {
      const dt = evTime(ev) - t0;
      if (!moved && Math.abs(dt) * S.pps < 4) return;
      moved = true;
      next = snap(orig + dt, id);
      const el = $(`#tl-inner [data-id="${id}"]`);
      el.style.left = `${X(next)}px`;
      if (type === "event") { el.previousElementSibling.style.left = el.style.left; el.nextElementSibling.style.left = el.style.left; }
      $("#clock").textContent = formatTime(next);
      setHover(next);
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      $("#clock").textContent = formatTime(S.playhead);
      if (moved && next !== orig) apply([{ op: type === "script" ? "updateScript" : "updateEvent", id, time: next }]).catch(() => renderTimeline());
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    e.preventDefault();
    return;
  }
  if (lane === "speech" || lane === "events") {
    const t = snap(evTime(e));
    movePlayhead(t);
    select({ type: lane === "speech" ? "script" : "event", id: null, time: t });
    setTimeout(() => $("#inspector [data-autofocus]")?.focus(), 20);
  }
}

function zoom(factor, anchorX) {
  const sc = $("#tl-scroll");
  const rect = sc.getBoundingClientRect();
  const ax = anchorX ?? rect.left + rect.width / 2;
  const tAt = (sc.scrollLeft + ax - rect.left) / S.pps;
  S.pps = Math.min(400, Math.max(0.5, S.pps * factor));
  renderTimeline();
  sc.scrollLeft = tAt * S.pps - (ax - rect.left);
}
function zoomFit() {
  const sc = $("#tl-scroll");
  S.pps = Math.min(400, Math.max(0.5, (sc.clientWidth - 60) / Math.max(20, lastTime() + 4)));
  renderTimeline();
  sc.scrollLeft = 0;
}

// ---------- play at reading speed ----------
function startPlay() {
  if (S.playing) return;
  if (S.playhead >= lastTime()) movePlayhead(0);
  S.hover = null;
  S.playing = { t0: performance.now(), from: S.playhead };
  $("#btn-play").classList.add("on");
  $("#btn-play").textContent = "❚❚";
  const tick = () => {
    if (!S.playing) return;
    const t = S.playing.from + (performance.now() - S.playing.t0) / 1000;
    if (t > lastTime() + 1) return stopPlay();
    movePlayhead(t, { scroll: true });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopPlay() {
  S.playing = null;
  $("#btn-play").classList.remove("on");
  $("#btn-play").textContent = "▶";
  reportUi();
}

// ---------- inspector ----------
function renderInspector(force = false) {
  const it = getSel();
  if (S.sel?.id && !it) { S.sel = null; force = true; }
  const key = S.sel ? `${S.sel.type}:${S.sel.id ?? `new@${S.sel.time}`}` : "project";
  if (force || key !== S.inspectorKey) {
    S.inspectorKey = key;
    $("#inspector").innerHTML = !S.sel ? projectSkeleton() : S.sel.type === "script" ? scriptSkeleton() : eventSkeleton();
  }
  fillInspector();
}

const SYNTAX = `<div class="syntax"><code>/4</code> = 4 birim sessizlik (<code>/</code> tek başına 1 birim) · <span class="p">[köşeli parantez]</span> = yapay zekâya not, okunmaz · konuşmanın uzunluğu metinden hesaplanır</div>`;
const MEDIA_BLOCK = `<div class="field"><label>Görsel referanslar ve medya</label><div class="media-grid" data-v="media"></div>
  <div class="drop" data-drop>Dosyaları buraya sürükleyin · <button data-act="pick">Dosya seç</button><input data-link placeholder="https://… bağlantı"><button data-act="link">Ekle</button></div></div>`;
function scriptSkeleton() {
  const draft = !S.sel.id;
  return `<div class="panel-head"><span class="kind script">KONUŞMA</span><h2 data-v="when"></h2>${draft ? '<span class="faint" data-draft>yazmaya başlayınca eklenir</span>' : ""}</div>
    <div class="row"><label>Başlangıç <input class="time" data-f="time"></label><span class="fitline" data-v="fit"></span></div>
    <textarea class="script-text" data-f="text" data-autofocus spellcheck="true" placeholder="Buse'nin bu anda söyleyeceği metin…   /4 sessizlik   [yapay zekâya not]"></textarea>
    <div class="slash" data-v="slash" hidden></div>
    ${SYNTAX}
    <div class="tokens" data-v="tokens"></div>
    <div class="fitline" data-v="clash"></div>
    <div class="meta" data-v="meta"></div>
    ${draft ? "" : `<div class="actions"><button data-act="event-here">Bu ana olay ekle</button><button class="danger" data-act="delete">Sil</button></div>`}`;
}
function eventSkeleton() {
  const draft = !S.sel.id;
  return `<div class="panel-head"><span class="kind event">OLAY</span><h2 data-v="when"></h2>${draft ? '<span class="faint" data-draft>yazmaya başlayınca eklenir</span>' : ""}</div>
    <div class="row"><label>An <input class="time" data-f="time"></label></div>
    <div class="field"><label>Ne oluyor?</label><input data-f="title" data-autofocus placeholder="Ör. İşte burada ekran ikiye bölünür" style="width:100%"></div>
    <div class="field"><label>Ayrıntı</label><textarea data-f="text" rows="3" placeholder="Nasıl görünsün, hangi animasyon, hangi ses, ne kadar sürsün…"></textarea></div>
    ${draft ? "" : MEDIA_BLOCK}
    <div class="meta" data-v="meta"></div>
    ${draft ? "" : `<div class="actions"><button class="danger" data-act="delete">Sil</button></div>`}`;
}
function projectSkeleton() {
  return `<div class="panel-head"><h2>Proje</h2><span class="faint" data-v="dir"></span></div>
    <div class="grid2" data-v="cards"></div>
    <ul class="keys">
      <li>Konuşma şeridinde bir ana <b>tıkla</b> ve yaz</li><li>Olay şeridinde bir ana tıkla: olay</li>
      <li>Sürükle: taşı · <kbd>←</kbd><kbd>→</kbd> 0,1 sn (<kbd>Shift</kbd> 1 sn)</li><li><kbd>Boşluk</kbd> okuma hızında oynat</li>
      <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> geri al · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> yinele</li><li><kbd>Del</kbd> sil · <kbd>Esc</kbd> seçimi bırak</li>
      <li>Fareyi çizelgede gezdir: üstteki ekran o anı gösterir</li><li><kbd>Ctrl</kbd>+<kbd>\`</kbd> terminal: Claude Code</li>
    </ul>
    <h3 style="margin:12px 0 4px;font-size:14px">Son değişiklikler</h3><ul class="activity" data-v="activity"></ul>`;
}
const setVal = (el, v) => { if (el && document.activeElement !== el && el.value !== v) el.value = v; };

function fillInspector() {
  const box = $("#inspector");
  const p = S.project;
  if (!S.sel) {
    $('[data-v="dir"]', box).textContent = S.dir;
    const spoken = p.scripts.reduce((a, s) => a + dur(s), 0);
    $('[data-v="cards"]', box).innerHTML = [["Kurgu süresi", formatTime(lastTime())], ["Konuşma", `~${formatTime(spoken)}`], ["Konuşma / olay", `${p.scripts.length} / ${p.events.length}`],
      ["Bekleyen öneri", p.suggestions.filter((s) => s.status === "pending").length]].map(([k, v]) => `<div class="card"><span class="muted">${k}</span><b>${v}</b></div>`).join("");
    $('[data-v="activity"]', box).innerHTML = p.activity.slice(-25).reverse().map((a) => `<li><span class="who ${a.actor}">${WHO[a.actor]}</span> ${esc(a.summary)} <span class="faint">· ${ago(a.at)}</span></li>`).join("") || '<li class="faint">Henüz değişiklik yok</li>';
    return;
  }
  const it = getSel();
  const time = it ? it.time : S.sel.time;
  setVal($('[data-f="time"]', box), formatTime(time));
  if (S.sel.type === "script") {
    if (it) setVal($('[data-f="text"]', box), it.text);
    updateScriptInfo(time, $('[data-f="text"]', box).value);
  } else {
    $('[data-v="when"]', box).textContent = `${formatTime(time)} anında`;
    if (it) { setVal($('[data-f="title"]', box), it.title); setVal($('[data-f="text"]', box), it.text); renderMedia(it); }
  }
  $('[data-v="meta"]', box).textContent = it ? `${WHO[it.createdBy]} ekledi, ${ago(it.createdAt)}${it.updatedAt !== it.createdAt ? ` · son değişiklik ${WHO[it.updatedBy]}, ${ago(it.updatedAt)}` : ""}` : "";
}

function updateScriptInfo(time, text) {
  const box = $("#inspector");
  const { tokens, duration: d } = tokenize(text, S.project.settings);
  $('[data-v="when"]', box).textContent = `${formatTime(time)} – ${formatTime(time + d)}`;
  $('[data-v="fit"]', box).innerHTML = `Süre <b>~${fmtS(d)} sn</b> · biter <b>${formatTime(time + d)}</b>`;
  let html = "", pos = 0;
  for (const k of tokens) {
    html += esc(text.slice(pos, k.index));
    const raw = esc(text.slice(k.index, k.index + k.length));
    html += k.type === "silence" ? `<span class="sil">⏸ ${fmtS(k.end - k.start)} sn</span>` : k.type === "direction" ? `<span class="dir">${raw}</span>` : raw;
    pos = k.index + k.length;
  }
  $('[data-v="tokens"]', box).innerHTML = tokens.some((k) => k.type !== "word") ? html + esc(text.slice(pos)) : "";
  const it = getSel();
  const others = sortedScripts().filter((s) => s.id !== it?.id);
  const prev = others.filter((s) => s.time <= time).at(-1);
  const next = others.find((s) => s.time > time);
  let clash = "";
  if (next && time + d > next.time + 0.05) {
    const by = r1(time + d - next.time);
    clash += `<span class="warn">Sonraki konuşmayla ${fmtS(by)} sn çakışıyor (${formatTime(next.time)})</span>${it ? ` <button data-act="push-after" data-by="${by}">Sonrasını ${fmtS(by)} sn kaydır</button>` : ""}`;
  }
  if (prev && endOf(prev) > time + 0.05) {
    const by = r1(endOf(prev) - time);
    clash += ` <span class="warn">Önceki konuşma bitmeden başlıyor (${fmtS(by)} sn)</span>${it ? ` <button data-act="push-self" data-by="${by}">Bunu ve sonrasını ${fmtS(by)} sn kaydır</button>` : ""}`;
  }
  $('[data-v="clash"]', box).innerHTML = clash;
}

// "/" guidance: shown while the caret is right after a lone "/" or "/<digits>"
function updateSlash(ta) {
  const box = $('[data-v="slash"]');
  if (!box) return;
  const m = ta.value.slice(0, ta.selectionStart).match(/(^|\s)\/(\d*(?:[.,]\d*)?)$/);
  if (!m) { box.hidden = true; return; }
  const u = S.project.settings.silenceUnit;
  const n = m[2] ? Number(m[2].replace(",", ".")) : null;
  box.hidden = false;
  box.innerHTML = `<b>Sessizlik</b> <span>${n ? `/${m[2]} = <b>${fmtS(n * u)} sn</b>` : `kaç birim? 1 birim = ${fmtS(u)} sn`}</span>
    ${[1, 2, 4, 8].map((k) => `<button data-slash="${k}" title="${fmtS(k * u)} sn">/${k}</button>`).join("")}<span class="faint">birimi üstteki "/1 =" ayarından değiştirin</span>`;
}
function insertSlash(k) {
  const ta = $('#inspector [data-f="text"]');
  const before = ta.value.slice(0, ta.selectionStart).replace(/\/\d*(?:[.,]\d*)?$/, "");
  const after = ta.value.slice(ta.selectionStart);
  const ins = `/${k} `;
  ta.value = before + ins + after.replace(/^\s+/, "");
  ta.selectionStart = ta.selectionEnd = before.length + ins.length;
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderMedia(e) {
  const box = $('[data-v="media"]');
  if (!box || document.activeElement?.closest?.("[data-media]")) return;
  box.innerHTML = e.media.map((m) => {
    const src = m.file ? K.mediaUrl(m.file) : "";
    const view = m.kind === "image" ? `<img src="${src}" data-openmedia="${esc(m.file)}" alt="">`
      : m.kind === "video" ? `<video src="${src}" controls preload="metadata"></video>`
      : m.kind === "audio" ? `<audio src="${src}" controls preload="metadata"></audio>`
      : m.kind === "link" ? `<button class="link" data-openurl="${esc(m.url)}">🔗 ${esc(m.url)}</button>`
      : `<button class="link" data-openmedia="${esc(m.file)}">📄 ${esc(m.name)}</button>`;
    return `<div class="media" data-media="${m.id}">${view}<span class="fname">${esc(m.name || m.url)}${m.createdBy === "mcp" ? " · Claude" : ""}</span>
      <input data-caption="${m.id}" value="${esc(m.caption)}" placeholder="Açıklama">
      <div class="mrow">${m.file ? `<button class="link" data-openmedia="${esc(m.file)}">Aç</button>` : "<span></span>"}<button class="link" data-rmmedia="${m.id}" style="color:var(--danger)">Kaldır</button></div></div>`;
  }).join("") || '<span class="faint">Henüz görsel ya da medya yok</span>';
}

// the composer: the first keystroke creates the item; the inputs (and the caret) stay
let creating = null;
function createFromDraft(field, value) {
  if (creating || !value.trim()) return;
  const sel = S.sel;
  const op = sel.type === "script" ? { op: "addScript", time: sel.time, text: value } : { op: "addEvent", time: sel.time, [field]: value };
  creating = (async () => {
    try {
      const r = await K.apply([op]);
      S.undo.push(r.undo); S.redo = [];
      S.project = r.project;
      const id = r.results[0].id;
      S.sel = { type: sel.type, id };
      S.inspectorKey = `${sel.type}:${id}`;
      const box = $("#inspector");
      $("[data-draft]", box)?.remove();
      if (sel.type === "event") $('[data-v="meta"]', box).insertAdjacentHTML("beforebegin", MEDIA_BLOCK);
      box.insertAdjacentHTML("beforeend", `<div class="actions">${sel.type === "script" ? '<button data-act="event-here">Bu ana olay ekle</button>' : ""}<button class="danger" data-act="delete">Sil</button></div>`);
      renderAll();
      for (const f of ["text", "title"]) { // keystrokes typed while it was being created
        const el = $(`[data-f="${f}"]`, box);
        const item = getSel();
        if (el && item && el.value !== item[f]) later(`${id}:${f}`, { op: sel.type === "script" ? "updateScript" : "updateEvent", id, [f]: el.value });
      }
    } catch (e) { toast(e.message); } finally { creating = null; }
  })();
}

function onInspectorInput(e) {
  const t = e.target;
  if (t.dataset.caption) return later(`cap:${t.dataset.caption}`, { op: "updateMedia", eventId: getSel().id, id: t.dataset.caption, caption: t.value }, 700);
  const f = t.dataset.f;
  if (f !== "text" && f !== "title") return;
  if (S.sel.type === "script") { updateScriptInfo(getSel()?.time ?? S.sel.time, t.value); updateSlash(t); }
  if (!S.sel.id) return createFromDraft(f, t.value);
  later(`${S.sel.id}:${f}`, { op: S.sel.type === "script" ? "updateScript" : "updateEvent", id: S.sel.id, [f]: t.value });
}
function onInspectorChange(e) {
  const t = e.target;
  if (t.dataset.f !== "time") return;
  try {
    const v = parseTime(t.value);
    if (!S.sel.id) { S.sel.time = v; S.inspectorKey = `${S.sel.type}:new@${v}`; movePlayhead(v); fillInspector(); return; }
    apply([{ op: S.sel.type === "script" ? "updateScript" : "updateEvent", id: S.sel.id, time: v }]).catch(() => fillInspector());
  } catch (err) { toast(err.message); fillInspector(); }
}
async function onInspectorClick(e) {
  const b = e.target.closest("button, [data-openmedia]");
  if (!b) return;
  const it = getSel();
  try {
    if (b.dataset.slash) return insertSlash(b.dataset.slash);
    if (b.dataset.openmedia) return void K.openMedia(b.dataset.openmedia);
    if (b.dataset.openurl) return void K.openUrl(b.dataset.openurl);
    if (b.dataset.rmmedia) return void (await apply([{ op: "removeMedia", eventId: it.id, id: b.dataset.rmmedia }]));
    const act = b.dataset.act;
    if (act === "delete") return deleteSelected();
    if (act === "pick") return void (await addMediaFiles(await K.pickMedia()));
    if (act === "link") {
      const inp = $("[data-link]");
      if (!inp.value.trim()) return;
      await apply([{ op: "addMedia", eventId: it.id, url: inp.value.trim() }]);
      inp.value = "";
    }
    if (act === "event-here") {
      const t = S.playhead >= it.time && S.playhead <= endOf(it) ? S.playhead : it.time;
      select({ type: "event", id: null, time: t });
      setTimeout(() => $("#inspector [data-autofocus]")?.focus(), 20);
    }
    if (act === "push-after" || act === "push-self") {
      flushAll();
      const by = Number(b.dataset.by);
      const self = act === "push-self";
      const scriptIds = S.project.scripts.filter((s) => (self ? s.time >= it.time : s.time > it.time)).map((s) => s.id);
      const eventIds = S.project.events.filter((x) => (self ? x.time >= it.time : x.time > it.time)).map((x) => x.id);
      await apply([{ op: "shiftItems", scriptIds, eventIds, by }]);
      toast(`${scriptIds.length + eventIds.length} öğe ${fmtS(by)} sn kaydırıldı (Ctrl+Z geri alır)`, "info");
    }
  } catch {}
}
async function addMediaFiles(paths) {
  const it = getSel();
  if (it && paths.length) await apply(paths.map((source) => ({ op: "addMedia", eventId: it.id, source })));
}
async function deleteSelected() {
  const it = getSel();
  if (!it) return;
  const kind = S.sel.type === "script" ? "Konuşma" : "Olay";
  pending.clear();
  await apply([{ op: S.sel.type === "script" ? "deleteScript" : "deleteEvent", id: it.id }]).catch(() => {});
  toast(`${kind} silindi (Ctrl+Z geri alır)`, "info");
  select(null);
}

// ---------- suggestions ----------
function renderSuggestions() {
  const p = S.project;
  const pend = p.suggestions.filter((s) => s.status === "pending");
  const done = p.suggestions.filter((s) => s.status !== "pending").reverse();
  const card = (sg) => {
    const lines = describeOps(p, sg.ops);
    const st = { accepted: "uygulandı", rejected: "reddedildi", withdrawn: "geri çekildi" }[sg.status];
    return `<div class="sg ${sg.status !== "pending" ? "done" : ""}" data-sg="${sg.id}">
      <div class="top"><span class="who ${sg.createdBy}">${WHO[sg.createdBy]}</span>${st ? `<span class="status">${st}</span>` : ""}<time>${ago(sg.createdAt)}</time></div>
      <div class="summary">${esc(sg.summary)}</div>
      ${sg.status === "pending" ? `<ul>${lines.map((l) => `<li class="${l.bad ? "bad" : ""}" ${l.time != null ? `data-goto-time="${l.time}"` : ""}>${esc(l.text)}</li>`).join("")}</ul>
      <div class="btns"><button class="primary" data-accept="${sg.id}">Uygula</button><button data-reject="${sg.id}">Reddet</button></div>` : ""}
      <div class="err" data-err="${sg.id}"></div></div>`;
  };
  $("#suggestions").innerHTML = `<div class="panel-head"><h2>Öneriler</h2><span class="muted">${pend.length} bekliyor</span></div>
    ${pend.map(card).join("") || `<div class="empty">Bekleyen öneri yok. Terminalde Claude'a "şuraya bir şey öner" diyebilirsiniz; öneriler burada görünür, uygular ya da reddedersiniz. Bekleyen önerilerin çizelgedeki yeri kesik çizgiyle gösterilir.</div>`}
    ${done.length ? `<button class="link" data-toggle-done style="margin-top:6px">${S.showDecided ? "Geçmişi gizle" : `Geçmiş (${done.length})`}</button>${S.showDecided ? done.map(card).join("") : ""}` : ""}`;
}
async function onSuggestionsClick(e) {
  const b = e.target.closest("button, [data-goto-time]");
  if (!b) return;
  if (b.dataset.toggleDone !== undefined) { S.showDecided = !S.showDecided; return renderSuggestions(); }
  if (b.dataset.gotoTime) { movePlayhead(Number(b.dataset.gotoTime)); $("#tl-scroll").scrollLeft = Math.max(0, X(Number(b.dataset.gotoTime)) - 160); return; }
  const id = b.dataset.accept || b.dataset.reject;
  if (!id) return;
  flushAll();
  try {
    await apply([{ op: "decideSuggestion", id, accept: !!b.dataset.accept }], { quiet: true });
    toast(b.dataset.accept ? "Öneri uygulandı (Ctrl+Z geri alır)" : "Öneri reddedildi", "info");
  } catch (err) {
    const el = $(`[data-err="${id}"]`);
    if (el) el.textContent = `Uygulanamadı: ${err.message}`;
  }
}

// ---------- terminal ----------
async function startTerm() {
  S.termStarted = true;
  try { await K.term.start({ cols: S.term.term.cols, rows: S.term.term.rows, withClaude: true }); } catch (e) { toast(e.message); S.termStarted = false; }
}
function toggleTerminal(force) {
  const d = $("#drawer");
  const show = force ?? d.hidden;
  d.hidden = !show;
  if (!show) return;
  $("#term-dir").textContent = S.dir;
  if (!S.term) {
    const term = new Terminal({ fontFamily: "ui-monospace, 'DejaVu Sans Mono', monospace", fontSize: 13, cursorBlink: true,
      theme: { background: "#0b0a1a", foreground: "#f2f0ff", cursor: "#F6A2FF", selectionBackground: "#463f85" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open($("#xterm"));
    term.onData((d) => K.term.input(d));
    K.term.onData((d) => term.write(d));
    K.term.onExit(() => { term.write("\r\n\x1b[2m[terminal kapandı — yeniden açmak için \"Claude Code'u başlat\"]\x1b[0m\r\n"); S.termStarted = false; });
    new ResizeObserver(() => { try { fit.fit(); K.term.resize({ cols: term.cols, rows: term.rows }); } catch {} }).observe($("#xterm"));
    S.term = { term, fit };
  }
  requestAnimationFrame(async () => {
    S.term.fit.fit();
    if (!S.termStarted) await startTerm();
    S.term.term.focus();
  });
}

// ---------- whole window ----------
function renderAll() {
  if (S.sel?.id && !getSel()) S.sel = null;
  renderTop();
  renderSaved();
  renderTimeline();
  renderScreen();
  renderInspector();
  renderSuggestions();
}
function showProject({ dir, project }) {
  S.dir = dir; S.project = project; S.sel = null; S.inspectorKey = null; S.undo = []; S.redo = [];
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  renderAll();
  zoomFit();
  movePlayhead(0);
}
function showWelcome(recent) {
  $("#app").hidden = true;
  $("#welcome").hidden = false;
  $("#recent").innerHTML = recent.length ? `<div class="muted" style="font-size:12px">Son projeler</div>${recent.map((d) => `<button data-recent="${esc(d)}">${esc(d)}</button>`).join("")}` : "";
}
function setSetting(k, v) {
  if (!Number.isFinite(v)) return renderTop();
  apply([{ op: "setSettings", settings: { [k]: Math.round(v * 100) / 100 } }]).catch(() => renderTop());
}

function wire() {
  $("#welcome").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      const r = b.dataset.act === "new" ? await K.newProject() : b.dataset.act === "open" ? await K.openProject() : await K.openProject(b.dataset.recent);
      if (r) showProject(r);
    } catch (err) { toast(err.message); }
  });
  $("#title").addEventListener("change", (e) => apply([{ op: "setSettings", title: e.target.value }]).catch(() => {}));
  $("#set-speed").addEventListener("change", (e) => setSetting("syllablesPerSecond", Number(e.target.value)));
  $("#set-unit").addEventListener("change", (e) => setSetting("silenceUnit", Number(e.target.value)));
  $("#set-sentence").addEventListener("change", (e) => setSetting("sentencePause", Number(e.target.value)));
  $("#set-comma").addEventListener("change", (e) => setSetting("commaPause", Number(e.target.value)));
  for (const b of document.querySelectorAll("[data-speed]")) b.addEventListener("click", () => setSetting("syllablesPerSecond", S.project.settings.syllablesPerSecond + Number(b.dataset.speed)));
  $("#btn-settings").addEventListener("click", () => { $("#settings-pop").hidden = !$("#settings-pop").hidden; });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#settings-pop, #btn-settings")) $("#settings-pop").hidden = true; });
  $("#btn-export").addEventListener("click", async () => { flushAll(); try { toast(`Dışa aktarıldı: ${await K.exportHtml()}`, "info"); } catch (e) { toast(e.message); } });
  $("#badge-sugg").addEventListener("click", () => $("#suggestions").scrollTo({ top: 0 }));
  $("#btn-term").addEventListener("click", () => toggleTerminal());
  $("#term-close").addEventListener("click", () => toggleTerminal(false));
  $("#term-claude").addEventListener("click", async () => {
    try {
      if (!S.termStarted) await startTerm(); else await K.term.claude();
      S.term.term.focus();
    } catch (e) { toast(e.message); }
  });
  $("#btn-play").addEventListener("click", () => (S.playing ? stopPlay() : startPlay()));
  for (const b of document.querySelectorAll("[data-zoom]")) b.addEventListener("click", () => (b.dataset.zoom === "fit" ? zoomFit() : zoom(b.dataset.zoom === "+" ? 1.5 : 1 / 1.5)));

  const sc = $("#tl-scroll");
  sc.addEventListener("mousedown", onTimelineDown);
  sc.addEventListener("mousemove", (e) => { if (!S.playing && !e.buttons) setHover(evTime(e)); });
  sc.addEventListener("mouseleave", () => { if (S.hover != null) setHover(null); });
  sc.addEventListener("scroll", reportUi);
  sc.addEventListener("wheel", (e) => {
    if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX); }
    else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { sc.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  $("#now").addEventListener("click", (e) => {
    const id = e.target.closest("[data-goto-event]")?.dataset.gotoEvent;
    if (id) { const ev = S.project.events.find((x) => x.id === id); movePlayhead(ev.time, { scroll: true }); select({ type: "event", id }); }
  });

  const ins = $("#inspector");
  ins.addEventListener("input", onInspectorInput);
  ins.addEventListener("change", onInspectorChange);
  ins.addEventListener("click", onInspectorClick);
  ins.addEventListener("keyup", (e) => { if (e.target.dataset.f === "text" && S.sel?.type === "script") updateSlash(e.target); });
  ins.addEventListener("focusout", (e) => {
    if (S.sel?.id && (e.target.dataset.f === "text" || e.target.dataset.f === "title")) flush(`${S.sel.id}:${e.target.dataset.f}`);
    if (e.target.dataset.caption) flush(`cap:${e.target.dataset.caption}`);
  });
  ins.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.link !== undefined) { e.preventDefault(); ins.querySelector('[data-act="link"]').click(); }
    if (e.key === "Escape") e.target.blur();
  });
  ins.addEventListener("dragover", (e) => { const d = e.target.closest("[data-drop]"); if (d) { e.preventDefault(); d.classList.add("over"); } });
  ins.addEventListener("dragleave", (e) => e.target.closest("[data-drop]")?.classList.remove("over"));
  ins.addEventListener("drop", (e) => {
    const d = e.target.closest("[data-drop]");
    if (!d) return;
    e.preventDefault();
    d.classList.remove("over");
    const paths = [...e.dataTransfer.files].map((f) => K.pathForFile(f)).filter(Boolean);
    const url = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")).trim();
    if (paths.length) addMediaFiles(paths).catch(() => {});
    else if (/^https?:\/\//.test(url)) apply([{ op: "addMedia", eventId: getSel().id, url }]).catch(() => {});
  });

  const sg = $("#suggestions");
  sg.addEventListener("click", onSuggestionsClick);
  sg.addEventListener("mouseover", (e) => {
    const id = e.target.closest("[data-sg]")?.dataset.sg || null;
    if (id !== S.hotSuggestion) { S.hotSuggestion = id; renderTimeline(); }
  });
  sg.addEventListener("mouseleave", () => { if (S.hotSuggestion) { S.hotSuggestion = null; renderTimeline(); } });

  K.onMenu((m) => {
    if (m === "terminal") return toggleTerminal();
    if (typing() && !document.activeElement.closest("#xterm")) return document.execCommand(m); // text undo inside an input
    if (m === "undo") undo(); else redo();
  });
  addEventListener("keydown", (e) => {
    if (!S.project || typing()) return;
    if (e.key === " ") { e.preventDefault(); S.playing ? stopPlay() : startPlay(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
    else if (e.key === "Escape") select(null);
    else if (e.key === "Home") movePlayhead(0, { scroll: true });
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && S.sel?.id) {
      e.preventDefault();
      const it = getSel();
      const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
      apply([{ op: S.sel.type === "script" ? "updateScript" : "updateEvent", id: it.id, time: Math.max(0, r1(it.time + d)) }]).catch(() => {});
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      movePlayhead(S.playhead + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1), { scroll: true });
    }
  });
  K.onChanged((p) => {
    if (!S.project || p.revision === S.project.revision) return;
    const last = p.activity.at(-1);
    S.project = p;
    renderAll();
    if (last?.actor === "mcp") toast(`Claude ${last.summary}`, "claude");
  });
  K.onOpened((r) => showProject(r));
  setInterval(() => { if (S.project) renderSuggestions(); }, 60000);
}

async function main() {
  wire();
  const st = await K.state();
  S.smoke = st.smoke;
  if (st.project) showProject({ dir: st.dir, project: st.project });
  else showWelcome(st.recent);
  if (S.smoke) {
    const { select: want, pps, time, term } = S.smoke;
    if (Number(pps)) { S.pps = Number(pps); renderTimeline(); }
    const it = want && (S.project.scripts.find((x) => x.id === want) || S.project.events.find((x) => x.id === want));
    if (it) select({ type: S.project.scripts.includes(it) ? "script" : "event", id: it.id }, { scroll: true });
    if (time) movePlayhead(Number(time), { scroll: !it });
    requestAnimationFrame(() => setTimeout(() => K.smokeReady(), 300));
  }
}
main().catch((e) => toast(e.message));
