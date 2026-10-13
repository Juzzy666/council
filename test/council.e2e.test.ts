/**
 * The whole council, end to end, with two scripted seats.
 *
 * No API key, no network, no spend — but real git worktrees, a real merge and
 * the fixture repo's real test command deciding the outcome. The fixture's test
 * passes only when BOTH seats' files are present, so a green run proves the
 * integration merge actually happened rather than one seat's branch being
 * mistaken for the result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Council } from "../src/council.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { loadConfig } from "../src/config.js";
import { Ledger, foldTask, ledgerPath } from "../src/ledger.js";
import { detectChecks } from "../src/checks.js";
import type { AgentRequest } from "../src/adapters/types.js";
import { makeRepo, planJson } from "./helpers.js";

type TurnKind = "plan" | "critique" | "vote" | "implement" | "review" | "judge" | "unknown";

/** Which turn is this? Taken from the schema the engine asked for. */
function turnKind(request: AgentRequest): TurnKind {
  const required = (request.jsonSchema?.["required"] as string[] | undefined) ?? [];
  if (required.includes("mergedPlan")) return "critique";
  if (required.includes("votes")) return "vote";
  if (required.includes("filesTouched")) return "implement";
  if (required.includes("findings") && required.includes("summary")) return "review";
  if (required.includes("steps")) return "plan";
  if (required.includes("planHash")) return "judge";
  return "unknown";
}

/**
 * The file this turn's own unit is about. Read from the `UNIT <id>:` line, not
 * from the prompt as a whole: the prompt also carries the agreed plan and the
 * peer's units, so a substring search picks up the other seat's files and both
 * seats write the same file — which the engine then correctly refuses to merge.
 */
function unitFile(prompt: string): string {
  const id = prompt.match(/^UNIT (\S+):/m)?.[1] ?? "alpha";
  return `src/${id}.txt`;
}

const STEPS = [
  { id: "alpha", title: "Write alpha", files: ["src/alpha.txt"], owner: "claude" },
  { id: "beta", title: "Write beta", files: ["src/beta.txt"], owner: "muse" },
];

/** A seat that plans, agrees, writes its file, and approves its peer's work. */
function cooperativeSeat(id: string, log: string[]) {
  return new FakeAdapter(id, (request) => {
    const kind = turnKind(request);
    log.push(`${id}:${kind}`);
    switch (kind) {
      case "plan":
        return planJson(id, STEPS);
      case "critique":
        return JSON.stringify({
          verdict: "endorse",
          findings: [],
          mergedPlan: JSON.parse(planJson(id, STEPS)),
        });
      case "vote": {
        // Agree with every candidate on the ballot, whatever its hash.
        const hashes = [...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!);
        return JSON.stringify({
          votes: [...new Set(hashes)].map((planHash) => ({
            planHash,
            position: "agree",
            rationale: "same plan, no objection",
          })),
        });
      }
      case "implement": {
        const file = unitFile(request.prompt);
        return {
          ok: true,
          text: JSON.stringify({ summary: `wrote ${file}`, filesTouched: [file], selfCheck: "ran nothing", unresolved: [] }),
          json: { summary: `wrote ${file}`, filesTouched: [file], selfCheck: "ran nothing", unresolved: [] },
          // The write happens as a side effect, like a real seat editing its worktree.
          meta: { wrote: file },
        };
      }
      case "review":
        return JSON.stringify({ verdict: "approve", summary: "does what the unit asked", findings: [] });
      default:
        return JSON.stringify({});
    }
  });
}

/** Wrap a seat so implementation turns really touch the worktree. */
function writingSeat(id: string, log: string[]) {
  const inner = cooperativeSeat(id, log);
  const run = inner.run.bind(inner);
  inner.run = async (request: AgentRequest) => {
    const result = await run(request);
    const file = (result.meta as { wrote?: string } | undefined)?.wrote;
    if (file) {
      await writeFile(join(request.workspace, file), `${id} was here\n`, "utf8");
    }
    return result;
  };
  return inner;
}

test("a cooperative council plans, builds in two worktrees, cross-reviews and merges green", async () => {
  const repo = await makeRepo();
  const log: string[] = [];
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ["npm run test"],
    limits: { critiqueRounds: 2, reviewRounds: 2, peerDepth: 1, turnTimeoutMs: 60_000 },
  });
  const claude = writingSeat("claude", log);
  const muse = writingSeat("muse", log);

  const state = await new Council({ config, adapters: [claude, muse] }).run({
    goal: "add alpha and beta",
    acceptance: ["npm run test"],
    taskId: "e2e",
  });

  assert.equal(state.phase, "done", `expected done, got ${state.phase}: ${JSON.stringify(state.escalation)}`);
  assert.equal(state.agreedPlan?.steps.length, 2);
  assert.ok(state.agreedPlanHash);

  // Each seat owns exactly one unit, and ownership follows the plan's hint.
  assert.equal(state.units.length, 2);
  assert.equal(state.units.find((unit) => unit.id === "alpha")?.owner, "claude");
  assert.equal(state.units.find((unit) => unit.id === "beta")?.owner, "muse");
  assert.ok(state.units.every((unit) => unit.status === "approved"));

  // Nobody reviewed their own work.
  assert.equal(state.reviews.length, 2);
  for (const review of state.reviews) {
    const unit = state.units.find((candidate) => candidate.id === review.unitId)!;
    assert.notEqual(review.agent, unit.owner, "a unit's reviewer must not be its owner");
  }

  // Independence: both plans were submitted before either critique ran.
  const firstCritique = log.findIndex((entry) => entry.endsWith(":critique"));
  const plans = log.filter((entry) => entry.endsWith(":plan")).length;
  assert.equal(plans, 2);
  assert.ok(log.slice(0, firstCritique).filter((e) => e.endsWith(":plan")).length === 2);

  // The merge is real: the integration worktree holds both seats' files and the
  // fixture's own test passes there.
  assert.ok(state.integrationBranch);
  const integration = join(repo, ".council", "worktrees", "e2e", "integration");
  assert.ok(existsSync(join(integration, "src", "alpha.txt")), "alpha.txt must survive the merge");
  assert.ok(existsSync(join(integration, "src", "beta.txt")), "beta.txt must survive the merge");
  const integrationChecks = state.checks.filter((check) => check.cwd === integration);
  assert.ok(integrationChecks.length > 0);
  assert.ok(integrationChecks.every((check) => check.ok), "the integrated result must pass the repo's checks");

  // The ledger alone can reconstruct all of that, and is intact.
  const ledger = new Ledger(ledgerPath(config.councilHome));
  assert.equal(await ledger.verifyChain(), null);
  const folded = foldTask(await ledger.readTask("e2e"))!;
  assert.equal(folded.phase, "done");
  assert.equal(folded.units.length, 2);
  assert.equal(folded.reviews.length, 2);
  assert.equal(folded.agreedPlanHash, state.agreedPlanHash);
});

test("a seat that refuses every plan ends in escalation, not in a silent merge", async () => {
  const repo = await makeRepo();
  const log: string[] = [];
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ["npm run test"],
    limits: { critiqueRounds: 1, reviewRounds: 1, peerDepth: 1, turnTimeoutMs: 60_000 },
    tiebreak: "human",
  });
  const claude = writingSeat("claude", log);
  const obstinate = new FakeAdapter("muse", (request) => {
    const kind = turnKind(request);
    log.push(`muse:${kind}`);
    if (kind === "plan") return planJson("muse", [{ id: "gamma", title: "Write gamma", files: ["src/gamma.txt"] }]);
    if (kind === "critique") {
      return JSON.stringify({
        verdict: "reject",
        findings: [
          { severity: "blocker", claim: "wrong layer", evidence: "alpha.txt is not where config lives", fix: "put it in src/config" },
        ],
        mergedPlan: JSON.parse(planJson("muse", [{ id: "gamma", title: "Write gamma", files: ["src/gamma.txt"] }])),
      });
    }
    if (kind === "vote") {
      const hashes = [...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!);
      return JSON.stringify({
        votes: [...new Set(hashes)].map((planHash) => ({
          planHash,
          position: "disagree",
          rationale: "none of these put the file in the right place",
        })),
      });
    }
    return JSON.stringify({});
  });

  const state = await new Council({ config, adapters: [claude, obstinate] }).run({
    goal: "add alpha",
    taskId: "deadlock",
  });

  assert.equal(state.phase, "escalated");
  assert.ok(state.escalation);
  assert.equal(state.escalation.phase, "convergence");
  assert.match(state.escalation.positions["muse"] ?? "", /right place/);
  assert.equal(state.units.length, 0, "no work may start without an agreed plan");
  assert.ok(!existsSync(join(repo, ".council", "worktrees", "deadlock")));
});

test("the judge tie-break picks a candidate off the ballot and the run proceeds", async () => {
  const repo = await makeRepo();
  const log: string[] = [];
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ["npm run test"],
    limits: { critiqueRounds: 1, reviewRounds: 1, peerDepth: 1, turnTimeoutMs: 60_000 },
    tiebreak: "judge",
    judgeSeat: "claude",
  });

  let ballot: string[] = [];
  const claude = new FakeAdapter("claude", (request) => {
    const kind = turnKind(request);
    log.push(`claude:${kind}`);
    if (kind === "plan") return planJson("claude", STEPS);
    if (kind === "critique") {
      return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson("claude", STEPS)) });
    }
    if (kind === "vote") {
      ballot = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
      return JSON.stringify({
        votes: ballot.map((planHash) => ({ planHash, position: "disagree", rationale: "deadlocking on purpose" })),
      });
    }
    if (kind === "judge") return JSON.stringify({ planHash: ballot[0], rationale: "it is the only coherent one" });
    if (kind === "implement") {
      const file = unitFile(request.prompt);
      return JSON.stringify({ summary: `wrote ${file}`, filesTouched: [file], selfCheck: "", unresolved: [] });
    }
    if (kind === "review") return JSON.stringify({ verdict: "approve", summary: "fine", findings: [] });
    return JSON.stringify({});
  });
  const muse = new FakeAdapter("muse", (request) => {
    const kind = turnKind(request);
    log.push(`muse:${kind}`);
    if (kind === "plan") return planJson("muse", STEPS);
    if (kind === "critique") {
      return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson("muse", STEPS)) });
    }
    if (kind === "vote") {
      const hashes = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
      return JSON.stringify({
        votes: hashes.map((planHash) => ({ planHash, position: "disagree", rationale: "no" })),
      });
    }
    if (kind === "implement") {
      const file = unitFile(request.prompt);
      return JSON.stringify({ summary: `wrote ${file}`, filesTouched: [file], selfCheck: "", unresolved: [] });
    }
    if (kind === "review") return JSON.stringify({ verdict: "approve", summary: "fine", findings: [] });
    return JSON.stringify({});
  });

  const state = await new Council({ config, adapters: [claude, muse] }).run({
    goal: "add alpha and beta",
    taskId: "judged",
    // planOnly keeps this test about the tie-break alone.
  } );

  assert.ok(state.agreedPlanHash, "the judge must produce an agreed plan");
  assert.ok(ballot.includes(state.agreedPlanHash));
  const ledger = new Ledger(ledgerPath(config.councilHome));
  const events = await ledger.readTask("judged");
  const agreed = events.find((event) => event.type === "plan_agreed")!;
  assert.equal((agreed.payload as { unanimous: boolean }).unanimous, false);
  assert.equal((agreed.payload as { tiebreakBy: string }).tiebreakBy, "claude");
});

test("a blocking review sends the unit back, and the fix round is recorded", async () => {
  const repo = await makeRepo({ withCheck: false });
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    // This repo declares no checks of its own; give the run a gate that passes
    // so the test is about the review round and nothing else.
    checks: ['node -e "process.exit(0)"'],
    limits: { critiqueRounds: 1, reviewRounds: 2, peerDepth: 1, turnTimeoutMs: 60_000 },
  });
  const onlyAlpha = [{ id: "alpha", title: "Write alpha", files: ["src/alpha.txt"], owner: "claude" }];
  let implementCalls = 0;

  const claude = new FakeAdapter("claude", (request) => {
    const kind = turnKind(request);
    if (kind === "plan") return planJson("claude", onlyAlpha);
    if (kind === "critique") return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson("claude", onlyAlpha)) });
    if (kind === "vote") {
      const hashes = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
      return JSON.stringify({ votes: hashes.map((planHash) => ({ planHash, position: "agree", rationale: "" })) });
    }
    if (kind === "implement") {
      implementCalls += 1;
      return JSON.stringify({ summary: `attempt ${implementCalls}`, filesTouched: ["src/alpha.txt"], selfCheck: "", unresolved: [] });
    }
    return JSON.stringify({});
  });
  const run = claude.run.bind(claude);
  claude.run = async (request: AgentRequest) => {
    const result = await run(request);
    if (turnKind(request) === "implement") {
      await writeFile(join(request.workspace, "src/alpha.txt"), `attempt ${implementCalls}\n`, "utf8");
    }
    return result;
  };

  let reviews = 0;
  const muse = new FakeAdapter("muse", (request) => {
    const kind = turnKind(request);
    if (kind === "plan") return planJson("muse", onlyAlpha);
    if (kind === "critique") return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson("muse", onlyAlpha)) });
    if (kind === "vote") {
      const hashes = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
      return JSON.stringify({ votes: hashes.map((planHash) => ({ planHash, position: "agree", rationale: "" })) });
    }
    if (kind === "review") {
      reviews += 1;
      return reviews === 1
        ? JSON.stringify({
            verdict: "request_changes",
            summary: "the file says nothing",
            findings: [{ severity: "blocker", claim: "empty content", evidence: "alpha.txt has no marker line", fix: "write the marker" }],
          })
        : JSON.stringify({ verdict: "approve", summary: "fixed", findings: [] });
    }
    return JSON.stringify({});
  });

  const state = await new Council({ config, adapters: [claude, muse] }).run({
    goal: "add alpha",
    taskId: "fixround",
  });

  assert.equal(state.phase, "done", JSON.stringify(state.escalation));
  assert.equal(reviews, 2, "a blocking review must be followed by a second review");
  assert.equal(implementCalls, 2, "the owner must get a fix turn");
  const ledger = new Ledger(ledgerPath(config.councilHome));
  const events = await ledger.readTask("fixround");
  assert.ok(events.some((event) => event.type === "fix_requested"));
  const unit = state.units[0]!;
  assert.equal(unit.status, "approved");
  assert.ok((unit.commits?.length ?? 0) >= 2, "the fix is its own commit");
});

test("one seat degrades honestly instead of pretending to be a council", async () => {
  const repo = await makeRepo({ withCheck: false });
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: [],
  });
  const log: string[] = [];
  const solo = writingSeat("claude", log);
  const state = await new Council({ config, adapters: [solo], planOnly: true }).run({
    goal: "add alpha",
    taskId: "solo",
  });

  assert.equal(state.phase, "done");
  assert.equal(log.filter((entry) => entry.endsWith(":critique")).length, 0, "no peer, no critique");
  const ledger = new Ledger(ledgerPath(config.councilHome));
  const events = await ledger.readTask("solo");
  const degraded = events.find(
    (event) => event.type === "note" && (event.payload as { degraded?: boolean }).degraded,
  );
  assert.ok(degraded, "the ledger must say the run was single-seat");
});

test("a repo's own scripts are detected as the objective gate", async () => {
  const repo = await makeRepo();
  const detected = await detectChecks(repo);
  assert.deepEqual(detected, ["npm run test"]);
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test"]);
});

test("a repo that declares nothing gets no invented checks", async () => {
  const repo = await makeRepo({ withCheck: false });
  assert.deepEqual(await detectChecks(repo), []);
});

test("a seat that writes outside its own unit is caught at integration, not merged", async () => {
  const repo = await makeRepo();
  const log: string[] = [];
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ["npm run test"],
    limits: { critiqueRounds: 1, reviewRounds: 1, peerDepth: 1, turnTimeoutMs: 60_000 },
  });

  const claude = writingSeat("claude", log);
  // This seat owns `beta` but edits `alpha` too — the exact failure that makes
  // two agents in one checkout dangerous. In separate worktrees it cannot
  // clobber anything; it surfaces as a merge conflict instead.
  const trespasser = cooperativeSeat("muse", log);
  const run = trespasser.run.bind(trespasser);
  trespasser.run = async (request: AgentRequest) => {
    const result = await run(request);
    if (turnKind(request) === "implement") {
      await writeFile(join(request.workspace, "src/beta.txt"), "muse was here\n", "utf8");
      await writeFile(join(request.workspace, "src/alpha.txt"), "muse overwrote this\n", "utf8");
    }
    return result;
  };

  const state = await new Council({ config, adapters: [claude, trespasser] }).run({
    goal: "add alpha and beta",
    taskId: "trespass",
  });

  assert.equal(state.phase, "escalated");
  assert.equal(state.escalation?.phase, "integration");
  assert.match(Object.values(state.escalation!.positions).join(" "), /src\/alpha\.txt/);

  // Claude's own branch is untouched by the trespass: isolation held.
  const claudeTree = join(repo, ".council", "worktrees", "trespass", "claude");
  assert.equal(await readFile(join(claudeTree, "src/alpha.txt"), "utf8"), "claude was here\n");
});


test("a seat whose turn fails without a commit is not called implemented", async () => {
  const repo = await makeRepo({ withCheck: false });
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ['node -e "process.exit(0)"'],
    limits: { critiqueRounds: 1, reviewRounds: 1, peerDepth: 1, turnTimeoutMs: 60_000 },
  });
  const onlyAlpha = [{ id: "alpha", title: "Write alpha", files: ["src/alpha.txt"], owner: "claude" }];

  const agreeable = (id: string) => (request: AgentRequest) => {
    const kind = turnKind(request);
    if (kind === "plan") return planJson(id, onlyAlpha);
    if (kind === "critique") {
      return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson(id, onlyAlpha)) });
    }
    if (kind === "vote") {
      const hashes = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
      return JSON.stringify({ votes: hashes.map((planHash) => ({ planHash, position: "agree", rationale: "" })) });
    }
    if (kind === "implement") {
      // The shape of the real failure found on the first live run: the runtime
      // rejected the turn, so there is no reply and no commit.
      return { ok: false, text: "", error: "claude exited 1: Invalid session ID. Must be a valid UUID." };
    }
    if (kind === "review") return JSON.stringify({ verdict: "approve", summary: "nothing to see", findings: [] });
    return JSON.stringify({});
  };

  const state = await new Council({
    config,
    adapters: [new FakeAdapter("claude", agreeable("claude")), new FakeAdapter("muse", agreeable("muse"))],
  }).run({ goal: "add alpha", taskId: "broken-seat" });

  assert.equal(state.phase, "escalated");
  assert.equal(state.escalation?.phase, "implementation");
  assert.equal(state.units[0]!.status, "abandoned");
  assert.ok(!state.integrationBranch, "nothing may be merged when nothing was built");
  assert.equal(state.reviews.length, 0, "an abandoned unit is not sent to review");
});

test("a repo with no checks is merged but never claimed to be verified", async () => {
  const repo = await makeRepo({ withCheck: false });
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: [],
    limits: { critiqueRounds: 1, reviewRounds: 1, peerDepth: 1, turnTimeoutMs: 60_000 },
  });
  const onlyAlpha = [{ id: "alpha", title: "Write alpha", files: ["src/alpha.txt"], owner: "claude" }];
  const seat = (id: string) => {
    const adapter = new FakeAdapter(id, (request) => {
      const kind = turnKind(request);
      if (kind === "plan") return planJson(id, onlyAlpha);
      if (kind === "critique") {
        return JSON.stringify({ verdict: "endorse", findings: [], mergedPlan: JSON.parse(planJson(id, onlyAlpha)) });
      }
      if (kind === "vote") {
        const hashes = [...new Set([...request.prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
        return JSON.stringify({ votes: hashes.map((planHash) => ({ planHash, position: "agree", rationale: "" })) });
      }
      if (kind === "implement") {
        return JSON.stringify({ summary: "wrote it", filesTouched: ["src/alpha.txt"], selfCheck: "", unresolved: [] });
      }
      if (kind === "review") return JSON.stringify({ verdict: "approve", summary: "fine", findings: [] });
      return JSON.stringify({});
    });
    const inner = adapter.run.bind(adapter);
    adapter.run = async (request: AgentRequest) => {
      const result = await inner(request);
      if (turnKind(request) === "implement") {
        await writeFile(join(request.workspace, "src/alpha.txt"), `${id}\n`, "utf8");
      }
      return result;
    };
    return adapter;
  };

  // The plan's own acceptanceChecks are an agent's claim, not the repo's gate,
  // and this fixture has no package.json for `npm run test` to work from.
  const state = await new Council({ config, adapters: [seat("claude"), seat("muse")] }).run({
    goal: "add alpha",
    taskId: "nogate",
  });

  assert.notEqual(state.phase, "done", "agreement alone must not count as verified");
  assert.equal(state.phase, "escalated");
  assert.match(state.escalation?.reason ?? "", /declares no checks|does not pass/);
  // The work is not thrown away: it merged, it is just not blessed.
  assert.ok(state.integrationBranch, "the branch still exists for a human to read");
});

test("requireChecks can be switched off deliberately", async () => {
  const repo = await makeRepo({ withCheck: false });
  const config = await loadConfig(repo, {
    councilHome: join(repo, ".council"),
    checks: ['node -e "process.exit(0)"'],
    requireChecks: false,
  });
  assert.equal(config.requireChecks, false);
  assert.equal((await loadConfig(repo, { councilHome: join(repo, ".council") })).requireChecks, true);
});
