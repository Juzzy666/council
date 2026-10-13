/**
 * The landing decision — the one piece of logic that decides what an
 * unattended run is allowed to do to a repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLanding, describeRun, integrationVerified } from "../src/landing.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { AutonomyConfig } from "../src/config.js";
import type { CheckResult, TaskState } from "../src/protocol.js";

const AUTONOMOUS: AutonomyConfig = {
  ...DEFAULT_CONFIG.autonomy,
  mode: "autonomous",
  mergeWhenGreen: true,
};

function check(ok: boolean, cwd = "/tree/integration"): CheckResult {
  return { command: "npm test", cwd, ok, exitCode: ok ? 0 : 1, durationMs: 10, outputTail: "" };
}

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    brief: {
      taskId: "t1",
      goal: "do the thing",
      constraints: [],
      acceptance: [],
      repoRoot: "/repo",
      baseRef: "main",
      createdAt: "2026-10-13T00:00:00.000Z",
    },
    phase: "done",
    plans: { claude: {} as never, muse: {} as never },
    critiques: [],
    votes: [],
    units: [
      { id: "u1", title: "t", detail: "d", files: [], owner: "claude", status: "approved" },
      { id: "u2", title: "t", detail: "d", files: [], owner: "muse", status: "approved" },
    ],
    reviews: [],
    checks: [check(true)],
    actionRequests: [],
    spendUsd: { claude: 0.5 },
    rounds: { critique: 1, review: 1 },
    integrationBranch: "council/t1/integration",
    startedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

test("done, approved and green is the only thing that merges", () => {
  const action = decideLanding(state(), AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "merge");
});

test("agreement with no checks never merges by default", () => {
  const action = decideLanding(state({ checks: [] }), AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "pull_request");
  assert.match(action.kind === "pull_request" ? action.why : "", /nothing verified it/);
});

test("merging with no checks takes a second, explicit opt-in", () => {
  const action = decideLanding(
    state({ checks: [] }),
    { ...AUTONOMOUS, mergeWithoutChecks: true },
    "/tree/integration",
  );
  assert.equal(action.kind, "merge");
  assert.match(action.why, /agreement alone/);
});

test("a failing check never merges", () => {
  const action = decideLanding(state({ checks: [check(false)] }), AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "pull_request");
});

test("an unapproved unit never merges, however green", () => {
  const unapproved = state({
    units: [{ id: "u1", title: "t", detail: "d", files: [], owner: "claude", status: "changes_requested" }],
  });
  const action = decideLanding(unapproved, AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "pull_request");
  assert.equal(action.kind === "pull_request" && action.draft, true);
  assert.match(action.why, /not every unit was approved/);
});

test("an escalated run becomes a draft PR carrying the reason", () => {
  const escalated = state({
    phase: "escalated",
    escalation: {
      reason: "the seats could not agree on a plan",
      phase: "convergence",
      positions: { claude: "a", muse: "b" },
      question: "pick one",
    },
  });
  const action = decideLanding(escalated, AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "pull_request");
  assert.equal(action.kind === "pull_request" && action.draft, true);
  assert.match(action.why, /could not agree/);
});

test("checks from a seat's own worktree do not count as verification", () => {
  // A seat worktree holds half the plan, so its result says nothing about the
  // merge. Only checks run in the integration tree count.
  const seatOnly = state({ checks: [check(true, "/tree/claude")] });
  assert.equal(integrationVerified(seatOnly, "/tree/integration"), false);
  assert.equal(decideLanding(seatOnly, AUTONOMOUS, "/tree/integration").kind, "pull_request");
});

test("nothing built means nothing to land", () => {
  const action = decideLanding(state({ integrationBranch: undefined }), AUTONOMOUS, "/tree/integration");
  assert.equal(action.kind, "nothing");
});

test("with PRs switched off, unmergeable work does nothing rather than merging", () => {
  const action = decideLanding(
    state({ checks: [] }),
    { ...AUTONOMOUS, openPullRequests: false },
    "/tree/integration",
  );
  assert.equal(action.kind, "nothing");
});

test("supervised mode never merges even when everything is green", () => {
  const action = decideLanding(state(), DEFAULT_CONFIG.autonomy, "/tree/integration");
  assert.equal(action.kind, "pull_request");
  assert.match(action.why, /mergeWhenGreen is off/);
});

test("the PR body says what verified the work, or that nothing did", () => {
  assert.match(describeRun(state(), "https://x/issues/1"), /✅ `npm test`/);
  assert.match(describeRun(state({ checks: [] })), /nothing verified this/);
  assert.match(describeRun(state()), /Replay: `council replay t1`/);
});

test("the blob upload uses the same request shape as the account's working one", async () => {
  const { publishJson } = await import("../src/publish.js");
  const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const result = await publishJson(
    { hello: "world" },
    {
      token: "blob-token",
      path: "/council/sweep.json",
      cacheMaxAge: 300,
      fetcher: async (url, init) => {
        seen.url = url;
        seen.headers = init?.headers as Record<string, string>;
        seen.body = String(init?.body);
        return new Response(JSON.stringify({ url: "https://blob/council/sweep.json" }), { status: 200 });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://blob/council/sweep.json");
  // The leading slash must be stripped, or the object lands at a double slash.
  assert.equal(seen.url, "https://blob.vercel-storage.com/council/sweep.json");
  assert.equal(seen.headers?.["x-api-version"], "7");
  assert.equal(seen.headers?.["x-allow-overwrite"], "1");
  assert.equal(seen.headers?.["x-add-random-suffix"], "0");
  assert.equal(seen.headers?.["x-cache-control-max-age"], "300");
  assert.equal(seen.headers?.["authorization"], "Bearer blob-token");
});

test("a failed upload is reported, never thrown", async () => {
  const { publishJson } = await import("../src/publish.js");
  const result = await publishJson({}, {
    token: "t",
    path: "p",
    fetcher: async () => new Response("no", { status: 403 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /403/);

  const thrown = await publishJson({}, {
    token: "t",
    path: "p",
    fetcher: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error ?? "", /network down/);
});
