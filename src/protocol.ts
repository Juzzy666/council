/**
 * The council protocol: the vocabulary both agents speak.
 *
 * Nothing here knows how to talk to Claude Code or Muse. These are the shapes
 * the engine folds, the ledger records, and the MCP peer channel serves — so a
 * run can be replayed and audited without either agent present.
 */

/** Stable identity of a seat at the table. */
export type AgentId = string;

export const CLAUDE: AgentId = "claude";
export const MUSE: AgentId = "muse";

/** The phases a task walks, in order. A run never skips backwards except into `escalated`. */
export const PHASES = [
  "briefing",
  "planning",
  "critique",
  "convergence",
  "implementation",
  "review",
  "verification",
  "integration",
  "done",
  "escalated",
  "failed",
] as const;

export type Phase = (typeof PHASES)[number];

/** Terminal phases: the engine stops here. */
export const TERMINAL_PHASES: readonly Phase[] = ["done", "escalated", "failed"];

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** What the council was asked to do, normalized once so both agents read the same words. */
export interface Brief {
  readonly taskId: string;
  readonly goal: string;
  /** Hard limits the plan may not trade away (style rules, "don't touch the schema", etc.). */
  readonly constraints: readonly string[];
  /** How we will know it worked. Commands preferred; prose allowed. */
  readonly acceptance: readonly string[];
  /** Absolute path of the repository the work happens in. */
  readonly repoRoot: string;
  /** Git ref the work branches from. */
  readonly baseRef: string;
  readonly createdAt: string;
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Files the step expects to touch. Used to detect collisions between seats. */
  readonly files: readonly string[];
  readonly risk: "low" | "medium" | "high";
  /** Which seat the author thinks should own it. Advisory — the engine assigns. */
  readonly suggestedOwner?: AgentId;
}

/** One agent's independent proposal. Produced with no sight of the peer's plan. */
export interface Plan {
  readonly agent: AgentId;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
  readonly risks: readonly string[];
  /** Commands the agent wants run to prove the work. */
  readonly acceptanceChecks: readonly string[];
  readonly openQuestions: readonly string[];
}

export type Severity = "blocker" | "major" | "minor" | "nit";

export interface Finding {
  readonly severity: Severity;
  /** What is wrong, in one sentence. */
  readonly claim: string;
  /** Why it is wrong — a path a reader can follow, not an assertion. */
  readonly evidence: string;
  /** What to do instead. */
  readonly fix: string;
  readonly file?: string;
}

export type CritiqueVerdict = "endorse" | "revise" | "reject";

/** One agent's reading of the peer's plan, plus the merged plan it would sign. */
export interface Critique {
  readonly agent: AgentId;
  readonly targetAgent: AgentId;
  readonly verdict: CritiqueVerdict;
  readonly findings: readonly Finding[];
  /** The plan this agent would commit to after reading both. Required unless `reject`. */
  readonly mergedPlan?: Plan;
}

export type Position = "agree" | "disagree";

/** A signature on a specific plan. `planHash` binds the vote to exact content. */
export interface Vote {
  readonly agent: AgentId;
  readonly position: Position;
  readonly rationale: string;
  readonly planHash: string;
}

export type UnitStatus =
  | "unassigned"
  | "claimed"
  | "implemented"
  | "changes_requested"
  | "approved"
  | "abandoned";

/** A slice of the agreed plan, owned by exactly one seat, built in its own worktree. */
export interface WorkUnit {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly files: readonly string[];
  owner: AgentId;
  status: UnitStatus;
  /** Branch the owner's worktree is on. */
  branch?: string;
  /** Worktree path on disk. */
  worktree?: string;
  /** Commits the owner produced, newest last. */
  commits?: string[];
  /** Review rounds already spent on this unit. */
  reviewRounds?: number;
}

export type ReviewVerdict = "approve" | "request_changes";

/** The peer's reading of a unit's actual diff. */
export interface Review {
  readonly agent: AgentId;
  readonly unitId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly Finding[];
  readonly summary: string;
}

/** Result of running one acceptance command. */
export interface CheckResult {
  readonly command: string;
  readonly cwd: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Tail of combined output — enough to diagnose, bounded so the ledger stays readable. */
  readonly outputTail: string;
}

/** Something a human has to answer before the council can go on. */
export interface Escalation {
  readonly reason: string
  readonly phase: Phase;
  /** Each seat's position, so the human can decide without reading the whole ledger. */
  readonly positions: Readonly<Record<AgentId, string>>;
  readonly question: string;
}

/**
 * A real-world action (email, booking, purchase) that only the consumer Muse app
 * can take. Never executed by the council itself — it is minted, held, and
 * handed to a human to approve.
 */
export interface ActionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly requestedBy: AgentId;
  /** Plain-language instruction, ready to paste into the Muse app. */
  readonly instruction: string;
  /** Why the task needs it. */
  readonly rationale: string;
  readonly irreversible: boolean;
  /** Set once a human decides. */
  status: "pending" | "approved" | "denied" | "delivered";
  decidedBy?: string;
  decidedAt?: string;
  deliveryNote?: string;
}

/** The whole state of a task — derivable by replaying the ledger. */
export interface TaskState {
  readonly brief: Brief;
  phase: Phase;
  plans: Record<AgentId, Plan>;
  critiques: Critique[];
  votes: Vote[];
  agreedPlan?: Plan;
  agreedPlanHash?: string;
  units: WorkUnit[];
  reviews: Review[];
  checks: CheckResult[];
  escalation?: Escalation;
  actionRequests: ActionRequest[];
  /** Dollars spent per seat, as reported by each agent runtime. */
  spendUsd: Record<AgentId, number>;
  rounds: { critique: number; review: number };
  integrationBranch?: string;
  startedAt: string;
  endedAt?: string;
}

/** Every event type the ledger carries. The union is closed on purpose: a new */
/** event type is a protocol change and must be added here to be recordable. */
export type LedgerEventType =
  | "task_opened"
  | "phase_entered"
  | "plan_submitted"
  | "critique_submitted"
  | "vote_cast"
  | "plan_agreed"
  | "unit_created"
  | "unit_claimed"
  | "unit_implemented"
  | "review_submitted"
  | "fix_requested"
  | "check_run"
  | "peer_question"
  | "peer_answer"
  | "note"
  | "action_requested"
  | "action_decided"
  | "escalated"
  | "integration_result"
  | "spend"
  | "agent_error"
  | "task_closed";

/** One link in the chain. `hash` covers `prevHash` too, so the log is tamper-evident. */
export interface LedgerEvent {
  readonly seq: number;
  readonly ts: string;
  readonly taskId: string;
  /** Who caused it: an AgentId, "engine", or "human". */
  readonly actor: string;
  readonly type: LedgerEventType;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
}
