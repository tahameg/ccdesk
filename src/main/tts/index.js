// Read-aloud, behind one interface: the window asks for a text in the content language at a rate, the active
// provider makes it. A provider is an object with
//   id, name, note, online (sends text over the internet), ext (audio file type), rateRange [min, max]
//   check()                  → {supported, ready, reason, details}: supported = can run on this machine at all
//                              (hardware, environment); ready = also configured. Unsupported ones can't be chosen.
//   signature(language)      → string: changes whenever the same text would sound different (voice, quality…)
//   speak({text, language, rate, session, out}) writes the audio to `out`; rate 1 = the provider's chosen speed
//   cancel(session), warm?(), stop?(), status?, actions {name: fn(args)} for its own settings pane (tts:call)
// The manager keeps the cache (<state>/tts-cache, by provider + signature + text + rate, so replaying is instant
// and a free quota isn't spent twice) and refuses providers that aren't supported or ready.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OmniVoiceProvider } from "./omnivoice.js";
import { AzureProvider } from "./azure.js";

const CACHE_MAX = 800; // files

export class TtsManager {
  constructor({ stateDir, readState, readPrefs, secrets, onStatus }) {
    this.readPrefs = readPrefs;
    this.cacheDir = path.join(stateDir, "tts-cache");
    const status = (id) => (s) => onStatus?.({ provider: id, ...s });
    this.providers = [
      new OmniVoiceProvider({ stateDir, readState, readPrefs, onStatus: status("omnivoice") }),
      new AzureProvider({ readPrefs, secrets }),
    ];
  }
  get(id) {
    const p = this.providers.find((x) => x.id === id);
    if (!p) throw new Error(`Bilinmeyen ses sağlayıcısı: ${id}`);
    return p;
  }
  active() {
    const id = this.readPrefs().tts.provider;
    return id ? this.providers.find((x) => x.id === id) || null : null;
  }

  /** Everything the settings pane shows: the read-aloud preferences and each provider with its check. */
  async describe() {
    return {
      prefs: this.readPrefs().tts,
      providers: await Promise.all(this.providers.map(async (p) => ({
        id: p.id, name: p.name, note: p.note, online: p.online, rateRange: p.rateRange, status: p.status || null,
        ...(await p.check().catch((e) => ({ supported: false, ready: false, reason: e.message }))),
      }))),
    };
  }
  /** Can `id` be chosen? (supported on this machine; null = silent is always fine) */
  async canChoose(id) {
    if (id === null) return true;
    return (await this.get(id).check()).supported;
  }

  /** {audio: Buffer, rate}: `text` read by the active provider, `rate` clamped to what it can do. */
  async speak({ text, language = "tr", rate = 1, session }) {
    const p = this.active();
    if (!p) throw new Error("Okuyan ses seçilmedi");
    const c = await p.check();
    if (!c.supported || !c.ready) throw new Error(c.reason || `${p.name} kullanılamıyor`);
    const [lo, hi] = p.rateRange;
    rate = Math.round(Math.min(hi, Math.max(lo, Number(rate) || 1)) * 20) / 20; // 0.05 steps: the cache stays useful
    const key = crypto.createHash("sha1").update(JSON.stringify([p.id, p.signature(language), String(text), rate, 2])).digest("hex");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const file = path.join(this.cacheDir, `${key}.${p.ext}`);
    if (!fs.existsSync(file)) {
      await p.speak({ text: String(text), language, rate, session, out: file });
      this.prune();
    } else fs.utimesSync(file, new Date(), new Date());
    return { audio: fs.readFileSync(file), rate };
  }
  cancel(session) { for (const p of this.providers) p.cancel?.(session); }
  warm() { const p = this.active(); return p?.warm ? p.check().then((c) => c.ready && p.warm()) : Promise.resolve(); }
  stop() { for (const p of this.providers) p.stop?.(); }
  call(id, action, args = {}) {
    const fn = this.get(id).actions?.[action];
    if (!fn) throw new Error(`${id}: bilinmeyen işlem ${action}`);
    return fn(args);
  }

  prune() {
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => !f.endsWith(".tmp")).map((f) => ({ f, t: fs.statSync(path.join(this.cacheDir, f)).mtimeMs }));
      if (files.length <= CACHE_MAX) return;
      files.sort((a, b) => a.t - b.t).slice(0, files.length - CACHE_MAX).forEach(({ f }) => fs.rmSync(path.join(this.cacheDir, f), { force: true }));
    } catch {}
  }
}
