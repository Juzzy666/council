/**
 * The seats' instructions and the JSON contracts their answers must satisfy.
 *
 * The prompts are written against one failure mode above all others: two
 * agents politely agreeing. A council whose members ratify each other is worse
 * than one agent, because it costs twice as much and feels twice as safe. So
 * every critique must either name a concrete defect with a path to it, or say
 * plainly that it found none — and "looks good" is named as a non-answer.
 */

import type { Brief, Finding, Plan, WorkUnit } from "./protocol.js";

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "risks", "acceptanceChecks", "openQuestions"],
  properties: {
    summary: { type: "string", description: "One paragraph: the approach and why." },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "detail", "files", "risk"],
        properties: {
          id: { type: "string", description: "Short slug, unique within the plan." },
          title: { type: "string" },
          detail: { type: "string", description: "What to change, concretely." },
          files: { type: "array", items: { type: "string" } },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          suggestedOwner: { type: "string" },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    acceptanceChecks: {
      type: "array",
      items: { type: "string" },
      description: "Shell commands that prove the work, runnable in the repo root.",
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["severity", "claim", "evidence", "fix"],
    properties: {
      severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
      claim: { type: "string" },
      evidence: { type: "string", description: "The path from a real input to the failure." },
      fix: { type: "string" },
      file: { type: "string" },
    },
  },
};

export const CRITIQUE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "mergedPlan"],
  properties: {
    verdict: { type: "string", enum: ["endorse", "revise", "reject"] },
    findings: FINDINGS_SCHEMA,
    mergedPlan: PLAN_SCHEMA,
  },
};

export const VOTE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["votes"],
  properties: {
    votes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["planHash", "position", "rationale"],
        properties: {
          planHash: { type: "string" },
          position: { type: "string", enum: ["agree", "disagree"] },
          rationale: { type: "string" },
        },
      },
    },
  },
};

export const IMPLEMENTATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "filesTouched", "selfCheck", "unresolved"],
  properties: {
    summary: { type: "string" },
    filesTouched: { type: "array", items: { type: "string" } },
    selfCheck: { type: "string", description: "What you ran, and what it printed." },
    unresolved: { type: "array", items: { type: "string" } },
  },
};

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: FINDINGS_SCHEMA,
  },
};

const ANTI_SYCOPHANCY = [
  "You are one of two independent agents on a council. The other seat is a",
  "different model from a different vendor. You are not here to agree with it,",
  "and you are not here to disagree for sport.",
  "",
  "Rules you are held to:",
  "- A finding needs a path: a real input or caller that reaches the failure.",
  '  "This could be fragile" is not a finding. Name the input.',
  "- If you genuinely find nothing, return an empty findings list and say so.",
  "  Padding the list with nits to look thorough is a failure.",
  "- Severity is about consequence, not tone. `blocker` means the work is wrong",
  "  or unsafe, not that you would have written it differently.",
  "- Never change what you were asked to judge.",
].join("\n");

export function seatSystemPrompt(seatLabel: string, peerLabel: string): string {
  return [
    `You are the ${seatLabel} seat on a two-agent council. Your peer is ${peerLabel}.`,
    "",
    ANTI_SYCOPHANCY,
    "",
    "Every answer you give is recorded in an append-only, hash-chained ledger",
    "that a human reads afterwards. Write for that reader.",
  ].join("\n");
}

function briefBlock(brief: Brief): string {
  return [
    `GOAL: ${brief.goal}`,
    brief.constraints.length ? `CONSTRAINTS:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    brief.acceptance.length ? `ACCEPTANCE:\n${brief.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    `REPO: ${brief.repoRoot} (base ref ${brief.baseRef})`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function planPrompt(brief: Brief): string {
  return [
    "Produce your own implementation plan. You have not seen your peer's plan,",
    "and it has not seen yours — that independence is the point, so do not try",
    "to guess what it will say.",
    "",
    briefBlock(brief),
    "",
    "Read the repository before planning. Steps must name real files and real",
    "commands. `acceptanceChecks` must be commands that actually exist in this",
    "repo (check package.json / Makefile / test config before naming one).",
    "Do not edit anything in this turn.",
  ].join("\n");
}

export function critiquePrompt(brief: Brief, own: Plan, peer: Plan): string {
  return [
    "Both plans are now on the table. Yours:",
    "",
    JSON.stringify(own, null, 2),
    "",
    `Your peer's (${peer.agent}):`,
    "",
    JSON.stringify(peer, null, 2),
    "",
    briefBlock(brief),
    "",
    "Do three things:",
    "1. Judge the peer's plan. Findings only where you can show the path.",
    "2. Set a verdict: `endorse` (sound as it stands), `revise` (fixable),",
    "   `reject` (wrong approach).",
    "3. Return `mergedPlan`: the single plan you would actually commit to,",
    "   taking the better half of each. If the peer's plan is better than yours,",
    "   say so by returning theirs. Preferring your own plan because it is yours",
    "   is the one outcome that is always wrong.",
  ].join("\n");
}

export function votePrompt(
  brief: Brief,
  candidates: readonly { hash: string; plan: Plan; proposedBy: string }[],
): string {
  return [
    "The council must now commit to exactly one plan. Vote on each candidate.",
    "",
    briefBlock(brief),
    "",
    ...candidates.map((candidate, index) =>
      [
        `CANDIDATE ${index + 1} — planHash ${candidate.hash} (merged by ${candidate.proposedBy}):`,
        JSON.stringify(candidate.plan, null, 2),
        "",
      ].join("\n"),
    ),
    "Vote `agree` on every candidate you could genuinely build and defend, even",
    "if it is not your favourite. Vote `disagree` only where you would refuse to",
    "ship the result, and say in one sentence what would change your vote.",
    "A candidate every seat agrees on is what gets built.",
  ].join("\n");
}

export function implementPrompt(brief: Brief, unit: WorkUnit, plan: Plan, peerUnits: readonly WorkUnit[]): string {
  return [
    `Implement your work unit. You are working in your own git worktree on branch ${unit.branch}.`,
    "Your peer is implementing other units in a separate worktree at the same",
    "time, so stay inside your own files and do not 'fix' theirs.",
    "",
    `UNIT ${unit.id}: ${unit.title}`,
    unit.detail,
    unit.files.length ? `Expected files: ${unit.files.join(", ")}` : "",
    "",
    peerUnits.length
      ? `Your peer owns (do not touch): ${peerUnits.map((u) => `${u.id} (${u.files.join(", ") || "n/a"})`).join("; ")}`
      : "",
    "",
    "The agreed plan, for context:",
    JSON.stringify(plan, null, 2),
    "",
    briefBlock(brief),
    "",
    "Write the code. Then run the relevant checks yourself and report exactly",
    "what they printed in `selfCheck` — a claim that tests pass when you did not",
    "run them is the worst thing you can put in the ledger. If something is",
    "genuinely blocked, put it in `unresolved` rather than faking it.",
    "If you need your peer's input, call the council MCP tool `ask_peer`.",
  ].join("\n");
}

export function reviewPrompt(
  brief: Brief,
  unit: WorkUnit,
  diff: { files: readonly string[]; patch: string; truncated: boolean },
  implementerNote: string,
): string {
  return [
    `Review your peer's diff for unit ${unit.id} (${unit.title}). You did not write it.`,
    "This is a read-only turn: you cannot change the code, only judge it.",
    "",
    briefBlock(brief),
    "",
    `The implementer reported: ${implementerNote || "(nothing)"}`,
    "",
    `FILES: ${diff.files.join(", ") || "(none)"}`,
    diff.truncated ? "(diff truncated — judge what you can see and say so)" : "",
    "",
    "```diff",
    diff.patch || "(empty diff)",
    "```",
    "",
    "Return `request_changes` only for findings you can show a path to, or for",
    "work that does not do what the unit asked. An empty diff when the unit",
    "asked for code is itself a blocker. Nits do not block.",
  ].join("\n");
}

export function fixPrompt(unit: WorkUnit, findings: readonly Finding[], reviewer: string): string {
  return [
    `Your peer (${reviewer}) reviewed unit ${unit.id} and asked for changes.`,
    "",
    ...findings.map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.claim}\n   evidence: ${finding.evidence}\n   suggested fix: ${finding.fix}${finding.file ? `\n   file: ${finding.file}` : ""}`,
    ),
    "",
    "Fix every blocker and major. For anything you are not fixing, say why in",
    "`unresolved` — a reviewer's finding you disagree with is a legitimate",
    "outcome, as long as you argue it instead of ignoring it.",
    "Re-run your checks and report what they printed.",
  ].join("\n");
}

export function judgePrompt(
  brief: Brief,
  candidates: readonly { hash: string; plan: Plan; proposedBy: string }[],
  positions: Readonly<Record<string, string>>,
): string {
  return [
    "The council deadlocked. You are the tie-breaker. Pick exactly one",
    "candidate planHash and justify it in two sentences.",
    "",
    briefBlock(brief),
    "",
    "POSITIONS:",
    ...Object.entries(positions).map(([agent, text]) => `- ${agent}: ${text}`),
    "",
    ...candidates.map((c) => `CANDIDATE ${c.hash} (by ${c.proposedBy}):\n${JSON.stringify(c.plan, null, 2)}\n`),
  ].join("\n");
}

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["planHash", "rationale"],
  properties: {
    planHash: { type: "string" },
    rationale: { type: "string" },
  },
};
