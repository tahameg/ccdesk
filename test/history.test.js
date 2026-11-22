import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, loadProject, applyOps, startHistory } from "../src/core/store.js";
import { listRevisions, stateAt, diffRevisions, diffStates, applyChanges, normalize, textDiff, HISTORY_DIR } from "../src/core/history.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccdesk-hist-"));

function sample() {
  const dir = tmp();
  createProject(dir, { title: "Tarih" });
  const ids = applyOps(dir, "ui", [
    { op: "addScript", text: "Merhaba, ben Buse. Bugün kanalı tanıtıyorum." },
    { op: "addScript", text: "İkinci bölümde database anlatacağım." },
  ]).results.map((r) => r.id);
  const ev = applyOps(dir, "mcp", [{ op: "addEvent", time: 1, title: "Logo", text: "Logo belirir" }]).results[0].id;
  return { dir, ids, ev };
}

test("every revision is recorded with its changes; the first change starts the history with a base", () => {
  const { dir } = sample();
  const { firstRev, revisions } = listRevisions(dir);
  assert.equal(firstRev, 0);
  assert.deepEqual(revisions.map((r) => r.rev), [1, 2]);
  assert.equal(revisions[0].actor, "ui");
  assert.equal(revisions[1].actor, "mcp");
  assert.ok(revisions[1].changeCount >= 1);
  assert.ok(fs.existsSync(path.join(dir, HISTORY_DIR, "base-0.json")));
});

test("stateAt rebuilds any revision exactly", () => {
  const { dir, ids } = sample();
  applyOps(dir, "ui", [{ op: "updateScript", id: ids[0], text: "Merhaba, ben Buse." }]);
  for (let r = 0; r <= 3; r++) assert.ok(stateAt(dir, r));
  assert.deepEqual(stateAt(dir, 3), normalize(loadProject(dir)));
  assert.equal(stateAt(dir, 2).scripts[ids[0]].text, "Merhaba, ben Buse. Bugün kanalı tanıtıyorum.");
  assert.equal(Object.keys(stateAt(dir, 0).scripts).length, 0);
});

test("a diff collapses many small edits into the end result and shows timing", () => {
  const { dir, ids } = sample();
  for (let i = 1; i <= 10; i++) applyOps(dir, "ui", [{ op: "setSettings", settings: { syllablesPerSecond: Math.round((7.5 + i / 10) * 100) / 100 } }]);
  const d = diffRevisions(dir, 2, 12);
  assert.equal(d.revisions.length, 10);
  const sp = d.changes.filter((c) => c.path.join(".") === "settings.syllablesPerSecond");
  assert.equal(sp.length, 1);
  assert.equal(sp[0].to, 8.5);
  assert.match(d.text, /settings\.syllablesPerSecond: .* → 8\.5/);
  assert.ok(d.timing.some((x) => x.id === ids[1] && x.to.start < x.from.start), "the second script starts earlier at a faster speed");
  assert.match(d.text, /total spoken length/);
});

test("diff shows text edits word by word, added and removed items, order and event moves", () => {
  const { dir, ids, ev } = sample();
  applyOps(dir, "ui", [{ op: "updateScript", id: ids[1], text: "İkinci bölümde backend anlatacağım." }]);
  applyOps(dir, "ui", [{ op: "swapScripts", a: ids[0], b: ids[1] }]);
  applyOps(dir, "ui", [{ op: "deleteEvent", id: ev }]);
  const added = applyOps(dir, "mcp", [{ op: "addEvent", time: 2, title: "Kart", text: "Kart gelir" }]).results[0].id;
  const d = diffRevisions(dir, 2, -1 + loadProject(dir).revision + 1);
  assert.match(d.text, /\[-database-\]\{\+backend\+\}/);
  assert.match(d.text, new RegExp(`- ${ev} removed`));
  assert.match(d.text, new RegExp(`\\+ ${added} added at 0:02`));
  assert.match(d.text, /Script order/);
  assert.equal(diffRevisions(dir, 3, 3).changes.length, 0);
});

test("a hand edit or a project from before history restarts the chain with a new base", () => {
  const { dir, ids } = sample();
  const p = JSON.parse(fs.readFileSync(path.join(dir, "ccdesk.json"), "utf8"));
  p.revision = 10; p.title = "Elle değişti";
  fs.writeFileSync(path.join(dir, "ccdesk.json"), JSON.stringify(p));
  applyOps(dir, "ui", [{ op: "updateScript", id: ids[0], text: "Yeni." }]);
  assert.ok(fs.existsSync(path.join(dir, HISTORY_DIR, "base-10.json")));
  assert.equal(stateAt(dir, 10).title, "Elle değişti");
  assert.equal(stateAt(dir, 11).scripts[ids[0]].text, "Yeni.");
  assert.equal(stateAt(dir, 2).title, "Tarih", "revisions before the restart are still rebuilt from the first base");
  assert.throws(() => stateAt(dir, 5), /gap/);
});

test("startHistory makes the current revision comparable before any change", () => {
  const dir = tmp();
  createProject(dir, { title: "Boş" });
  const p = JSON.parse(fs.readFileSync(path.join(dir, "ccdesk.json"), "utf8"));
  p.revision = 64; fs.writeFileSync(path.join(dir, "ccdesk.json"), JSON.stringify(p));
  assert.equal(startHistory(dir), 64);
  assert.throws(() => stateAt(dir, 63), /older than the history/);
  applyOps(dir, "ui", [{ op: "setSettings", title: "Dolu" }]);
  assert.match(diffRevisions(dir, 64, 65).text, /title: “Boş” → “Dolu”/);
});

test("diffStates / applyChanges round-trip both ways", () => {
  const a = { x: 1, o: { k: "a", arr: [1, 2] }, gone: true };
  const b = { x: 2, o: { k: "a", arr: [1, 3], n: null }, added: { y: 1 } };
  const ch = diffStates(a, b);
  assert.deepEqual(applyChanges(structuredClone(a), ch, "to"), b);
  assert.deepEqual(applyChanges(structuredClone(b), ch, "from"), a);
  assert.equal(textDiff("a b c", "a x c"), "a [-b-]{+x+} c");
});

test("MCP: ccdesk_history and ccdesk_diff", async () => {
  const { dir, ids } = sample();
  applyOps(dir, "ui", [{ op: "updateScript", id: ids[0], text: "Merhaba, ben Buse. Bugün yeni kanalı tanıtıyorum." }]);
  const stateDir = tmp();
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
  try {
  const h = await call("ccdesk_history");
  assert.match(h, /current revision 3; history can rebuild revisions 0–3/);
  assert.match(h, /3 .* Taha: /);
  const d = await call("ccdesk_diff", { from: -1 });
  assert.match(d, /revision 2 → 3/);
  assert.match(d, /\{\+yeni/);
  const j = JSON.parse(await call("ccdesk_diff", { from: 0, to: 3, json: true }));
  assert.ok(j.changes.length > 0);
  } finally { await client.close(); }
});
