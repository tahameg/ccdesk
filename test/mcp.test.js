import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, loadProject } from "../src/core/store.js";

test("MCP server: Claude reads and edits as its own user", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurgu-mcp-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kurgu-state-"));
  createProject(dir, { title: "MCP deneme", duration: 30 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/mcp/server.js")],
    env: { ...process.env, KURGU_PROJECT: dir, KURGU_STATE_DIR: stateDir },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return r.content[0].text;
  };
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("kurgu_timeline") && tools.includes("kurgu_add_comment"));

  const img = path.join(dir, "ref.png");
  fs.writeFileSync(img, "x");
  const s = JSON.parse(await call("kurgu_add_script", { start: 1, text: "Merhaba, ben Buse. [gülümseyerek]" }));
  const n = JSON.parse(await call("kurgu_add_note", { start: 1, end: 4, title: "Alt başlık", media: [{ path: img, caption: "stil" }] }));
  await call("kurgu_add_comment", { target: { type: "script", id: s.results[0].id }, text: "Bu cümle daha sıcak olabilir." });
  const tl = await call("kurgu_timeline");
  assert.match(tl, /SCRIPT/);
  assert.match(tl, /“Alt başlık”/);
  assert.match(tl, /OPEN\] Claude: Bu cümle/);
  const est = JSON.parse(await call("kurgu_estimate_reading", { text: "Merhaba [x]" }));
  assert.deepEqual(est.directions, ["x"]);
  await assert.rejects(call("kurgu_update_script", { id: "nope", text: "a" }), /No script/);

  const p = loadProject(dir);
  assert.equal(p.scripts[0].createdBy, "mcp");
  assert.equal(p.notes[0].media.length, 1);
  assert.equal(n.media, 1);
  const out = JSON.parse(await call("kurgu_export_html"));
  assert.ok(fs.existsSync(out.file));
  await client.close();
});
