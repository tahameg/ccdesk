// Kurgu Masası window. State lives in the project file; every change is an op sent to the main process
// (window.kurgu.apply), which returns the new project. Changes made by Claude (MCP) arrive through onChanged.
import { estimateReading, directions } from "../core/reading.js";
import { formatTime, parseTime } from "../core/time.js";

const K = window.kurgu;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r1 = (x) => Math.round(x * 10) / 10;
const WHO = { ui: "Taha", mcp: "Claude" };
const LANE_ROW = 46, RULER = 28, PAD_END = 200;

const S = {
  dir: null, project: null, recent: [],
  sel: null, // {type: "script" | "note", id}
  tool: "select",
  pps: 24, // pixels per second
  cursor: 0,
  filter: "open", // comment filter: open | all | sel
  replyOpen: null,
  inspectorKey: null,
  saving: 0,
  smoke: false,
};

// ---------- helpers ----------
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "az önce";
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return new Date(iso).toLocaleDateString("tr-TR");
}
function toast(msg, kind = "error") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 5000 : 2500);
}
const items = (type) => (type === "script" ? S.project.scripts : S.project.notes);
const getSel = () => (S.sel ? items(S.sel.type).find((x) => x.id === S.sel.id) : null);
const isEvent = (n) => n.start === n.end;
const fit = (s) => {
  const est = estimateReading(s.text, S.project.reading).seconds;
  return { est, len: r1(s.end - s.start), over: r1(est - (s.end - s.start)) };
};

async function apply(ops, { quiet = false } = {}) {
  S.saving++;
  renderSaved();
  try {
    const r = await K.apply(ops);
    S.project = r.project;
    renderAll();
    return r.results;
  } catch (e) {
    if (!quiet) toast(e.message);
    throw e;
  } finally {
    S.saving--;
    renderSaved();
  }
}

// debounced text edits, flushed on blur / selection change
const pending = new Map();
function later(key, op, ms = 450) {
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
  const title = $("#title");
  if (document.activeElement !== title) title.value = p.title;
  const last = Math.max(0, ...p.scripts.map((s) => s.end), ...p.notes.map((n) => n.end));
  const spoken = p.scripts.reduce((a, s) => a + fit(s).est, 0);
  $("#stat-length").innerHTML = `Kurgu <b>${formatTime(last)}</b>`;
  $("#stat-reading").innerHTML = `Okuma <b>~${formatTime(spoken)}</b>`;
  const open = p.comments.filter((c) => !c.resolved).length;
  const b = $("#badge-comments");
  b.textContent = open ? `💬 ${open} açık yorum` : "💬 açık yorum yok";
  b.classList.toggle("has", open > 0);
}
function renderSaved() {
  $("#stat-saved").textContent = S.saving ? "kaydediliyor…" : S.project ? `kaydedildi · rev ${S.project.revision}` : "";
}

// ---------- timeline ----------
const X = (t) => t * S.pps;
const T = (x) => Math.max(0, r1(x / S.pps));

function stack(list) {
  const rows = [];
  const pos = new Map();
  for (const it of [...list].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let r = rows.findIndex((end) => end <= it.start + 1e-6);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = Math.max(it.end, it.start + 0.3);
    pos.set(it.id, r);
  }
  return { rows: Math.max(1, rows.length), pos };
}

function renderTimeline() {
  const p = S.project;
  const inner = $("#tl-inner");
  const width = X(p.duration) + PAD_END;
  const ranges = p.notes.filter((n) => !isEvent(n));
  const events = p.notes.filter(isEvent);
  const sc = stack(p.scripts), nt = stack(ranges);
  const evRows = events.length ? 1 : 0;
  const hS = sc.rows * LANE_ROW, hN = (nt.rows + evRows) * LANE_ROW;
  const commentCount = (id) => p.comments.filter((c) => !c.resolved && c.target.id === id).length;

  // ruler ticks
  const step = S.pps >= 60 ? 1 : S.pps >= 20 ? 5 : S.pps >= 6 ? 10 : 30;
  const minor = step >= 5 ? step / 5 : 0;
  let ticks = "";
  for (let t = 0; t <= p.duration + 1e-6; t += step) ticks += `<div class="tick" style="left:${X(t)}px">${formatTime(t, false)}</div>`;
  if (minor && S.pps * minor >= 6) for (let t = 0; t <= p.duration; t += minor) if (Math.abs(t / step - Math.round(t / step)) > 1e-6) ticks += `<div class="tick minor" style="left:${X(t)}px"></div>`;
  const pins = p.comments.filter((c) => c.target.type === "time").map((c) => `<div class="pin ${c.resolved ? "done" : ""}" style="left:${X(c.target.time)}px" data-comment="${c.id}" title="${esc(WHO[c.createdBy])}: ${esc(c.text)}">💬</div>`).join("");

  const scriptEls = p.scripts.map((s) => {
    const f = fit(s);
    const fillW = Math.min(100, (f.est / Math.max(0.1, f.len)) * 100);
    const cc = commentCount(s.id);
    return `<div class="item script ${S.sel?.id === s.id ? "sel" : ""} ${f.over > 0.2 ? "over" : ""}" data-type="script" data-id="${s.id}"
      style="left:${X(s.start)}px;width:${Math.max(6, X(s.end - s.start))}px;top:${sc.pos.get(s.id) * LANE_ROW + 4}px"
      title="${esc(s.text)}\n\nOkuma ~${f.est} sn / aralık ${f.len} sn">
      <span class="txt">${esc(s.text.replace(/\s+/g, " ")) || "<i>(boş)</i>"}</span>
      <span class="sub">${formatTime(s.start)} · ${f.over > 0.2 ? `⚠ ${f.over} sn uzun` : `~${f.est}/${f.len} sn`}</span>
      <span class="fit" style="width:${fillW}%"></span>
      ${s.createdBy === "mcp" ? '<span class="by">C</span>' : ""}${cc ? `<span class="cc">💬${cc}</span>` : ""}
      <span class="h l" data-h="l"></span><span class="h r" data-h="r"></span></div>`;
  }).join("");
  const noteEls = ranges.map((n) => {
    const cc = commentCount(n.id);
    return `<div class="item note ${S.sel?.id === n.id ? "sel" : ""}" data-type="note" data-id="${n.id}"
      style="left:${X(n.start)}px;width:${Math.max(6, X(n.end - n.start))}px;top:${nt.pos.get(n.id) * LANE_ROW + 4}px" title="${esc(n.title)}\n${esc(n.text)}">
      <span class="txt"><b>${esc(n.title) || esc(n.text.split("\n")[0]) || "<i>(not)</i>"}</b></span>
      <span class="sub">${n.media.length ? `📎 ${n.media.length} · ` : ""}${esc(n.title ? n.text.split("\n")[0] : "")}</span>
      ${n.createdBy === "mcp" ? '<span class="by">C</span>' : ""}${cc ? `<span class="cc">💬${cc}</span>` : ""}
      <span class="h l" data-h="l"></span><span class="h r" data-h="r"></span></div>`;
  }).join("");
  const evTop = nt.rows * LANE_ROW;
  const eventEls = events.map((n) => `<div class="event ${S.sel?.id === n.id ? "sel" : ""}" data-type="note" data-id="${n.id}" style="left:${X(n.start)}px;top:${evTop + 16}px" title="${esc(n.title || n.text)}"></div>
    <div class="event-label" style="left:${X(n.start)}px;top:${evTop + 14}px">${esc(n.title || n.text.split("\n")[0])}${n.createdBy === "mcp" ? " · C" : ""}</div>`).join("");

  $("#app").style.setProperty("--tl-h", `${RULER + hS + hN + 20}px`); // content height + scrollbar
  inner.style.width = `${width}px`;
  inner.style.height = `${RULER + hS + hN + 2}px`;
  inner.innerHTML = `
    <div class="ruler" data-lane="ruler">${ticks}${pins}</div>
    <div class="lane script" data-lane="script" style="height:${hS}px">${scriptEls}</div>
    <div class="lane note" data-lane="note" style="height:${hN}px">${noteEls}${eventEls}</div>
    <div class="endzone" style="left:${X(p.duration)}px;width:${PAD_END}px"></div>
    <div class="cursor" id="cursor" style="left:${X(S.cursor)}px"></div>`;
  for (const l of inner.querySelectorAll(".lane")) l.classList.toggle("drawing", S.tool !== "select");
  $("#labels").innerHTML = `<div class="l-script" style="height:${hS}px">Senaryo</div><div class="l-note" style="height:${hN}px">Notlar${events.length ? "<br>ve olaylar" : ""}</div>`;
  $("#cursor-time").textContent = formatTime(S.cursor);
}

function setCursor(t) {
  S.cursor = Math.min(S.project.duration, Math.max(0, r1(t)));
  const c = $("#cursor");
  if (c) c.style.left = `${X(S.cursor)}px`;
  $("#cursor-time").textContent = formatTime(S.cursor);
  renderCommentTargets();
}

function select(sel, { scroll = false } = {}) {
  if (S.sel?.id !== sel?.id) flushAll();
  S.sel = sel;
  renderTimeline();
  renderInspector();
  renderComments();
  if (scroll && sel) {
    const it = getSel();
    if (it) {
      const sc = $("#tl-scroll");
      const x = X(it.start);
      if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = Math.max(0, x - 120);
    }
  }
}

// snapping: 0.1 s grid, plus edges of other items and the cursor within 8 px
function snap(t, ignoreId) {
  const cands = [S.cursor, 0];
  for (const x of [...S.project.scripts, ...S.project.notes]) if (x.id !== ignoreId) cands.push(x.start, x.end);
  let best = r1(t), bd = 8 / S.pps;
  for (const c of cands) if (Math.abs(c - t) < bd) { best = c; bd = Math.abs(c - t); }
  return Math.max(0, r1(best));
}

function laneTime(e) {
  const inner = $("#tl-inner").getBoundingClientRect();
  return T(e.clientX - inner.left);
}

function onTimelineDown(e) {
  if (e.button !== 0) return;
  const inner = $("#tl-inner");
  const itemEl = e.target.closest("[data-id]");
  const lane = e.target.closest("[data-lane]")?.dataset.lane;
  const pin = e.target.closest("[data-comment]");
  if (pin) {
    S.filter = "all";
    renderComments(pin.dataset.comment);
    return;
  }
  if (lane === "ruler") {
    setCursor(laneTime(e));
    const move = (ev) => setCursor(laneTime(ev));
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    return;
  }
  if (itemEl && S.tool === "select") {
    const type = itemEl.dataset.type, id = itemEl.dataset.id;
    const it = items(type).find((x) => x.id === id);
    if (S.sel?.id !== id) select({ type, id });
    const handle = e.target.dataset.h;
    const t0 = laneTime(e);
    const orig = { start: it.start, end: it.end };
    const el = inner.querySelector(`[data-id="${id}"]`);
    const label = el?.nextElementSibling?.classList.contains("event-label") ? el.nextElementSibling : null;
    let moved = false, next = { ...orig };
    const point = orig.start === orig.end;
    const move = (ev) => {
      const dt = laneTime(ev) - t0;
      if (!moved && Math.abs(dt) * S.pps < 3) return;
      moved = true;
      if (handle === "l") next.start = Math.min(snap(orig.start + dt, id), orig.end - 0.1);
      else if (handle === "r") next.end = Math.max(snap(orig.end + dt, id), orig.start + 0.1);
      else {
        const s = snap(orig.start + dt, id);
        const len = orig.end - orig.start;
        // snap the end too when that is closer
        const e2 = snap(orig.end + dt, id);
        next.start = Math.abs(e2 - (orig.end + dt)) < Math.abs(s - (orig.start + dt)) ? r1(e2 - len) : s;
        next.start = Math.max(0, next.start);
        next.end = r1(next.start + len);
      }
      if (point) next.end = next.start;
      const el2 = inner.querySelector(`[data-id="${id}"]`);
      el2.style.left = `${X(next.start)}px`;
      if (!point) el2.style.width = `${Math.max(6, X(next.end - next.start))}px`;
      if (label) label.style.left = `${X(next.start)}px`;
      $("#cursor-time").textContent = `${formatTime(next.start)}${point ? "" : ` – ${formatTime(next.end)}`}`;
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      if (moved && (next.start !== orig.start || next.end !== orig.end)) {
        apply([{ op: type === "script" ? "updateScript" : "updateNote", id, start: next.start, end: next.end }]).catch(() => renderTimeline());
      } else $("#cursor-time").textContent = formatTime(S.cursor);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    e.preventDefault();
    return;
  }
  if (!lane) return;
  if (S.tool === "select") {
    setCursor(laneTime(e));
    select(null);
    return;
  }
  // drawing a new item
  const kind = S.tool;
  const t0 = snap(laneTime(e));
  if (kind === "event") {
    apply([{ op: "addNote", start: t0, end: t0, title: "" }]).then((r) => { setTool("select"); select({ type: "note", id: r[0].id }); focusFirst(); }).catch(() => {});
    return;
  }
  const targetLane = inner.querySelector(`.lane.${kind}`);
  const ghost = document.createElement("div");
  ghost.className = "ghost";
  ghost.style.top = "4px";
  ghost.style.height = `${LANE_ROW - 8}px`;
  targetLane.append(ghost);
  let t1 = t0;
  const draw = () => {
    ghost.style.left = `${X(Math.min(t0, t1))}px`;
    ghost.style.width = `${Math.max(2, X(Math.abs(t1 - t0)))}px`;
    $("#cursor-time").textContent = `${formatTime(Math.min(t0, t1))} – ${formatTime(Math.max(t0, t1))}`;
  };
  draw();
  const move = (ev) => { t1 = snap(laneTime(ev)); draw(); };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    ghost.remove();
    let s = Math.min(t0, t1), en = Math.max(t0, t1);
    if (en - s < 0.3) en = s + (kind === "script" ? 4 : 3);
    const op = kind === "script" ? { op: "addScript", start: s, end: r1(en), text: "" } : { op: "addNote", start: s, end: r1(en), title: "" };
    apply([op]).then((r) => { setTool("select"); select({ type: kind, id: r[0].id }); focusFirst(); }).catch(() => {});
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
  e.preventDefault();
}

function focusFirst() {
  setTimeout(() => $("#inspector [data-autofocus]")?.focus(), 30);
}

function setTool(t) {
  S.tool = t;
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === t);
  $("#tool-hint").textContent = {
    select: "Tıkla: seç · sürükle: taşı · kenardan sürükle: uzat · cetvele tıkla: imleç · Del: sil",
    script: "Senaryo şeridinde sürükleyerek bir aralık çiz (tıklarsan 4 sn)",
    note: "Notlar şeridinde sürükleyerek bir aralık çiz (tıklarsan 3 sn)",
    event: "Bir ana olay koymak için zaman çizelgesine tıkla",
  }[t];
  for (const l of document.querySelectorAll(".lane")) l.classList.toggle("drawing", t !== "select");
}

function zoom(factor, anchorClientX) {
  const sc = $("#tl-scroll");
  const rect = sc.getBoundingClientRect();
  const ax = anchorClientX ?? rect.left + rect.width / 2;
  const tAt = (sc.scrollLeft + ax - rect.left) / S.pps;
  S.pps = Math.min(400, Math.max(1, S.pps * factor));
  renderTimeline();
  sc.scrollLeft = tAt * S.pps - (ax - rect.left);
}
function zoomFit() {
  const sc = $("#tl-scroll");
  const last = Math.max(10, ...S.project.scripts.map((s) => s.end), ...S.project.notes.map((n) => n.end));
  S.pps = Math.min(400, Math.max(1, (sc.clientWidth - 40) / (last + 2)));
  renderTimeline();
  sc.scrollLeft = 0;
}

// ---------- inspector ----------
function renderInspector(force = false) {
  const it = getSel();
  const key = it ? `${S.sel.type}:${it.id}:${isEvent(it) && S.sel.type === "note" ? "e" : "r"}` : "project";
  if (force || key !== S.inspectorKey) {
    S.inspectorKey = key;
    $("#inspector").innerHTML = it ? (S.sel.type === "script" ? scriptSkeleton(it) : noteSkeleton(it)) : projectSkeleton();
  }
  fillInspector();
}

const timeInputs = (it, point) => `
  <div class="row">
    <label>${point ? "An" : "Başlangıç"}<input class="time" data-f="start" value="${formatTime(it.start)}"></label>
    ${point ? "" : `<label>Bitiş<input class="time" data-f="end" value="${formatTime(it.end)}"></label>`}
    ${point ? "" : `<span class="stat" data-v="len"></span>`}
  </div>`;

function scriptSkeleton(s) {
  return `<div class="panel-head"><span class="kind script">SENARYO</span><h2 data-v="when"></h2></div>
    ${timeInputs(s, false)}
    <div class="field"><textarea class="script-text" data-f="text" data-autofocus spellcheck="true" placeholder="Buse'nin söyleyeceği metin. Yapay zekâya not: [köşeli parantez içinde]"></textarea></div>
    <div class="fitline" data-v="fit"></div>
    <div class="directions" data-v="dirs"></div>
    <div class="note-hint">Senaryoya yalnızca söylenecek metin girer. [Köşeli parantez] içindekiler okunmaz, yapay zekâya nottur. Görsel, medya ve kurgu fikri için bir <b>Not</b> açın.</div>
    <div class="meta" data-v="meta"></div>
    <div class="actions"><button data-act="comment">Bu senaryoya yorum yaz</button><button class="danger" data-act="delete">Sil</button></div>`;
}
function noteSkeleton(n) {
  const point = isEvent(n);
  return `<div class="panel-head"><span class="kind ${point ? "event" : "note"}">${point ? "OLAY" : "NOT"}</span><h2 data-v="when"></h2></div>
    ${timeInputs(n, point)}
    <div class="field"><label>Başlık</label><input data-f="title" data-autofocus placeholder="${point ? "Ör. Ekran ikiye bölünür" : "Ör. Sağda kavram paneli"}" style="width:100%"></div>
    <div class="field"><label>Açıklama</label><textarea data-f="text" rows="4" placeholder="Burada ne görünsün, nasıl kesilsin, hangi animasyon, hangi ses…"></textarea></div>
    <div class="field"><label>Medya ve referanslar</label>
      <div class="media-grid" data-v="media"></div>
      <div class="drop" data-drop>Dosyaları buraya sürükleyin veya <button data-act="pick">Dosya seç</button>
        <input data-link placeholder="https://… bağlantı ekle"><button data-act="link">Ekle</button></div>
    </div>
    <div class="meta" data-v="meta"></div>
    <div class="actions"><button data-act="toggle-event">${point ? "Aralığa çevir" : "Tek ana olaya çevir"}</button><button data-act="comment">Bu nota yorum yaz</button><button class="danger" data-act="delete">Sil</button></div>`;
}
function projectSkeleton() {
  return `<div class="panel-head"><h2>Proje</h2><span class="muted" data-v="dir"></span></div>
    <div class="grid2" data-v="cards"></div>
    <div class="row" style="margin-top:14px">
      <label>Zaman çizelgesi süresi<input class="time" data-p="duration"></label>
      <label>Okuma hızı (hece/sn)<input class="time" data-p="syllablesPerSecond" type="number" step="0.1" min="1"></label>
      <label>Cümle arası (sn)<input class="time" data-p="sentencePause" type="number" step="0.05" min="0"></label>
      <label>Virgül (sn)<input class="time" data-p="commaPause" type="number" step="0.05" min="0"></label>
    </div>
    <div class="note-hint">Okuma hızı Buse'nin kaydından ölçüldü (6,3 hece/sn, cümle arası ~0,9 sn). Türkçede hece sayısı ünlü sayısına eşittir. Bir öğe seçmek için zaman çizelgesine tıklayın.</div>
    <h3 style="margin:16px 0 4px;font-size:14px">Son değişiklikler</h3><ul class="activity" data-v="activity"></ul>`;
}

function setVal(el, v) {
  if (el && document.activeElement !== el && el.value !== v) el.value = v;
}

function fillInspector() {
  const box = $("#inspector");
  const it = getSel();
  const p = S.project;
  if (!it) {
    $('[data-v="dir"]', box).textContent = S.dir;
    const last = Math.max(0, ...p.scripts.map((s) => s.end), ...p.notes.map((n) => n.end));
    const spoken = p.scripts.reduce((a, s) => a + fit(s).est, 0);
    const over = p.scripts.filter((s) => fit(s).over > 0.2).length;
    $('[data-v="cards"]', box).innerHTML = [
      ["Kurgu uzunluğu", formatTime(last)], ["Toplam okuma", `~${formatTime(spoken)}`],
      ["Senaryo / not", `${p.scripts.length} / ${p.notes.length}`], ["Sığmayan senaryo", over],
      ["Açık yorum", p.comments.filter((c) => !c.resolved).length],
    ].map(([k, v]) => `<div class="card"><span class="muted">${k}</span><b>${v}</b></div>`).join("");
    setVal($('[data-p="duration"]', box), formatTime(p.duration));
    for (const k of ["syllablesPerSecond", "sentencePause", "commaPause"]) setVal($(`[data-p="${k}"]`, box), String(p.reading[k]));
    $('[data-v="activity"]', box).innerHTML = p.activity.slice(-30).reverse().map((a) => `<li><span class="who ${a.actor}">${WHO[a.actor]}</span> ${esc(a.summary)} <span class="faint">· ${ago(a.at)}</span></li>`).join("") || '<li class="faint">Henüz değişiklik yok</li>';
    return;
  }
  const point = S.sel.type === "note" && isEvent(it);
  $('[data-v="when"]', box).textContent = point ? `${formatTime(it.start)} anında` : `${formatTime(it.start)} – ${formatTime(it.end)}`;
  setVal($('[data-f="start"]', box), formatTime(it.start));
  setVal($('[data-f="end"]', box), formatTime(it.end));
  const len = $('[data-v="len"]', box);
  if (len) len.textContent = `${r1(it.end - it.start)} sn`;
  setVal($('[data-f="text"]', box), it.text);
  if (S.sel.type === "script") updateFit(it.text);
  else {
    setVal($('[data-f="title"]', box), it.title);
    renderMedia(it);
  }
  const created = `${WHO[it.createdBy]} ekledi, ${ago(it.createdAt)}`;
  const updated = it.updatedAt !== it.createdAt ? ` · son değişiklik ${WHO[it.updatedBy]}, ${ago(it.updatedAt)}` : "";
  $('[data-v="meta"]', box).innerHTML = esc(created + updated);
}

function updateFit(text) {
  const it = getSel();
  if (!it) return;
  const est = estimateReading(text, S.project.reading).seconds;
  const len = r1(it.end - it.start);
  const over = r1(est - len);
  $('[data-v="fit"]').innerHTML = `Okuma ~<b>${est} sn</b> · aralık ${len} sn · ${over > 0.2 ? `<span class="warn">${over} sn uzun</span>` : over < -1 ? `<span class="ok">${-over} sn boş kalıyor</span>` : '<span class="ok">sığıyor</span>'}
    <button data-act="fit">Bitişi okumaya uydur</button>`;
  const d = directions(text);
  $('[data-v="dirs"]').textContent = d.length ? `Yapay zekâya notlar: ${d.map((x) => `[${x}]`).join("  ")}` : "";
}

function renderMedia(n) {
  const box = $('[data-v="media"]');
  if (!box) return;
  const focused = document.activeElement?.closest?.("[data-media]")?.dataset.media;
  if (focused) return; // don't clobber a caption being typed
  box.innerHTML = n.media.map((m) => {
    const src = m.file ? K.mediaUrl(m.file) : "";
    const view = m.kind === "image" ? `<img src="${src}" data-openmedia="${esc(m.file)}" alt="">`
      : m.kind === "video" ? `<video src="${src}" controls preload="metadata"></video>`
      : m.kind === "audio" ? `<audio src="${src}" controls preload="metadata"></audio>`
      : m.kind === "link" ? `<button class="link" data-openurl="${esc(m.url)}">🔗 ${esc(m.url)}</button>`
      : `<button class="link" data-openmedia="${esc(m.file)}">📄 ${esc(m.name)}</button>`;
    return `<div class="media" data-media="${m.id}">${view}<span class="fname">${esc(m.name || m.url)}${m.createdBy === "mcp" ? " · Claude" : ""}</span>
      <input data-caption="${m.id}" value="${esc(m.caption)}" placeholder="Açıklama">
      <div class="mrow">${m.file ? `<button class="link" data-openmedia="${esc(m.file)}">Aç</button>` : "<span></span>"}<button class="link" data-rmmedia="${m.id}" style="color:var(--danger)">Kaldır</button></div></div>`;
  }).join("") || '<span class="faint">Henüz medya yok</span>';
}

async function addMediaFiles(paths) {
  const it = getSel();
  if (!it || !paths.length) return;
  await apply(paths.map((source) => ({ op: "addMedia", noteId: it.id, source })));
}

function onInspectorInput(e) {
  const it = getSel();
  const t = e.target;
  if (!it) {
    return;
  }
  const f = t.dataset.f;
  const type = S.sel.type;
  const opName = type === "script" ? "updateScript" : "updateNote";
  if (f === "text" || f === "title") {
    if (f === "text" && type === "script") updateFit(t.value);
    later(`${it.id}:${f}`, { op: opName, id: it.id, [f]: t.value });
  }
  if (t.dataset.caption) later(`cap:${t.dataset.caption}`, { op: "updateMedia", noteId: it.id, id: t.dataset.caption, caption: t.value }, 700);
}

function onInspectorChange(e) {
  const t = e.target;
  const it = getSel();
  if (!it && t.dataset.p) {
    try {
      if (t.dataset.p === "duration") apply([{ op: "setProject", duration: parseTime(t.value) }]).catch(() => fillInspector());
      else apply([{ op: "setProject", reading: { [t.dataset.p]: Number(t.value) } }]).catch(() => fillInspector());
    } catch (err) { toast(err.message); fillInspector(); }
    return;
  }
  if (!it) return;
  if (t.dataset.f === "start" || t.dataset.f === "end") {
    try {
      const v = parseTime(t.value);
      const point = S.sel.type === "note" && isEvent(it);
      const op = { op: S.sel.type === "script" ? "updateScript" : "updateNote", id: it.id, [t.dataset.f]: v };
      if (point) op.end = v;
      apply([op]).catch(() => fillInspector());
    } catch (err) { toast(err.message); fillInspector(); }
  }
}

async function onInspectorClick(e) {
  const b = e.target.closest("button, [data-openmedia], [data-openurl], img");
  if (!b) return;
  const it = getSel();
  const act = b.dataset.act;
  try {
    if (b.dataset.openmedia) return void K.openMedia(b.dataset.openmedia);
    if (b.dataset.openurl) return void K.openUrl(b.dataset.openurl);
    if (b.dataset.rmmedia) {
      if (confirm("Bu medya nottan kaldırılsın mı? (Dosya proje klasöründen de silinir.)")) await apply([{ op: "removeMedia", noteId: it.id, id: b.dataset.rmmedia }]);
      return;
    }
    if (act === "delete") return void deleteSelected();
    if (act === "fit") {
      flushAll();
      const est = estimateReading($('[data-f="text"]').value, S.project.reading).seconds;
      await apply([{ op: "updateScript", id: it.id, end: r1(it.start + Math.max(0.5, est)) }]);
    }
    if (act === "pick") await addMediaFiles(await K.pickMedia());
    if (act === "link") {
      const inp = $("[data-link]");
      const url = inp.value.trim();
      if (!url) return;
      await apply([{ op: "addMedia", noteId: it.id, url }]);
      inp.value = "";
    }
    if (act === "toggle-event") {
      flushAll();
      await apply([{ op: "updateNote", id: it.id, end: isEvent(it) ? r1(it.start + 3) : it.start }]);
      renderInspector(true);
    }
    if (act === "comment") {
      const ta = $("#c-new-text");
      $("#c-new-target").value = "sel";
      ta.focus();
    }
  } catch {}
}

async function deleteSelected() {
  const it = getSel();
  if (!it) return;
  const what = S.sel.type === "script" ? "Bu senaryo" : isEvent(it) ? "Bu olay" : "Bu not";
  if (!confirm(`${what} silinsin mi? Yorumları silinmez, bu ana iğnelenir.`)) return;
  pending.clear();
  await apply([{ op: S.sel.type === "script" ? "deleteScript" : "deleteNote", id: it.id }]).catch(() => {});
  select(null);
}

// ---------- comments ----------
function targetLabel(c) {
  const p = S.project;
  if (c.target.type === "project") return "Proje";
  if (c.target.type === "time") return `${formatTime(c.target.time)}${c.target.deleted ? " (silinmiş öğe)" : ""}`;
  const list = c.target.type === "script" ? p.scripts : p.notes;
  const it = list.find((x) => x.id === c.target.id);
  if (!it) return "?";
  const kind = c.target.type === "script" ? "Senaryo" : isEvent(it) ? "Olay" : "Not";
  return `${kind} ${formatTime(it.start)}`;
}

function renderCommentTargets() {
  const sel = $("#c-new-target");
  if (!sel) return;
  const it = getSel();
  const cur = sel.value;
  sel.innerHTML = `${it ? `<option value="sel">Seçili ${S.sel.type === "script" ? "senaryo" : "not"} (${formatTime(it.start)})</option>` : ""}
    <option value="time">İmleç anı (${formatTime(S.cursor)})</option><option value="project">Proje geneli</option>`;
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : it ? "sel" : "project";
}

function renderComments(focusId) {
  const box = $("#comments");
  const p = S.project;
  if (!box.dataset.built) {
    box.dataset.built = "1";
    box.innerHTML = `<div class="c-head"><div class="panel-head" style="margin:0"><h2>Yorumlar</h2><span class="muted" id="c-count"></span></div>
      <div class="c-filter"><button data-cf="open">Açık</button><button data-cf="all">Tümü</button><button data-cf="sel">Seçili öğe</button></div></div>
      <div class="c-new"><textarea id="c-new-text" placeholder="Önerinizi yazın… (Ctrl+Enter gönderir)"></textarea>
      <div class="row"><select id="c-new-target" aria-label="Yorumun hedefi"></select><button class="primary" id="c-send">Gönder</button></div></div>
      <div class="c-list" id="c-list"></div>`;
  }
  renderCommentTargets();
  const open = p.comments.filter((c) => !c.resolved).length;
  $("#c-count").textContent = `${open} açık · ${p.comments.length} toplam`;
  for (const b of box.querySelectorAll("[data-cf]")) b.classList.toggle("on", b.dataset.cf === S.filter);
  let list = [...p.comments];
  if (S.filter === "open") list = list.filter((c) => !c.resolved);
  if (S.filter === "sel") list = S.sel ? list.filter((c) => c.target.id === S.sel.id) : [];
  list.sort((a, b) => Number(a.resolved) - Number(b.resolved) || (b.updatedAt > a.updatedAt ? 1 : -1));
  const focusedReply = document.activeElement?.dataset?.replyto;
  const keep = focusedReply ? document.activeElement.value : null;
  $("#c-list").innerHTML = list.map((c) => `
    <div class="cmt ${c.resolved ? "resolved" : ""} ${focusId === c.id ? "focus" : ""}" data-cid="${c.id}">
      <div class="c-top"><span class="who ${c.createdBy}">${WHO[c.createdBy]}</span><button class="c-target" data-goto="${c.id}">${esc(targetLabel(c))}</button><time>${ago(c.createdAt)}</time></div>
      <div class="c-text">${esc(c.text)}</div>
      ${c.replies.map((r) => `<div class="reply"><span class="who ${r.createdBy}">${WHO[r.createdBy]}</span> <span class="faint">${ago(r.createdAt)}</span><div class="c-text">${esc(r.text)}</div></div>`).join("")}
      <div class="c-actions">
        <button data-resolve="${c.id}">${c.resolved ? "Yeniden aç" : "Çözüldü ✓"}</button>
        <button data-reply="${c.id}">Cevapla</button>
        ${c.createdBy === "ui" ? `<button class="danger" data-cdel="${c.id}">Sil</button>` : ""}
      </div>
      ${S.replyOpen === c.id ? `<div class="c-reply"><textarea data-replyto="${c.id}" placeholder="Cevap… (Ctrl+Enter)"></textarea><button class="primary" data-sendreply="${c.id}">Gönder</button></div>` : ""}
    </div>`).join("") || `<div class="empty">${S.filter === "open" ? "Açık yorum yok." : S.filter === "sel" ? (S.sel ? "Bu öğede yorum yok." : "Bir öğe seçin.") : "Henüz yorum yok."}</div>`;
  if (focusedReply) {
    const ta = $(`[data-replyto="${focusedReply}"]`);
    if (ta) { ta.value = keep; ta.focus(); }
  }
  if (focusId) $(`[data-cid="${focusId}"]`)?.scrollIntoView({ block: "nearest" });
}

async function sendComment() {
  const ta = $("#c-new-text");
  const text = ta.value.trim();
  if (!text) return;
  const tv = $("#c-new-target").value;
  const target = tv === "sel" && S.sel ? { type: S.sel.type, id: S.sel.id } : tv === "time" ? { type: "time", time: S.cursor } : { type: "project" };
  await apply([{ op: "addComment", target, text }]);
  ta.value = "";
}

async function onCommentsClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.cf) { S.filter = b.dataset.cf; renderComments(); }
    if (b.id === "c-send") await sendComment();
    if (b.dataset.resolve) {
      const c = S.project.comments.find((x) => x.id === b.dataset.resolve);
      await apply([{ op: "resolveComment", id: c.id, resolved: !c.resolved }]);
    }
    if (b.dataset.reply) {
      S.replyOpen = S.replyOpen === b.dataset.reply ? null : b.dataset.reply;
      renderComments();
      $(`[data-replyto="${b.dataset.reply}"]`)?.focus();
    }
    if (b.dataset.sendreply) await sendReply(b.dataset.sendreply);
    if (b.dataset.cdel && confirm("Yorumunuz silinsin mi?")) await apply([{ op: "deleteComment", id: b.dataset.cdel }]);
    if (b.dataset.goto) {
      const c = S.project.comments.find((x) => x.id === b.dataset.goto);
      if (c.target.type === "script" || c.target.type === "note") select({ type: c.target.type, id: c.target.id }, { scroll: true });
      else if (c.target.type === "time") { setCursor(c.target.time); $("#tl-scroll").scrollLeft = Math.max(0, X(c.target.time) - 120); }
    }
  } catch {}
}

async function sendReply(id) {
  const ta = $(`[data-replyto="${id}"]`);
  const text = ta?.value.trim();
  if (!text) return;
  ta.value = "";
  S.replyOpen = null;
  await apply([{ op: "replyComment", id, text }]);
}

// ---------- whole window ----------
function renderAll() {
  if (S.sel && !getSel()) S.sel = null;
  renderTop();
  renderSaved();
  renderTimeline();
  renderInspector();
  renderComments();
}

function showProject({ dir, project }) {
  S.dir = dir;
  S.project = project;
  S.sel = null;
  S.inspectorKey = null;
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  renderAll();
  zoomFit();
}

function showWelcome(recent) {
  $("#app").hidden = true;
  $("#welcome").hidden = false;
  $("#recent").innerHTML = recent.length ? `<div class="muted" style="font-size:12px">Son projeler</div>${recent.map((d) => `<button data-recent="${esc(d)}">${esc(d)}</button>`).join("")}` : "";
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
  $("#title").addEventListener("change", (e) => apply([{ op: "setProject", title: e.target.value }]).catch(() => {}));
  $("#btn-export").addEventListener("click", async () => {
    flushAll();
    try { const f = await K.exportHtml(); toast(`Dışa aktarıldı: ${f}`, "info"); } catch (e) { toast(e.message); }
  });
  $("#badge-comments").addEventListener("click", () => { S.filter = "open"; renderComments(); });
  for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
  for (const b of document.querySelectorAll("[data-zoom]")) b.addEventListener("click", () => (b.dataset.zoom === "fit" ? zoomFit() : zoom(b.dataset.zoom === "+" ? 1.5 : 1 / 1.5)));
  const sc = $("#tl-scroll");
  sc.addEventListener("mousedown", onTimelineDown);
  sc.addEventListener("wheel", (e) => {
    if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX); }
    else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { sc.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  const ins = $("#inspector");
  ins.addEventListener("input", onInspectorInput);
  ins.addEventListener("change", onInspectorChange);
  ins.addEventListener("click", onInspectorClick);
  ins.addEventListener("focusout", (e) => {
    const it = getSel();
    if (it && (e.target.dataset.f === "text" || e.target.dataset.f === "title")) flush(`${it.id}:${e.target.dataset.f}`);
    if (e.target.dataset.caption) flush(`cap:${e.target.dataset.caption}`);
  });
  ins.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.link !== undefined) { e.preventDefault(); ins.querySelector('[data-act="link"]').click(); }
  });
  ins.addEventListener("dragover", (e) => { const d = e.target.closest("[data-drop]"); if (d) { e.preventDefault(); d.classList.add("over"); } });
  ins.addEventListener("dragleave", (e) => e.target.closest("[data-drop]")?.classList.remove("over"));
  ins.addEventListener("drop", (e) => {
    const d = e.target.closest("[data-drop]");
    if (!d) return;
    e.preventDefault();
    d.classList.remove("over");
    const paths = [...e.dataTransfer.files].map((f) => K.pathForFile(f)).filter(Boolean);
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (paths.length) addMediaFiles(paths).catch(() => {});
    else if (/^https?:\/\//.test(url)) apply([{ op: "addMedia", noteId: getSel().id, url: url.trim() }]).catch(() => {});
  });
  const cm = $("#comments");
  cm.addEventListener("click", onCommentsClick);
  cm.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (e.target.id === "c-new-text") { e.preventDefault(); sendComment().catch(() => {}); }
      if (e.target.dataset.replyto) { e.preventDefault(); sendReply(e.target.dataset.replyto).catch(() => {}); }
    }
  });
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing || !S.project) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
    if (e.key === "Escape") { setTool("select"); select(null); }
    const tools = { v: "select", s: "script", n: "note", e: "event" };
    if (tools[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) setTool(tools[e.key.toLowerCase()]);
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && S.sel) {
      e.preventDefault();
      const it = getSel();
      const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
      const s = Math.max(0, r1(it.start + d));
      apply([{ op: S.sel.type === "script" ? "updateScript" : "updateNote", id: it.id, start: s, end: r1(s + it.end - it.start) }]).catch(() => {});
    }
  });
  K.onChanged((p) => {
    if (!S.project || p.revision === S.project.revision) return;
    const byClaude = p.activity.at(-1)?.actor === "mcp";
    S.project = p;
    renderAll();
    if (byClaude) toast(`Claude: ${p.activity.at(-1).summary}`, "info");
  });
  K.onOpened((r) => showProject(r));
  setInterval(() => { if (S.project && !document.activeElement?.closest?.("#comments")) renderComments(); }, 60000); // refresh "x dk önce"
}

async function main() {
  wire();
  setTool("select");
  const st = await K.state();
  S.smoke = st.smoke;
  if (st.project) showProject({ dir: st.dir, project: st.project });
  else showWelcome(st.recent);
  if (S.smoke) {
    const q = new URLSearchParams(location.search);
    const want = q.get("select");
    const note = want && S.project?.notes.find((n) => n.id === want);
    const first = (want && S.project?.scripts.find((s) => s.id === want)) || S.project?.scripts.find((s) => s.text.length > 40);
    if (note) select({ type: "note", id: note.id }, { scroll: true });
    else if (first) select({ type: "script", id: first.id }, { scroll: true });
    if (Number(q.get("pps"))) { S.pps = Number(q.get("pps")); renderTimeline(); select(S.sel, { scroll: true }); }
    S.filter = "all";
    renderComments();
    requestAnimationFrame(() => setTimeout(() => K.smokeReady(), 200));
  }
}
main().catch((e) => toast(e.message));
