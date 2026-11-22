// Reading time for narration, word by word, in the project's content language (settings.language: tr | en).
// A Turkish word has exactly as many syllables as vowels, so speed is measured in syllables per second; English
// syllables are estimated from vowel groups (a silent final e not counted).
// Defaults were measured on Buse's recording (2026-11-14): 6.3 syllables/s while speaking and ~0.9 s between
// sentences; the model gave 28.9 s for a paragraph she read in 29.0 s.
//
// Script syntax:  words …   [a direction for the AI: not read]   /4 = four units of silence (unit in settings)
// Pure module (no Node imports): the window imports it directly.

export const DEFAULT_SETTINGS = Object.freeze({
  syllablesPerSecond: 6.3,
  sentencePause: 0.9,
  commaPause: 0.15,
  silenceUnit: 0.5,
  language: "tr", // the content language: what the script is written (and read aloud) in
});

/** Content languages a project can be in. */
export const LANGUAGES = Object.freeze({ tr: "Türkçe", en: "English" });

const VOWEL = /[aeıioöuüâîûAEIİOÖUÜÂÎÛ]/g;
// a direction, a silence (/ or /n, standing alone), or a word
const TOKEN = /\[([^\]]*)\]?|(?<=^|\s)\/(\d+(?:[.,]\d+)?)?(?=\s|$)|[^\s[]+/g;

function englishSyllables(letters) {
  const w = letters.toLowerCase();
  const groups = (w.match(/[aeiouy]+/g) || []).length;
  if (!groups) return 0;
  const silentE = groups > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w) ? 1 : 0; // "make", not "table"
  return groups - silentE;
}

export function wordSyllables(word, language = "tr") {
  const digits = word.replace(/\D/g, "");
  const letters = word.replace(/[^\p{L}]/gu, "");
  let n = digits.length * 2; // "2026" ≈ "iki bin yirmi altı" / "twenty twenty-six": about two syllables a digit
  if (letters) {
    const vowels = language === "en" ? englishSyllables(letters) : (letters.match(VOWEL) || []).length;
    n += vowels > 0 ? vowels : letters.length; // no vowel (HTML, CSS): read letter by letter
  }
  return n;
}

const r2 = (x) => Math.round(x * 100) / 100;

/** Tokens with times (seconds from the script's start): word {text,start,end,syl}, silence {units,start,end},
 * direction {text,at}. `pause` after a word is added only if more speech follows. */
export function tokenize(text, settings = DEFAULT_SETTINGS) {
  const p = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const out = [];
  let t = 0;
  let owed = 0; // punctuation pause, paid before the next word
  for (const m of String(text ?? "").matchAll(TOKEN)) {
    if (m[0].startsWith("[")) {
      out.push({ type: "direction", text: (m[1] ?? "").trim(), at: r2(t), index: m.index, length: m[0].length });
      continue;
    }
    if (m[0].startsWith("/") && /^\/(\d+(?:[.,]\d+)?)?$/.test(m[0])) {
      const units = m[2] ? Number(m[2].replace(",", ".")) : 1;
      owed = 0; // the silence replaces the punctuation pause
      const start = t;
      t += units * p.silenceUnit;
      out.push({ type: "silence", units, start: r2(start), end: r2(t), index: m.index, length: m[0].length });
      continue;
    }
    const syl = wordSyllables(m[0], p.language);
    if (!syl) continue; // a lone dash or symbol
    t += owed;
    owed = 0;
    const start = t;
    t += syl / p.syllablesPerSecond;
    out.push({ type: "word", text: m[0], syl, start: r2(start), end: r2(t), index: m.index, length: m[0].length });
    if (/[.!?…]["'”’)]*$/.test(m[0])) owed = p.sentencePause;
    else if (/[,;:—–]["'”’)]*$/.test(m[0])) owed = p.commaPause;
  }
  return { tokens: out, duration: r2(t) };
}

export function estimateReading(text, settings = DEFAULT_SETTINGS) {
  const { tokens, duration } = tokenize(text, settings);
  const words = tokens.filter((x) => x.type === "word");
  const silences = tokens.filter((x) => x.type === "silence");
  return {
    seconds: Math.round(duration * 10) / 10,
    syllables: words.reduce((s, w) => s + w.syl, 0),
    words: words.length,
    silence: Math.round(silences.reduce((s, x) => s + (x.end - x.start), 0) * 10) / 10,
  };
}

/** Text inside [square brackets] is a direction for the AI, never read aloud. */
export function stripDirections(text) {
  return String(text ?? "").replace(/\[[^\]]*\]/g, " ");
}

export function directions(text) {
  return [...String(text ?? "").matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** The token being spoken at `t` seconds into a script (or the silence / the gap before the next word). */
export function tokenAt(tokens, t) {
  let last = null;
  for (const k of tokens) {
    if (k.type === "direction") continue;
    if (t < k.start) return { token: last && t < last.end ? last : null, next: k, prev: last };
    if (t < k.end) return { token: k, next: null, prev: last };
    last = k;
  }
  return { token: null, next: null, prev: last };
}
