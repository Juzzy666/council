import { test } from "node:test";
import assert from "node:assert/strict";
import { assignUnits, hasBlockers, planHash, resolveConvergence, toCandidate } from "../src/consensus.js";
import type { Plan, Vote } from "../src/protocol.js";

function plan(agent: string, overrides: Partial<Plan> = {}): Plan {
  return {
    agent,
    summary: "same approach",
    steps: [
      { id: "a", title: "A", detail: "do a", files: ["src/a.ts"], risk: "low" },
      { id: "b", title: "B", detail: "do b", files: ["src/b.ts"], risk: "low" },
    ],
    risks: [],
    acceptanceChecks: ["npm test"],
    openQuestions: [],
    ...overrides,
  };
}

test("plan hash ignores the author, so identical plans collide on purpose", () => {
  assert.equal(planHash(plan("claude")), planHash(plan("muse")));
});

test("plan hash ignores incidental whitespace but not content", () => {
  assert.equal(planHash(plan("claude", { summary: "  same approach  " })), planHash(plan("claude")));
  assert.notEqual(planHash(plan("claude", { summary: "different" })), planHash(plan("claude")));
});

test("a candidate needs every seat to agree", () => {
  const candidate = toCandidate(plan("claude"), "claude");
  const votes: Vote[] = [
    { agent: "claude", position: "agree", rationale: "mine", planHash: candidate.hash },
    { agent: "muse", position: "disagree", rationale: "no", planHash: candidate.hash },
  ];
  assert.equal(resolveConvergence(["claude", "muse"], [candidate], votes).kind, "deadlock");

  votes[1] = { agent: "muse", position: "agree", rationale: "fine", planHash: candidate.hash };
  const agreed = resolveConvergence(["claude", "muse"], [candidate], votes);
  assert.equal(agreed.kind, "agreed");
  assert.equal(agreed.kind === "agreed" && agreed.candidate.hash, candidate.hash);
});

test("deadlock reports each seat's own objection", () => {
  const candidate = toCandidate(plan("claude"), "claude");
  const outcome = resolveConvergence(["claude", "muse"], [candidate], [
    { agent: "claude", position: "agree", rationale: "mine", planHash: candidate.hash },
    { agent: "muse", position: "disagree", rationale: "it breaks the schema", planHash: candidate.hash },
  ]);
  assert.equal(outcome.kind, "deadlock");
  if (outcome.kind === "deadlock") {
    assert.equal(outcome.positions["muse"], "it breaks the schema");
    assert.equal(outcome.positions["claude"], "mine");
  }
});

test("ties between accepted candidates resolve to the same plan every replay", () => {
  const first = toCandidate(plan("claude", { summary: "one" }), "claude");
  const second = toCandidate(plan("muse", { summary: "two" }), "muse");
  const votes: Vote[] = [first, second].flatMap((candidate) => [
    { agent: "claude", position: "agree" as const, rationale: "", planHash: candidate.hash },
    { agent: "muse", position: "agree" as const, rationale: "", planHash: candidate.hash },
  ]);
  const a = resolveConvergence(["claude", "muse"], [first, second], votes);
  const b = resolveConvergence(["claude", "muse"], [second, first], votes);
  assert.equal(a.kind, "agreed");
  assert.equal(
    a.kind === "agreed" ? a.candidate.hash : "",
    b.kind === "agreed" ? b.candidate.hash : "x",
  );
});

test("votes on a hash nobody proposed cannot create agreement", () => {
  const candidate = toCandidate(plan("claude"), "claude");
  const outcome = resolveConvergence(["claude", "muse"], [candidate], [
    { agent: "claude", position: "agree", rationale: "", planHash: "deadbeef" },
    { agent: "muse", position: "agree", rationale: "", planHash: "deadbeef" },
  ]);
  assert.equal(outcome.kind, "deadlock");
});

test("steps sharing a file land with one owner", () => {
  const shared = plan("claude", {
    steps: [
      { id: "a", title: "A", detail: "", files: ["src/shared.ts"], risk: "low" },
      { id: "b", title: "B", detail: "", files: ["src/shared.ts", "src/other.ts"], risk: "low" },
      { id: "c", title: "C", detail: "", files: ["src/other.ts"], risk: "low" },
      { id: "d", title: "D", detail: "", files: ["src/alone.ts"], risk: "low" },
    ],
  });
  const assignment = assignUnits(shared, ["claude", "muse"]);
  const owners = new Map(assignment.map((entry) => [entry.stepId, entry.owner]));
  assert.equal(owners.get("a"), owners.get("b"), "a and b share src/shared.ts");
  assert.equal(owners.get("b"), owners.get("c"), "b and c share src/other.ts transitively");
  assert.notEqual(owners.get("d"), owners.get("a"), "the independent step goes to the other seat");
});

test("an explicit suggestedOwner is honoured", () => {
  const hinted = plan("claude", {
    steps: [
      { id: "a", title: "A", detail: "", files: ["x.ts"], risk: "low", suggestedOwner: "muse" },
      { id: "b", title: "B", detail: "", files: ["y.ts"], risk: "low" },
    ],
  });
  const assignment = assignUnits(hinted, ["claude", "muse"]);
  assert.equal(assignment.find((entry) => entry.stepId === "a")?.owner, "muse");
});

test("assignment keeps the plan's step order", () => {
  const assignment = assignUnits(plan("claude"), ["claude", "muse"]);
  assert.deepEqual(assignment.map((entry) => entry.stepId), ["a", "b"]);
});

test("a single seat owns everything", () => {
  const assignment = assignUnits(plan("claude"), ["claude"]);
  assert.ok(assignment.every((entry) => entry.owner === "claude"));
});

test("blockers and majors block; nits do not", () => {
  assert.equal(hasBlockers([{ severity: "nit" }, { severity: "minor" }]), false);
  assert.equal(hasBlockers([{ severity: "major" }]), true);
  assert.equal(hasBlockers([{ severity: "blocker" }]), true);
});
