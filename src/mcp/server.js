#!/usr/bin/env node
// MCP server for Kurgu Masası: Claude reads and changes the edit as its own user ("Claude"), through the same
// operations as the app. Default project = the one open in the app (~/.config/kurgu-masasi/state.json).
import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyOps, loadProject, isProjectDir, createProject, unresolvedCount, scriptFit } from "../core/store.js";
import { estimateReading, directions } from "../core/reading.js";
import { exportHtml } from "../core/export.js";
import { readState } from "../core/state.js";
import { formatTime } from "../core/time.js";

let sessionProject = process.env.KURGU_PROJECT || null;

function projectDir(given) {
  const dir = given || sessionProject || readState().current;
  if (!dir) throw new Error("No project is open. Open one in the Kurgu Masası app, or pass `project` (a project folder).");
  const abs = path.resolve(dir);
  if (!isProjectDir(abs)) throw new Error(`Not a Kurgu Masası project (no kurgu.json): ${abs}`);
  return abs;
}

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
const who = (id) => (id === "mcp" ? "Claude" : "Taha");
const t = (s) => formatTime(s);

function run(project, ops) {
  const dir = projectDir(project);
  const { project: p, results } = applyOps(dir, "mcp", ops);
  return { revision: p.revision, unresolvedComments: unresolvedCount(p), results: results.map(({ id, ids, summary }) => ({ id, ids, summary })) };
}

function timelineText(p) {
  const items = [
    ...p.scripts.map((s) => ({ ...s, kind: "SCRIPT" })),
    ...p.notes.map((n) => ({ ...n, kind: n.start === n.end ? "EVENT" : "NOTE" })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const lines = [`# ${p.title}  (rev ${p.revision}, duration ${t(p.duration)}, reading ${p.reading.syllablesPerSecond} syl/s, open comments ${unresolvedCount(p)})`, ""];
  for (const i of items) {
    const when = i.kind === "EVENT" ? `${t(i.start)}` : `${t(i.start)}–${t(i.end)}`;
    if (i.kind === "SCRIPT") {
      const f = scriptFit(p, i);
      lines.push(`[${when}] SCRIPT ${i.id} (by ${who(i.createdBy)}; reading ~${f.estimate}s of ${f.length}s${f.over > 0.2 ? `, ${f.over}s TOO LONG` : ""})`);
      lines.push(`  ${i.text.replace(/\n/g, "\n  ")}`);
    } else {
      lines.push(`[${when}] ${i.kind} ${i.id} (by ${who(i.createdBy)}) ${i.title ? `“${i.title}”` : ""}`);
      if (i.text) lines.push(`  ${i.text.replace(/\n/g, "\n  ")}`);
      for (const m of i.media) lines.push(`  · media ${m.id}: ${m.kind} ${m.file ? path.join(MEDIA_PATH_HINT, m.file) : m.url}${m.caption ? ` — ${m.caption}` : ""}`);
    }
    for (const c of p.comments.filter((c) => c.target.id === i.id)) lines.push(`  ✎ comment ${c.id} [${c.resolved ? "resolved" : "OPEN"}] ${who(c.createdBy)}: ${c.text}${c.replies.map((r) => `\n      ↳ ${who(r.createdBy)}: ${r.text}`).join("")}`);
  }
  const loose = p.comments.filter((c) => c.target.type === "time" || c.target.type === "project");
  if (loose.length) {
    lines.push("", "Comments on times / the project:");
    for (const c of loose) lines.push(`  ✎ ${c.id} [${c.resolved ? "resolved" : "OPEN"}] ${c.target.type === "time" ? `@${t(c.target.time)}${c.target.deleted ? ` (on a deleted ${c.target.deleted})` : ""}` : "project"} ${who(c.createdBy)}: ${c.text}${c.replies.map((r) => `\n      ↳ ${who(r.createdBy)}: ${r.text}`).join("")}`);
  }
  return lines.join("\n");
}
const MEDIA_PATH_HINT = "medya";

const server = new McpServer({ name: "kurgu-masasi", version: "0.1.0" }, {
  instructions:
    "Kurgu Masası is the owner's timeline for discussing a video edit. Times are seconds. Three kinds of items: " +
    "SCRIPTS (only the words to be spoken; directions for the AI go in [square brackets] and are not read aloud), " +
    "NOTES (what is on screen / how it is cut, with any media; a note whose start = end is an EVENT at one moment), and " +
    "COMMENTS (discussion, on an item, a time or the project; resolve them when done). Items may overlap. " +
    "You act as the user 'Claude'; the owner sees your changes live in the app. Read kurgu_timeline first. " +
    "Prefer comments to propose; change scripts or notes directly when asked or when it is clearly your part. " +
    "Script text is Turkish and must not be invented about real people: ask in a comment instead.",
});

const target = z.object({
  type: z.enum(["script", "note", "time", "project"]),
  id: z.string().optional().describe("script or note id, for type script/note"),
  time: z.number().optional().describe("seconds, for type time"),
});
const P = { project: z.string().optional().describe("Project folder; default: the project open in the app") };

function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fail(e);
    }
  });
}

tool("kurgu_open_project", "Use this project folder for the rest of the session (or create one there with create=true).",
  { path: z.string(), create: z.boolean().optional(), title: z.string().optional() },
  ({ path: p, create, title }) => {
    const abs = path.resolve(p);
    if (create && !isProjectDir(abs)) createProject(abs, { title });
    projectDir(abs);
    sessionProject = abs;
    return `Using ${abs}`;
  });

tool("kurgu_timeline", "The whole edit as readable text, in time order: scripts (with reading-time fit), notes, events, media, comments. Start here.",
  P, ({ project }) => timelineText(loadProject(projectDir(project))));

tool("kurgu_get_project", "The raw project JSON (ids, times, authors, activity). Use kurgu_timeline to read; this for exact data.",
  { ...P, activity: z.boolean().optional().describe("include the last 50 activity entries") },
  ({ project, activity }) => {
    const p = loadProject(projectDir(project));
    const out = { ...p, activity: activity ? p.activity.slice(-50) : undefined, dir: projectDir(project) };
    return out;
  });

tool("kurgu_estimate_reading", "Estimate how long Buse needs to read a text aloud (Turkish; [brackets] are not read). Uses the project's reading speed if a project is open.",
  { text: z.string(), ...P },
  ({ text, project }) => {
    let reading;
    try { reading = loadProject(projectDir(project)).reading; } catch {}
    return { ...estimateReading(text, reading), directions: directions(text) };
  });

tool("kurgu_add_script", "Add spoken text on the timeline from start to end (seconds). end defaults to start + the reading estimate. Only words to be spoken; [directions] allowed.",
  { ...P, start: z.number(), end: z.number().optional(), text: z.string() },
  ({ project, ...a }) => run(project, [{ op: "addScript", ...a }]));
tool("kurgu_update_script", "Change a script's text and/or times.",
  { ...P, id: z.string(), start: z.number().optional(), end: z.number().optional(), text: z.string().optional() },
  ({ project, ...a }) => run(project, [{ op: "updateScript", ...a }]));
tool("kurgu_delete_script", "Delete a script (its comments stay, pinned to its start time).",
  { ...P, id: z.string() }, ({ project, id }) => run(project, [{ op: "deleteScript", id }]));

tool("kurgu_add_note", "Add a note (what is on screen / how it is cut) from start to end; start = end makes an EVENT at that moment (a cut, a split screen, a sound). Optional media: local file paths (copied into the project) or URLs.",
  { ...P, start: z.number(), end: z.number().optional(), title: z.string().optional(), text: z.string().optional(),
    media: z.array(z.object({ path: z.string().optional(), url: z.string().optional(), caption: z.string().optional() })).optional() },
  ({ project, media = [], ...a }) => {
    const dir = projectDir(project);
    const r = applyOps(dir, "mcp", [{ op: "addNote", ...a }]);
    const id = r.results[0].id;
    if (media.length) applyOps(dir, "mcp", media.map((m) => ({ op: "addMedia", noteId: id, source: m.path, url: m.url, caption: m.caption })));
    return { id, summary: r.results[0].summary, media: media.length };
  });
tool("kurgu_update_note", "Change a note's title, text and/or times.",
  { ...P, id: z.string(), start: z.number().optional(), end: z.number().optional(), title: z.string().optional(), text: z.string().optional() },
  ({ project, ...a }) => run(project, [{ op: "updateNote", ...a }]));
tool("kurgu_delete_note", "Delete a note and its media files.",
  { ...P, id: z.string() }, ({ project, id }) => run(project, [{ op: "deleteNote", id }]));
tool("kurgu_add_media", "Attach a file (copied into the project's medya/ folder) or a URL to a note.",
  { ...P, noteId: z.string(), path: z.string().optional(), url: z.string().optional(), caption: z.string().optional() },
  ({ project, noteId, path: source, url, caption }) => run(project, [{ op: "addMedia", noteId, source, url, caption }]));
tool("kurgu_remove_media", "Remove a media item from a note.",
  { ...P, noteId: z.string(), id: z.string() }, ({ project, ...a }) => run(project, [{ op: "removeMedia", ...a }]));

tool("kurgu_list_comments", "Comments with their targets and replies. open_only=true lists only unresolved ones.",
  { ...P, open_only: z.boolean().optional() },
  ({ project, open_only }) => {
    const p = loadProject(projectDir(project));
    return p.comments.filter((c) => !open_only || !c.resolved).map((c) => ({ id: c.id, target: c.target, by: who(c.createdBy), text: c.text, resolved: c.resolved, replies: c.replies.map((r) => ({ by: who(r.createdBy), text: r.text })) }));
  });
tool("kurgu_add_comment", "Comment on a script, a note, a time (seconds) or the whole project. Use this to propose changes for the owner to decide.",
  { ...P, target, text: z.string() }, ({ project, target: tg, text }) => run(project, [{ op: "addComment", target: tg, text }]));
tool("kurgu_reply_comment", "Reply in a comment thread.",
  { ...P, id: z.string(), text: z.string() }, ({ project, ...a }) => run(project, [{ op: "replyComment", ...a }]));
tool("kurgu_resolve_comment", "Mark a comment resolved (or reopen with resolved=false). Resolve the owner's comment only after doing what it asked.",
  { ...P, id: z.string(), resolved: z.boolean().optional() }, ({ project, ...a }) => run(project, [{ op: "resolveComment", ...a }]));

tool("kurgu_import_script", "Lay a whole script out on the timeline from `start`: one script item per paragraph (blank-line separated), back to back by reading estimate; a paragraph that is only a [direction] becomes a note under the next paragraph.",
  { ...P, text: z.string(), start: z.number().optional(), gap: z.number().optional() },
  ({ project, ...a }) => run(project, [{ op: "importScript", ...a }]));

tool("kurgu_set_project", "Change the title, duration (seconds) or reading speed (syllablesPerSecond, sentencePause, commaPause).",
  { ...P, title: z.string().optional(), duration: z.number().optional(),
    reading: z.object({ syllablesPerSecond: z.number().optional(), sentencePause: z.number().optional(), commaPause: z.number().optional() }).optional() },
  ({ project, ...a }) => run(project, [{ op: "setProject", ...a }]));

tool("kurgu_export_html", "Export the edit as an HTML document (what is said when, what is on screen, visuals to prepare, open comments). Returns the file path.",
  P, ({ project }) => {
    const dir = projectDir(project);
    return { file: exportHtml(dir, loadProject(dir)) };
  });

await server.connect(new StdioServerTransport());
