// HTML export: the edit as a readable document — at which second what is said, and what has to be on screen.
// Writes <project>/disa-aktarim/<slug>.html with the note media copied next to it (open it anywhere, share the folder).
import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, unresolvedCount, scriptFit } from "./store.js";
import { formatTime } from "./time.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function richText(s) {
  return esc(s)
    .replace(/\[([^\]]*)\]/g, '<span class="dir" title="Yapay zekâya not">[$1]</span>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
}

const who = (id) => (id === "mcp" ? "Claude" : "Taha");
const t = (s) => formatTime(s);
const span = (a, b) => (a === b ? t(a) : `${t(a)} – ${t(b)}`);

function mediaHtml(m) {
  const cap = m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : "";
  const src = m.file ? `medya/${encodeURIComponent(m.file)}` : m.url;
  if (m.kind === "image") return `<figure><a href="${src}"><img src="${src}" alt="${esc(m.caption || m.name)}"></a>${cap}</figure>`;
  if (m.kind === "video") return `<figure><video src="${src}" controls preload="metadata"></video>${cap}</figure>`;
  if (m.kind === "audio") return `<figure><audio src="${src}" controls preload="metadata"></audio>${cap}</figure>`;
  return `<figure class="file"><a href="${src}">${esc(m.kind === "link" ? m.url : m.name)}</a>${cap}</figure>`;
}

function commentsFor(p, type, id) {
  const open = p.comments.filter((c) => !c.resolved && c.target.type === type && c.target.id === id);
  if (!open.length) return "";
  return `<ul class="cm">${open.map((c) => `<li><b>${who(c.createdBy)}:</b> ${richText(c.text)}${c.replies.map((r) => `<div class="re"><b>${who(r.createdBy)}:</b> ${richText(r.text)}</div>`).join("")}</li>`).join("")}</ul>`;
}

function timelineSvg(p) {
  const W = 1000, rowH = 14, pad = 4;
  const x = (s) => (s / p.duration) * W;
  const lanes = (items) => {
    const rows = [];
    for (const it of [...items].sort((a, b) => a.start - b.start)) {
      let r = rows.findIndex((end) => end <= it.start);
      if (r < 0) { r = rows.length; rows.push(0); }
      rows[r] = Math.max(it.end, it.start + 0.01);
      it._row = r;
    }
    return rows.length || 1;
  };
  const sc = p.scripts.map((s) => ({ ...s })), nt = p.notes.map((n) => ({ ...n }));
  const sr = lanes(sc), nr = lanes(nt);
  const H = (sr + nr) * rowH + pad * 3 + 14;
  const ticks = [];
  const step = p.duration > 600 ? 60 : p.duration > 120 ? 30 : 10;
  for (let s = 0; s <= p.duration; s += step) ticks.push(`<line x1="${x(s)}" x2="${x(s)}" y1="0" y2="${H - 14}" class="tick"/><text x="${x(s) + 2}" y="${H - 3}">${t(s)}</text>`);
  const bar = (it, y0, cls) => it.start === it.end
    ? `<a href="#${it.id}"><circle cx="${x(it.start)}" cy="${y0 + it._row * rowH + rowH / 2}" r="4" class="${cls}"/></a>`
    : `<a href="#${it.id}"><rect x="${x(it.start)}" y="${y0 + it._row * rowH + 1}" width="${Math.max(2, x(it.end) - x(it.start))}" height="${rowH - 2}" rx="3" class="${cls}"/></a>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="tl" role="img" aria-label="Zaman çizelgesi">${ticks.join("")}
${sc.map((s) => bar(s, pad, "s")).join("")}${nt.map((n) => bar(n, pad * 2 + sr * rowH, n.start === n.end ? "e" : "n")).join("")}</svg>`;
}

export function renderHtml(p) {
  const items = [
    ...p.scripts.map((s) => ({ ...s, type: "script" })),
    ...p.notes.map((n) => ({ ...n, type: "note" })),
  ].sort((a, b) => a.start - b.start || (a.type === "script" ? -1 : 1));
  const times = [...new Set(items.map((i) => i.start))];
  const rows = times.map((time) => {
    const here = items.filter((i) => i.start === time);
    const said = here.filter((i) => i.type === "script").map((s) => {
      const f = scriptFit(p, s);
      const warn = f.over > 0.2 ? ` <span class="warn">metin ~${f.over} sn uzun</span>` : "";
      return `<div class="item" id="${s.id}"><div class="when">${span(s.start, s.end)} · okuma ~${f.estimate} sn / ${f.length} sn${warn}</div><p>${richText(s.text)}</p>${commentsFor(p, "script", s.id)}</div>`;
    }).join("");
    const shown = here.filter((i) => i.type === "note").map((n) => `<div class="item ${n.start === n.end ? "event" : ""}" id="${n.id}"><div class="when">${n.start === n.end ? `⚑ ${t(n.start)} anında` : span(n.start, n.end)}</div>${n.title ? `<h3>${esc(n.title)}</h3>` : ""}${n.text ? `<p>${richText(n.text)}</p>` : ""}${n.media.length ? `<div class="media">${n.media.map(mediaHtml).join("")}</div>` : ""}${commentsFor(p, "note", n.id)}</div>`).join("");
    return `<tr><th>${t(time)}</th><td>${said}</td><td>${shown}</td></tr>`;
  }).join("\n");

  const visuals = [...p.notes].sort((a, b) => a.start - b.start)
    .map((n) => `<li><a href="#${n.id}">${t(n.start)}</a> — ${esc(n.title || n.text.split("\n")[0].slice(0, 90) || "(başlıksız)")}${n.media.length ? ` <span class="muted">(${n.media.length} referans)</span>` : ""}</li>`).join("");
  const open = p.comments.filter((c) => !c.resolved).map((c) => {
    const where = c.target.type === "project" ? "Proje" : c.target.type === "time" ? `${t(c.target.time)}${c.target.deleted ? " (silinmiş öğe)" : ""}` : `<a href="#${c.target.id}">${c.target.type === "script" ? "Senaryo" : "Not"}</a>`;
    return `<li><span class="muted">${where} · ${who(c.createdBy)}:</span> ${richText(c.text)}${c.replies.map((r) => `<div class="re"><b>${who(r.createdBy)}:</b> ${richText(r.text)}</div>`).join("")}</li>`;
  }).join("");
  const spoken = p.scripts.reduce((s, x) => s + scriptFit(p, x).estimate, 0);
  const lastEnd = Math.max(0, ...items.map((i) => i.end));

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — kurgu</title>
<style>
:root{--bg:#14122b;--panel:#1d1a3d;--line:#2f2a5c;--ink:#f1efff;--muted:#a9a3d6;--s:#7E7FFB;--n:#2FE6F6;--e:#B9FF8C;--warn:#ffb86b;--dir:#F6A2FF}
@media (prefers-color-scheme: light){:root{--bg:#f7f6ff;--panel:#fff;--line:#dcd8f5;--ink:#1d1a3d;--muted:#5f5a8a;--s:#5b5ce0;--n:#0c9fb0;--e:#4f9a1a;--warn:#b55d00;--dir:#a3359b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,"Noto Sans",system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font:700 26px/1.2 Montserrat,Inter,system-ui,sans-serif;margin:0 0 4px}
.muted{color:var(--muted)}.stats{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 18px;color:var(--muted)}.stats b{color:var(--ink)}
.tl{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;margin-bottom:22px}
.tl text{font-size:9px;fill:var(--muted)}.tl .tick{stroke:var(--line)}.tl .s{fill:var(--s)}.tl .n{fill:var(--n);opacity:.85}.tl .e{fill:var(--e)}
table{width:100%;border-collapse:collapse}th,td{vertical-align:top;border-top:1px solid var(--line);padding:10px 8px}
thead th{font-size:12px;text-transform:none;color:var(--muted);text-align:left;border-top:0}tbody th{width:64px;font:600 13px/1.4 ui-monospace,monospace;color:var(--muted);text-align:left}
td{width:46%}.item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
td:nth-child(2) .item{border-left:4px solid var(--s)}td:nth-child(3) .item{border-left:4px solid var(--n)}td:nth-child(3) .item.event{border-left-color:var(--e)}
.when{font-size:12px;color:var(--muted);margin-bottom:4px}.warn{color:var(--warn);font-weight:600}.item p{margin:0}.item h3{margin:0 0 4px;font-size:15px}
.dir{color:var(--dir);font-style:italic}.media{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}figure{margin:0;max-width:260px}
figure img,figure video{max-width:260px;max-height:180px;border-radius:8px;display:block}figure audio{width:260px}figcaption{font-size:12px;color:var(--muted)}
.cm{margin:8px 0 0;padding:8px 10px 8px 22px;border-radius:8px;background:color-mix(in srgb,var(--warn) 12%,transparent);font-size:13px}.re{margin:4px 0 0 10px}
section{margin-top:32px}h2{font:700 18px Montserrat,Inter,system-ui,sans-serif}a{color:var(--n)}
@media (max-width:760px){table,thead,tbody,tr,th,td{display:block;width:100%}thead{display:none}tbody th{border-top:2px solid var(--line);padding-bottom:0}td{border-top:0}}
</style></head><body><main>
<h1>${esc(p.title)}</h1>
<div class="stats"><span>Süre <b>${t(lastEnd)}</b></span><span>Senaryo okuması <b>~${t(spoken)}</b></span><span><b>${p.scripts.length}</b> senaryo · <b>${p.notes.length}</b> not</span><span>Açık yorum <b>${unresolvedCount(p)}</b></span><span>Okuma hızı ${p.reading.syllablesPerSecond} hece/sn</span><span>${esc(new Date(p.updatedAt).toLocaleString("tr-TR"))}</span></div>
${timelineSvg(p)}
<table><thead><tr><th>Zaman</th><th>Söylenen</th><th>Ekranda / kurgu</th></tr></thead><tbody>
${rows || '<tr><td colspan="3" class="muted">Henüz bir şey yok.</td></tr>'}
</tbody></table>
<section><h2>Hazırlanacak görseller ve olaylar</h2><ol>${visuals || "<li class=muted>Yok</li>"}</ol></section>
<section><h2>Açık yorumlar</h2><ul>${open || "<li class=muted>Yok</li>"}</ul></section>
</main></body></html>`;
}

const FOLD = { ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c", â: "a", î: "i", û: "u" };
const slug = (s) => String(s).toLocaleLowerCase("tr").replace(/[ışğüöçâîû]/g, (c) => FOLD[c])
  .normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kurgu";

export function exportHtml(dir, p) {
  const out = path.join(dir, "disa-aktarim");
  fs.mkdirSync(path.join(out, "medya"), { recursive: true });
  for (const n of p.notes) for (const m of n.media) {
    if (m.file) fs.copyFileSync(path.join(dir, MEDIA_DIR, m.file), path.join(out, "medya", m.file));
  }
  const file = path.join(out, `${slug(p.title)}.html`);
  fs.writeFileSync(file, renderHtml(p));
  return file;
}
