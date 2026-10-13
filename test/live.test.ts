/**
 * Live tests against the real `claude` CLI. Skipped unless COUNCIL_LIVE=1,
 * because they cost money and need working auth.
 *
 *   COUNCIL_LIVE=1 COUNCIL_LIVE_MODEL=haiku node --test dist-test/test/live.test.js
 *
 * They exist to catch the failure the offline suite cannot: a CLI flag or
 * output field changing underneath the adapter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { coercePlan } from "../src/council.js";
import { Ledger, ledgerPath } from "../src/ledger.js";
import { PLAN_SCHEMA } from "../src/prompts.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeRepo } from "./helpers.js";

const live = process.env["COUNCIL_LIVE"] === "1";
const model = process.env["COUNCIL_LIVE_MODEL"] ?? "haiku";
const SERVER = resolve(import.meta.dirname, "../src/mcp/server.js");

function seat(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ ...DEFAULT_CONFIG.seats.claude, model });
}

test("the real claude CLI reports itself available", { skip: !live }, async () => {
  const availability = await seat().availability();
  assert.equal(availability.available, true, availability.detail);
  assert.match(availability.version ?? "", /\d+\.\d+/);
});

test("a real plan turn comes back as a plan the engine accepts", { skip: !live }, async () => {
  const repo = await makeRepo();
  const result = await seat().run({
    prompt:
      "Plan adding a src/hello.txt file containing the word hello to this repo. " +
      "Keep it to one or two steps.",
    workspace: repo,
    jsonSchema: PLAN_SCHEMA,
    allowWrites: false,
    budgetUsd: 0.5,
    timeoutMs: 240_000,
  });

  assert.equal(result.ok, true, result.error ?? "turn failed");
  assert.ok(result.json, "a --json-schema turn must return structured output");
  const plan = coercePlan(result.json, "claude");
  assert.ok(plan, "the structured output must satisfy the engine's plan shape");
  assert.ok(plan.steps.length >= 1);
  assert.ok(typeof result.costUsd === "number" && result.costUsd > 0, "cost must be reported");
  assert.ok(result.sessionId, "a session id must come back for the audit trail");
});

test("a read-only turn really cannot write", { skip: !live }, async () => {
  const repo = await makeRepo({ withCheck: false });
  const result = await seat().run({
    prompt:
      "Create a file called src/should-not-exist.txt containing the word nope. " +
      "If you cannot write files, say exactly: BLOCKED.",
    workspace: repo,
    allowWrites: false,
    budgetUsd: 0.5,
    timeoutMs: 240_000,
  });
  const { existsSync } = await import("node:fs");
  assert.equal(
    existsSync(join(repo, "src", "should-not-exist.txt")),
    false,
    "a read-only council turn must not be able to write to the repo",
  );
  void result;
});

test("the real claude CLI can reach the council peer channel", { skip: !live }, async () => {
  const repo = await makeRepo({ withCheck: false });
  const home = join(repo, ".council");
  const ledger = new Ledger(ledgerPath(home));
  await ledger.load();
  await ledger.append({
    taskId: "live1",
    actor: "muse",
    type: "note",
    payload: { text: "MUSE_MARKER_7391: the retry budget lives in src/seed.txt" },
  });

  const result = await seat().run({
    prompt:
      "Use the council MCP tool read_ledger to read the shared ledger, then " +
      "reply with the marker string you find in it and nothing else.",
    workspace: repo,
    allowWrites: false,
    budgetUsd: 0.75,
    timeoutMs: 300_000,
    mcp: {
      serverPath: SERVER,
      env: {
        COUNCIL_REPO_ROOT: repo,
        COUNCIL_HOME: home,
        COUNCIL_TASK_ID: "live1",
        COUNCIL_SELF: "claude",
        COUNCIL_PEER: "muse",
        COUNCIL_PEER_DEPTH: "0",
      },
      toolNames: ["read_ledger", "post_note", "ask_peer", "flag_blocker", "request_real_world_action"],
    },
  });

  assert.equal(result.ok, true, result.error ?? "turn failed");
  assert.match(
    result.text,
    /MUSE_MARKER_7391/,
    "Claude must be able to read what its peer wrote through the channel",
  );
});
