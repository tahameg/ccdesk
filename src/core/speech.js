// What the voice reads, in chunks placed on the timeline (pure: the window imports it).
// A chunk is a sentence or so of words from one script: [directions] are left out, /n silences break chunks
// (the player waits them out), numbers are spelled out in the content language (settings.language). Each chunk
// carries the times the reading model
// gives it, so the player can move the playhead over its audio, whatever length the voice makes it.
import { tokenize } from "./reading.js";

const ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const BIG = [[1e9, "milyar"], [1e6, "milyon"], [1e3, "bin"]];

function under1000(n) {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
  return [h ? (h === 1 ? "yüz" : `${ONES[h]} yüz`) : "", TENS[t], ONES[o]].filter(Boolean).join(" ");
}
/** 2026 → "iki bin yirmi altı" (whole numbers below a trillion). */
export function turkishNumber(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "sıfır";
  if (n >= 1e12) return String(n);
  const parts = [];
  for (const [v, name] of BIG) {
    const k = Math.floor(n / v);
    if (k) parts.push(v === 1e3 && k === 1 ? "bin" : `${under1000(k)} ${name}`);
    n %= v;
  }
  if (n) parts.push(under1000(n));
  return parts.join(" ");
}

const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function enUnder1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? EN_ONES[r] : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? `-${EN_ONES[r % 10]}` : ""}`;
  return [h ? `${EN_ONES[h]} hundred` : "", rest].filter(Boolean).join(" ");
}
/** 2026 → "two thousand twenty-six" (whole numbers below a trillion). */
export function englishNumber(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "zero";
  if (n >= 1e12) return String(n);
  const parts = [];
  for (const [v, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    const k = Math.floor(n / v);
    if (k) parts.push(`${enUnder1000(k)} ${name}`);
    n %= v;
  }
  if (n) parts.push(enUnder1000(n));
  return parts.join(" ");
}

const SPELL = {
  // Turkish: decimal comma, thousands dot
  tr: { num: turkishNumber, percent: "yüzde", percentFirst: true, point: "virgül", decimal: ",", thousands: "." },
  en: { num: englishNumber, percent: "percent", point: "point", decimal: ".", thousands: "," },
};

/** A word as it should be said: "%40" → "yüzde kırk", "3,5" → "üç virgül beş", "2026'da" → "iki bin yirmi altı'da";
 * in English "40%" → "forty percent", "3.5" → "three point five", "10,000" → "ten thousand". */
export function spokenWord(w, language = "tr") {
  const L = SPELL[language] || SPELL.tr;
  const th = L.thousands === "." ? "\\." : ",";
  const grouped = new RegExp(`^\\d{1,3}(${th}\\d{3})+$`);
  return w
    .replace(/%(\d+)/g, (_, d) => `${L.percent} ${L.num(Number(d))}`)
    .replace(/(\d+)%/g, (_, d) => (L.percentFirst ? `${L.percent} ${L.num(Number(d))}` : `${L.num(Number(d))} ${L.percent}`))
    .replace(/(\d+)[.,](\d+)/g, (m, a, b) => {
      if (grouped.test(m)) return L.num(Number(m.split(L.thousands).join("")));
      return m.includes(L.decimal) ? `${L.num(Number(a))} ${L.point} ${L.num(Number(b))}` : `${L.num(Number(a))} ${L.num(Number(b))}`;
    })
    .replace(/\d+/g, (d) => L.num(Number(d)));
}

const SENTENCE_END = /[.!?…]["'”’)]*$/;
const CLAUSE_END = /[,;:—–]["'”’)]*$/;

/** One script's chunks: [{text, start, end}] (seconds from the script's start). */
export function scriptChunks(text, settings, { min = 40, soft = 160, max = 240 } = {}) {
  const { tokens } = tokenize(text, settings);
  const out = [];
  let words = [];
  const flush = () => {
    if (!words.length) return;
    out.push({ text: words.map((k) => spokenWord(k.text, settings?.language)).join(" "), start: words[0].start, end: words.at(-1).end });
    words = [];
  };
  const len = () => words.reduce((a, k) => a + k.text.length + 1, 0);
  for (const k of tokens) {
    if (k.type === "silence") { flush(); continue; }
    if (k.type !== "word") continue;
    words.push(k);
    const n = len();
    if ((SENTENCE_END.test(k.text) && n >= min) || (CLAUSE_END.test(k.text) && n >= soft) || n >= max) flush();
  }
  flush();
  return out;
}

/** Every chunk from time `from` on, in flow order: [{key, scriptId, text, start, end}] in timeline seconds.
 * A chunk the playhead is inside of comes first, with `offset` = how far into it (0–1). */
export function speechPlan(project, from = 0) {
  const plan = [];
  for (const s of [...project.scripts].sort((a, b) => a.time - b.time)) {
    for (const c of scriptChunks(s.text, project.settings)) {
      const start = Math.round((s.time + c.start) * 100) / 100, end = Math.round((s.time + c.end) * 100) / 100;
      if (end <= from) continue;
      plan.push({ key: `${s.id}:${c.start}`, scriptId: s.id, text: c.text, start, end, offset: from > start ? (from - start) / Math.max(0.01, end - start) : 0 });
    }
  }
  return plan;
}
