// The settings window: a menu on the left (Görünüm, Dil, Sesli okuma; Proje ayarları), the chosen pane on the
// right. App-wide preferences live in the state dir (window.ccdesk.prefs); the project's own settings are ops.
// Read-aloud: the provider list comes from the main process (tts:describe) with each provider's check; one that
// this machine can't run is shown but can't be chosen. Each provider brings its own pane (./tts/<id>.js).
import { LANGUAGES } from "../core/reading.js";
import { omnivoicePane } from "./tts/omnivoice.js";
import { azurePane } from "./tts/azure.js";

const K = window.ccdesk;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const UI_FONTS = { roboto: "Roboto", inter: "Inter", system: "Sistem yazı tipi" };
const SCRIPT_FONTS = { "courier-prime": "Courier Prime (daktilo)", "ibm-plex-mono": "IBM Plex Mono", "source-serif": "Source Serif" };
const PANES = { appearance: "Görünüm", language: "Dil", tts: "Sesli okuma", project: "Proje ayarları" };
const PROVIDER_PANES = { omnivoice: omnivoicePane, azure: azurePane };
const SAMPLE = {
  tr: "Merhaba! Bu, sesli okuma denemesi. İki bin yirmi altıda yüzde kırk daha hızlı.",
  en: "Hello! This is a read-aloud test. In 2026 it got 40% faster.",
};

/** Read-aloud state shared with the player. */
export const TTS = {
  prefs: { provider: null, sync: true, omnivoice: {}, azure: {} },
  providers: [],
  status: {}, // provider id → last status from the main process
  provider() { return this.providers.find((p) => p.id === this.prefs.provider) || null; },
  /** Who reads now, for the player: null = silent. */
  active() { const p = this.provider(); return p && p.supported && p.ready ? p : null; },
  /** What the speed calibration is remembered by: provider, voice, language. */
  voiceKey(language) {
    const p = this.prefs;
    const v = p.provider === "omnivoice" ? p.omnivoice.voice : p.provider === "azure" ? (language === "en" ? p.azure.voiceEn : p.azure.voiceTr) : "";
    return `${p.provider}|${v}|${language}`;
  },
};

export const PREFS = { value: null };

export function applyAppearance(a) {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.uiFont = a.uiFont;
  root.dataset.scriptFont = a.scriptFont;
}

export async function loadPrefs() {
  PREFS.value = await K.prefs.get();
  applyAppearance(PREFS.value.appearance);
  TTS.prefs = PREFS.value.tts;
  return PREFS.value;
}

export function initSettings({ toast, getProject, apply, onTtsChange, onDescribed }) {
  let pane = "appearance";
  let audioCtx = null;
  const ctx = () => (audioCtx ||= new AudioContext());
  let playing = null;
  const play = async (bytes) => {
    try { playing?.stop(); } catch {}
    await ctx().resume();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const s = ctx().createBufferSource();
    s.buffer = await ctx().decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    s.connect(ctx().destination);
    s.start();
    playing = s;
  };
  const language = () => getProject()?.settings.language || "tr";

  async function setPrefs(patch) {
    try {
      PREFS.value = await K.prefs.set(patch);
      applyAppearance(PREFS.value.appearance);
      const ttsChanged = patch.tts !== undefined;
      TTS.prefs = PREFS.value.tts;
      if (ttsChanged) { await describe(); onTtsChange(); }
    } catch (e) { toast(e.message); }
    render();
  }
  async function describe() {
    const d = await K.tts.describe();
    TTS.prefs = d.prefs; TTS.providers = d.providers;
    for (const p of d.providers) if (p.status && !TTS.status[p.id]) TTS.status[p.id] = p.status;
    return d;
  }

  // the provider's own pane lives as long as that provider stays chosen
  let providerPane = null;
  const paneCtx = { toast, play, language, setPrefs, describe: async () => { await describe(); renderTts(); onTtsChange(); }, prefs: () => TTS.prefs, status: (id) => TTS.status[id] || {} };

  function render() {
    for (const b of document.querySelectorAll(".settings-nav [data-pane]")) {
      b.classList.toggle("on", b.dataset.pane === pane);
      if (b.dataset.pane === "project") b.disabled = !getProject();
    }
    for (const el of document.querySelectorAll(".settings-body .pane")) el.hidden = el.dataset.pane !== pane;
    $("#settings-title").textContent = PANES[pane];
    if (pane === "appearance") renderAppearance();
    if (pane === "tts") renderTts();
    if (pane === "project") renderProject();
  }

  function renderAppearance() {
    const a = PREFS.value.appearance;
    for (const b of document.querySelectorAll("[data-theme-pick]")) b.classList.toggle("on", b.dataset.themePick === a.theme);
    $("#pref-ui-font").innerHTML = Object.entries(UI_FONTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    $("#pref-ui-font").value = a.uiFont;
    $("#pref-script-font").innerHTML = Object.entries(SCRIPT_FONTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    $("#pref-script-font").value = a.scriptFont;
  }

  function renderTts() {
    const P = TTS.prefs;
    const rows = [{ id: null, name: "Yok", note: "Ses yok: oynatma sessiz, okuma hızında.", supported: true, ready: true }, ...TTS.providers];
    $("#tts-providers").innerHTML = rows.map((p) => {
      const on = (P.provider ?? null) === p.id;
      const tag = p.id === null ? "" : `<span class="tag ${p.online ? "net" : "local"}">${p.online ? "İnternet" : "Yerel"}</span>`;
      const state = !p.supported ? `<span class="why bad">${esc(p.reason)}</span>` : p.id && !p.ready ? `<span class="why">${esc(p.reason)}</span>` : "";
      const spec = p.id === "omnivoice" && p.details?.gpu ? `<span class="faint">${esc(p.details.gpu)} · ${p.details.ramGB} GB RAM</span>` : "";
      return `<label class="provider ${on ? "on" : ""} ${p.supported ? "" : "off"}">
        <input type="radio" name="tts-provider" value="${p.id ?? ""}" ${on ? "checked" : ""} ${p.supported ? "" : "disabled"}>
        <span class="pv-body"><span class="pv-name"><b>${esc(p.name)}</b>${tag}</span><span class="pv-note">${esc(p.note)}</span>${spec}${state}</span></label>`;
    }).join("");
    $("#tts-sync").checked = !!P.sync;
    $("#tts-common").hidden = !P.provider;
    const box = $("#tts-provider-pane");
    const make = PROVIDER_PANES[P.provider];
    const prov = TTS.provider();
    if (!make || !prov?.supported) { providerPane?.destroy?.(); providerPane = null; box.innerHTML = ""; box.dataset.id = ""; return; }
    if (box.dataset.id !== P.provider) {
      providerPane?.destroy?.();
      box.dataset.id = P.provider;
      box.innerHTML = "";
      providerPane = make(box, paneCtx);
    }
    providerPane.render();
  }

  function renderProject() {
    const p = getProject();
    $("#proj-none").hidden = !!p;
    $("#proj-language").disabled = !p;
    $("#proj-language").innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    $("#proj-language").value = p?.settings.language || "tr";
  }

  function open(which) {
    if (which) pane = which;
    if (pane === "project" && !getProject()) pane = "appearance";
    $("#settings").hidden = false;
    render();
    describe().then(() => { if (!$("#settings").hidden) render(); onDescribed?.(); }).catch((e) => toast(e.message));
  }
  function close() {
    providerPane?.closing?.();
    $("#settings").hidden = true;
  }

  // ---- wiring ----
  $(".settings-nav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pane]");
    if (b && !b.disabled) { pane = b.dataset.pane; render(); }
  });
  $("#settings-close").addEventListener("click", close);
  $("#settings").addEventListener("mousedown", (e) => { if (e.target.id === "settings") close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#settings").hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) close(); });

  for (const b of document.querySelectorAll("[data-theme-pick]")) b.addEventListener("click", () => setPrefs({ appearance: { theme: b.dataset.themePick } }));
  $("#pref-ui-font").addEventListener("change", (e) => setPrefs({ appearance: { uiFont: e.target.value } }));
  $("#pref-script-font").addEventListener("change", (e) => setPrefs({ appearance: { scriptFont: e.target.value } }));

  $("#tts-providers").addEventListener("change", (e) => {
    if (e.target.name === "tts-provider") setPrefs({ tts: { provider: e.target.value || null } });
  });
  $("#tts-sync").addEventListener("change", (e) => setPrefs({ tts: { sync: e.target.checked } }));
  $("#tts-try").addEventListener("click", async () => {
    const lang = language();
    $("#tts-try").disabled = true;
    $("#tts-try-msg").textContent = "Hazırlanıyor…";
    try {
      const r = await K.tts.speak(SAMPLE[lang], { session: "try", language: lang });
      $("#tts-try-msg").textContent = `${LANGUAGES[lang]} örnek`;
      await play(r.audio);
    } catch (err) { $("#tts-try-msg").textContent = ""; toast(err.message); } finally { $("#tts-try").disabled = false; }
  });

  $("#proj-language").addEventListener("change", (e) => apply([{ op: "setSettings", settings: { language: e.target.value } }]).then(() => onTtsChange()).catch(() => renderProject()));

  K.tts.onStatus((st) => {
    TTS.status[st.provider] = st;
    if (!$("#settings").hidden && pane === "tts" && TTS.prefs.provider === st.provider) providerPane?.status?.(st);
  });

  return {
    open,
    /** the project changed (or another opened): keep the project pane true */
    refresh() { if (!$("#settings").hidden && pane === "project") renderProject(); },
    describe,
  };
}
