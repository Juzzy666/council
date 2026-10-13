/**
 * Consensus: how two independent plans become one the council is bound to.
 *
 * The rule is deliberately dumb and deterministic, because a clever rule is a
 * rule nobody can audit afterwards:
 *
 *  1. Each seat's critique carries the merged plan it would commit to. Those
 *     are the candidates, identified by a content hash.
 *  2. Every seat votes on every candidate.
 *  3. A candidate is *accepted* only if every seat voted `agree` on it.
 *  4. If several are accepted, the lowest hash wins — arbitrary but stable, so
 *     a replay reaches the same plan.
 *  5. Nothing accepted is a deadlock: another round, then the configured
 *     tie-break (a human by default).
 *
 * Unanimity is the bar on purpose. The point of a second seat is the power to
 * refuse, and a majority rule between exactly two voters is just the chair
 * deciding.
 */

import { hashOf } from "./ledger.js";
import type { AgentId, Plan, Vote } from "./protocol.js";

export interface Candidate {
  readonly hash: string;
  readonly plan: Plan;
  readonly proposedBy: AgentId;
}

/**
 * Content hash of a plan, ignoring who wrote it: two seats proposing the same
 * plan must produce the same hash, or step 3 can never be satisfied.
 */
export function planHash(plan: Plan): string {
  return hashOf({
    summary: plan.summary.trim(),
    steps: plan.steps.map((step) => ({
      title: step.title.trim(),
      detail: step.detail.trim(),
      files: [...step.files].map((f) => f.trim()).sort(),
      risk: step.risk,
    })),
    acceptanceChecks: [...plan.acceptanceChecks].map((c) => c.trim()).sort(),
  });
}

export function toCandidate(plan: Plan, proposedBy: AgentId): Candidate {
  return { hash: planHash(plan), plan, proposedBy };
}

/** Deduplicate candidates by hash, keeping the first proposer seen. */
export function dedupeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!seen.has(candidate.hash)) seen.set(candidate.hash, candidate);
  }
  return [...seen.values()];
}

export type Convergence =
  | { readonly kind: "agreed"; readonly candidate: Candidate; readonly unanimous: true }
  | {
      readonly kind: "deadlock";
      /** Per seat, the sharpest objection it raised, for the human or the judge. */
      readonly positions: Readonly<Record<AgentId, string>>;
    };

export function resolveConvergence(
  seats: readonly AgentId[],
  candidates: readonly Candidate[],
  votes: readonly Vote[],
): Convergence {
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    const forCandidate = votes.filter((vote) => vote.planHash === candidate.hash);
    const unanimous =
      seats.length > 0 &&
      seats.every((seat) =>
        forCandidate.some((vote) => vote.agent === seat && vote.position === "agree"),
      );
    if (unanimous) accepted.push(candidate);
  }

  if (accepted.length > 0) {
    const winner = [...accepted].sort((a, b) => (a.hash < b.hash ? -1 : 1))[0]!;
    return { kind: "agreed", candidate: winner, unanimous: true };
  }

  const positions: Record<AgentId, string> = {};
  for (const seat of seats) {
    const objection = votes.find((vote) => vote.agent === seat && vote.position === "disagree");
    positions[seat] =
      objection?.rationale ??
      votes.find((vote) => vote.agent === seat)?.rationale ??
      "cast no vote";
  }
  return { kind: "deadlock", positions };
}

/**
 * Split an agreed plan into units, one owner each.
 *
 * Steps that touch the same file must land with the same seat: two worktrees
 * editing one file is a merge conflict the council manufactured for itself.
 * Otherwise the author's `suggestedOwner` is honoured when it names a real
 * seat, and anything left is dealt round-robin to keep the load even.
 */
export function assignUnits(
  plan: Plan,
  seats: readonly AgentId[],
): { stepId: string; owner: AgentId }[] {
  if (seats.length === 0) return [];
  const groups: { steps: string[]; files: Set<string>; hinted?: AgentId }[] = [];

  for (const step of plan.steps) {
    const files = new Set(step.files.map((file) => file.trim()).filter(Boolean));
    const overlapping = groups.filter(
      (group) => [...files].some((file) => group.files.has(file)),
    );
    if (overlapping.length === 0) {
      groups.push({
        steps: [step.id],
        files,
        ...(step.suggestedOwner && seats.includes(step.suggestedOwner)
          ? { hinted: step.suggestedOwner }
          : {}),
      });
      continue;
    }
    // Fold every overlapping group together with this step: transitive file
    // sharing means they are one unit of ownership.
    const merged = overlapping[0]!;
    for (const other of overlapping.slice(1)) {
      merged.steps.push(...other.steps);
      for (const file of other.files) merged.files.add(file);
      merged.hinted = merged.hinted ?? other.hinted;
      groups.splice(groups.indexOf(other), 1);
    }
    merged.steps.push(step.id);
    for (const file of files) merged.files.add(file);
    if (!merged.hinted && step.suggestedOwner && seats.includes(step.suggestedOwner)) {
      merged.hinted = step.suggestedOwner;
    }
  }

  const load = new Map<AgentId, number>(seats.map((seat) => [seat, 0]));
  const assignment: { stepId: string; owner: AgentId }[] = [];
  // Hinted groups first, so round-robin fills around them instead of fighting them.
  const ordered = [...groups].sort((a, b) => Number(Boolean(b.hinted)) - Number(Boolean(a.hinted)));
  for (const group of ordered) {
    const owner =
      group.hinted ??
      [...load.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    load.set(owner, (load.get(owner) ?? 0) + group.steps.length);
    for (const stepId of group.steps) assignment.push({ stepId, owner });
  }
  // Preserve the plan's own step order; ownership does not reorder the work.
  const order = new Map(plan.steps.map((step, index) => [step.id, index]));
  return assignment.sort((a, b) => (order.get(a.stepId) ?? 0) - (order.get(b.stepId) ?? 0));
}

export function hasBlockers(findings: readonly { severity: string }[]): boolean {
  return findings.some((f) => f.severity === "blocker" || f.severity === "major");
}
