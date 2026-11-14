/** 83.4 → "1:23.4"; whole seconds drop the decimal. */
export function formatTime(sec, withTenths = true) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const secs = withTenths && Math.round(rest * 10) % 10 !== 0 ? rest.toFixed(1) : String(Math.round(rest));
  return `${m}:${secs.padStart(withTenths && secs.includes(".") ? 4 : 2, "0")}`;
}

/** "1:23.4", "83.4", "1:23" → seconds. */
export function parseTime(text) {
  const t = String(text).trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) throw new Error(`Invalid time "${text}" (use 1:23.4 or 83.4)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const round1 = (x) => Math.round(Number(x) * 10) / 10;
