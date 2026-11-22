import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, loadProject, applyOps, writeUiState } from "../src/core/store.js";

test("MCP server: cursor, suggestions, direct edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-mcp-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-state-"));
  createProject(dir, { title: "MCP deneme" });
  const sid = applyOps(dir, "ui", [{ op: "addScript", time: 0, text: "Merhaba, ben Buse. /2 Bugün kanalı tanıtıyorum." }]).results[0].id;
  writeUiState(dir, { playhead: 0.3, hover: 4.2, selected: { type: "script", id: sid }, view: [0, 30], playing: false });

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.resolve("src/mcp/server.js")],
    env: { ...process.env, CCDESK_PROJECT: dir, CCDESK_STATE_DIR: stateDir },
  }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return r.content[0].text;
  };

  const cur = JSON.parse(await call("ccdesk_cursor"));
  assert.match(cur.playhead.said.now, /word “Merhaba,”/);
  assert.equal(cur.selected.id, sid);
  assert.ok(cur.mouse);

  const img = path.join(dir, "ref.png");
  fs.writeFileSync(img, "x");
  const sg = JSON.parse(await call("ccdesk_suggest", { summary: "Tanıtımdan önce kanal adı kartı", ops: [
    { op: "addEvent", time: 1, title: "Kanal adı kartı", media: [{ path: img, caption: "stil" }] },
    { op: "updateScript", id: sid, text: "Merhaba, ben Buse." },
  ] }));
  assert.equal(sg.changes.length, 2);
  assert.equal(loadProject(dir).events.length, 0, "not applied before the owner accepts");
  await assert.rejects(call("ccdesk_suggest", { summary: "x", ops: [{ op: "deleteScript", id: "yok" }] }), /No script/);

  applyOps(dir, "ui", [{ op: "decideSuggestion", id: sg.suggestion, accept: true }]);
  const p = loadProject(dir);
  assert.equal(p.events[0].media.length, 1);
  assert.equal(p.scripts[0].text, "Merhaba, ben Buse.");

  await call("ccdesk_add_event", { time: 5, title: "Ekran ikiye bölünür" });
  const tl = await call("ccdesk_timeline");
  assert.match(tl, /EVENT .*“Ekran ikiye bölünür”/);
  assert.match(tl, /SCRIPT/);
  const est = JSON.parse(await call("ccdesk_estimate_reading", { text: "Merhaba /4 [x]" }));
  assert.deepEqual(est.directions, ["x"]);
  assert.equal(est.silence, 2);
  const out = JSON.parse(await call("ccdesk_export_html"));
  assert.ok(fs.existsSync(out.file));
  await client.close();
});
