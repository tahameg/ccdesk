// Terminal shortcuts: buttons in the terminal's header that paste a saved command into the shell without running
// it, and an editor for them. Two lists: this project's (<project>/.ccdesk-shortcuts.json) and global (state.json).
const K = window.ccdesk;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function initShortcuts({ toast, paste }) {
  let lists = { global: [], project: [] };
  let draft = null; // {global: [...], project: [...]} while the editor is open

  function renderBar() {
    const all = [...lists.project.map((x) => ({ ...x, scope: "project" })), ...lists.global.map((x) => ({ ...x, scope: "global" }))];
    $("#term-shortcuts").innerHTML = all.map((x) =>
      `<button class="sc ${x.scope}" data-sc="${esc(x.scope)}:${esc(x.id)}" title="${esc(x.command)}\n\nTerminale yapıştırır, çalıştırmaz (Enter sizde).${x.scope === "project" ? " Bu projeye özel." : ""}">${esc(x.label)}</button>`).join("");
  }
  async function load() {
    try { lists = await K.shortcuts.get(); } catch (e) { toast(e.message); }
    renderBar();
  }

  const row = (scope, x, i) => `<div class="sc-row" data-scope="${scope}" data-i="${i}">
    <input class="sc-label" placeholder="Ad" value="${esc(x.label)}" maxlength="40">
    <input class="sc-cmd" placeholder="Komut (tek satır)" value="${esc(x.command)}" spellcheck="false">
    <button class="icon" data-move="-1" title="Yukarı">↑</button><button class="icon" data-move="1" title="Aşağı">↓</button>
    <button class="icon" data-del title="Sil">✕</button></div>`;
  function readDraft() { // the inputs back into the draft
    for (const r of document.querySelectorAll("#sc-modal .sc-row")) {
      const x = draft[r.dataset.scope][Number(r.dataset.i)];
      x.label = $(".sc-label", r).value;
      x.command = $(".sc-cmd", r).value;
    }
  }
  function renderEditor() {
    const sec = (scope, title, note) => `<section><h3>${title}</h3><p class="faint">${note}</p>
      ${draft[scope].map((x, i) => row(scope, x, i)).join("") || '<div class="empty">Kısayol yok.</div>'}
      <div class="sc-actions"><button data-add="${scope}">+ Kısayol ekle</button>${scope === "global" ? '<button data-defaults>Varsayılanları geri yükle</button>' : ""}</div></section>`;
    $("#sc-modal .sc-body").innerHTML =
      sec("project", "Bu proje", "Yalnızca bu projede görünür (proje klasöründe <code>.ccdesk-shortcuts.json</code>).") +
      sec("global", "Tüm projeler", "Her projede görünür.") +
      `<p class="faint sc-help">Komut terminale yapıştırılır, çalıştırılmaz. Terminalde hazır değişkenler: <code>$CCDESK_PROJECT</code> (proje klasörü), <code>$CCDESK_MCP_CONFIG</code> (MCP sunucu dosyası), <code>$CCDESK_AGENT_PROMPT</code> (asistana not), <code>$CCDESK_MCP_COMMAND</code> + <code>$CCDESK_MCP_SERVER</code> (sunucuyu kendisi ekleyen asistanlar için).</p>`;
  }
  function openEditor() {
    draft = { global: lists.global.map((x) => ({ ...x })), project: lists.project.map((x) => ({ ...x })) };
    $("#sc-modal").hidden = false;
    renderEditor();
  }
  const closeEditor = () => { $("#sc-modal").hidden = true; draft = null; };
  async function save() {
    readDraft();
    try {
      await K.shortcuts.set("project", draft.project);
      lists = await K.shortcuts.set("global", draft.global);
      renderBar();
      closeEditor();
      toast("Kısayollar kaydedildi", "info");
    } catch (e) { toast(e.message); }
  }

  $("#term-shortcuts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sc]");
    if (!b) return;
    const [scope, id] = b.dataset.sc.split(":");
    const x = lists[scope].find((s) => s.id === id);
    if (x) paste(x.command);
  });
  $("#term-sc-edit").addEventListener("click", openEditor);
  $("#sc-modal").addEventListener("click", async (e) => {
    if (e.target.id === "sc-modal" || e.target.closest("[data-cancel]")) return closeEditor();
    if (e.target.closest("[data-save]")) return save();
    const b = e.target.closest("button");
    if (!b) return;
    readDraft();
    const r = b.closest(".sc-row");
    if (b.dataset.add) draft[b.dataset.add].push({ label: "", command: "" });
    else if (b.dataset.defaults !== undefined) {
      try { lists = await K.shortcuts.set("global", null); } catch (err) { return toast(err.message); }
      draft.global = lists.global.map((x) => ({ ...x }));
      renderBar();
    } else if (r) {
      const l = draft[r.dataset.scope], i = Number(r.dataset.i);
      if (b.dataset.del !== undefined) l.splice(i, 1);
      else if (b.dataset.move) { const j = i + Number(b.dataset.move); if (j >= 0 && j < l.length) [l[i], l[j]] = [l[j], l[i]]; }
    }
    renderEditor();
    if (b.dataset.add) [...document.querySelectorAll(`#sc-modal .sc-row[data-scope="${b.dataset.add}"] .sc-label`)].pop()?.focus();
  });
  $("#sc-modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeEditor(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
  });

  return { load, isOpen: () => !!draft };
}
