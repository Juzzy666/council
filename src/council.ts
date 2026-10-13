/**
 * The council engine.
 *
 * One task walks one path: brief → independent plans → cross-critique →
 * unanimous vote → split into units → parallel implementation in isolated
 * worktrees → cross-review → the repo's own checks → integration merge.
 *
 * Three properties the design protects:
 *
 *  - **Independence before agreement.** Plans are produced in parallel with
 *    neither seat able to see the other's. Agreement after that means
 *    something; agreement reached by reading each other first does not.
 *  - **Nobody reviews their own work.** A unit's reviewer is never its owner,
 *    and review turns run read-only so a reviewer cannot quietly fix what it
 *    is judging.
 *  - **The repository casts the deciding vote.** Two agents endorsing each
 *    other is not evidence; `npm test` passing on the merged result is.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { AgentAdapter, AgentRequest, McpWiring } from "./adapters/types.js";
import type { CouncilConfig } from "./config.js";
import { allPassed, detectChecks, runChecks } from "./checks.js";
import {
  assignUnits,
  dedupeCandidates,
  hasBlockers,
  planHash,
  resolveConvergence,
  toCandidate,
  type Candidate,
} from "./consensus.js";
import {
  addWorktree,
  assertRepo,
  commitAll,
  currentBranch,
  diffAgainst,
  git,
  integrate,
  isDirty,
  resolveRef,
} from "./git.js";
import { Ledger, ledgerPath } from "./ledger.js";
import {
  CRITIQUE_SCHEMA,
  IMPLEMENTATION_SCHEMA,
  JUDGE_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  VOTE_SCHEMA,
  critiquePrompt,
  fixPrompt,
  implementPrompt,
  judgePrompt,
  planPrompt,
  reviewPrompt,
  seatSystemPrompt,
  votePrompt,
} from "./prompts.js";
import type {
  AgentId,
  Brief,
  Critique,
  Finding,
  LedgerEvent,
  LedgerEventType,
  Phase,
  Plan,
  Review,
  TaskState,
  Vote,
  WorkUnit,
} from "./protocol.js";

export interface BriefInput {
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly acceptance?: readonly string[];
  readonly taskId?: string;
}

export interface CouncilOptions {
  readonly config: CouncilConfig;
  /** The seats, in table order. Two is the designed case; one degrades honestly. */
  readonly adapters: readonly AgentAdapter[];
  /** Progress callback — the CLI renders from this. */
  readonly onEvent?: (event: LedgerEvent) => void;
  /** Stop after the plan is agreed. Nothing is written to the repo. */
  readonly planOnly?: boolean;
}

/** Where the MCP peer-channel entry point lives, relative to this module. */
export function defaultMcpServerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "mcp", "server.js");
}

const PEER_TOOLS = [
  "read_ledger",
  "post_note",
  "ask_peer",
  "request_real_world_action",
  "flag_blocker",
];

export class Council {
  readonly #config: CouncilConfig;
  readonly #adapters: readonly AgentAdapter[];
  readonly #ledger: Ledger;
  readonly #onEvent: (event: LedgerEvent) => void;
  readonly #planOnly: boolean;
  #state!: TaskState;

  constructor(options: CouncilOptions) {
    this.#config = options.config;
    this.#adapters = options.adapters;
    this.#ledger = new Ledger(ledgerPath(options.config.councilHome));
    this.#onEvent = options.onEvent ?? (() => {});
    this.#planOnly = options.planOnly ?? false;
  }

  get seats(): AgentId[] {
    return this.#adapters.map((adapter) => adapter.id);
  }

  async run(input: BriefInput): Promise<TaskState> {
    await assertRepo(this.#config.repoRoot);
    await ensureCouncilHome(this.#config.councilHome);
    await this.#ledger.load();

    const baseRef = this.#config.baseRef === "HEAD" ? await currentBranch(this.#config.repoRoot) : this.#config.baseRef;
    const baseSha = await resolveRef(this.#config.repoRoot, this.#config.baseRef);
    const brief: Brief = {
      taskId: input.taskId ?? `t_${Date.now().toString(36)}`,
      goal: input.goal.trim(),
      constraints: input.constraints ?? [],
      acceptance: input.acceptance ?? [],
      repoRoot: this.#config.repoRoot,
      baseRef,
      createdAt: new Date().toISOString(),
    };

    this.#state = {
      brief,
      phase: "briefing",
      plans: {},
      critiques: [],
      votes: [],
      units: [],
      reviews: [],
      checks: [],
      actionRequests: [],
      spendUsd: {},
      rounds: { critique: 0, review: 0 },
      startedAt: brief.createdAt,
    };

    await this.#record("engine", "task_opened", {
      brief,
      baseSha,
      seats: this.seats,
      planOnly: this.#planOnly,
    });

    if (await isDirty(this.#config.repoRoot)) {
      await this.#record("engine", "note", {
        text:
          "The repository has uncommitted changes. Seats work in separate " +
          "worktrees cut from the base ref, so those changes are neither used " +
          "nor touched.",
      });
    }

    try {
      const plan = await this.#agreeOnPlan();
      if (!plan) return this.#close(this.#state.phase === "escalated" ? "escalated" : "failed");
      if (this.#planOnly) return this.#close("done");

      const ok = await this.#build(plan, baseSha);
      if (!ok) return this.#close(this.#state.phase === "escalated" ? "escalated" : "failed");

      return this.#close("done");
    } catch (error) {
      await this.#record("engine", "agent_error", {
        fatal: true,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      return this.#close("failed");
    } finally {
      for (const adapter of this.#adapters) await adapter.dispose?.();
    }
  }

  // ---------------------------------------------------------------- planning

  async #agreeOnPlan(): Promise<Plan | null> {
    await this.#enter("planning");
    const plans = await this.#collectPlans();
    if (plans.length === 0) {
      await this.#record("engine", "note", { text: "No seat produced a usable plan." });
      return null;
    }

    if (plans.length === 1 || this.#adapters.length === 1) {
      const only = plans[0]!;
      await this.#record("engine", "note", {
        text:
          `Only one seat (${only.agent}) produced a plan, so there is no council ` +
          "to convene. Running single-seat: no cross-critique, no cross-review.",
        degraded: true,
      });
      await this.#record("engine", "plan_agreed", { plan: only, planHash: planHash(only), unanimous: false });
      this.#state.agreedPlan = only;
      this.#state.agreedPlanHash = planHash(only);
      return only;
    }

    let candidates: Candidate[] = [];
    for (let round = 1; round <= Math.max(1, this.#config.limits.critiqueRounds); round += 1) {
      await this.#enter("critique");
      const critiques = await this.#collectCritiques(plans, round);
      candidates = dedupeCandidates([
        ...critiques.flatMap((critique) =>
          critique.mergedPlan ? [toCandidate(critique.mergedPlan, critique.agent)] : [],
        ),
        // The originals stay on the ballot: if both seats' merged plans are
        // worse than a plan already on the table, the table should be able to
        // pick it.
        ...plans.map((plan) => toCandidate(plan, plan.agent)),
      ]);

      await this.#enter("convergence");
      const votes = await this.#collectVotes(candidates, round);
      const outcome = resolveConvergence(this.seats, candidates, votes);

      if (outcome.kind === "agreed") {
        await this.#record("engine", "plan_agreed", {
          plan: outcome.candidate.plan,
          planHash: outcome.candidate.hash,
          proposedBy: outcome.candidate.proposedBy,
          unanimous: true,
          round,
        });
        this.#state.agreedPlan = outcome.candidate.plan;
        this.#state.agreedPlanHash = outcome.candidate.hash;
        return outcome.candidate.plan;
      }

      await this.#record("engine", "note", {
        text: `Round ${round} ended in deadlock.`,
        positions: outcome.positions,
      });
      if (round === Math.max(1, this.#config.limits.critiqueRounds)) {
        return this.#breakTie(candidates, outcome.positions);
      }
    }
    return null;
  }

  async #collectPlans(): Promise<Plan[]> {
    const results = await Promise.all(
      this.#adapters.map(async (adapter) => {
        const result = await this.#ask(adapter, {
          prompt: planPrompt(this.#state.brief),
          systemPrompt: this.#seatSystem(adapter),
          workspace: this.#config.repoRoot,
          jsonSchema: PLAN_SCHEMA,
          allowWrites: false,
        });
        if (!result.ok || !result.json) return null;
        const plan = coercePlan(result.json, adapter.id);
        if (!plan) {
          await this.#record(adapter.id, "agent_error", {
            phase: "planning",
            error: "reply did not match the plan schema",
            textHead: result.text.slice(0, 400),
          });
          return null;
        }
        await this.#record(adapter.id, "plan_submitted", { plan });
        this.#state.plans[adapter.id] = plan;
        return plan;
      }),
    );
    return results.filter((plan): plan is Plan => plan !== null);
  }

  async #collectCritiques(plans: readonly Plan[], round: number): Promise<Critique[]> {
    const results = await Promise.all(
      this.#adapters.map(async (adapter) => {
        const own = plans.find((plan) => plan.agent === adapter.id);
        const peer = plans.find((plan) => plan.agent !== adapter.id);
        if (!own || !peer) return null;
        const result = await this.#ask(adapter, {
          prompt: critiquePrompt(this.#state.brief, own, peer),
          systemPrompt: this.#seatSystem(adapter),
          workspace: this.#config.repoRoot,
          jsonSchema: CRITIQUE_SCHEMA,
          allowWrites: false,
        });
        if (!result.ok || !result.json) return null;
        const body = result.json as {
          verdict?: string;
          findings?: Finding[];
          mergedPlan?: unknown;
        };
        const merged = body.mergedPlan ? coercePlan(body.mergedPlan, adapter.id) : undefined;
        const critique: Critique = {
          agent: adapter.id,
          targetAgent: peer.agent,
          verdict:
            body.verdict === "endorse" || body.verdict === "revise" || body.verdict === "reject"
              ? body.verdict
              : "revise",
          findings: Array.isArray(body.findings) ? body.findings : [],
          ...(merged ? { mergedPlan: merged } : {}),
        };
        this.#state.critiques.push(critique);
        await this.#record(adapter.id, "critique_submitted", { critique, round });
        return critique;
      }),
    );
    return results.filter((critique): critique is Critique => critique !== null);
  }

  async #collectVotes(candidates: readonly Candidate[], round: number): Promise<Vote[]> {
    const nested = await Promise.all(
      this.#adapters.map(async (adapter) => {
        const result = await this.#ask(adapter, {
          prompt: votePrompt(this.#state.brief, candidates),
          systemPrompt: this.#seatSystem(adapter),
          workspace: this.#config.repoRoot,
          jsonSchema: VOTE_SCHEMA,
          allowWrites: false,
        });
        const body = result.json as { votes?: { planHash?: string; position?: string; rationale?: string }[] };
        const votes: Vote[] = [];
        for (const raw of body?.votes ?? []) {
          // A vote on a hash nobody proposed cannot bind anything.
          if (!raw.planHash || !candidates.some((c) => c.hash === raw.planHash)) continue;
          const vote: Vote = {
            agent: adapter.id,
            position: raw.position === "agree" ? "agree" : "disagree",
            rationale: (raw.rationale ?? "").trim(),
            planHash: raw.planHash,
          };
          votes.push(vote);
          this.#state.votes.push(vote);
          await this.#record(adapter.id, "vote_cast", { vote, round });
        }
        return votes;
      }),
    );
    return nested.flat();
  }

  async #breakTie(
    candidates: readonly Candidate[],
    positions: Readonly<Record<AgentId, string>>,
  ): Promise<Plan | null> {
    if (this.#config.tiebreak === "human" || candidates.length === 0) {
      await this.#escalate(
        "The seats could not agree on a plan.",
        "convergence",
        positions,
        "Pick a plan (council replay <task> shows both), or restate the goal and run again.",
      );
      return null;
    }
    const judge = this.#adapters.find((adapter) => adapter.id === this.#config.judgeSeat) ?? this.#adapters[0]!;
    const result = await this.#ask(judge, {
      prompt: judgePrompt(this.#state.brief, candidates, positions),
      systemPrompt: `You are the council's tie-breaker. ${seatSystemPrompt(judge.label, "the other seat")}`,
      workspace: this.#config.repoRoot,
      jsonSchema: JUDGE_SCHEMA,
      allowWrites: false,
    });
    const picked = (result.json as { planHash?: string } | undefined)?.planHash;
    const winner = candidates.find((candidate) => candidate.hash === picked);
    if (!winner) {
      await this.#escalate(
        "The tie-breaker did not pick a candidate on the ballot.",
        "convergence",
        positions,
        "Decide between the candidate plans yourself, or re-run with a clearer brief.",
      );
      return null;
    }
    await this.#record("engine", "plan_agreed", {
      plan: winner.plan,
      planHash: winner.hash,
      proposedBy: winner.proposedBy,
      unanimous: false,
      tiebreakBy: judge.id,
    });
    this.#state.agreedPlan = winner.plan;
    this.#state.agreedPlanHash = winner.hash;
    return winner.plan;
  }

  // ---------------------------------------------------------- implementation

  async #build(plan: Plan, baseSha: string): Promise<boolean> {
    await this.#enter("implementation");
    const assignment = assignUnits(plan, this.seats);
    const worktrees = new Map<AgentId, string>();

    for (const adapter of this.#adapters) {
      const owns = assignment.some((entry) => entry.owner === adapter.id);
      if (!owns) continue;
      const path = join(this.#config.councilHome, "worktrees", this.#state.brief.taskId, adapter.id);
      const branch = `council/${this.#state.brief.taskId}/${adapter.id}`;
      await addWorktree(this.#config.repoRoot, path, branch, baseSha);
      worktrees.set(adapter.id, path);
    }

    for (const entry of assignment) {
      const step = plan.steps.find((candidate) => candidate.id === entry.stepId);
      if (!step) continue;
      const unit: WorkUnit = {
        id: step.id,
        title: step.title,
        detail: step.detail,
        files: step.files,
        owner: entry.owner,
        status: "claimed",
        branch: `council/${this.#state.brief.taskId}/${entry.owner}`,
        worktree: worktrees.get(entry.owner),
        commits: [],
        reviewRounds: 0,
      };
      this.#state.units.push(unit);
      await this.#record("engine", "unit_created", { unit });
    }

    // Seats build in parallel; a single seat builds its own units in order, so
    // one worktree is never written by two turns at once.
    const notes = new Map<string, string>();
    await Promise.all(
      this.#adapters.map(async (adapter) => {
        const mine = this.#state.units.filter((unit) => unit.owner === adapter.id);
        for (const unit of mine) {
          const peerUnits = this.#state.units.filter((other) => other.owner !== adapter.id);
          const before = await this.#headSha(unit.worktree!);
          const result = await this.#ask(adapter, {
            prompt: implementPrompt(this.#state.brief, unit, plan, peerUnits),
            systemPrompt: this.#seatSystem(adapter),
            workspace: unit.worktree!,
            jsonSchema: IMPLEMENTATION_SCHEMA,
            allowWrites: true,
            readDirs: [this.#config.repoRoot],
            mcp: this.#mcpFor(adapter.id),
            sessionKey: `${this.#state.brief.taskId}-${adapter.id}`,
          });
          const note = (result.json as { summary?: string } | undefined)?.summary ?? result.text;
          notes.set(unit.id, note.slice(0, 2_000));

          const sha = await commitAll(
            unit.worktree!,
            `council(${unit.id}): ${unit.title}\n\nSeat: ${adapter.label}\nTask: ${this.#state.brief.taskId}`,
          );
          // A turn that failed AND produced no commit did not implement
          // anything. Recording it as "implemented" would send an empty diff
          // to review and let the run limp on to a merge of nothing — which is
          // exactly what a broken `--session-id` did on the first real run.
          unit.status = result.ok || sha !== null ? "implemented" : "abandoned";
          unit.commits = sha ? [...(unit.commits ?? []), sha] : unit.commits;
          await this.#record(adapter.id, "unit_implemented", {
            unitId: unit.id,
            status: unit.status,
            branch: unit.branch,
            worktree: unit.worktree,
            commits: unit.commits,
            baseline: before,
            emptyDiff: sha === null,
            agentOk: result.ok,
            unresolved: (result.json as { unresolved?: string[] } | undefined)?.unresolved ?? [],
            selfCheck: (result.json as { selfCheck?: string } | undefined)?.selfCheck ?? "",
          });
          (unit as WorkUnit & { baseline?: string }).baseline = before;
        }
      }),
    );

    const abandoned = this.#state.units.filter((unit) => unit.status === "abandoned");
    if (abandoned.length > 0) {
      await this.#escalate(
        `${abandoned.length} of ${this.#state.units.length} unit(s) produced nothing: the seat's turn failed and left no commit.`,
        "implementation",
        Object.fromEntries(
          abandoned.map((unit) => [unit.owner, `${unit.id}: no commit, no diff — see the agent_error events in the ledger`]),
        ),
        "Run `council replay <task>` and look at the agent_error events; the seat's runtime, not the plan, is what failed.",
      );
      return false;
    }

    const reviewed = await this.#reviewLoop(plan, notes);
    if (!reviewed) return false;

    await this.#enter("verification");
    const commands = await this.#checkCommands(plan);
    // Per-seat checks are ADVISORY and never gate the run: a seat's worktree
    // holds only its own half of the plan, so a suite that needs both halves is
    // expected to fail here and pass after the merge. They are still worth
    // running — a seat whose own unit breaks the build shows up before
    // integration instead of inside a conflict.
    for (const [seat, worktree] of worktrees) {
      const results = await runChecks(commands, worktree);
      for (const result of results) {
        this.#state.checks.push(result);
        await this.#record(seat, "check_run", { result, scope: "seat-worktree", advisory: true });
      }
    }

    return this.#integrate(baseSha, [...worktrees.keys()], commands);
  }

  async #reviewLoop(plan: Plan, notes: Map<string, string>): Promise<boolean> {
    if (this.#adapters.length < 2) {
      await this.#record("engine", "note", {
        text: "Single seat: no cross-review is possible, so none was performed.",
        degraded: true,
      });
      return true;
    }

    for (let round = 1; round <= Math.max(1, this.#config.limits.reviewRounds); round += 1) {
      await this.#enter("review");
      const pending = this.#state.units.filter(
        (unit) => unit.status === "implemented" || unit.status === "changes_requested",
      );
      if (pending.length === 0) return true;

      const blocked: { unit: WorkUnit; review: Review }[] = [];
      for (const unit of pending) {
        const reviewer = this.#adapters.find((adapter) => adapter.id !== unit.owner);
        if (!reviewer) continue;
        const baseline = (unit as WorkUnit & { baseline?: string }).baseline;
        const diff = await diffAgainst(unit.worktree!, baseline ?? this.#state.brief.baseRef);
        const result = await this.#ask(reviewer, {
          prompt: reviewPrompt(this.#state.brief, unit, diff, notes.get(unit.id) ?? ""),
          systemPrompt: this.#seatSystem(reviewer),
          // Reviews read the owner's worktree from the repo root: a read-only
          // turn with no write path into what it is judging.
          workspace: this.#config.repoRoot,
          readDirs: [unit.worktree!],
          jsonSchema: REVIEW_SCHEMA,
          allowWrites: false,
        });
        const body = result.json as { verdict?: string; summary?: string; findings?: Finding[] } | undefined;
        const review: Review = {
          agent: reviewer.id,
          unitId: unit.id,
          verdict: body?.verdict === "approve" ? "approve" : "request_changes",
          findings: Array.isArray(body?.findings) ? body!.findings! : [],
          summary: (body?.summary ?? result.text).slice(0, 2_000),
        };
        this.#state.reviews.push(review);
        unit.reviewRounds = (unit.reviewRounds ?? 0) + 1;
        await this.#record(reviewer.id, "review_submitted", { review, round });

        if (review.verdict === "approve" || !hasBlockers(review.findings)) {
          unit.status = "approved";
          continue;
        }
        unit.status = "changes_requested";
        blocked.push({ unit, review });
      }

      if (blocked.length === 0) return true;

      if (round === Math.max(1, this.#config.limits.reviewRounds)) {
        await this.#escalate(
          `${blocked.length} unit(s) still have blocking findings after ${round} review round(s).`,
          "review",
          Object.fromEntries(
            blocked.map(({ unit, review }) => [
              review.agent,
              `${unit.id}: ${review.findings.map((f) => f.claim).join("; ")}`,
            ]),
          ),
          "Read the findings in the ledger and decide: fix them yourself, or re-run with a narrower brief.",
        );
        return false;
      }

      await this.#enter("implementation");
      for (const { unit, review } of blocked) {
        const owner = this.#adapters.find((adapter) => adapter.id === unit.owner);
        if (!owner) continue;
        await this.#record("engine", "fix_requested", {
          unitId: unit.id,
          reviewer: review.agent,
          findings: review.findings,
          round,
        });
        const before = await this.#headSha(unit.worktree!);
        const result = await this.#ask(owner, {
          prompt: fixPrompt(unit, review.findings, review.agent),
          systemPrompt: this.#seatSystem(owner),
          workspace: unit.worktree!,
          jsonSchema: IMPLEMENTATION_SCHEMA,
          allowWrites: true,
          readDirs: [this.#config.repoRoot],
          mcp: this.#mcpFor(owner.id),
          sessionKey: `${this.#state.brief.taskId}-${owner.id}`,
        });
        notes.set(unit.id, ((result.json as { summary?: string } | undefined)?.summary ?? result.text).slice(0, 2_000));
        const sha = await commitAll(unit.worktree!, `council(${unit.id}): address review from ${review.agent}`);
        unit.status = result.ok || sha !== null ? "implemented" : "changes_requested";
        if (sha) unit.commits = [...(unit.commits ?? []), sha];
        (unit as WorkUnit & { baseline?: string }).baseline = before;
        await this.#record(owner.id, "unit_implemented", {
          unitId: unit.id,
          status: "implemented",
          commits: unit.commits,
          baseline: before,
          emptyDiff: sha === null,
          fixRound: round,
        });
      }
    }
    return true;
  }

  async #integrate(baseSha: string, seats: readonly AgentId[], commands: readonly string[]): Promise<boolean> {
    await this.#enter("integration");
    const branches = seats.map((seat) => `council/${this.#state.brief.taskId}/${seat}`);
    const branch = `council/${this.#state.brief.taskId}/integration`;
    const path = join(this.#config.councilHome, "worktrees", this.#state.brief.taskId, "integration");
    const report = await integrate(this.#config.repoRoot, path, branch, baseSha, branches);

    if (report.conflicts.length > 0) {
      await this.#record("engine", "integration_result", {
        branch,
        merged: report.merged,
        conflicts: report.conflicts,
        ok: false,
      });
      await this.#escalate(
        "The seats' branches conflict with each other.",
        "integration",
        Object.fromEntries(
          report.conflicts.map((conflict) => [conflict.branch, `conflicting files: ${conflict.files.join(", ")}`]),
        ),
        `Resolve the merge in ${path}, or re-run so the plan splits the files differently.`,
      );
      return false;
    }

    if (commands.length === 0 && this.#config.requireChecks) {
      // `allPassed([])` is true, so without this a repo that declares no checks
      // would reach `done` having verified nothing at all.
      await this.#record("engine", "integration_result", {
        branch,
        merged: report.merged,
        conflicts: [],
        worktree: report.worktree,
        checksPassed: false,
        ok: false,
        reason: "no objective gate",
      });
      this.#state.integrationBranch = branch;
      await this.#escalate(
        "The seats agreed and the branches merged cleanly, but this repository " +
          "declares no checks, so nothing verified the result.",
        "verification",
        Object.fromEntries(seats.map((seat) => [seat, "agreed; unverified by anything but the other seat"])),
        `Review ${branch} yourself, add a test command to council.config.json \`checks\`, ` +
          "or set `requireChecks: false` to accept agreement alone as the bar.",
      );
      return false;
    }

    const results = await runChecks(commands, report.worktree);
    for (const result of results) {
      this.#state.checks.push(result);
      await this.#record("engine", "check_run", { result, scope: "integration" });
    }
    const passed = allPassed(results);
    this.#state.integrationBranch = branch;
    await this.#record("engine", "integration_result", {
      branch,
      merged: report.merged,
      conflicts: [],
      worktree: report.worktree,
      checksPassed: passed,
      ok: passed,
    });

    if (!passed) {
      await this.#escalate(
        "The merged result does not pass the repository's own checks.",
        "verification",
        Object.fromEntries(
          results.filter((r) => !r.ok).map((r) => [r.command, r.outputTail.slice(-600)]),
        ),
        `Inspect ${report.worktree}; the integration branch ${branch} holds the merge.`,
      );
      return false;
    }

    if (this.#config.push) {
      const push = await git(report.worktree, ["push", "-u", "origin", branch], 300_000);
      await this.#record("engine", "note", {
        text: push.ok ? `pushed ${branch}` : `push failed: ${push.stderr.slice(-500)}`,
      });
    }
    return true;
  }

  // --------------------------------------------------------------- utilities

  async #checkCommands(plan: Plan): Promise<string[]> {
    if (this.#config.checks.length > 0) return [...this.#config.checks];
    const detected = await detectChecks(this.#config.repoRoot);
    if (detected.length > 0) return detected;
    // Last resort: what the council itself said would prove the work. Recorded
    // as such, because an agent-authored check command is weaker evidence than
    // one the repo already shipped.
    if (plan.acceptanceChecks.length > 0) {
      await this.#record("engine", "note", {
        text: "No repo checks detected; running the council's own acceptanceChecks instead.",
        commands: plan.acceptanceChecks,
      });
      return [...plan.acceptanceChecks];
    }
    await this.#record("engine", "note", {
      text: "No checks to run: the repository declares none and the plan proposed none.",
    });
    return [];
  }

  async #headSha(worktree: string): Promise<string> {
    const outcome = await git(worktree, ["rev-parse", "HEAD"]);
    return outcome.stdout.trim();
  }

  #seatSystem(adapter: AgentAdapter): string {
    const peer = this.#adapters.find((other) => other.id !== adapter.id);
    return seatSystemPrompt(adapter.label, peer?.label ?? "no peer (single-seat run)");
  }

  #mcpFor(seat: AgentId): McpWiring | undefined {
    const peer = this.#adapters.find((adapter) => adapter.id !== seat);
    if (!peer) return undefined;
    return {
      serverPath: defaultMcpServerPath(),
      env: {
        COUNCIL_REPO_ROOT: this.#config.repoRoot,
        COUNCIL_HOME: this.#config.councilHome,
        COUNCIL_TASK_ID: this.#state.brief.taskId,
        COUNCIL_SELF: seat,
        COUNCIL_PEER: peer.id,
        COUNCIL_PEER_DEPTH: String(this.#config.limits.peerDepth),
      },
      toolNames: PEER_TOOLS,
    };
  }

  /** One agent turn, with the budget guard and the ledger bookkeeping around it. */
  async #ask(adapter: AgentAdapter, request: AgentRequest) {
    const spent = Object.values(this.#state.spendUsd).reduce((sum, value) => sum + value, 0);
    if (spent >= this.#config.budget.perTaskUsd) {
      await this.#record("engine", "note", {
        text: `Budget ceiling reached ($${spent.toFixed(2)} of $${this.#config.budget.perTaskUsd}); refusing further turns.`,
      });
      return { ok: false, text: "", durationMs: 0, error: "budget exhausted" };
    }

    const result = await adapter.run({
      ...request,
      budgetUsd: request.budgetUsd ?? this.#config.budget.perTurnUsd,
      timeoutMs: request.timeoutMs ?? this.#config.limits.turnTimeoutMs,
    });

    if (typeof result.costUsd === "number" && result.costUsd > 0) {
      this.#state.spendUsd[adapter.id] = (this.#state.spendUsd[adapter.id] ?? 0) + result.costUsd;
      await this.#record(adapter.id, "spend", { agent: adapter.id, usd: result.costUsd });
    }
    if (!result.ok) {
      await this.#record(adapter.id, "agent_error", {
        error: result.error ?? "unknown failure",
        meta: result.meta,
        textHead: result.text.slice(0, 400),
      });
    }
    return result;
  }

  async #enter(phase: Phase): Promise<void> {
    if (this.#state.phase === phase) return;
    this.#state.phase = phase;
    await this.#record("engine", "phase_entered", { phase });
  }

  async #escalate(
    reason: string,
    phase: Phase,
    positions: Readonly<Record<string, string>>,
    question: string,
  ): Promise<void> {
    this.#state.escalation = { reason, phase, positions, question };
    this.#state.phase = "escalated";
    await this.#record("engine", "escalated", { escalation: this.#state.escalation });
  }

  async #close(phase: Phase): Promise<TaskState> {
    this.#state.phase = phase;
    this.#state.endedAt = new Date().toISOString();
    await this.#record("engine", "task_closed", {
      phase,
      spendUsd: this.#state.spendUsd,
      integrationBranch: this.#state.integrationBranch,
    });
    return this.#state;
  }

  async #record(actor: string, type: LedgerEventType, payload: unknown): Promise<void> {
    const event = await this.#ledger.append({
      taskId: this.#state.brief.taskId,
      actor,
      type,
      payload,
    });
    this.#onEvent(event);
  }
}

/** Validate an agent's JSON into a Plan, or reject it. Nothing is invented here. */
export function coercePlan(value: unknown, agent: AgentId): Plan | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const rawSteps = Array.isArray(body["steps"]) ? body["steps"] : [];
  const steps = rawSteps
    .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object")
    .map((step, index) => ({
      id: String(step["id"] ?? `step-${index + 1}`).trim() || `step-${index + 1}`,
      title: String(step["title"] ?? "").trim(),
      detail: String(step["detail"] ?? "").trim(),
      files: Array.isArray(step["files"]) ? step["files"].map((file) => String(file)) : [],
      risk:
        step["risk"] === "high" || step["risk"] === "medium" || step["risk"] === "low"
          ? (step["risk"] as "high" | "medium" | "low")
          : "medium",
      ...(typeof step["suggestedOwner"] === "string" ? { suggestedOwner: step["suggestedOwner"] } : {}),
    }))
    .filter((step) => step.title.length > 0);

  if (steps.length === 0) return null;
  // Duplicate ids would make unit assignment ambiguous.
  const seen = new Set<string>();
  const unique = steps.map((step) => {
    let id = step.id;
    let suffix = 2;
    while (seen.has(id)) id = `${step.id}-${suffix++}`;
    seen.add(id);
    return { ...step, id };
  });

  return {
    agent,
    summary: String(body["summary"] ?? "").trim(),
    steps: unique,
    risks: Array.isArray(body["risks"]) ? body["risks"].map((risk) => String(risk)) : [],
    acceptanceChecks: Array.isArray(body["acceptanceChecks"])
      ? body["acceptanceChecks"].map((check) => String(check))
      : [],
    openQuestions: Array.isArray(body["openQuestions"])
      ? body["openQuestions"].map((question) => String(question))
      : [],
  };
}


/**
 * Create the council home and keep it out of the user's `git status`.
 *
 * The home sits inside the repository by default (that is where the worktrees
 * have to live for `git worktree` to be cheap), so it ships its own
 * `.gitignore` containing `*` — a directory that ignores itself, including the
 * ignore file. Nobody has to edit the repository's own `.gitignore`, and a
 * council run never shows up as untracked noise in the work it is doing.
 */
export async function ensureCouncilHome(councilHome: string): Promise<void> {
  await mkdir(councilHome, { recursive: true });
  const ignore = join(councilHome, ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, "*\n", "utf8");
}
