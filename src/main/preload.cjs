// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, x) => cb(x));

contextBridge.exposeInMainWorld("kurgu", {
  state: () => call("app:state"),
  newProject: () => call("project:new"),
  openProject: (dir) => call("project:open", dir),
  apply: (ops) => call("project:apply", ops),
  pickMedia: () => call("media:pick"),
  exportHtml: () => call("export:html"),
  openMedia: (file) => call("shell:openMedia", file),
  openUrl: (url) => call("shell:openUrl", url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (file) => `medya://local/${encodeURIComponent(file)}`,
  uiState: (s) => ipcRenderer.send("ui:state", s),
  onChanged: on("project:changed"),
  onOpened: on("project:opened"),
  onMenu: (cb) => ["undo", "redo", "terminal"].forEach((m) => ipcRenderer.on(`menu:${m}`, () => cb(m))),
  term: {
    start: (o) => call("term:start", o),
    claude: () => call("term:claude"),
    input: (d) => ipcRenderer.send("term:input", d),
    resize: (s) => ipcRenderer.send("term:resize", s),
    onData: on("term:data"),
    onExit: on("term:exit"),
  },
  smokeReady: () => ipcRenderer.send("smoke:ready"),
});
