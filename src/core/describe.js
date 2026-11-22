// Turkish one-line descriptions of operations, against the current project (pure: the window imports it).
import { formatTime } from "./time.js";
import { LANGUAGES as LANG_NAMES } from "./reading.js";

const q = (s, n = 70) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return `“${t.length > n ? `${t.slice(0, n - 1)}…` : t}”`;
};
const T = (x) => formatTime(x);

export function describeOp(p, o) {
  const sc = (id) => p.scripts.find((x) => x.id === id);
  const ev = (id) => p.events.find((x) => x.id === id);
  switch (o.op) {
    case "addScript": return { time: o.time, text: `${T(o.time)} — konuşma ekle: ${q(o.text)}` };
    case "updateScript": {
      const s = sc(o.id);
      if (!s) return { text: "Silinmiş bir konuşmayı değiştir (uygulanamaz)", bad: true };
      const parts = [];
      if (o.text !== undefined && o.text !== s.text) parts.push(`metin ${q(s.text, 40)} → ${q(o.text)}`);
      if (o.time !== undefined && o.time !== s.time) parts.push(`${T(s.time)} → ${T(o.time)} taşı`);
      return { time: o.time ?? s.time, id: s.id, text: `${T(s.time)} konuşması: ${parts.join(", ") || "değişiklik yok"}` };
    }
    case "deleteScript": {
      const s = sc(o.id);
      return s ? { time: s.time, id: s.id, text: `${T(s.time)} konuşmasını sil: ${q(s.text, 50)}` } : { text: "Zaten silinmiş bir konuşma", bad: true };
    }
    case "addEvent": return { time: o.time, text: `${T(o.time)} — olay ekle: ${q(o.title || o.text, 60)}${o.media?.length ? ` (+${o.media.length} medya)` : ""}` };
    case "updateEvent": {
      const e = ev(o.id);
      if (!e) return { text: "Silinmiş bir olayı değiştir (uygulanamaz)", bad: true };
      const parts = [];
      if (o.title !== undefined && o.title !== e.title) parts.push(`başlık → ${q(o.title, 50)}`);
      if (o.text !== undefined && o.text !== e.text) parts.push(`açıklama → ${q(o.text, 50)}`);
      if (o.time !== undefined && o.time !== e.time) parts.push(`${T(e.time)} → ${T(o.time)} taşı`);
      return { time: o.time ?? e.time, id: e.id, text: `${T(e.time)} olayı ${q(e.title, 30)}: ${parts.join(", ") || "değişiklik yok"}` };
    }
    case "deleteEvent": {
      const e = ev(o.id);
      return e ? { time: e.time, id: e.id, text: `${T(e.time)} olayını sil: ${q(e.title || e.text, 50)}` } : { text: "Zaten silinmiş bir olay", bad: true };
    }
    case "addMedia": {
      const e = ev(o.eventId);
      return { time: e?.time, id: o.eventId, text: `${e ? `${T(e.time)} olayına` : "Olaya"} ${o.url ? "bağlantı" : "medya"} ekle: ${o.url || o.name || o.stored || ""}${o.caption ? ` (${o.caption})` : ""}` };
    }
    case "removeMedia": return { id: o.eventId, text: "Olaydan bir medyayı kaldır" };
    case "swapScripts": {
      const a = sc(o.a), b = sc(o.b);
      if (!a || !b) return { text: "Silinmiş bir konuşmanın yerini değiştir (uygulanamaz)", bad: true };
      const [x, y] = a.time <= b.time ? [a, b] : [b, a];
      return { time: x.time, id: x.id, text: `${T(x.time)} ${q(x.text, 30)} ile ${T(y.time)} ${q(y.text, 30)} konuşmalarının yerini değiştir` };
    }
    case "shiftItems": return { text: `${(o.scriptIds?.length || 0) + (o.eventIds?.length || 0)} öğeyi ${o.by > 0 ? `${o.by} sn ileri` : `${-o.by} sn geri`} kaydır` };
    case "setSettings": {
      const { language, ...rest } = o.settings || {};
      const named = { ...rest, ...(language !== undefined ? { "içerik dili": LANG_NAMES[language] || language } : {}), ...(o.title !== undefined ? { başlık: o.title } : {}) };
      return { text: `Ayarlar: ${Object.entries(named).map(([k, v]) => `${k} = ${v}`).join(", ")}` };
    }
    case "importScript": return { time: o.time, text: `${T(o.time || 0)}'dan başlayarak senaryo yerleştir (${String(o.text).split(/\n\s*\n/).filter((x) => x.trim()).length} paragraf)` };
    default: return { text: o.op };
  }
}

export function describeOps(p, ops) {
  return ops.map((o) => describeOp(p, o));
}
