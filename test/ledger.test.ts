import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, canonicalize, foldTask, hashOf } from "../src/ledger.js";
import type { Brief } from "../src/protocol.js";

async function freshLedger(): Promise<Ledger> {
  const dir = await mkdtemp(join(tmpdir(), "council-ledger-"));
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  await ledger.load();
  return ledger;
}

const brief: Brief = {
  taskId: "t1",
  goal: "do the thing",
  constraints: [],
  acceptance: [],
  repoRoot: "/repo",
  baseRef: "main",
  createdAt: "2026-10-13T00:00:00.000Z",
};

test("canonical JSON sorts keys recursively so hashes are stable", () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
});

test("canonical JSON drops undefined members but keeps nulls", () => {
  assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
});

test("appends form an unbroken hash chain", async () => {
  const ledger = await freshLedger();
  await ledger.append({ taskId: "t1", actor: "engine", type: "task_opened", payload: { brief } });
  await ledger.append({ taskId: "t1", actor: "claude", type: "note", payload: { text: "hi" } });
  const events = await ledger.read();
  assert.equal(events.length, 2);
  assert.equal(events[0]!.seq, 1);
  assert.equal(events[1]!.prevHash, events[0]!.hash);
  assert.equal(await ledger.verifyChain(), null);
});

test("concurrent appends serialize without losing or duplicating a seq", async () => {
  const ledger = await freshLedger();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      ledger.append({ taskId: "t1", actor: "claude", type: "note", payload: { i } }),
    ),
  );
  const events = await ledger.read();
  assert.equal(events.length, 25);
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(await ledger.verifyChain(), null);
});

test("an edited event is detected", async () => {
  const ledger = await freshLedger();
  await ledger.append({ taskId: "t1", actor: "engine", type: "task_opened", payload: { brief } });
  await ledger.append({ taskId: "t1", actor: "claude", type: "note", payload: { text: "original" } });
  const raw = (await readFile(ledger.path, "utf8")).replace("original", "tampered");
  await writeFile(ledger.path, raw, "utf8");
  const broken = await ledger.verifyChain();
  assert.ok(broken, "a rewritten payload must break the chain");
  assert.equal(broken.seq, 2);
});

test("a removed event is detected", async () => {
  const ledger = await freshLedger();
  for (const text of ["a", "b", "c"]) {
    await ledger.append({ taskId: "t1", actor: "claude", type: "note", payload: { text } });
  }
  const lines = (await readFile(ledger.path, "utf8")).trim().split("\n");
  await writeFile(ledger.path, `${[lines[0], lines[2]].join("\n")}\n`, "utf8");
  const broken = await ledger.verifyChain();
  assert.ok(broken);
  assert.match(broken.reason, /expected seq 2/);
});

test("folding rebuilds task state from events alone", async () => {
  const ledger = await freshLedger();
  await ledger.append({ taskId: "t1", actor: "engine", type: "task_opened", payload: { brief } });
  await ledger.append({ taskId: "t1", actor: "engine", type: "phase_entered", payload: { phase: "planning" } });
  await ledger.append({
    taskId: "t1",
    actor: "claude",
    type: "plan_submitted",
    payload: { plan: { agent: "claude", summary: "s", steps: [], risks: [], acceptanceChecks: [], openQuestions: [] } },
  });
  await ledger.append({
    taskId: "t1",
    actor: "engine",
    type: "unit_created",
    payload: { unit: { id: "u1", title: "t", detail: "d", files: [], owner: "claude", status: "claimed" } },
  });
  await ledger.append({
    taskId: "t1",
    actor: "muse",
    type: "review_submitted",
    payload: { review: { agent: "muse", unitId: "u1", verdict: "approve", findings: [], summary: "fine" }, round: 1 },
  });
  await ledger.append({ taskId: "t1", actor: "claude", type: "spend", payload: { agent: "claude", usd: 0.25 } });
  await ledger.append({ taskId: "t1", actor: "claude", type: "spend", payload: { agent: "claude", usd: 0.25 } });
  await ledger.append({ taskId: "t1", actor: "engine", type: "task_closed", payload: { phase: "done" } });

  const state = foldTask(await ledger.readTask("t1"));
  assert.ok(state);
  assert.equal(state.phase, "done");
  assert.equal(state.units[0]!.status, "approved");
  assert.equal(state.units[0]!.reviewRounds, 1);
  assert.equal(state.spendUsd["claude"], 0.5);
  assert.ok(state.endedAt);
});

test("folding a log with no task_opened yields null", async () => {
  const ledger = await freshLedger();
  await ledger.append({ taskId: "t1", actor: "claude", type: "note", payload: { text: "orphan" } });
  assert.equal(foldTask(await ledger.readTask("t1")), null);
});
