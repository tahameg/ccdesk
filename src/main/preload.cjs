// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, x) => cb(x));

contextBridge.exposeInMainWorld("ccdesk", {
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
  onMenu: (cb) => ["undo", "redo", "terminal", "settings"].forEach((m) => ipcRenderer.on(`menu:${m}`, () => cb(m))),
  term: {
    start: (o) => call("term:start", o),
    input: (d) => ipcRenderer.send("term:input", d),
    resize: (s) => ipcRenderer.send("term:resize", s),
    onData: on("term:data"),
    onExit: on("term:exit"),
  },
  shortcuts: {
    get: () => call("shortcuts:get"),
    set: (scope, list) => call("shortcuts:set", { scope, list }),
  },
  prefs: {
    get: () => call("prefs:get"),
    set: (patch) => call("prefs:set", patch),
  },
  tts: {
    describe: () => call("tts:describe"),
    speak: (text, { session, language, rate } = {}) => call("tts:speak", { text, session, language, rate }),
    cancel: (session) => call("tts:cancel", session),
    warm: () => call("tts:warm"),
    pickAudio: () => call("tts:pickAudio"),
    call: (provider, action, args) => call("tts:call", provider, action, args),
    onStatus: on("tts:status"),
  },
  smokeReady: () => ipcRenderer.send("smoke:ready"),
});
