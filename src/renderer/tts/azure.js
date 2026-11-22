// Azure Speech's settings pane: the key (kept encrypted by the main process; the window only learns whether
// one is saved), the region, and a voice for each content language.
const K = window.ccdesk;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const call = (action, args) => K.tts.call("azure", action, args);
const PORTAL = "https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices";

export function azurePane(box, ctx) {
  box.innerHTML = `
    <div class="set-group">
      <div class="set-label">Hesap</div>
      <p class="faint">Ücretsiz anahtar: Azure portalında bir <b>Speech</b> kaynağı oluşturun, fiyat katmanı <b>Free F0</b> (ayda 500 bin karakter). “Keys and Endpoint” sayfasındaki anahtarı ve bölgeyi buraya girin. <button class="link" data-act="portal">Azure portalını aç</button></p>
      <div class="row"><input data-o="key" type="password" placeholder="Anahtar" autocomplete="off" spellcheck="false"><button data-act="save">Kaydet</button><button data-act="forget" class="danger" hidden>Anahtarı sil</button><span data-o="keystate" class="faint"></span></div>
      <div class="set-grid"><label>Bölge<select data-o="region"></select></label></div>
    </div>
    <div class="set-group">
      <div class="set-label">Sesler</div>
      <div class="set-grid">
        <label>Türkçe içerik<select data-o="voiceTr"></select></label>
        <label>İngilizce içerik<select data-o="voiceEn"></select></label>
      </div>
      <p class="faint">Hangisinin okuyacağını projenin içerik dili belirler (Proje ayarları).</p>
    </div>`;
  const $ = (k) => box.querySelector(`[data-o="${k}"]`);
  const btn = (k) => box.querySelector(`[data-act="${k}"]`);
  let voices = { tr: [], en: [] }, regions = [], hasKey = false;
  const a = () => ctx.prefs().azure;
  const opts = (list, cur) => {
    const all = list.some((v) => v.id === cur) || !cur ? list : [...list, { id: cur, name: cur }];
    return all.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("");
  };

  function render() {
    $("region").innerHTML = opts(regions.map((r) => ({ id: r, name: r })), a().region);
    $("region").value = a().region;
    $("voiceTr").innerHTML = opts(voices.tr, a().voiceTr); $("voiceTr").value = a().voiceTr;
    $("voiceEn").innerHTML = opts(voices.en, a().voiceEn); $("voiceEn").value = a().voiceEn;
    $("keystate").textContent = hasKey ? "✓ anahtar kayıtlı" : "anahtar yok";
    btn("forget").hidden = !hasKey;
  }
  async function load() {
    [voices, regions, hasKey] = await Promise.all([call("voices"), call("regions"), call("hasKey")]);
    render();
  }
  const setA = (patch) => ctx.setPrefs({ tts: { azure: patch } });

  btn("portal").addEventListener("click", () => K.openUrl(PORTAL).catch((e) => ctx.toast(e.message)));
  btn("save").addEventListener("click", async () => {
    const key = $("key").value.trim();
    if (!key) return ctx.toast("Anahtarı yapıştırın.");
    try { hasKey = await call("setKey", { key }); $("key").value = ""; render(); await ctx.describe(); } catch (e) { ctx.toast(e.message); }
  });
  $("key").addEventListener("keydown", (e) => { if (e.key === "Enter") btn("save").click(); });
  btn("forget").addEventListener("click", async () => {
    if (!confirm("Kayıtlı Azure anahtarı silinsin mi?")) return;
    try { hasKey = await call("setKey", { key: null }); render(); await ctx.describe(); } catch (e) { ctx.toast(e.message); }
  });
  $("region").addEventListener("change", (e) => setA({ region: e.target.value }));
  $("voiceTr").addEventListener("change", (e) => setA({ voiceTr: e.target.value }));
  $("voiceEn").addEventListener("change", (e) => setA({ voiceEn: e.target.value }));

  load().catch((e) => ctx.toast(e.message));
  return { render };
}
