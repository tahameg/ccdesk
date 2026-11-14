#!/usr/bin/env node
// MCP server for Kurgu Masası: Claude reads the edit, sees where the owner is looking, and proposes changes
// (suggestions the owner accepts in the app) or edits directly when asked. Same ops as the app.
// Project: KURGU_PROJECT (set when Claude Code is started from the app's terminal), else the one open in the app.
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyOps, checkOps, loadProject, isProjectDir, createProject, scriptEnd, overlaps, pendingCount, readUiState, storeMediaFile, SUGGESTABLE } from "../core/store.js";
import { estimateReading, tokenize, tokenAt, directions } from "../core/reading.js";
import { describeOps } from "../core/describe.js";
import { exportHtml } from "../core/export.js";
import { readState } from "../core/state.js";
import { formatTime } from "../core/time.js";

let sessionProject = process.env.KURGU_PROJECT || null;
const t = (s) => formatTime(s);
const who = (id) => (id === "mcp" ? "Claude" : "Taha");

function projectDir(given) {
  const dir = given || sessionProject || readState().current;
  if (!dir) throw new Error("No project is open. Open one in the Kurgu Masası app, or pass `project` (a project folder).");
  const abs = path.resolve(dir);
  if (!isProjectDir(abs)) throw new Error(`Not a Kurgu Masası project (no kurgu.json): ${abs}`);
  return abs;
}
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });

function run(project, ops) {
  const { project: p, results } = applyOps(projectDir(project), "mcp", ops);
  return { revision: p.revision, results };
}

function spokenAt(p, time) {
  for (const s of [...p.scripts].sort((a, b) => a.time - b.time)) {
    const { tokens, duration } = tokenize(s.text, p.settings);
    if (time >= s.time && time < s.time + duration) {
      const { token } = tokenAt(tokens, time - s.time);
      return { script: s.id, scriptStart: s.time, scriptEnd: t(s.time + duration), text: s.text,
        now: token ? (token.type === "word" ? `word “${token.text}”` : `silence (${token.units} units)`) : "pause between words" };
    }
  }
  const next = p.scripts.filter((s) => s.time > time).sort((a, b) => a.time - b.time)[0];
  return { script: null, now: "nothing is being said", nextScriptIn: next ? Math.round((next.time - time) * 10) / 10 : null };
}

function momentAt(p, time) {
  const evs = [...p.events].sort((a, b) => a.time - b.time);
  const active = evs.filter((e) => e.time <= time).at(-1);
  return {
    time: t(time),
    said: spokenAt(p, time),
    lastEvent: active ? { id: active.id, at: t(active.time), title: active.title, text: active.text, media: active.media.map((m) => m.caption || m.name || m.url) } : null,
    eventsNear: evs.filter((e) => Math.abs(e.time - time) <= 8 && e !== active).map((e) => ({ id: e.id, at: t(e.time), inSeconds: Math.round((e.time - time) * 10) / 10, title: e.title })),
  };
}

function timelineText(p) {
  const ov = new Map(overlaps(p).map((o) => [o.second, o.by]));
  const items = [...p.scripts.map((s) => ({ ...s, kind: "SCRIPT" })), ...p.events.map((e) => ({ ...e, kind: "EVENT" }))]
    .sort((a, b) => a.time - b.time || (a.kind === "EVENT" ? -1 : 1));
  const lines = [`# ${p.title}  (rev ${p.revision}; speech ${p.settings.syllablesPerSecond} syl/s, sentence pause ${p.settings.sentencePause}s, /1 = ${p.settings.silenceUnit}s; pending suggestions ${pendingCount(p)})`, ""];
  for (const i of items) {
    if (i.kind === "SCRIPT") {
      const end = scriptEnd(p, i);
      lines.push(`[${t(i.time)}–${t(end)}] SCRIPT ${i.id} (${Math.round((end - i.time) * 10) / 10}s, by ${who(i.createdBy)})${ov.has(i.id) ? ` ⚠ overlaps the previous script by ${ov.get(i.id)}s` : ""}`);
      lines.push(`  ${i.text.replace(/\n/g, "\n  ")}`);
    } else {
      lines.push(`[${t(i.time)}] EVENT ${i.id} (by ${who(i.createdBy)}) ${i.title ? `“${i.title}”` : ""}`);
      if (i.text) lines.push(`  ${i.text.replace(/\n/g, "\n  ")}`);
      for (const m of i.media) lines.push(`  · media ${m.id}: ${m.kind} ${m.file ? `medya/${m.file}` : m.url}${m.caption ? ` — ${m.caption}` : ""}`);
    }
  }
  const pend = p.suggestions.filter((s) => s.status === "pending");
  if (pend.length) {
    lines.push("", "Pending suggestions (the owner hasn't decided):");
    for (const s of pend) lines.push(`  ${s.id} by ${who(s.createdBy)}: ${s.summary}\n${describeOps(p, s.ops).map((d) => `    - ${d.text}`).join("\n")}`);
  }
  return lines.join("\n");
}

const server = new McpServer({ name: "kurgu-masasi", version: "0.2.0" }, {
  instructions:
    "Kurgu Masası is the owner's desk for deciding a video edit (not a video editor). Times are seconds. " +
    "SCRIPTS start at a moment and hold only the words Buse says; their length comes from the text (reading speed in settings). " +
    "In script text, [square brackets] are directions for the AI (not read) and /n is n units of silence (/ alone = 1 unit). " +
    "EVENTS are moments where something happens on screen (\"the screen splits in two\"), with media references. " +
    "Start with kurgu_cursor (where the owner is looking) and kurgu_timeline. Propose changes with kurgu_suggest — the owner " +
    "accepts or rejects them in the app; edit directly only when the owner asks you to. You act as the user 'Claude'. " +
    "Never invent facts about real people in script text: put a [BUSE DOLDURACAK: …] gap instead.",
});

const P = { project: z.string().optional().describe("Project folder; default: the app's project") };
function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try { return ok(await handler(args)); } catch (e) { return fail(e); }
  });
}
const mediaShape = z.object({ path: z.string().optional().describe("local file, copied into the project"), url: z.string().optional(), caption: z.string().optional() });
const toMedia = (m) => ({ source: m.path, url: m.url, caption: m.caption });

tool("kurgu_open_project", "Use this project folder for the rest of the session (create=true makes a new one there).",
  { path: z.string(), create: z.boolean().optional(), title: z.string().optional() },
  ({ path: p, create, title }) => {
    const abs = path.resolve(p);
    if (create && !isProjectDir(abs)) createProject(abs, { title });
    projectDir(abs);
    sessionProject = abs;
    return `Using ${abs}`;
  });

tool("kurgu_cursor", "Where the owner is looking right now in the app: the playhead and the mouse position on the timeline, what is being said there (the exact word), the event on screen, events nearby, the selected item. Use this when the owner says 'here', 'this', 'şurası'.",
  P, ({ project }) => {
    const dir = projectDir(project);
    const p = loadProject(dir);
    const ui = readUiState(dir);
    if (!ui) return "The app hasn't reported a cursor yet (is the project open in Kurgu Masası?).";
    const sel = ui.selected ? (ui.selected.type === "script" ? p.scripts : p.events).find((x) => x.id === ui.selected.id) : null;
    return {
      reportedSecondsAgo: Math.round((Date.now() - new Date(ui.at).getTime()) / 1000),
      playing: !!ui.playing,
      playhead: momentAt(p, ui.playhead || 0),
      mouse: ui.hover != null ? momentAt(p, ui.hover) : null,
      selected: sel ? { type: ui.selected.type, ...sel } : null,
      visible: ui.view ? `${t(ui.view[0])}–${t(ui.view[1])}` : null,
    };
  });

tool("kurgu_timeline", "The whole edit as text in time order: scripts (with computed length, overlaps), events (with media), pending suggestions.",
  P, ({ project }) => timelineText(loadProject(projectDir(project))));

tool("kurgu_get_project", "Raw project JSON (ids, times, authors, settings, suggestions; activity with activity=true).",
  { ...P, activity: z.boolean().optional() },
  ({ project, activity }) => {
    const p = loadProject(projectDir(project));
    return { ...p, activity: activity ? p.activity.slice(-50) : undefined };
  });

tool("kurgu_estimate_reading", "How long Buse needs to say a text ([brackets] not read, /n silences counted), with the project's speed settings.",
  { text: z.string(), ...P },
  ({ text, project }) => {
    let settings;
    try { settings = loadProject(projectDir(project)).settings; } catch {}
    return { ...estimateReading(text, settings), directions: directions(text) };
  });

const OP_HELP = "Each op is {op, ...args}: addScript {time, text} · updateScript {id, time?, text?} · deleteScript {id} · " +
  "addEvent {time, title?, text?, media?: [{path|url, caption?}]} · updateEvent {id, time?, title?, text?} · deleteEvent {id} · " +
  "addMedia {eventId, path|url, caption?} · removeMedia {eventId, id} · shiftItems {scriptIds?, eventIds?, by} · " +
  "setSettings {settings: {syllablesPerSecond?, sentencePause?, commaPause?, silenceUnit?}} · importScript {text, time?}";

tool("kurgu_suggest", `Propose a change for the owner to accept or reject in the app (nothing changes until accepted). Give a short Turkish summary of why. ${OP_HELP}`,
  { ...P, summary: z.string().describe("Turkish, one or two sentences: what and why"), ops: z.array(z.object({ op: z.string() }).passthrough()) },
  ({ project, summary, ops }) => {
    const dir = projectDir(project);
    const fixed = ops.map((o) => {
      const x = { ...o };
      if (!SUGGESTABLE.has(x.op)) throw new Error(`${x.op} can't be suggested`);
      if (x.op === "addMedia" && x.path) { const s = storeMediaFile(dir, x.path); Object.assign(x, { stored: s.file, mediaId: s.id, name: s.name }); delete x.path; }
      if (x.op === "addEvent" && x.media) x.media = x.media.map((m) => (m.path ? (({ id, file, name }) => ({ stored: file, mediaId: id, name, caption: m.caption }))(storeMediaFile(dir, m.path)) : { url: m.url, caption: m.caption }));
      return x;
    });
    checkOps(dir, "mcp", fixed);
    const r = run(project, [{ op: "addSuggestion", summary, ops: fixed }]);
    const p = loadProject(dir);
    return { suggestion: r.results[0].id, changes: describeOps(p, fixed).map((d) => d.text), note: "The owner sees it in the app's Öneriler panel." };
  });
tool("kurgu_list_suggestions", "Suggestions and their status (pending / accepted / rejected / withdrawn).",
  { ...P, pending_only: z.boolean().optional() },
  ({ project, pending_only }) => {
    const p = loadProject(projectDir(project));
    return p.suggestions.filter((s) => !pending_only || s.status === "pending")
      .map((s) => ({ id: s.id, status: s.status, by: who(s.createdBy), summary: s.summary, changes: describeOps(p, s.ops).map((d) => d.text), decidedBy: s.decidedBy && who(s.decidedBy) }));
  });
tool("kurgu_withdraw_suggestion", "Withdraw one of your pending suggestions.",
  { ...P, id: z.string() }, ({ project, id }) => run(project, [{ op: "withdrawSuggestion", id }]));

// direct edits — when the owner asks for them
tool("kurgu_add_script", "Add what Buse says from `time` on (direct edit). Length follows the text.",
  { ...P, time: z.number(), text: z.string() }, ({ project, ...a }) => run(project, [{ op: "addScript", ...a }]));
tool("kurgu_update_script", "Change a script's text and/or start time (direct edit).",
  { ...P, id: z.string(), time: z.number().optional(), text: z.string().optional() }, ({ project, ...a }) => run(project, [{ op: "updateScript", ...a }]));
tool("kurgu_delete_script", "Delete a script (direct edit).", { ...P, id: z.string() }, ({ project, id }) => run(project, [{ op: "deleteScript", id }]));
tool("kurgu_add_event", "Add an event at a moment (direct edit): what happens on screen, with optional media (local files are copied in) or URLs.",
  { ...P, time: z.number(), title: z.string().optional(), text: z.string().optional(), media: z.array(mediaShape).optional() },
  ({ project, media = [], ...a }) => run(project, [{ op: "addEvent", ...a, media: media.map(toMedia) }]));
tool("kurgu_update_event", "Change an event's title, text or time (direct edit).",
  { ...P, id: z.string(), time: z.number().optional(), title: z.string().optional(), text: z.string().optional() }, ({ project, ...a }) => run(project, [{ op: "updateEvent", ...a }]));
tool("kurgu_delete_event", "Delete an event (direct edit).", { ...P, id: z.string() }, ({ project, id }) => run(project, [{ op: "deleteEvent", id }]));
tool("kurgu_add_media", "Attach a local file (copied in) or a URL to an event (direct edit).",
  { ...P, eventId: z.string(), path: z.string().optional(), url: z.string().optional(), caption: z.string().optional() },
  ({ project, eventId, path: source, url, caption }) => run(project, [{ op: "addMedia", eventId, source, url, caption }]));
tool("kurgu_remove_media", "Remove a media item from an event (direct edit).",
  { ...P, eventId: z.string(), id: z.string() }, ({ project, ...a }) => run(project, [{ op: "removeMedia", ...a }]));
tool("kurgu_import_script", "Lay a whole script out from `time`: one script per paragraph, back to back; a paragraph that is only a [direction] becomes an event (direct edit; prefer kurgu_suggest with importScript when the owner hasn't asked).",
  { ...P, text: z.string(), time: z.number().optional() }, ({ project, ...a }) => run(project, [{ op: "importScript", ...a }]));
tool("kurgu_set_settings", "Change the title or the speech settings: syllablesPerSecond (Buse: 6.3), sentencePause, commaPause, silenceUnit (seconds per /1).",
  { ...P, title: z.string().optional(), settings: z.object({ syllablesPerSecond: z.number().optional(), sentencePause: z.number().optional(), commaPause: z.number().optional(), silenceUnit: z.number().optional() }).optional() },
  ({ project, ...a }) => run(project, [{ op: "setSettings", ...a }]));
tool("kurgu_export_html", "Export the edit as an HTML document (what is said when, what happens on screen, events to prepare). Returns the file path.",
  P, ({ project }) => {
    const dir = projectDir(project);
    return { file: exportHtml(dir, loadProject(dir)) };
  });

await server.connect(new StdioServerTransport());
