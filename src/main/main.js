// Electron main process: window, menus, dialogs, the project watcher, the medya:// protocol and the terminal.
// Every change goes through core/store.applyOps (the MCP server uses the same path), so the app and Claude can
// work on one project at once; the watcher pushes the other side's changes to the window.
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyOps, loadProject, createProject, isProjectDir, writeUiState, startHistory, PROJECT_FILE, MEDIA_DIR } from "../core/store.js";
import { exportHtml } from "../core/export.js";
import { readState, setCurrent, readPrefs, setPrefs, STATE_DIR } from "../core/state.js";
import { readGlobalShortcuts, setGlobalShortcuts, readProjectShortcuts, setProjectShortcuts } from "../core/shortcuts.js";
import { TtsManager } from "./tts/index.js";
import { secretStore } from "./secrets.js";

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
const APP = "ccdesk";
const tts = new TtsManager({ stateDir: STATE_DIR, readState, readPrefs, secrets: secretStore(STATE_DIR), onStatus: (s) => send("tts:status", s) });

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
  if (!isProjectDir(abs)) throw new Error(`Bu klasörde bir ${APP} projesi yok: ${abs}`);
  const p = loadProject(abs);
  try { startHistory(abs); } catch (e) { console.error(`history: ${e.message}`); }
  if (abs !== current) stopTerminal();
  current = abs;
  lastRevision = p.revision;
  if (!smoke) setCurrent(abs);
  watch(abs);
  win?.setTitle(`${p.title} — ${APP}`);
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

// ---- terminal: a plain login shell in the project folder; which AI (if any) runs in it is the owner's choice ----
// For an assistant that speaks MCP, the shell gets CCDESK_MCP_CONFIG (an mcpServers file for this project, e.g.
// `claude --mcp-config "$CCDESK_MCP_CONFIG"`), CCDESK_AGENT_PROMPT (a short note on how to use the tools), and
// CCDESK_MCP_COMMAND + CCDESK_MCP_SERVER (the server's command line, for assistants that register servers
// themselves, e.g. `agy mcp add`). Terminal shortcuts (core/shortcuts.js) paste such commands.
let term = null;
function agentFiles(dir) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const h = crypto.createHash("sha1").update(dir).digest("hex").slice(0, 10);
  const cfg = path.join(STATE_DIR, `mcp-${h}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { ccdesk: {
    command: process.execPath, args: [path.join(ROOT, "src", "mcp", "server.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", CCDESK_PROJECT: dir },
  } } }, null, 1));
  const prompt = path.join(STATE_DIR, "agent-prompt.md");
  fs.writeFileSync(prompt, [
    "You were started from the terminal inside ccdesk, the owner's desk for deciding a video edit.",
    `The project open in the app: ${dir}`,
    "The ccdesk MCP tools work on it. When the owner says here / this / burası / şurası, call ccdesk_cursor first: it",
    "tells you the playhead, the mouse position, the word being said there and the selected item. ccdesk_timeline gives the whole edit.",
    "Propose changes with ccdesk_suggest (the owner accepts or rejects them in the app); edit directly only when asked.",
    "Speak Turkish with the owner. Never invent facts about real people.",
  ].join("\n"));
  return { cfg, prompt, command: process.execPath, server: path.join(ROOT, "src", "mcp", "server.js") };
}
function startTerminal({ cols, rows }) {
  if (!current) throw new Error("Açık proje yok");
  if (term) { resizeTerminal({ cols, rows }); return { running: true }; }
  const sh = process.env.SHELL || "/bin/bash";
  const { cfg, prompt, command, server } = agentFiles(current);
  const child = spawn("python3", [path.join(HERE, "pty-helper.py"), current, sh, "-l"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({ ...rest, TERM: "xterm-256color", COLORTERM: "truecolor",
      CCDESK_PROJECT: current, CCDESK_MCP_CONFIG: cfg, CCDESK_AGENT_PROMPT: prompt,
      CCDESK_MCP_COMMAND: command, CCDESK_MCP_SERVER: server }))(process.env),
  });
  const dec = new StringDecoder("utf8");
  child.stdout.on("data", (d) => send("term:data", dec.write(d)));
  child.stderr.on("data", (d) => send("term:data", d.toString()));
  child.on("exit", (code) => { if (term?.child === child) term = null; send("term:exit", code); });
  term = { child, dir: current };
  resizeTerminal({ cols, rows });
  return { running: true };
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
      { type: "separator" },
      { label: "Ayarlar…", accelerator: "CmdOrCtrl+,", click: () => send("menu:settings") },
    ] },
    { label: "Görünüm", submenu: [
      { label: "Terminal", accelerator: "CmdOrCtrl+`", click: () => send("menu:terminal") },
      { type: "separator" },
      { role: "reload", label: "Yenile" }, { role: "toggleDevTools", label: "Geliştirici araçları" }, { type: "separator" },
      { role: "resetZoom", label: "Gerçek boyut" }, { role: "zoomIn", label: "Büyüt" }, { role: "zoomOut", label: "Küçült" }, { role: "togglefullscreen", label: "Tam ekran" },
    ] },
  ]));
}
const showError = (e) => dialog.showErrorBox(APP, String(e?.message || e));

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
  if (ops.some((o) => o.op === "setSettings" && o.title !== undefined)) win?.setTitle(`${r.project.title} — ${APP}`);
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
// ---- preferences (app-wide) ----
handle("prefs:get", () => readPrefs());
handle("prefs:set", async (patch) => {
  const was = readPrefs();
  const want = patch?.tts?.provider;
  if (want !== undefined && want !== was.tts.provider && !(await tts.canChoose(want))) throw new Error("Bu ses sağlayıcısı bu bilgisayarda kullanılamıyor");
  const next = setPrefs(patch || {});
  if (patch?.appearance?.theme) win?.setBackgroundColor(next.appearance.theme === "dark" ? "#17181b" : "#f3eee4");
  if (next.tts.provider !== was.tts.provider || next.tts.omnivoice.voice !== was.tts.omnivoice.voice) { tts.stop(); if (!smoke) tts.warm(); }
  return next;
});

// ---- read-aloud (src/main/tts: one interface, several providers) ----
handle("tts:describe", () => tts.describe());
handle("tts:speak", ({ text, session, language, rate }) => tts.speak({ text, session, language, rate }));
handle("tts:cancel", (session) => tts.cancel(session));
handle("tts:warm", () => { if (!smoke) tts.warm(); });
handle("tts:pickAudio", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Ses kaydı seçin (5–15 sn, gürültüsüz, tek kişi)", properties: ["openFile"],
    filters: [{ name: "Ses", extensions: ["wav", "mp3", "m4a", "ogg", "opus", "flac", "webm", "aac", "mp4", "mov"] }] });
  return r.canceled ? null : r.filePaths[0];
});
handle("tts:call", async (provider, action, args = {}) => {
  if (provider === "omnivoice" && action === "addVoice" && args.bytes) { // a recording from the microphone
    const tmp = path.join(os.tmpdir(), `ccdesk-kayit-${Date.now()}.webm`);
    fs.writeFileSync(tmp, Buffer.from(args.bytes));
    try { return await tts.call(provider, action, { name: args.name, audio: tmp, refText: args.refText }); } finally { fs.rmSync(tmp, { force: true }); }
  }
  if (provider === "omnivoice" && action === "addVoice") return tts.call(provider, action, { name: args.name, audio: args.path, refText: args.refText });
  const out = await tts.call(provider, action, args);
  if (provider === "omnivoice" && action === "deleteVoice" && readPrefs().tts.omnivoice.voice === args.id) setPrefs({ tts: { omnivoice: { voice: null } } });
  return out;
});

handle("term:start", (o) => startTerminal(o));
const shortcuts = () => ({ global: readGlobalShortcuts(), project: current ? readProjectShortcuts(current) : [] });
handle("shortcuts:get", () => shortcuts());
handle("shortcuts:set", ({ scope, list }) => {
  if (scope === "global") setGlobalShortcuts(list);
  else if (scope === "project") { if (!current) throw new Error("Açık proje yok"); setProjectShortcuts(current, list); }
  else throw new Error(`Bilinmeyen kapsam: ${scope}`);
  return shortcuts();
});
ipcMain.on("term:input", (_e, data) => term?.child.stdin.write(data));
ipcMain.on("term:resize", (_e, size) => resizeTerminal(size));
ipcMain.on("ui:state", (_e, state) => { if (current && !smoke) try { writeUiState(current, state); } catch {} });
ipcMain.on("smoke:ready", async () => {
  if (!smoke) return;
  await new Promise((r) => setTimeout(r, 500));
  if (process.env.CCDESK_SMOKE_JS) { // a test script run in the window before the screenshot (dev checks only)
    const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.CCDESK_SMOKE_JS, "utf8")).catch((e) => `ERROR ${e.message}`);
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
    backgroundColor: readPrefs().appearance.theme === "dark" ? "#17181b" : "#f3eee4", title: APP, show: !smoke, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  const start = smoke?.dir || readState().current;
  if (start && isProjectDir(start)) { try { openProject(start); } catch (e) { console.error(e); } }
  buildMenu();
  win.loadFile(path.join(HERE, "..", "renderer", "index.html"));
});
app.on("window-all-closed", () => { stopTerminal(); tts.stop(); app.quit(); });
