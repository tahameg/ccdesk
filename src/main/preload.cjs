// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

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
  onChanged: (cb) => ipcRenderer.on("project:changed", (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on("project:opened", (_e, r) => cb(r)),
  smokeReady: () => ipcRenderer.send("smoke:ready"),
});
