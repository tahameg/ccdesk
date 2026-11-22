// TTS provider "omnivoice": local voice cloning with OmniVoice (src/tts/worker.py) run as a child process, one
// request at a time. Offered only on a machine that meets MIN_SPECS (an NVIDIA GPU with enough memory, enough
// RAM) and has the OmniVoice Python environment.
// Built so that a failure stays small: a request that fails or times out only fails itself; a worker that dies
// (or exits after a CUDA error, on purpose) is started again for the next request; after three deaths within two
// minutes it rests a minute and requests fail fast with the reason. The worker quits after 10 idle minutes to
// give the GPU back. (Caching is the manager's: see index.js.)
//
// Voices live in <state dir>/voices/<id>/ (ref.wav, prompt.pt, meta.json: the ai-test studio's format; its
// voices are copied in once). Python: CCDESK_TTS_PYTHON, else state.json "ttsPython", else the ai-test venv.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "..", "..", "tts", "worker.py");
const AI_TEST = path.join(os.homedir(), "Workspace", "ai-test", "omnivoice");
const IDLE_MS = 10 * 60 * 1000;
/** The least this machine needs for OmniVoice: the model is ~1.6 GB in fp16 plus room to generate. */
export const MIN_SPECS = Object.freeze({ gpuMemoryMB: 4096, ramGB: 8 });

/** NVIDIA GPUs as nvidia-smi sees them: [{name, memoryMB}] ([] without a driver). */
function nvidiaGpus() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 4000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).trim().split("\n").filter(Boolean).map((l) => { const [name, mem] = l.split(/,\s*/); return { name, memoryMB: Number(mem) || 0 }; }));
    });
  });
}

const slugify = (name) => name.replace(/ı/g, "i").replace(/İ/g, "I").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || `ses-${Date.now()}`;

export class OmniVoiceProvider {
  id = "omnivoice";
  name = "OmniVoice";
  note = "Yerel, ses klonlama: kendi sesinizden bir ses oluşturur. Metin bilgisayardan çıkmaz.";
  online = false;
  ext = "wav";
  rateRange = [0.6, 1.6]; // multiplies the chosen speed

  constructor({ stateDir, readState, readPrefs, onStatus }) {
    this.stateDir = stateDir;
    this.voicesDir = path.join(stateDir, "voices");
    this.logFile = path.join(stateDir, "tts.log");
    this.readState = readState;
    this.readPrefs = readPrefs;
    this.onStatus = onStatus || (() => {});
    this.checked = null;
    this.proc = null; this.buf = ""; this.queue = []; this.current = null; this.nextId = 1;
    this.deaths = []; this.restUntil = 0; this.lastError = null; this.idleTimer = null;
    this.status = { state: "off", device: null, note: null };
    this.tail = [];
  }

  // ---- can this machine run it? ----
  /** {supported, ready, reason, details}: supported = the hardware and the Python environment are there; ready =
   * also a voice is chosen. Checked once (recheck() to look again). */
  async check() {
    this.checked ||= (async () => {
      const gpus = await nvidiaGpus();
      const ramGB = Math.round(os.totalmem() / 2 ** 30);
      const best = gpus.sort((a, b) => b.memoryMB - a.memoryMB)[0];
      const details = { gpu: best ? `${best.name} · ${Math.round(best.memoryMB / 1024)} GB` : "NVIDIA GPU yok", ramGB };
      const lacks = [];
      if (!best || best.memoryMB < MIN_SPECS.gpuMemoryMB) lacks.push(`en az ${MIN_SPECS.gpuMemoryMB / 1024} GB belleği olan bir NVIDIA GPU`);
      if (ramGB < MIN_SPECS.ramGB) lacks.push(`en az ${MIN_SPECS.ramGB} GB RAM`);
      let py = null;
      try { py = this.python(); } catch (e) { lacks.push("OmniVoice Python ortamı"); details.python = e.message; }
      if (py) details.python = py;
      return { supported: !lacks.length, reason: lacks.length ? `Bu bilgisayarda yok: ${lacks.join(", ")}.` : null, details };
    })();
    const c = await this.checked;
    if (!c.supported) return { ...c, ready: false };
    const voice = this.readPrefs().tts.omnivoice.voice;
    const has = voice && fs.existsSync(path.join(this.voicesDir, path.basename(voice), "prompt.pt"));
    return { ...c, ready: !!has, reason: has ? null : "Bir ses seçin ya da oluşturun." };
  }
  recheck() { this.checked = null; return this.check(); }

  /** What makes the audio for a text differ: the voice (and its prompt), quality, base speed, language. */
  signature(language) {
    const o = this.readPrefs().tts.omnivoice;
    let mt = 0;
    try { mt = fs.statSync(path.join(this.voiceDir(o.voice), "prompt.pt")).mtimeMs; } catch {}
    return JSON.stringify([o.voice, mt, o.steps, o.speed, language]);
  }

  // ---- setup ----
  python() {
    const cands = [process.env.CCDESK_TTS_PYTHON, this.readState().ttsPython, path.join(AI_TEST, ".venv", "bin", "python")].filter(Boolean);
    const py = cands.find((p) => fs.existsSync(p));
    if (!py) throw new Error(`OmniVoice için Python bulunamadı (${cands.join(", ")}). ai-test/omnivoice kurulu olmalı ya da state.json'da "ttsPython" verilmeli.`);
    return py;
  }
  importVoices() {
    fs.mkdirSync(this.voicesDir, { recursive: true });
    const marker = path.join(this.voicesDir, ".imported");
    if (fs.existsSync(marker)) return;
    const src = path.join(AI_TEST, "voices");
    if (fs.existsSync(src)) {
      for (const d of fs.readdirSync(src)) {
        const from = path.join(src, d), to = path.join(this.voicesDir, d);
        if (fs.existsSync(path.join(from, "prompt.pt")) && fs.existsSync(path.join(from, "meta.json")) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }
  voices() {
    this.importVoices();
    const out = [];
    for (const id of fs.readdirSync(this.voicesDir)) {
      const d = path.join(this.voicesDir, id);
      try {
        if (!fs.existsSync(path.join(d, "prompt.pt"))) continue;
        const m = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
        out.push({ id, name: m.name || id, seconds: m.seconds || 0, refText: m.ref_text || "", created: m.created || "" });
      } catch {} // a half-made voice: skip it
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }
  voiceDir(id) {
    const d = path.join(this.voicesDir, path.basename(String(id || "")));
    if (!id || !fs.existsSync(path.join(d, "prompt.pt"))) throw new Error("Seçili ses bulunamadı; Ayarlar → Sesli okuma'dan bir ses seçin.");
    return d;
  }
  refAudio(id) { return fs.readFileSync(path.join(this.voiceDir(id), "ref.wav")); }

  setStatus(s) { this.status = { ...this.status, ...s }; this.onStatus(this.status); }
  log(line) {
    this.tail.push(line); if (this.tail.length > 60) this.tail.shift();
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 1_000_000) fs.renameSync(this.logFile, `${this.logFile}.1`);
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  }

  // ---- the worker ----
  start() {
    if (this.proc) return;
    if (Date.now() < this.restUntil) throw new Error(`Ses motoru üst üste çöktü, biraz dinleniyor: ${this.lastError || "bilinmeyen hata"}`);
    const py = this.python();
    this.log(`start ${py}`);
    const hfCached = fs.existsSync(path.join(os.homedir(), ".cache", "huggingface", "hub", "models--k2-fsa--OmniVoice", "snapshots"));
    const p = spawn(py, ["-u", WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({
        ...rest, PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1", PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True",
        ...(hfCached ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {}), // no network hang when the model is here
      }))(process.env),
    });
    this.proc = p; this.buf = "";
    this.setStatus({ state: "starting", note: null });
    p.stdout.on("data", (d) => this.onData(p, d));
    p.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => this.log(l)));
    p.on("error", (e) => this.onExit(p, null, e.message));
    p.on("exit", (code, sig) => this.onExit(p, code, sig));
    p.stdin.on("error", () => {}); // EPIPE when it died: handled by exit
  }
  onData(p, d) {
    if (p !== this.proc) return;
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { this.log(`? ${line}`); continue; }
      if (m.event === "status") this.setStatus({ state: m.state, device: m.device ?? this.status.device, note: m.note ?? null });
      else if (m.event) continue;
      else if (this.current && m.id === this.current.id) {
        const c = this.current; this.current = null; clearTimeout(c.timer);
        if (m.ok) c.resolve(m); else { this.lastError = m.error; c.reject(new Error(m.error)); }
        if (m.fatal) return this.retire(p, m.error); // it exits now: the next request gets a fresh one
        this.pump();
      }
    }
  }
  /** A worker that can't be trusted: forget it at once (requests go to a new one), let it exit. */
  retire(p, why) {
    if (p !== this.proc) return;
    this.proc = null;
    this.died(why);
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 2000);
    if (this.queue.length) setTimeout(() => this.pump(), 300);
  }
  died(why) {
    this.deaths = [...this.deaths.filter((t) => Date.now() - t < 120000), Date.now()];
    if (this.deaths.length >= 3) { this.restUntil = Date.now() + 60000; this.deaths = []; }
    this.setStatus({ state: "off", device: null, note: `Ses motoru yeniden başlatılacak (${String(why).slice(0, 120)})` });
  }
  onExit(p, code, sig) {
    this.log(`exit ${code} ${sig || ""}`);
    if (p !== this.proc) return; // already retired
    this.proc = null;
    const why = this.lastError || (this.tail.filter((l) => /Error|error/.test(l)).at(-1) ?? `çıkış ${code ?? sig}`);
    if (code !== 0) this.died(why); else this.setStatus({ state: "off", device: null, note: null });
    if (this.current) { const c = this.current; this.current = null; clearTimeout(c.timer); c.reject(new Error(`Ses motoru durdu: ${why}`)); }
    if (this.queue.length) setTimeout(() => this.pump(), 500); // the rest goes to a fresh worker
  }
  stop() {
    clearTimeout(this.idleTimer);
    for (const q of this.queue.splice(0)) q.reject(new Error("Ses motoru kapatıldı"));
    if (this.proc) { const p = this.proc; try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000); }
  }

  /** One request; `session` lets the player drop what it no longer needs. */
  request(cmd, args = {}, { timeout = 120000, session = null } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, args, timeout, session, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.current || !this.queue.length) return;
    try { this.start(); } catch (e) { for (const q of this.queue.splice(0)) q.reject(e); return; }
    const q = this.queue.shift();
    const id = this.nextId++;
    const cpu = this.status.device === "cpu";
    const limit = q.timeout * (cpu ? 6 : 1) + (this.status.state === "ready" ? 0 : 240000); // first request also loads the model
    this.current = { ...q, id, timer: setTimeout(() => this.timeout(id), limit) };
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.current && !this.queue.length) this.stop(); }, IDLE_MS);
    this.proc.stdin.write(`${JSON.stringify({ id, cmd: q.cmd, ...q.args })}\n`);
  }
  timeout(id) {
    if (this.current?.id !== id) return;
    this.lastError = "istek zaman aşımına uğradı";
    this.log(`timeout ${this.current.cmd}`);
    try { this.proc?.kill("SIGKILL"); } catch {} // hung (GPU?): a fresh one is better than waiting
  }
  cancel(session) {
    for (const q of this.queue.filter((x) => x.session === session)) q.reject(Object.assign(new Error("iptal"), { cancelled: true }));
    this.queue = this.queue.filter((x) => x.session !== session);
  }

  // ---- the provider interface ----
  /** Writes the audio for `text` to `out`. rate multiplies the chosen speed (1 = as chosen). */
  async speak({ text, language, rate = 1, session, out }) {
    const o = this.readPrefs().tts.omnivoice;
    const dir = this.voiceDir(o.voice);
    const speed = Math.round(Math.min(2, Math.max(0.5, o.speed * rate)) * 100) / 100;
    await this.request("speak", { voice: dir, text, speed, steps: o.steps, out, language: language === "en" ? "en" : "tr" }, { timeout: 60000 + text.length * 300, session });
  }
  warm() { return this.request("load", {}, { timeout: 30000 }).catch(() => {}); }

  /** What the settings pane can ask for (tts:call). */
  actions = {
    voices: () => this.voices(),
    addVoice: (a) => this.addVoice(a),
    deleteVoice: ({ id }) => this.deleteVoice(id),
    refAudio: ({ id }) => this.refAudio(id),
    recheck: () => this.recheck(),
  };

  async addVoice({ name, audio, refText }) {
    name = String(name || "").trim();
    if (!name) throw new Error("Sese bir ad verin.");
    if (!audio || !fs.existsSync(audio)) throw new Error("Bir ses kaydı seçin ya da kaydedin.");
    this.importVoices();
    if (this.voices().some((v) => v.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) throw new Error(`“${name}” adında bir ses zaten var.`);
    let id = slugify(name);
    if (fs.existsSync(path.join(this.voicesDir, id))) id = `${id}-${Date.now()}`;
    const dir = path.join(this.voicesDir, id);
    try {
      await this.request("addVoice", { audio, dir, name, refText: refText || "" }, { timeout: 600000 });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true }); // no half voices
      throw e;
    }
    return { id, ...this.voices().find((v) => v.id === id) };
  }
  deleteVoice(id) {
    const d = path.join(this.voicesDir, path.basename(String(id)));
    if (!fs.existsSync(path.join(d, "meta.json"))) throw new Error("Ses bulunamadı");
    fs.rmSync(d, { recursive: true, force: true });
  }
}
