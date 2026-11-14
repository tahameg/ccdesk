// Electron main process: window, menus, dialogs, the project watcher, the medya:// protocol and the terminal.
// Every change goes through core/store.applyOps (the MCP server uses the same path), so the app and Claude can
// work on one project at once; the watcher pushes the other side's changes to the window.
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyOps, loadProject, createProject, isProjectDir, writeUiState, PROJECT_FILE, MEDIA_DIR } from "../core/store.js";
import { exportHtml } from "../core/export.js";
import { readState, setCurrent, STATE_DIR } from "../core/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const args = process.argv.slice(app.isPackaged ? 1 : 2);
// --smoke <project dir> <out.png> [item id] [px per second] [time]: render once, save a screenshot, quit
const smoke = args.includes("--smoke") ? (([dir, out, select, pps, time]) => ({ dir, out, select, pps, time }))(args.slice(args.indexOf("--smoke") + 1)) : null;

protocol.registerSchemesAsPrivileged([{ scheme: "medya", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win = null;
let current = null;
let lastRevision = -1;
let watcher = null;

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function watch(dir) {
  watcher?.close();
  let timer = null;
  watcher = fs.watch(dir, (_ev, name) => {
    if (name && name !== PROJECT_FILE) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const p = loadProject(dir);
        if (p.revision !== lastRevision) { lastRevision = p.revision; send("project:changed", p); }
      } catch {} // mid-write: the next event brings it
    }, 80);
  });
}

function openProject(dir) {
  const abs = path.resolve(dir);
  if (!isProjectDir(abs)) throw new Error(`Bu klasörde bir Kurgu Masası projesi yok: ${abs}`);
  const p = loadProject(abs);
  if (abs !== current) stopTerminal();
  current = abs;
  lastRevision = p.revision;
  if (!smoke) setCurrent(abs);
  watch(abs);
  win?.setTitle(`${p.title} — Kurgu Masası`);
  buildMenu();
  return { dir: abs, project: p };
}

async function chooseFolder(title, create) {
  const r = await dialog.showOpenDialog(win, { title, properties: ["openDirectory", ...(create ? ["createDirectory", "promptToCreate"] : [])], buttonLabel: create ? "Bu klasörde oluştur" : "Aç" });
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

// ---- terminal (Claude Code in the project folder) ----
let term = null;
function claudeFiles(dir) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const h = crypto.createHash("sha1").update(dir).digest("hex").slice(0, 10);
  const cfg = path.join(STATE_DIR, `claude-mcp-${h}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { "kurgu-masasi": {
    command: process.execPath, args: [path.join(ROOT, "src", "mcp", "server.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", KURGU_PROJECT: dir },
  } } }, null, 1));
  const prompt = path.join(STATE_DIR, "claude-prompt.md");
  fs.writeFileSync(prompt, [
    "You were started from the terminal inside Kurgu Masası, the owner's desk for deciding a video edit.",
    `The project open in the app: ${dir}`,
    "The kurgu-masasi MCP tools work on it. When the owner says here / this / burası / şurası, call kurgu_cursor first: it",
    "tells you the playhead, the mouse position, the word being said there and the selected item. kurgu_timeline gives the whole edit.",
    "Propose changes with kurgu_suggest (the owner accepts or rejects them in the app); edit directly only when asked.",
    "Speak Turkish with the owner. Never invent facts about real people.",
  ].join("\n"));
  return { cfg, prompt };
}
function startTerminal({ cols, rows, withClaude }) {
  if (!current) throw new Error("Açık proje yok");
  if (term) { resizeTerminal({ cols, rows }); return { running: true }; }
  const sh = process.env.SHELL || "/bin/bash";
  const child = spawn("python3", [path.join(HERE, "pty-helper.py"), current, sh, "-l"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({ ...rest, TERM: "xterm-256color", COLORTERM: "truecolor", KURGU_PROJECT: current }))(process.env),
  });
  const dec = new StringDecoder("utf8");
  child.stdout.on("data", (d) => send("term:data", dec.write(d)));
  child.stderr.on("data", (d) => send("term:data", d.toString()));
  child.on("exit", (code) => { if (term?.child === child) term = null; send("term:exit", code); });
  term = { child, dir: current };
  resizeTerminal({ cols, rows });
  if (withClaude) setTimeout(() => runClaude(), 350);
  return { running: true };
}
function runClaude() {
  if (!term) throw new Error("Terminal kapalı");
  const { cfg, prompt } = claudeFiles(term.dir);
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  term.child.stdin.write(`claude --mcp-config ${q(cfg)} --append-system-prompt-file ${q(prompt)}\r`);
}
function resizeTerminal({ cols, rows }) {
  if (term && cols > 0 && rows > 0) term.child.stdio[3].write(`${JSON.stringify({ cols, rows })}\n`);
}
function stopTerminal() {
  if (term) { try { term.child.stdin.end(); term.child.kill(); } catch {} term = null; }
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
      { label: "Geri al", accelerator: "CmdOrCtrl+Z", click: () => send("menu:undo") },
      { label: "Yinele", accelerator: "CmdOrCtrl+Shift+Z", click: () => send("menu:redo") },
      { type: "separator" },
      { role: "cut", label: "Kes" }, { role: "copy", label: "Kopyala" }, { role: "paste", label: "Yapıştır" }, { role: "selectAll", label: "Tümünü seç" },
    ] },
    { label: "Görünüm", submenu: [
      { label: "Terminal (Claude Code)", accelerator: "CmdOrCtrl+`", click: () => send("menu:terminal") },
      { type: "separator" },
      { role: "reload", label: "Yenile" }, { role: "toggleDevTools", label: "Geliştirici araçları" }, { type: "separator" },
      { role: "resetZoom", label: "Gerçek boyut" }, { role: "zoomIn", label: "Büyüt" }, { role: "zoomOut", label: "Küçült" }, { role: "togglefullscreen", label: "Tam ekran" },
    ] },
  ]));
}
const showError = (e) => dialog.showErrorBox("Kurgu Masası", String(e?.message || e));

// ---- IPC ----
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
handle("app:state", () => ({ dir: current, project: current ? loadProject(current) : null, recent: readState().recent.filter((d) => isProjectDir(d)), smoke }));
handle("project:new", () => newProjectFlow());
handle("project:open", (dir) => openProjectFlow(dir));
handle("project:apply", (ops) => {
  if (!current) throw new Error("Açık proje yok");
  const r = applyOps(current, "ui", ops);
  lastRevision = r.project.revision;
  if (ops.some((o) => o.op === "setSettings" && o.title !== undefined)) win?.setTitle(`${r.project.title} — Kurgu Masası`);
  return r;
});
handle("media:pick", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Olaya eklenecek dosyalar", properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : r.filePaths;
});
handle("export:html", () => exportFlow());
handle("shell:openMedia", (file) => current && shell.openPath(path.join(current, MEDIA_DIR, path.basename(file))));
handle("shell:openUrl", (url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error("Yalnızca http(s) bağlantıları açılır");
  return shell.openExternal(url);
});
handle("term:start", (o) => startTerminal(o));
handle("term:claude", () => runClaude());
ipcMain.on("term:input", (_e, data) => term?.child.stdin.write(data));
ipcMain.on("term:resize", (_e, size) => resizeTerminal(size));
ipcMain.on("ui:state", (_e, state) => { if (current && !smoke) try { writeUiState(current, state); } catch {} });
ipcMain.on("smoke:ready", async () => {
  if (!smoke) return;
  await new Promise((r) => setTimeout(r, 500));
  if (process.env.KURGU_SMOKE_JS) { // a test script run in the window before the screenshot (dev checks only)
    const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.KURGU_SMOKE_JS, "utf8")).catch((e) => `ERROR ${e.message}`);
    console.log("SMOKE_JS", JSON.stringify(out));
  }
  fs.writeFileSync(smoke.out, (await win.webContents.capturePage()).toPNG());
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
    width: smoke ? 1500 : 1480, height: smoke ? 940 : 940, minWidth: 1000, minHeight: 640,
    backgroundColor: "#12102a", title: "Kurgu Masası", show: !smoke, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  const start = smoke?.dir || readState().current;
  if (start && isProjectDir(start)) { try { openProject(start); } catch (e) { console.error(e); } }
  buildMenu();
  win.loadFile(path.join(HERE, "..", "renderer", "index.html"));
});
app.on("window-all-closed", () => { stopTerminal(); app.quit(); });
