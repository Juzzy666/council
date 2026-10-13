/**
 * The shared ledger: one append-only, hash-chained JSONL file per council home.
 *
 * It is the single source of truth both agents read and write through. Two
 * properties earn the extra machinery:
 *
 *  - **Append-only with a hash chain.** Each event's hash covers the previous
 *    hash, so a rewritten or dropped line is detectable (`verifyChain`). An
 *    agent that is told to quietly revise history cannot.
 *  - **Replayable.** `foldTask` rebuilds a task's state from its events, so
 *    `council status` and `council replay` never need a second store to drift
 *    from.
 *
 * Writes are serialized through an in-process promise chain and appended with a
 * single `appendFile` call per event, so concurrent seats interleave lines
 * rather than corrupting one.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ActionRequest,
  AgentId,
  Brief,
  CheckResult,
  Critique,
  Escalation,
  LedgerEvent,
  LedgerEventType,
  Phase,
  Plan,
  Review,
  TaskState,
  Vote,
  WorkUnit,
} from "./protocol.js";

export const GENESIS_HASH = "0".repeat(64);

/** Canonical JSON: object keys sorted recursively, so a hash is stable across runtimes. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function hashOf(input: unknown): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex");
}

function eventHash(event: Omit<LedgerEvent, "hash">): string {
  return createHash("sha256")
    .update(
      canonicalize({
        seq: event.seq,
        ts: event.ts,
        taskId: event.taskId,
        actor: event.actor,
        type: event.type,
        payload: event.payload,
        prevHash: event.prevHash,
      }),
    )
    .digest("hex");
}

export interface LedgerAppend {
  readonly taskId: string;
  readonly actor: string;
  readonly type: LedgerEventType;
  readonly payload: unknown;
}

export class Ledger {
  readonly path: string;
  #tail: Promise<void> = Promise.resolve();
  #seq = 0;
  #prevHash = GENESIS_HASH;
  #loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Read what is already on disk so appends continue the existing chain. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      await writeFile(this.path, "", "utf8");
      this.#loaded = true;
      return;
    }
    const events = await this.read();
    const last = events.at(-1);
    if (last) {
      this.#seq = last.seq;
      this.#prevHash = last.hash;
    }
    this.#loaded = true;
  }

  async read(): Promise<LedgerEvent[]> {
    if (!existsSync(this.path)) return [];
    const text = await readFile(this.path, "utf8");
    const out: LedgerEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as LedgerEvent);
      } catch {
        // A torn final line (killed mid-write) is skipped rather than thrown:
        // the chain check below is what reports damage, with a seq to point at.
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async readTask(taskId: string): Promise<LedgerEvent[]> {
    return (await this.read()).filter((e) => e.taskId === taskId);
  }

  /**
   * Append one event. Serialized: every caller awaits the same chain, so `seq`
   * and `prevHash` can never be read by two writers at once.
   */
  async append(entry: LedgerAppend): Promise<LedgerEvent> {
    await this.load();
    let settle!: (event: LedgerEvent) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<LedgerEvent>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.#tail = this.#tail.then(async () => {
      try {
        const base = {
          seq: this.#seq + 1,
          ts: new Date().toISOString(),
          taskId: entry.taskId,
          actor: entry.actor,
          type: entry.type,
          payload: entry.payload,
          prevHash: this.#prevHash,
        };
        const event: LedgerEvent = { ...base, hash: eventHash(base) };
        await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
        this.#seq = event.seq;
        this.#prevHash = event.hash;
        settle(event);
      } catch (error) {
        fail(error);
      }
    });
    return result;
  }

  /** Verify the chain. Returns the first break, or null when the log is intact. */
  async verifyChain(): Promise<{ seq: number; reason: string } | null> {
    const events = await this.read();
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const event of events) {
      if (event.seq !== expectedSeq) {
        return { seq: event.seq, reason: `expected seq ${expectedSeq}, found ${event.seq}` };
      }
      if (event.prevHash !== prev) {
        return { seq: event.seq, reason: "prevHash does not match the preceding event" };
      }
      const { hash, ...rest } = event;
      if (eventHash(rest) !== hash) {
        return { seq: event.seq, reason: "hash does not cover this event's contents" };
      }
      prev = hash;
      expectedSeq += 1;
    }
    return null;
  }
}

/** Default on-disk layout for a council home. */
export function ledgerPath(councilHome: string): string {
  return join(councilHome, "ledger.jsonl");
}

function emptyState(brief: Brief): TaskState {
  return {
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
}

/**
 * Rebuild a task's state by replaying its events. The engine keeps its own live
 * copy while running; this is what every *reader* uses, so a stale cache can
 * never be what `status` reports.
 */
export function foldTask(events: readonly LedgerEvent[]): TaskState | null {
  const opened = events.find((e) => e.type === "task_opened");
  if (!opened) return null;
  const state = emptyState((opened.payload as { brief: Brief }).brief);

  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "phase_entered":
        state.phase = p["phase"] as Phase;
        break;
      case "plan_submitted": {
        const plan = p["plan"] as Plan;
        state.plans[plan.agent] = plan;
        break;
      }
      case "critique_submitted":
        state.critiques.push(p["critique"] as Critique);
        state.rounds.critique = Math.max(state.rounds.critique, Number(p["round"] ?? 0));
        break;
      case "vote_cast":
        state.votes.push(p["vote"] as Vote);
        break;
      case "plan_agreed":
        state.agreedPlan = p["plan"] as Plan;
        state.agreedPlanHash = p["planHash"] as string;
        break;
      case "unit_created":
        state.units.push(structuredClone(p["unit"] as WorkUnit));
        break;
      case "unit_claimed":
      case "unit_implemented": {
        const unit = state.units.find((u) => u.id === p["unitId"]);
        if (unit) {
          unit.status = p["status"] as WorkUnit["status"];
          if (typeof p["owner"] === "string") unit.owner = p["owner"];
          if (typeof p["branch"] === "string") unit.branch = p["branch"];
          if (typeof p["worktree"] === "string") unit.worktree = p["worktree"];
          if (Array.isArray(p["commits"])) unit.commits = p["commits"] as string[];
        }
        break;
      }
      case "review_submitted": {
        const review = p["review"] as Review;
        state.reviews.push(review);
        const unit = state.units.find((u) => u.id === review.unitId);
        if (unit) {
          unit.status = review.verdict === "approve" ? "approved" : "changes_requested";
          unit.reviewRounds = (unit.reviewRounds ?? 0) + 1;
        }
        state.rounds.review = Math.max(state.rounds.review, Number(p["round"] ?? 0));
        break;
      }
      case "check_run":
        state.checks.push(p["result"] as CheckResult);
        break;
      case "escalated":
        state.escalation = p["escalation"] as Escalation;
        break;
      case "action_requested":
        state.actionRequests.push(structuredClone(p["request"] as ActionRequest));
        break;
      case "action_decided": {
        const request = state.actionRequests.find((a) => a.id === p["id"]);
        if (request) {
          request.status = p["status"] as ActionRequest["status"];
          request.decidedBy = p["decidedBy"] as string | undefined;
          request.decidedAt = event.ts;
          request.deliveryNote = p["deliveryNote"] as string | undefined;
        }
        break;
      }
      case "spend": {
        const agent = p["agent"] as AgentId;
        state.spendUsd[agent] = (state.spendUsd[agent] ?? 0) + Number(p["usd"] ?? 0);
        break;
      }
      case "integration_result":
        state.integrationBranch = p["branch"] as string | undefined;
        break;
      case "task_closed":
        state.phase = p["phase"] as Phase;
        state.endedAt = event.ts;
        break;
      default:
        break;
    }
  }
  return state;
}
