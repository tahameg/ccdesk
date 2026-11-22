// OmniVoice's settings pane: the voice, speed and quality, the engine's state, and the voice manager (list,
// listen, delete, add from a file or the microphone). Voices are app-wide (state dir), not per project.
const K = window.ccdesk;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const call = (action, args) => K.tts.call("omnivoice", action, args);

const STATE_TEXT = { off: "Ses motoru kapalı (oynatınca açılır)", starting: "Ses motoru başlıyor…", loading: "Model yükleniyor…", ready: "Hazır", busy: "Çalışıyor…" };

export function omnivoicePane(box, ctx) {
  box.innerHTML = `
    <div class="set-group">
      <div class="set-label">Ses</div>
      <div class="set-grid">
        <label>Ses<select data-o="voice"></select></label>
        <label>Hız<input data-o="speed" type="number" step="0.05" min="0.6" max="1.5"></label>
        <label title="Yüksek = daha temiz, daha yavaş">Kalite (adım)<input data-o="steps" type="number" step="4" min="8" max="64"></label>
      </div>
      <p class="faint" data-o="status"></p>
    </div>
    <div class="set-group">
      <div class="set-label">Sesler</div>
      <div class="voices-list" data-o="list"></div>
    </div>
    <div class="set-group new-voice">
      <div class="set-label">Yeni ses</div>
      <p class="faint">5–15 saniyelik, gürültüsüz, tek kişinin konuştuğu bir kayıt en iyisi. Kayıtta söylenen metni yazarsanız daha iyi olur; boş bırakırsanız Whisper yazıya döker.</p>
      <input data-o="name" placeholder="Sesin adı (ör. Buse)">
      <div class="row"><button data-act="pick">Dosya seç</button><button data-act="rec">● Mikrofonla kaydet</button><button data-act="listen" hidden>▶ Dinle</button><span data-o="src" class="faint">Kayıt yok</span></div>
      <textarea data-o="text" rows="2" placeholder="Kayıtta söylenen metin (isteğe bağlı)"></textarea>
      <div class="row"><button data-act="create" class="primary">Sesi oluştur</button><span data-o="msg" class="muted"></span></div>
    </div>`;
  const $ = (k) => box.querySelector(`[data-o="${k}"]`);
  const btn = (k) => box.querySelector(`[data-act="${k}"]`);
  let voices = [];
  let source = null; // {path} | {bytes, seconds}
  let rec = null;
  let creating = false;
  let alive = true;
  const o = () => ctx.prefs().omnivoice;

  function renderStatus(st = ctx.status("omnivoice")) {
    const dev = st.device ? (st.device === "cpu" ? " · CPU (yavaş)" : " · GPU") : "";
    $("status").textContent = o().voice ? `${STATE_TEXT[st.state] || st.state || STATE_TEXT.off}${dev}${st.note ? ` — ${st.note}` : ""}` : "Ses seçilmedi: aşağıdan bir ses seçin ya da oluşturun.";
    if (creating && st.note) $("msg").textContent = st.note;
  }
  function renderControls() {
    $("voice").innerHTML = `<option value="">— ses seçin —</option>${voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("")}`;
    $("voice").value = voices.some((v) => v.id === o().voice) ? o().voice : "";
    if (document.activeElement !== $("speed")) $("speed").value = o().speed;
    if (document.activeElement !== $("steps")) $("steps").value = o().steps;
    renderStatus();
  }
  function renderList() {
    const cur = o().voice;
    $("list").innerHTML = voices.map((v) => `<div class="voice ${v.id === cur ? "on" : ""}">
      <b>${esc(v.name)}</b>
      <div class="btns"><button data-listen="${esc(v.id)}">▶ Kayıt</button>${v.id === cur ? "" : `<button data-use="${esc(v.id)}">Seç</button>`}<button class="danger" data-del="${esc(v.id)}">Sil</button></div>
      <p class="meta">${String(Math.round(v.seconds * 10) / 10).replace(".", ",")} sn · “${esc(v.refText)}”</p></div>`).join("") || '<p class="faint">Henüz ses yok. Aşağıdan bir kayıtla oluşturun.</p>';
  }
  async function load() {
    voices = await call("voices");
    if (!alive) return;
    renderControls(); renderList();
  }
  const setO = (patch) => ctx.setPrefs({ tts: { omnivoice: patch } });

  $("voice").addEventListener("change", (e) => setO({ voice: e.target.value || null }));
  $("speed").addEventListener("change", (e) => setO({ speed: Number(e.target.value) }));
  $("steps").addEventListener("change", (e) => setO({ steps: Number(e.target.value) }));
  $("list").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.listen) await ctx.play(await call("refAudio", { id: b.dataset.listen }));
      if (b.dataset.use) await setO({ voice: b.dataset.use });
      if (b.dataset.del) {
        const v = voices.find((x) => x.id === b.dataset.del);
        if (!confirm(`“${v?.name}” sesi silinsin mi? Kaydı da silinir.`)) return;
        await call("deleteVoice", { id: b.dataset.del });
        await ctx.describe();
        await load();
      }
    } catch (err) { ctx.toast(err.message); }
  });

  // ---- a new voice ----
  const showSource = (text) => { $("src").textContent = text; btn("listen").hidden = !source?.bytes; };
  btn("pick").addEventListener("click", async () => {
    try {
      const f = await K.tts.pickAudio();
      if (f) { source = { path: f }; showSource(f.split("/").pop()); }
    } catch (e) { ctx.toast(e.message); }
  });
  const stopRec = () => { if (rec?.state === "recording") rec.stop(); };
  btn("rec").addEventListener("click", async () => {
    if (rec?.state === "recording") return stopRec();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } });
      const parts = [];
      const t0 = Date.now();
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      const timer = setInterval(() => showSource(`Kaydediliyor… ${Math.round((Date.now() - t0) / 1000)} sn (5–15 sn yeterli)`), 250);
      rec.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        btn("rec").classList.remove("rec"); btn("rec").textContent = "● Yeniden kaydet";
        const bytes = new Uint8Array(await new Blob(parts, { type: rec.mimeType }).arrayBuffer());
        const seconds = (Date.now() - t0) / 1000;
        source = { bytes, seconds };
        showSource(`Mikrofon kaydı · ${Math.round(seconds)} sn${seconds < 5 ? " — kısa, 5–15 sn daha iyi" : ""}`);
      };
      rec.start(250);
      btn("rec").classList.add("rec"); btn("rec").textContent = "■ Durdur";
    } catch (e) { ctx.toast(`Mikrofon açılamadı: ${e.message}`); }
  });
  btn("listen").addEventListener("click", () => source?.bytes && ctx.play(source.bytes).catch((e) => ctx.toast(`Kayıt çalınamadı: ${e.message}`)));
  btn("create").addEventListener("click", async () => {
    if (creating) return;
    const name = $("name").value.trim();
    if (!name) return ctx.toast("Sese bir ad verin.");
    if (!source) return ctx.toast("Bir dosya seçin ya da mikrofonla kaydedin.");
    stopRec();
    creating = true;
    btn("create").disabled = true;
    $("msg").textContent = "Ses hazırlanıyor (ilk seferde model de yüklenir)…";
    try {
      const v = await call("addVoice", { name, path: source.path, bytes: source.bytes, refText: $("text").value });
      $("msg").textContent = `✓ “${v.name}” oluşturuldu. Duyulan metin: “${v.refText}”`;
      source = null; showSource("Kayıt yok"); $("name").value = ""; $("text").value = ""; btn("rec").textContent = "● Mikrofonla kaydet";
      await load();
      if (!o().voice) await setO({ voice: v.id });
    } catch (e) {
      $("msg").textContent = "";
      ctx.toast(`Ses oluşturulamadı: ${e.message}`);
    } finally { creating = false; btn("create").disabled = false; }
  });

  load().catch((e) => { $("status").textContent = e.message; });
  return {
    render() { renderControls(); renderList(); },
    status: renderStatus,
    closing: stopRec,
    destroy() { alive = false; stopRec(); },
  };
}
