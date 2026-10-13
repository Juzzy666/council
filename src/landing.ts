/**
 * What happens to finished work when there is no human in the loop.
 *
 * The decision is made from the task's own state, not from how the run felt:
 * a merge needs the phase to be `done`, every unit approved, and a real check
 * to have actually run and passed. Anything short of that gets a pull request
 * and a notification, because the alternative — merging on agreement alone — is
 * the one failure mode an autonomous council cannot recover from by itself.
 */

import type { AutonomyConfig } from "./config.js";
import type { CheckResult, TaskState } from "./protocol.js";

export type LandingAction =
  | { readonly kind: "merge"; readonly why: string }
  | { readonly kind: "pull_request"; readonly draft: boolean; readonly why: string }
  | { readonly kind: "nothing"; readonly why: string };

/** Did a real check run against the integrated result and pass? */
export function integrationVerified(state: TaskState, integrationCwd?: string): boolean {
  const relevant: CheckResult[] = state.checks.filter(
    (check) => !integrationCwd || check.cwd === integrationCwd,
  );
  return relevant.length > 0 && relevant.every((check) => check.ok);
}

export function decideLanding(
  state: TaskState,
  autonomy: AutonomyConfig,
  integrationCwd?: string,
): LandingAction {
  // One helper, so "open a PR unless PRs are off" is expressed once and no
  // branch can return a half-built action.
  const park = (draft: boolean, why: string): LandingAction =>
    autonomy.openPullRequests ? { kind: "pull_request", draft, why } : { kind: "nothing", why };

  if (!state.integrationBranch) {
    return { kind: "nothing", why: "there is no integration branch: nothing was built" };
  }

  if (state.phase !== "done") {
    return park(true, state.escalation?.reason ?? `the run ended in ${state.phase} rather than done`);
  }

  const unitsApproved =
    state.units.length > 0 && state.units.every((unit) => unit.status === "approved");
  if (!unitsApproved) {
    return park(true, "not every unit was approved by the other seat");
  }

  if (!integrationVerified(state, integrationCwd)) {
    // The honest case: the seats agreed, it merged cleanly, and nothing tested
    // it. Mergeable on an explicit opt-in only.
    if (autonomy.mergeWhenGreen && autonomy.mergeWithoutChecks) {
      return { kind: "merge", why: "mergeWithoutChecks is on: merging on agreement alone" };
    }
    return park(false, "no check ran against the merged result, so nothing verified it");
  }

  if (!autonomy.mergeWhenGreen) {
    return park(false, "green and approved, but mergeWhenGreen is off");
  }

  return { kind: "merge", why: "done, every unit approved, and the repository's own checks passed" };
}

/** The pull-request body: what was decided, by whom, and what proved it. */
export function describeRun(state: TaskState, issueUrl?: string): string {
  const lines: string[] = [];
  lines.push(`**Goal.** ${state.brief.goal.split("\n")[0]}`);
  lines.push("");
  if (issueUrl) lines.push(`Task: ${issueUrl}`);
  lines.push(`Task id: \`${state.brief.taskId}\` · phase: **${state.phase}**`);
  lines.push("");

  const seats = Object.keys(state.plans);
  lines.push(
    `**Plan.** ${seats.length} seat(s) planned independently (${seats.join(", ")}); ` +
      `${state.agreedPlanHash ? `agreed on \`${state.agreedPlanHash.slice(0, 12)}\`` : "no plan was agreed"}` +
      `${state.votes.some((vote) => vote.position === "disagree") ? ", after at least one objection" : ""}.`,
  );

  if (state.units.length > 0) {
    lines.push("");
    lines.push("**Work.**");
    lines.push("");
    lines.push("| unit | owner | reviewer | state |");
    lines.push("|---|---|---|---|");
    for (const unit of state.units) {
      const review = state.reviews.findLast((candidate) => candidate.unitId === unit.id);
      lines.push(`| ${unit.id} | ${unit.owner} | ${review?.agent ?? "—"} | ${unit.status} |`);
    }
  }

  const findings = state.reviews.flatMap((review) => review.findings);
  if (findings.length > 0) {
    lines.push("");
    lines.push(`**Review.** ${findings.length} finding(s) raised by the reviewing seat:`);
    lines.push("");
    for (const finding of findings.slice(0, 10)) {
      lines.push(`- \`${finding.severity}\` ${finding.claim}`);
    }
  }

  if (state.checks.length > 0) {
    lines.push("");
    lines.push("**Checks.**");
    lines.push("");
    for (const check of state.checks) {
      lines.push(`- ${check.ok ? "✅" : "❌"} \`${check.command}\``);
    }
  } else {
    lines.push("");
    lines.push("**Checks.** None — this repository declares no check command, so nothing verified this.");
  }

  if (state.escalation) {
    lines.push("");
    lines.push(`**Needs a human.** ${state.escalation.reason}`);
    for (const [agent, position] of Object.entries(state.escalation.positions)) {
      lines.push(`- ${agent}: ${position}`);
    }
    lines.push("");
    lines.push(`→ ${state.escalation.question}`);
  }

  const spend = Object.entries(state.spendUsd);
  if (spend.length > 0) {
    lines.push("");
    lines.push(
      `**Cost.** ${spend.map(([seat, usd]) => `${seat} $${usd.toFixed(4)}`).join(", ")} ` +
        "(the Muse seat reports no cost on the wire and is not included).",
    );
  }

  lines.push("");
  lines.push(`Replay: \`council replay ${state.brief.taskId}\``);
  return lines.join("\n");
}
