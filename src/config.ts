/**
 * Configuration: defaults, `council.config.json`, then environment overrides.
 *
 * Every knob that can burn money or write to a repo has a conservative default,
 * so an unconfigured run is safe rather than fast.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CLAUDE, MUSE, type AgentId } from "./protocol.js";
import type { NotifyConfig } from "./notify.js";
import type { PublishConfig } from "./publish.js";

export interface ClaudeSeatConfig {
  readonly enabled: boolean;
  /** Binary on PATH, or an absolute path. */
  readonly bin: string;
  /** Model alias or full name; omitted means the CLI's own default. */
  readonly model?: string;
  /** `claude --permission-mode`. `acceptEdits` lets a seat edit inside its worktree. */
  readonly permissionMode: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
  /** Extra args appended verbatim, for anything this config does not name. */
  readonly extraArgs: readonly string[];
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface MuseSeatConfig {
  readonly enabled: boolean;
  /** The `muse` binary. Installed by Meta's installer; see README. */
  readonly bin: string;
  /** Args for the MSP host. `serve` is the protocol host the SDK drives. */
  readonly args: readonly string[];
  /** MSP `session/start.modelId`; omitted means the host default. */
  readonly modelId?: string;
  /**
   * MSP `session/start.approvalMode`. `promptUnmatched` is the safe default: the
   * council answers prompts through its own policy instead of blanket-allowing.
   */
  readonly approvalMode: "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
  /** Tool names auto-approved when the host asks. Anything else is denied. */
  readonly autoApproveTools: readonly string[];
  /** MSP `session/start.permissionProfile`, when the host catalog defines one. */
  readonly permissionProfile?: string;
}

export interface MuseAppConfig {
  /** Off by default: the consumer app has no official automation API. */
  readonly enabled: boolean;
  /**
   * Optional command that delivers an approved instruction to the Muse app.
   * Receives the instruction on stdin. Unofficial by definition — see README.
   */
  readonly bridgeCmd?: string;
  /** Always true in practice; kept explicit so turning it off is a visible edit. */
  readonly requireHumanApproval: boolean;
}

/** What the council may do when nobody is watching. */
export interface AutonomyConfig {
  /**
   * `supervised` (default) stops at a human for anything it cannot settle:
   * deadlocks, blocking reviews, conflicts, an unverifiable result.
   * `autonomous` lands its own work and only reports afterwards.
   */
  readonly mode: "supervised" | "autonomous";
  /** Merge the integration branch once the repo's own checks pass on it. */
  readonly mergeWhenGreen: boolean;
  /**
   * Merge even when the repository declares no checks.
   *
   * Off by default and deliberately separate from `mode`: with no checks there
   * is nothing behind the result except two agents agreeing, and merging on
   * that is a different decision from merging on a green suite. An autonomous
   * run opens a pull request and says so instead.
   */
  readonly mergeWithoutChecks: boolean;
  readonly mergeMethod: "merge" | "squash" | "rebase";
  readonly closeIssueOnMerge: boolean;
  readonly deleteBranchOnMerge: boolean;
  /** Open a pull request for work that cannot be merged, so it is not lost. */
  readonly openPullRequests: boolean;
}

/** One repository the sweep is allowed to work on. */
export interface ProjectConfig {
  /** `owner/name`. */
  readonly repo: string;
  /** Existing checkout to reuse. Omitted means the sweep clones it. */
  readonly dir?: string;
  /** Issue labels that mark a task for the council. Falls back to `sweep.labels`. */
  readonly labels?: readonly string[];
  /** Per-project overrides, merged over the global config. */
  readonly overrides?: Partial<CouncilConfig>;
  readonly enabled?: boolean;
}

export interface SweepConfig {
  /** Issues carrying all of these labels are council tasks. */
  readonly labels: readonly string[];
  /** Applied while a task is being worked, so a second sweep cannot double-claim it. */
  readonly runningLabel: string;
  /** Applied when a task needs a human after all. */
  readonly parkedLabel: string;
  /** Ceiling for one whole sweep across every project. */
  readonly budgetUsd: number;
  readonly maxTasksPerRepo: number;
  /** Where repositories are cloned when a project names no `dir`. */
  readonly workRoot?: string;
}

export interface CouncilConfig {
  readonly repoRoot: string;
  readonly councilHome: string;
  readonly baseRef: string;
  readonly seats: {
    readonly claude: ClaudeSeatConfig;
    readonly muse: MuseSeatConfig;
  };
  readonly budget: {
    /** Hard ceiling for one task across all seats. The engine stops when crossed. */
    readonly perTaskUsd: number;
    /** Ceiling handed to a single agent turn, where the runtime supports one. */
    readonly perTurnUsd: number;
  };
  readonly limits: {
    readonly critiqueRounds: number;
    readonly reviewRounds: number;
    /** How many times an agent may call its peer inside one turn. Stops ping-pong. */
    readonly peerDepth: number;
    readonly turnTimeoutMs: number;
  };
  /** What happens when the seats cannot agree: ask a human, or a third judge turn. */
  readonly tiebreak: "human" | "judge";
  readonly judgeSeat: AgentId;
  /** Acceptance commands. Empty means "detect from the repo". */
  readonly checks: readonly string[];
  /**
   * Refuse to call a run `done` when there is no objective gate at all.
   *
   * With no checks, "the checks passed" degenerates to "no checks ran", and the
   * only thing left supporting the result is that both agents liked it. For an
   * unattended run across many repositories that is the difference between a
   * council and a rubber stamp, so the default is to escalate instead: the work
   * is still on its integration branch, it just is not claimed to be verified.
   */
  readonly requireChecks: boolean;
  readonly museApp: MuseAppConfig;
  /** Push the integration branch when the run lands. Off by default. */
  readonly push: boolean;
  readonly autonomy: AutonomyConfig;
  readonly notify: NotifyConfig;
  /** Where the sweep report is published for a status page to read. */
  readonly publish: PublishConfig;
  readonly sweep: SweepConfig;
  /** Repositories the sweep may work on. Nothing happens to a repo not listed here. */
  readonly projects: readonly ProjectConfig[];
}

export const DEFAULT_CONFIG: Omit<CouncilConfig, "repoRoot" | "councilHome" | "baseRef"> = {
  seats: {
    claude: {
      enabled: true,
      bin: "claude",
      permissionMode: "acceptEdits",
      extraArgs: [],
    },
    muse: {
      enabled: true,
      bin: "muse",
      args: ["serve"],
      approvalMode: "promptUnmatched",
      autoApproveTools: ["read", "grep", "glob", "list", "shell", "edit", "write", "patch"],
    },
  },
  budget: { perTaskUsd: 10, perTurnUsd: 2.5 },
  limits: { critiqueRounds: 2, reviewRounds: 2, peerDepth: 2, turnTimeoutMs: 15 * 60_000 },
  tiebreak: "human",
  judgeSeat: CLAUDE,
  checks: [],
  requireChecks: true,
  autonomy: {
    mode: "supervised",
    mergeWhenGreen: false,
    mergeWithoutChecks: false,
    mergeMethod: "squash",
    closeIssueOnMerge: true,
    deleteBranchOnMerge: true,
    openPullRequests: true,
  },
  notify: {},
  publish: { blobPath: "council/sweep.json", cacheMaxAge: 60 },
  sweep: {
    labels: ["council"],
    runningLabel: "council:running",
    parkedLabel: "council:parked",
    budgetUsd: 25,
    maxTasksPerRepo: 3,
  },
  projects: [],
  museApp: { enabled: false, requireHumanApproval: true },
  push: false,
};

export const CONFIG_FILENAME = "council.config.json";

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function boolFromEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Resolve the effective config. `overrides` wins over the file, which wins over
 * the defaults; a few env vars win over everything so CI can cap spend without
 * editing a tracked file.
 */
export async function loadConfig(
  repoRoot: string,
  overrides: Partial<CouncilConfig> = {},
): Promise<CouncilConfig> {
  const root = resolve(repoRoot);
  const filePath = join(root, CONFIG_FILENAME);
  let fromFile: Partial<CouncilConfig> = {};
  if (existsSync(filePath)) {
    try {
      fromFile = JSON.parse(await readFile(filePath, "utf8")) as Partial<CouncilConfig>;
    } catch (error) {
      throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${(error as Error).message}`);
    }
  }

  const home = overrides.councilHome ?? fromFile.councilHome ?? join(root, ".council");
  const config: CouncilConfig = {
    repoRoot: root,
    councilHome: isAbsolute(home) ? home : join(root, home),
    baseRef: overrides.baseRef ?? fromFile.baseRef ?? "HEAD",
    seats: {
      claude: { ...DEFAULT_CONFIG.seats.claude, ...fromFile.seats?.claude, ...overrides.seats?.claude },
      muse: { ...DEFAULT_CONFIG.seats.muse, ...fromFile.seats?.muse, ...overrides.seats?.muse },
    },
    budget: { ...DEFAULT_CONFIG.budget, ...fromFile.budget, ...overrides.budget },
    limits: { ...DEFAULT_CONFIG.limits, ...fromFile.limits, ...overrides.limits },
    tiebreak: overrides.tiebreak ?? fromFile.tiebreak ?? DEFAULT_CONFIG.tiebreak,
    judgeSeat: overrides.judgeSeat ?? fromFile.judgeSeat ?? DEFAULT_CONFIG.judgeSeat,
    checks: overrides.checks ?? fromFile.checks ?? DEFAULT_CONFIG.checks,
    requireChecks: overrides.requireChecks ?? fromFile.requireChecks ?? DEFAULT_CONFIG.requireChecks,
    autonomy: { ...DEFAULT_CONFIG.autonomy, ...fromFile.autonomy, ...overrides.autonomy },
    notify: { ...DEFAULT_CONFIG.notify, ...fromFile.notify, ...overrides.notify },
    publish: { ...DEFAULT_CONFIG.publish, ...fromFile.publish, ...overrides.publish },
    sweep: { ...DEFAULT_CONFIG.sweep, ...fromFile.sweep, ...overrides.sweep },
    projects: overrides.projects ?? fromFile.projects ?? DEFAULT_CONFIG.projects,
    museApp: { ...DEFAULT_CONFIG.museApp, ...fromFile.museApp, ...overrides.museApp },
    push: overrides.push ?? fromFile.push ?? DEFAULT_CONFIG.push,
  };

  // `mode: "autonomous"` is a posture, not a single switch: it turns on the
  // behaviours that make a run not need a human, while leaving the two that are
  // separate decisions (merging without a gate, opening PRs) as configured.
  const autonomy: AutonomyConfig =
    config.autonomy.mode === "autonomous"
      ? {
          ...config.autonomy,
          mergeWhenGreen:
            fromFile.autonomy?.mergeWhenGreen ?? overrides.autonomy?.mergeWhenGreen ?? true,
        }
      : config.autonomy;

  const perTask = numberFromEnv("COUNCIL_BUDGET_USD");
  const peerDepth = numberFromEnv("COUNCIL_PEER_DEPTH");
  const push = boolFromEnv("COUNCIL_PUSH");
  return {
    ...config,
    autonomy,
    budget: { ...config.budget, ...(perTask === undefined ? {} : { perTaskUsd: perTask }) },
    limits: { ...config.limits, ...(peerDepth === undefined ? {} : { peerDepth }) },
    ...(push === undefined ? {} : { push }),
  };
}

/** The seats a run will actually use, in table order. */
export function seatIds(config: CouncilConfig): AgentId[] {
  const seats: AgentId[] = [];
  if (config.seats.claude.enabled) seats.push(CLAUDE);
  if (config.seats.muse.enabled) seats.push(MUSE);
  return seats;
}
