// Reading-time estimate for Turkish narration.
// A Turkish word has exactly as many syllables as vowels, so speed is measured in syllables per second.
// Defaults were measured on Buse's recording (2026-11-14): 6.3 syllables/s while speaking and ~0.9 s
// between sentences; the model gave 28.9 s for a paragraph she read in 29.0 s.

export const DEFAULT_READING = Object.freeze({
  syllablesPerSecond: 6.3,
  sentencePause: 0.9,
  commaPause: 0.15,
});

const VOWEL = /[aeıioöuüâîûAEIİOÖUÜÂÎÛ]/g;

/** Text inside [square brackets] is a direction for the AI, never read aloud. */
export function stripDirections(text) {
  return String(text ?? "").replace(/\[[^\]]*\]/g, " ");
}

export function directions(text) {
  return [...String(text ?? "").matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

function wordSyllables(word) {
  const digits = word.replace(/\D/g, "");
  const letters = word.replace(/[^\p{L}]/gu, "");
  let n = digits.length * 2; // "2026" ≈ "iki bin yirmi altı": roughly two syllables a digit
  if (letters) {
    const vowels = (letters.match(VOWEL) || []).length;
    // no vowel (HTML, CSS, PWA's consonants): read letter by letter
    n += vowels > 0 ? vowels : letters.length;
  }
  return n;
}

export function estimateReading(text, params = DEFAULT_READING) {
  const p = { ...DEFAULT_READING, ...(params || {}) };
  const spoken = stripDirections(text).replace(/\s+/g, " ").trim();
  if (!spoken) return { seconds: 0, syllables: 0, words: 0, sentences: 0 };
  const words = spoken.split(" ").filter((w) => /[\p{L}\d]/u.test(w));
  const syllables = words.reduce((s, w) => s + wordSyllables(w), 0);
  // sentence breaks inside the text (the final one costs nothing: the next item decides the gap)
  const breaks = (spoken.match(/[.!?…]+(?=\s+\S)/g) || []).length;
  const commas = (spoken.match(/[,;:—–](?=\s)/g) || []).length;
  const seconds = syllables / p.syllablesPerSecond + breaks * p.sentencePause + commas * p.commaPause;
  return { seconds: Math.round(seconds * 10) / 10, syllables, words: words.length, sentences: breaks + 1 };
}
