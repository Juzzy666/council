/**
 * The unattended path, end to end, with no network and no API key.
 *
 * A scripted GitHub answers the REST calls, a local bare repository stands in
 * for the remote, and scripted seats do the work. What is being proved is the
 * part that is frightening to leave running: that a green run merges and closes
 * its issue, that an unverified one does not, that a task is claimed before it
 * is worked, and that a repository nobody listed is never touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sweep } from "../src/sweep.js";
import { loadConfig } from "../src/config.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { AgentAdapter, AgentRequest } from "../src/adapters/types.js";
import { ballotHashes, makeRemoteAndClone, planJson, turnKind, unitFile } from "./helpers.js";

const STEPS = [
  { id: "alpha", title: "Write alpha", files: ["src/alpha.txt"], owner: "claude" },
  { id: "beta", title: "Write beta", files: ["src/beta.txt"], owner: "muse" },
];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A scripted github.com (and ntfy), recording everything it is asked to do. */
function fakeGitHub(options: { issueBody?: string; mergeStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (parsed.host === "ntfy.sh") return json({ ok: true });
    if (method === "GET" && path === "/repos/o/r/issues") {
      return json([
        {
          number: 42,
          title: "Add alpha and beta",
          body: options.issueBody ?? "## Acceptance\n- `node -e \"process.exit(0)\"`",
          html_url: "https://github.com/o/r/issues/42",
          updated_at: "2026-10-13T00:00:00Z",
          user: { login: "juzzy666" },
          labels: [{ name: "council" }],
        },
      ]);
    }
    if (method === "GET" && path === "/repos/o/r") return json({ default_branch: "main" });
    if (method === "POST" && path === "/repos/o/r/pulls") {
      return json({ number: 7, html_url: "https://github.com/o/r/pull/7", draft: body?.draft ?? false });
    }
    if (method === "PUT" && path === "/repos/o/r/pulls/7/merge") {
      const status = options.mergeStatus ?? 200;
      return status === 200 ? json({ merged: true }) : json({ message: "not mergeable" }, status);
    }
    return json({});
  };
  return { calls, fetcher };
}

/** A seat that plans, agrees, writes its own file and approves its peer's. */
function seat(id: string): AgentAdapter {
  const adapter = new FakeAdapter(id, (request) => {
    switch (turnKind(request)) {
      case "plan":
        return planJson(id, STEPS);
      case "critique":
        return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson(id, STEPS)) });
      case "vote":
        return JSON.stringify({
          votes: ballotHashes(request.prompt).map((planHash) => ({ planHash, position: "agree", rationale: "" })),
        });
      case "implement": {
        const file = unitFile(request.prompt);
        return {
          ok: true,
          text: JSON.stringify({ summary: `wrote ${file}`, filesTouched: [file], selfCheck: "", unresolved: [] }),
          json: { summary: `wrote ${file}`, filesTouched: [file], selfCheck: "", unresolved: [] },
          meta: { wrote: file },
        };
      }
      case "review":
        return JSON.stringify({ verdict: "approve", summary: "does what the unit asked", findings: [] });
      default:
        return JSON.stringify({});
    }
  });
  const inner = adapter.run.bind(adapter);
  adapter.run = async (request: AgentRequest) => {
    const result = await inner(request);
    const file = (result.meta as { wrote?: string } | undefined)?.wrote;
    if (file) {
      // A real seat would create the directory; the fake has to as well.
      await mkdir(dirname(join(request.workspace, file)), { recursive: true });
      await writeFile(join(request.workspace, file), `${id} was here\n`, "utf8");
    }
    return result;
  };
  return adapter;
}

const PASSING_REPO_CONFIG = JSON.stringify({ checks: ['node -e "process.exit(0)"'] }, null, 2);
const FAILING_REPO_CONFIG = JSON.stringify({ checks: ['node -e "process.exit(1)"'] }, null, 2);

async function controlConfig(work: string, overrides: Record<string, unknown> = {}) {
  const control = await mkdtemp(join(tmpdir(), "council-control-"));
  return loadConfig(control, {
    councilHome: join(control, ".council"),
    projects: [{ repo: "o/r", dir: work }],
    autonomy: { mode: "autonomous", mergeWhenGreen: true } as never,
    notify: { ntfyTopic: "council-test" },
    sweep: { labels: ["council"], runningLabel: "council:running", parkedLabel: "council:parked", budgetUsd: 5, maxTasksPerRepo: 2 },
    ...overrides,
  });
}

test("a green autonomous run merges, comments and closes its issue", async () => {
  const { work } = await makeRemoteAndClone({
    "README.md": "fixture\n",
    "council.config.json": PASSING_REPO_CONFIG,
  });
  const { calls, fetcher } = fakeGitHub();
  const config = await controlConfig(work);

  const report = await sweep({
    config,
    fetcher,
    token: "test-token",
    makeSeats: () => [seat("claude"), seat("muse")],
  });

  assert.deepEqual(report.errors, []);
  assert.equal(report.results.length, 1);
  const result = report.results[0]!;
  assert.equal(result.action, "merged", result.why);
  assert.equal(result.phase, "done");
  assert.equal(result.pullRequest, "https://github.com/o/r/pull/7");

  // Claimed before it was worked: the running label goes on, the trigger label
  // comes off, so an overlapping sweep cannot take the same issue.
  const labelAdd = calls.find((call) => call.method === "POST" && call.path.endsWith("/labels"));
  assert.deepEqual((labelAdd?.body as { labels: string[] }).labels, ["council:running"]);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.endsWith("/labels/council")));

  // Opened a real (non-draft) PR, merged it, closed the issue.
  const pr = calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/pulls");
  assert.equal((pr?.body as { draft: boolean }).draft, false);
  assert.match((pr?.body as { body: string }).body, /✅ `node -e "process.exit\(0\)"`/);
  assert.ok(calls.some((call) => call.method === "PUT" && call.path === "/repos/o/r/pulls/7/merge"));
  const close = calls.find((call) => call.method === "PATCH" && call.path === "/repos/o/r/issues/42");
  assert.equal((close?.body as { state: string }).state, "closed");

  // Said so out loud, and left a machine-readable report behind.
  const ntfy = calls.find((call) => call.path === "/" && call.method === "POST");
  assert.match(JSON.stringify(ntfy?.body), /council merged/);
  assert.ok(existsSync(join(config.councilHome, "sweep.json")));
});

test("a run whose checks fail opens a PR and parks the issue instead of merging", async () => {
  const { work } = await makeRemoteAndClone({
    "README.md": "fixture\n",
    "council.config.json": FAILING_REPO_CONFIG,
  });
  const { calls, fetcher } = fakeGitHub();
  const config = await controlConfig(work);

  const report = await sweep({
    config,
    fetcher,
    token: "test-token",
    makeSeats: () => [seat("claude"), seat("muse")],
  });

  const result = report.results[0]!;
  assert.equal(result.action, "pull_request", result.why);
  assert.equal(result.phase, "escalated");
  assert.ok(!calls.some((call) => call.method === "PUT"), "nothing may be merged when the checks fail");
  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.path.endsWith("/labels") && JSON.stringify(call.body).includes("parked"),
    ),
    "the issue must be parked for a human",
  );
  const pr = calls.find((call) => call.method === "POST" && call.path === "/repos/o/r/pulls");
  assert.equal((pr?.body as { draft: boolean }).draft, true, "an escalated run's PR is a draft");
});

test("a repository that declares no checks is never merged autonomously", async () => {
  const { work } = await makeRemoteAndClone({ "README.md": "fixture\n" });
  const { calls, fetcher } = fakeGitHub({ issueBody: "no sections here" });
  const config = await controlConfig(work);

  const report = await sweep({
    config,
    fetcher,
    token: "test-token",
    makeSeats: () => [seat("claude"), seat("muse")],
  });

  assert.notEqual(report.results[0]!.action, "merged");
  assert.ok(!calls.some((call) => call.method === "PUT"));
});

test("GitHub refusing the merge is reported, not retried into a loop", async () => {
  const { work } = await makeRemoteAndClone({
    "README.md": "fixture\n",
    "council.config.json": PASSING_REPO_CONFIG,
  });
  const { calls, fetcher } = fakeGitHub({ mergeStatus: 405 });
  const config = await controlConfig(work);

  const report = await sweep({
    config,
    fetcher,
    token: "test-token",
    makeSeats: () => [seat("claude"), seat("muse")],
  });

  const result = report.results[0]!;
  assert.equal(result.action, "pull_request");
  assert.match(result.why, /merge refused/);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1, "one attempt, not a retry loop");
});

test("a dry run claims nothing and writes nothing", async () => {
  const { work } = await makeRemoteAndClone({ "README.md": "fixture\n" });
  const { calls, fetcher } = fakeGitHub();
  const config = await controlConfig(work);

  const report = await sweep({ config, fetcher, token: "t", dryRun: true, makeSeats: () => [seat("claude")] });

  assert.equal(report.results[0]!.action, "skipped");
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET"),
    [],
    "a dry run may only read",
  );
});

test("a project not in the configured list is never touched", async () => {
  const { work } = await makeRemoteAndClone({ "README.md": "fixture\n" });
  const { calls, fetcher } = fakeGitHub();
  const config = await controlConfig(work);

  const report = await sweep({ config, fetcher, token: "t", onlyRepo: "someone/else", makeSeats: () => [seat("claude")] });

  assert.equal(report.results.length, 0);
  assert.ok(!calls.some((call) => call.path.startsWith("/repos/o/r")));
  assert.match(report.errors.join(" "), /nothing to sweep/);
});

test("no token is a refusal with the fix in it, not a crash", async () => {
  const { work } = await makeRemoteAndClone({ "README.md": "fixture\n" });
  const config = await controlConfig(work);
  const report = await sweep({ config, token: "", makeSeats: () => [] });
  assert.match(report.errors.join(" "), /COUNCIL_GITHUB_TOKEN/);
  assert.equal(report.results.length, 0);
});

test("the sweep budget stops the pass, not just the task", async () => {
  const { work } = await makeRemoteAndClone({
    "README.md": "fixture\n",
    "council.config.json": PASSING_REPO_CONFIG,
  });
  const { fetcher } = fakeGitHub();
  const config = await controlConfig(work, { sweep: { labels: ["council"], runningLabel: "council:running", parkedLabel: "council:parked", budgetUsd: 0, maxTasksPerRepo: 2 } });

  const report = await sweep({ config, fetcher, token: "t", makeSeats: () => [seat("claude"), seat("muse")] });
  assert.equal(report.results.length, 0, "a spent budget means no task is started at all");
  assert.equal(report.budgetExhausted, true);
});
