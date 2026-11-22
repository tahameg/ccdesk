// Shared app state: which project is open in the app, recent projects, and app-wide preferences (appearance,
// interface language, read-aloud). The MCP server reads it, so Claude works on the project the owner has open
// unless told otherwise. Before the rename the folder was ~/.config/kurgu-masasi: it is moved over once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".config");
export const STATE_DIR = process.env.CCDESK_STATE_DIR || path.join(CONFIG, "ccdesk");
const FILE = path.join(STATE_DIR, "state.json");

function adoptLegacyDir() {
  if (process.env.CCDESK_STATE_DIR || fs.existsSync(STATE_DIR)) return;
  const old = path.join(CONFIG, "kurgu-masasi");
  if (!fs.existsSync(old)) return;
  try { fs.renameSync(old, STATE_DIR); } catch { try { fs.cpSync(old, STATE_DIR, { recursive: true }); } catch {} }
}
adoptLegacyDir();

function readRaw() {
  try { const s = JSON.parse(fs.readFileSync(FILE, "utf8")); return s && typeof s === "object" ? s : {}; } catch { return {}; }
}
function write(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, FILE);
}

/** Sets top-level keys of state.json (other keys kept). */
export function patchState(patch) {
  const s = readState();
  Object.assign(s, patch);
  write(s);
  return s;
}

export function readState() {
  const s = readRaw();
  return { ...s, current: s.current || null, recent: Array.isArray(s.recent) ? s.recent : [] };
}

export function setCurrent(dir) {
  const s = readState();
  s.current = dir;
  s.recent = [dir, ...s.recent.filter((d) => d !== dir)].slice(0, 10);
  write(s);
  return s;
}

// ---- preferences ----
export const THEMES = ["light", "dark"];
export const UI_FONTS = { roboto: "Roboto", inter: "Inter", system: "Sistem" };
export const SCRIPT_FONTS = { "courier-prime": "Courier Prime", "ibm-plex-mono": "IBM Plex Mono", "source-serif": "Source Serif" };
export const UI_LANGUAGES = ["tr", "en"];

/** Every preference with its default. tts.<provider> holds that provider's own (non-secret) settings. */
export const PREF_DEFAULTS = Object.freeze({
  appearance: { theme: "light", uiFont: "roboto", scriptFont: "courier-prime" },
  uiLanguage: "tr",
  tts: {
    provider: null, // null = silent: play at reading speed
    sync: true, // fit the voice to the reading speed
    omnivoice: { voice: null, speed: 1, steps: 24 },
    azure: { region: "westeurope", voiceTr: "tr-TR-EmelNeural", voiceEn: "en-US-AvaMultilingualNeural" },
  },
});

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function merge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(base)) if (isObj(over) && over[k] !== undefined) out[k] = merge(base[k], over[k]);
  return out;
}
const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);

/** Puts every value back in its allowed range (unknown keys are dropped by merge). */
function sanitize(p) {
  const D = PREF_DEFAULTS;
  const a = p.appearance;
  if (!THEMES.includes(a.theme)) a.theme = D.appearance.theme;
  if (!(a.uiFont in UI_FONTS)) a.uiFont = D.appearance.uiFont;
  if (!(a.scriptFont in SCRIPT_FONTS)) a.scriptFont = D.appearance.scriptFont;
  if (!UI_LANGUAGES.includes(p.uiLanguage)) p.uiLanguage = D.uiLanguage;
  const t = p.tts;
  if (t.provider !== null && typeof t.provider !== "string") t.provider = null;
  t.sync = !!t.sync;
  const o = t.omnivoice;
  if (o.voice !== null && typeof o.voice !== "string") o.voice = null;
  o.speed = clamp(o.speed, 0.6, 1.5, 1);
  o.steps = Math.round(clamp(o.steps, 8, 64, 24));
  for (const k of ["region", "voiceTr", "voiceEn"]) t.azure[k] = String(t.azure[k] || D.tts.azure[k]).replace(/[^\w-]/g, "").slice(0, 80) || D.tts.azure[k];
  return p;
}

/** The preferences in force. Older state files (voice, voiceSpeed, voiceSteps at the top) mean OmniVoice. */
export function readPrefs() {
  const s = readState();
  const raw = { appearance: s.appearance, uiLanguage: s.uiLanguage, tts: s.tts };
  if (!s.tts && s.voice) raw.tts = { provider: "omnivoice", omnivoice: { voice: s.voice, speed: s.voiceSpeed, steps: s.voiceSteps } };
  return sanitize(merge(PREF_DEFAULTS, raw));
}

/** Deep-merges a partial preferences object ({tts: {omnivoice: {voice: "x"}}}) and returns the result. */
export function setPrefs(patch) {
  const next = sanitize(merge(readPrefs(), patch));
  const s = readState();
  delete s.voice; delete s.voiceSpeed; delete s.voiceSteps; // the old flat voice keys
  Object.assign(s, next);
  write(s);
  return next;
}
