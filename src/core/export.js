// HTML export: the edit as a readable document — at which second what is said, and what happens on screen.
// Writes <project>/disa-aktarim/<slug>.html with the event media copied next to it.
import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, scriptEnd, overlaps, lastTime, pendingCount } from "./store.js";
import { tokenize } from "./reading.js";
import { formatTime } from "./time.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const t = (s) => formatTime(s);
const who = (id) => (id === "mcp" ? "Claude" : "Taha");

function scriptHtml(p, s) {
  const { tokens } = tokenize(s.text, p.settings);
  let out = "", pos = 0;
  for (const k of tokens) {
    out += esc(s.text.slice(pos, k.index)).replace(/\n/g, "<br>");
    const raw = s.text.slice(k.index, k.index + k.length);
    if (k.type === "silence") out += `<span class="sil">⏸ ${Math.round((k.end - k.start) * 10) / 10} sn</span>`;
    else if (k.type === "direction") out += `<span class="dir">${esc(raw)}</span>`;
    else out += esc(raw);
    pos = k.index + k.length;
  }
  return out + esc(s.text.slice(pos)).replace(/\n/g, "<br>");
}

function mediaHtml(m) {
  const cap = m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : "";
  const src = m.file ? `medya/${encodeURIComponent(m.file)}` : m.url;
  if (m.kind === "image") return `<figure><a href="${src}"><img src="${src}" alt="${esc(m.caption || m.name)}"></a>${cap}</figure>`;
  if (m.kind === "video") return `<figure><video src="${src}" controls preload="metadata"></video>${cap}</figure>`;
  if (m.kind === "audio") return `<figure><audio src="${src}" controls preload="metadata"></audio>${cap}</figure>`;
  return `<figure class="file"><a href="${src}">${esc(m.kind === "link" ? m.url : m.name)}</a>${cap}</figure>`;
}

function timelineSvg(p, end) {
  const W = 1000, H = 64;
  const x = (s) => (s / Math.max(end, 1)) * W;
  const step = end > 600 ? 60 : end > 120 ? 30 : 10;
  let g = `<defs><linearGradient id="beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#7E7FFB"/><stop offset="1" stop-color="#7E7FFB" stop-opacity="0"/></linearGradient></defs>`;
  for (let s = 0; s <= end; s += step) g += `<line x1="${x(s)}" x2="${x(s)}" y1="0" y2="${H - 12}" class="tick"/><text x="${x(s) + 2}" y="${H - 2}">${t(s)}</text>`;
  for (const s of p.scripts) g += `<a href="#${s.id}"><rect x="${x(s.time)}" y="6" width="${Math.max(1.5, x(scriptEnd(p, s)) - x(s.time))}" height="30" fill="url(#beam)"/><rect x="${x(s.time)}" y="34" width="${Math.max(1.5, x(scriptEnd(p, s)) - x(s.time))}" height="2" fill="#7E7FFB"/></a>`;
  for (const e of p.events) g += `<a href="#${e.id}"><rect x="${x(e.time) - 3.5}" y="40" width="7" height="7" transform="rotate(45 ${x(e.time)} 43.5)" fill="#B9FF8C"/></a>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="tl" role="img" aria-label="Zaman çizelgesi">${g}</svg>`;
}

export function renderHtml(p) {
  const end = lastTime(p);
  const ov = new Map(overlaps(p).map((o) => [o.second, o.by]));
  const items = [...p.scripts.map((s) => ({ ...s, kind: "s" })), ...p.events.map((e) => ({ ...e, kind: "e" }))]
    .sort((a, b) => a.time - b.time || (a.kind === "e" ? -1 : 1));
  const times = [...new Set(items.map((i) => i.time))];
  const rows = times.map((time) => {
    const here = items.filter((i) => i.time === time);
    const said = here.filter((i) => i.kind === "s").map((s) => {
      const e = scriptEnd(p, s);
      const warn = ov.has(s.id) ? ` <span class="warn">önceki konuşmayla ${ov.get(s.id)} sn çakışıyor</span>` : "";
      return `<div class="item s" id="${s.id}"><div class="when">${t(s.time)} – ${t(e)} · ${Math.round((e - s.time) * 10) / 10} sn${warn}</div><p>${scriptHtml(p, s)}</p></div>`;
    }).join("");
    const shown = here.filter((i) => i.kind === "e").map((e) => `<div class="item e" id="${e.id}"><div class="when">⚑ ${t(e.time)}</div>${e.title ? `<h3>${esc(e.title)}</h3>` : ""}${e.text ? `<p>${esc(e.text).replace(/\n/g, "<br>")}</p>` : ""}${e.media.length ? `<div class="media">${e.media.map(mediaHtml).join("")}</div>` : ""}</div>`).join("");
    return `<tr><th>${t(time)}</th><td>${said}</td><td>${shown}</td></tr>`;
  }).join("\n");
  const visuals = [...p.events].sort((a, b) => a.time - b.time)
    .map((e) => `<li><a href="#${e.id}">${t(e.time)}</a> — ${esc(e.title || e.text.split("\n")[0].slice(0, 90) || "(başlıksız)")}${e.media.length ? ` <span class="muted">(${e.media.length} referans)</span>` : ""}</li>`).join("");
  const spoken = p.scripts.reduce((a, s) => a + (scriptEnd(p, s) - s.time), 0);
  const pend = pendingCount(p);

  return `<!doctype html>
<html lang="${p.settings.language || "tr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — kurgu</title>
<style>
:root{--bg:#14122b;--panel:#1d1a3d;--line:#2f2a5c;--ink:#f1efff;--muted:#a9a3d6;--s:#7E7FFB;--e:#B9FF8C;--warn:#ffb86b;--dir:#F6A2FF;--sil:#2FE6F6}
@media (prefers-color-scheme: light){:root{--bg:#f7f6ff;--panel:#fff;--line:#dcd8f5;--ink:#1d1a3d;--muted:#5f5a8a;--s:#5b5ce0;--e:#3f7d12;--warn:#b55d00;--dir:#a3359b;--sil:#0c8796}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,"Noto Sans",system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font:700 26px/1.2 Montserrat,Inter,system-ui,sans-serif;margin:0 0 4px}
.muted{color:var(--muted)}.stats{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 18px;color:var(--muted)}.stats b{color:var(--ink)}
.tl{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;margin-bottom:22px}
.tl text{font-size:9px;fill:var(--muted)}.tl .tick{stroke:var(--line)}
table{width:100%;border-collapse:collapse}th,td{vertical-align:top;border-top:1px solid var(--line);padding:10px 8px}
thead th{font-size:12px;color:var(--muted);text-align:left;border-top:0}tbody th{width:64px;font:600 13px/1.4 ui-monospace,monospace;color:var(--muted);text-align:left}
td{width:46%}.item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.item.s{border-left:4px solid var(--s)}.item.e{border-left:4px solid var(--e)}
.when{font-size:12px;color:var(--muted);margin-bottom:4px}.warn{color:var(--warn);font-weight:600}.item p{margin:0}.item h3{margin:0 0 4px;font-size:15px}
.dir{color:var(--dir);font-style:italic}.sil{display:inline-block;font-size:12px;color:var(--sil);border:1px solid var(--sil);border-radius:999px;padding:0 6px;margin:0 2px}
.media{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}figure{margin:0;max-width:260px}
figure img,figure video{max-width:260px;max-height:180px;border-radius:8px;display:block}figure audio{width:260px}figcaption{font-size:12px;color:var(--muted)}
section{margin-top:32px}h2{font:700 18px Montserrat,Inter,system-ui,sans-serif}a{color:var(--sil)}
@media (max-width:760px){table,thead,tbody,tr,th,td{display:block;width:100%}thead{display:none}tbody th{border-top:2px solid var(--line);padding-bottom:0}td{border-top:0}}
</style></head><body><main>
<h1>${esc(p.title)}</h1>
<div class="stats"><span>Süre <b>${t(end)}</b></span><span>Konuşma <b>~${t(spoken)}</b></span><span><b>${p.scripts.length}</b> konuşma · <b>${p.events.length}</b> olay</span><span>Konuşma hızı ${p.settings.syllablesPerSecond} hece/sn · /1 = ${p.settings.silenceUnit} sn</span>${pend ? `<span>Bekleyen öneri <b>${pend}</b></span>` : ""}<span>${esc(new Date(p.updatedAt).toLocaleString("tr-TR"))}</span></div>
${timelineSvg(p, end)}
<table><thead><tr><th>Zaman</th><th>Söylenen</th><th>Ekranda olan</th></tr></thead><tbody>
${rows || '<tr><td colspan="3" class="muted">Henüz bir şey yok.</td></tr>'}
</tbody></table>
<section><h2>Olaylar ve hazırlanacak görseller</h2><ol>${visuals || "<li class=muted>Yok</li>"}</ol></section>
</main></body></html>`;
}

const FOLD = { ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c", â: "a", î: "i", û: "u" };
const slug = (s) => String(s).toLocaleLowerCase("tr").replace(/[ışğüöçâîû]/g, (c) => FOLD[c])
  .normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kurgu";

export function exportHtml(dir, p) {
  const out = path.join(dir, "disa-aktarim");
  fs.mkdirSync(path.join(out, "medya"), { recursive: true });
  for (const e of p.events) for (const m of e.media) {
    if (m.file && fs.existsSync(path.join(dir, MEDIA_DIR, m.file))) fs.copyFileSync(path.join(dir, MEDIA_DIR, m.file), path.join(out, "medya", m.file));
  }
  const file = path.join(out, `${slug(p.title)}.html`);
  fs.writeFileSync(file, renderHtml(p));
  return file;
}
