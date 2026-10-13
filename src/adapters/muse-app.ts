/**
 * The consumer Muse lane — Meta's personal agent app (launched 8 Sep 2026;
 * iOS, Android, muse.ai and WhatsApp), the one that sends email, books travel,
 * fills forms and checks out purchases.
 *
 * It is NOT a council seat. It does not reason about the repo, and there is no
 * official automation API for it, so this lane never pretends to drive it:
 *
 *  1. A seat asks for a real-world action. The lane mints an `ActionRequest`
 *     and stops.
 *  2. A human approves or denies it (`council actions approve <id>`). Meta's
 *     own posture is that prompt injection is unsolved and a separate agent
 *     must approve outgoing actions — a council that auto-fired purchases off
 *     the back of repo text would be the exact hazard.
 *  3. Only then is it delivered: printed for the human to paste into Muse, or
 *     handed to a user-configured bridge command if they have one.
 *
 * Irreversible actions (money, sending, deleting) always require approval, and
 * `requireHumanApproval: false` cannot waive that.
 */

import { randomUUID } from "node:crypto";
import type { MuseAppConfig } from "../config.js";
import type { ActionRequest, AgentId } from "../protocol.js";
import { runProcess, tail } from "./claude-code.js";

/** Words that mark an action as irreversible regardless of what the asker claims. */
const IRREVERSIBLE_HINTS = [
  "buy",
  "purchase",
  "pay",
  "checkout",
  "order",
  "book",
  "send",
  "email",
  "message",
  "post",
  "delete",
  "cancel",
  "transfer",
  "subscribe",
];

export interface ActionDecision {
  readonly approved: boolean;
  readonly by: string;
  readonly note?: string;
}

export interface DeliveryOutcome {
  readonly delivered: boolean;
  /** What to tell the human: either the bridge's report, or the paste-ready text. */
  readonly note: string;
}

export class MuseAppLane {
  readonly #config: MuseAppConfig;

  constructor(config: MuseAppConfig) {
    this.#config = config;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  /** Mint a request. Never executes anything. */
  mint(taskId: string, requestedBy: AgentId, instruction: string, rationale: string): ActionRequest {
    const lowered = instruction.toLowerCase();
    return {
      id: `act_${randomUUID().slice(0, 8)}`,
      taskId,
      requestedBy,
      instruction: instruction.trim(),
      rationale: rationale.trim(),
      irreversible: IRREVERSIBLE_HINTS.some((hint) => lowered.includes(hint)),
      status: "pending",
    };
  }

  /**
   * Deliver an approved request. Refuses anything not approved — the check is
   * here, not only at the CLI, so no code path can skip it.
   */
  async deliver(request: ActionRequest): Promise<DeliveryOutcome> {
    if (request.status !== "approved") {
      return { delivered: false, note: `refused: request ${request.id} is ${request.status}` };
    }
    if (!this.#config.enabled) {
      return { delivered: false, note: "refused: the Muse app lane is disabled in config" };
    }
    const bridge = this.#config.bridgeCmd;
    if (!bridge) {
      return {
        delivered: false,
        note: [
          "No bridge command configured, so nothing was sent automatically.",
          "Paste this into the Muse app (or WhatsApp) yourself:",
          "",
          request.instruction,
        ].join("\n"),
      };
    }
    const outcome = await runProcess(bridge, [], {
      cwd: process.cwd(),
      stdin: `${request.instruction}\n`,
      timeoutMs: 120_000,
    });
    if (outcome.code !== 0 || outcome.timedOut) {
      return {
        delivered: false,
        note:
          `bridge command failed (${outcome.timedOut ? "timed out" : `exit ${outcome.code}`}). ` +
          `stderr: ${tail(outcome.stderr, 500)}`,
      };
    }
    return { delivered: true, note: tail(outcome.stdout.trim(), 1_000) || "bridge reported success" };
  }
}
