// Electron main process: windows, menus, dialogs, the project file watcher and the medya:// protocol.
// Every change goes through core/store.applyOps (the same path the MCP server uses), so the app and Claude
// can work on one project at the same time; the watcher pushes the other side's changes to the window.
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyOps, loadProject, createProject, isProjectDir, PROJECT_FILE, MEDIA_DIR } from "../core/store.js";
import { exportHtml } from "../core/export.js";
import { readState, setCurrent } from "../core/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(app.isPackaged ? 1 : 2);
// --smoke <project dir> <out.png> [item id] [px per second]: render once, save a screenshot, quit (for checks)
const smoke = args.includes("--smoke") ? (([dir, out, select, pps]) => ({ dir, out, select, pps }))(args.slice(args.indexOf("--smoke") + 1)) : null;

protocol.registerSchemesAsPrivileged([
  { scheme: "medya", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let current = null; // project folder
let lastRevision = -1;
let watcher = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function watch(dir) {
  watcher?.close();
  let timer = null;
  watcher = fs.watch(dir, (event, name) => {
    if (name && name !== PROJECT_FILE) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const p = loadProject(dir);
        if (p.revision !== lastRevision) {
          lastRevision = p.revision;
          send("project:changed", p);
        }
      } catch {} // mid-write or removed: the next event brings it
    }, 80);
  });
}

function openProject(dir) {
  const abs = path.resolve(dir);
  if (!isProjectDir(abs)) throw new Error(`Bu klasörde bir Kurgu Masası projesi yok: ${abs}`);
  const p = loadProject(abs);
  current = abs;
  lastRevision = p.revision;
  if (!smoke) setCurrent(abs);
  watch(abs);
  win?.setTitle(`${p.title} — Kurgu Masası`);
  buildMenu();
  return { dir: abs, project: p };
}

async function chooseFolder(title, create) {
  const r = await dialog.showOpenDialog(win, {
    title,
    properties: ["openDirectory", ...(create ? ["createDirectory", "promptToCreate"] : [])],
    buttonLabel: create ? "Bu klasörde oluştur" : "Aç",
  });
  return r.canceled ? null : r.filePaths[0];
}

async function newProjectFlow() {
  const dir = await chooseFolder("Yeni proje için boş bir klasör seçin (veya oluşturun)", true);
  if (!dir) return null;
  if (!isProjectDir(dir)) createProject(dir, { title: path.basename(dir) });
  const r = openProject(dir);
  send("project:opened", r);
  return r;
}

async function openProjectFlow(dir) {
  const d = dir || (await chooseFolder("Proje klasörünü seçin", false));
  if (!d) return null;
  const r = openProject(d);
  send("project:opened", r);
  return r;
}

async function exportFlow() {
  if (!current) return null;
  const file = exportHtml(current, loadProject(current));
  shell.openExternal(pathToFileURL(file).href);
  return file;
}

function buildMenu() {
  const recent = readState().recent.filter((d) => d !== current && isProjectDir(d));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Dosya", submenu: [
      { label: "Yeni proje…", accelerator: "CmdOrCtrl+N", click: () => newProjectFlow().catch(showError) },
      { label: "Proje aç…", accelerator: "CmdOrCtrl+O", click: () => openProjectFlow().catch(showError) },
      { label: "Son projeler", enabled: recent.length > 0, submenu: recent.map((d) => ({ label: d, click: () => openProjectFlow(d).catch(showError) })) },
      { type: "separator" },
      { label: "HTML olarak dışa aktar", accelerator: "CmdOrCtrl+E", enabled: !!current, click: () => exportFlow().catch(showError) },
      { label: "Proje klasörünü göster", enabled: !!current, click: () => shell.openPath(current) },
      { type: "separator" },
      { role: "quit", label: "Çıkış" },
    ] },
    { label: "Düzen", submenu: [
      { role: "undo", label: "Geri al (metin)" }, { role: "redo", label: "Yinele (metin)" }, { type: "separator" },
      { role: "cut", label: "Kes" }, { role: "copy", label: "Kopyala" }, { role: "paste", label: "Yapıştır" }, { role: "selectAll", label: "Tümünü seç" },
    ] },
    { label: "Görünüm", submenu: [
      { role: "reload", label: "Yenile" }, { role: "toggleDevTools", label: "Geliştirici araçları" }, { type: "separator" },
      { role: "resetZoom", label: "Gerçek boyut" }, { role: "zoomIn", label: "Büyüt" }, { role: "zoomOut", label: "Küçült" }, { role: "togglefullscreen", label: "Tam ekran" },
    ] },
  ]));
}

function showError(e) {
  dialog.showErrorBox("Kurgu Masası", String(e?.message || e));
}

// ---- IPC ----
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  try {
    return { ok: true, value: await fn(...a) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

handle("app:state", () => ({
  dir: current,
  project: current ? loadProject(current) : null,
  recent: readState().recent.filter((d) => isProjectDir(d)),
  smoke: !!smoke,
}));
handle("project:new", () => newProjectFlow());
handle("project:open", (dir) => openProjectFlow(dir));
handle("project:apply", (ops) => {
  if (!current) throw new Error("Açık proje yok");
  const r = applyOps(current, "ui", ops);
  lastRevision = r.project.revision;
  if (ops.some((o) => o.op === "setProject")) win?.setTitle(`${r.project.title} — Kurgu Masası`);
  return { project: r.project, results: r.results };
});
handle("media:pick", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Nota eklenecek dosyalar", properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : r.filePaths;
});
handle("export:html", () => exportFlow());
handle("shell:openMedia", (file) => {
  if (!current) return;
  const full = path.join(current, MEDIA_DIR, path.basename(file));
  return shell.openPath(full);
});
handle("shell:openUrl", (url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error("Yalnızca http(s) bağlantıları açılır");
  return shell.openExternal(url);
});
ipcMain.on("smoke:ready", async () => {
  if (!smoke) return;
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(smoke.out, img.toPNG());
  app.exit(0);
});

// ---- app ----
app.whenReady().then(() => {
  protocol.handle("medya", (req) => {
    if (!current) return new Response("no project", { status: 404 });
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    const file = path.join(current, MEDIA_DIR, path.basename(name));
    if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  win = new BrowserWindow({
    width: smoke ? 1500 : 1440,
    height: smoke ? 920 : 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#14122b",
    title: "Kurgu Masası",
    show: !smoke,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  const start = smoke?.dir || readState().current;
  if (start && isProjectDir(start)) {
    try { openProject(start); } catch (e) { console.error(e); }
  }
  buildMenu();
  win.loadFile(path.join(HERE, "..", "renderer", "index.html"), { query: smoke ? { smoke: "1", select: smoke.select || "", pps: smoke.pps || "" } : {} });
});

app.on("window-all-closed", () => app.quit());
