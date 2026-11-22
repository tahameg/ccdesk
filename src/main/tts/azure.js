// TTS provider "azure": Microsoft Azure AI Speech over its documented REST API. The free tier (F0) gives
// 500 000 characters of neural voices a month; it needs a Speech resource's key and region (portal.azure.com).
// The key is a secret: kept encrypted by the main process (secrets.js), never in state.json or the window.
// Speed: SSML <prosody rate>, so the reading speed can be met by the voice itself.
import fs from "node:fs";

/** Neural voices offered per content language (Azure has more; these read Turkish / English well). */
export const AZURE_VOICES = Object.freeze({
  tr: [
    { id: "tr-TR-EmelNeural", name: "Emel (kadın)" },
    { id: "tr-TR-AhmetNeural", name: "Ahmet (erkek)" },
  ],
  en: [
    { id: "en-US-AvaMultilingualNeural", name: "Ava (US, kadın)" },
    { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US, erkek)" },
    { id: "en-US-JennyNeural", name: "Jenny (US, kadın)" },
    { id: "en-US-GuyNeural", name: "Guy (US, erkek)" },
    { id: "en-GB-SoniaNeural", name: "Sonia (UK, kadın)" },
    { id: "en-GB-RyanNeural", name: "Ryan (UK, erkek)" },
  ],
});
export const AZURE_REGIONS = ["westeurope", "northeurope", "germanywestcentral", "francecentral", "uksouth", "swedencentral", "eastus", "eastus2", "westus2", "centralindia", "southeastasia", "japaneast", "australiaeast"];

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export class AzureProvider {
  id = "azure";
  name = "Azure Speech";
  note = "İnternet üzerinden, Microsoft'un sinir ağı sesleri. Ücretsiz katman (F0) ayda 500 bin karakter; bir Azure Speech anahtarı gerekir. Okunan metin Microsoft'a gönderilir.";
  online = true;
  ext = "wav";
  rateRange = [0.5, 2];

  constructor({ readPrefs, secrets }) {
    this.readPrefs = readPrefs;
    this.secrets = secrets;
    this.inflight = new Map(); // session → Set<AbortController>
    this.status = { state: "ready" };
  }

  voiceFor(language) {
    const a = this.readPrefs().tts.azure;
    return language === "en" ? a.voiceEn : a.voiceTr;
  }
  /** Runs anywhere with internet; ready once a key is given. */
  async check() {
    const has = !!this.secrets.get("azureKey");
    return { supported: true, ready: has, reason: has ? null : "Azure Speech anahtarını girin.", details: { region: this.readPrefs().tts.azure.region } };
  }
  signature(language) { return JSON.stringify([this.voiceFor(language), language]); }

  async speak({ text, language, rate = 1, session, out }) {
    const key = this.secrets.get("azureKey");
    if (!key) throw new Error("Azure Speech anahtarı girilmedi (Ayarlar → Sesli okuma).");
    const { region } = this.readPrefs().tts.azure;
    const lang = language === "en" ? "en-US" : "tr-TR";
    const pct = Math.round((rate - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xml(this.voiceFor(language))}"><prosody rate="${pct >= 0 ? "+" : ""}${pct}%">${xml(text)}</prosody></voice></speak>`;
    const ctl = new AbortController();
    const set = this.inflight.get(session) || new Set();
    set.add(ctl); this.inflight.set(session, set);
    const timer = setTimeout(() => ctl.abort(new Error("Azure yanıt vermedi (zaman aşımı)")), 30000);
    try {
      const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST", signal: ctl.signal, body: ssml,
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "ccdesk" },
      });
      if (!r.ok) {
        const why = { 400: "istek reddedildi (ses adı bu bölgede yok olabilir)", 401: "anahtar geçersiz ya da bölge yanlış", 403: "erişim yok (anahtar / bölge)", 429: "kota ya da hız sınırı doldu" }[r.status] || `HTTP ${r.status}`;
        throw new Error(`Azure Speech: ${why}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) throw new Error("Azure Speech boş ses döndürdü");
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, out);
    } catch (e) {
      if (ctl.signal.aborted && ctl.signal.reason?.cancelled) throw Object.assign(new Error("iptal"), { cancelled: true });
      if (e.name === "TypeError") throw new Error(`Azure Speech'e ulaşılamadı (internet?): ${e.cause?.code || e.message}`);
      throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
    } finally {
      clearTimeout(timer);
      set.delete(ctl);
      if (!set.size) this.inflight.delete(session);
    }
  }
  cancel(session) {
    for (const c of this.inflight.get(session) || []) c.abort(Object.assign(new Error("iptal"), { cancelled: true }));
  }
  stop() { for (const s of this.inflight.keys()) this.cancel(s); }

  actions = {
    voices: () => AZURE_VOICES,
    regions: () => AZURE_REGIONS,
    hasKey: () => !!this.secrets.get("azureKey"),
    setKey: ({ key }) => { this.secrets.set("azureKey", String(key || "").trim() || null); return !!this.secrets.get("azureKey"); },
  };
}
