/**
 * The seat interface. Everything the engine knows about an agent is here, so a
 * third runtime becomes a council member by implementing this and nothing else.
 */

import type { AgentId } from "../protocol.js";

/** How the council reaches its own MCP peer channel from inside an agent. */
export interface McpWiring {
  /** Absolute path to the node entry that serves the channel over stdio. */
  readonly serverPath: string;
  /** Environment the server is started with: task id, which seat is calling, caps. */
  readonly env: Readonly<Record<string, string>>;
  /** Tool names the agent may call on the channel. */
  readonly toolNames: readonly string[];
}

export interface AgentRequest {
  /** The turn's prompt. */
  readonly prompt: string;
  /** Appended to the runtime's own system prompt — the seat's role, not a jailbreak. */
  readonly systemPrompt?: string;
  /** Directory the agent runs in. For implementation turns this is its worktree. */
  readonly workspace: string;
  /** When set, the answer must be JSON matching this schema. */
  readonly jsonSchema?: Record<string, unknown>;
  /** May the agent write files and run commands, or is this a read-only turn? */
  readonly allowWrites: boolean;
  readonly budgetUsd?: number;
  readonly timeoutMs?: number;
  /** Wire the live peer channel into this turn. */
  readonly mcp?: McpWiring;
  /** Opaque key the adapter may use to continue its own session across turns. */
  readonly sessionKey?: string;
  /** Extra directories the agent may read (the repo root, when it works in a worktree). */
  readonly readDirs?: readonly string[];
}

export interface AgentResult {
  readonly ok: boolean;
  /** The agent's final text, trimmed. */
  readonly text: string;
  /** Parsed JSON when `jsonSchema` was asked for and the answer parsed. */
  readonly json?: unknown;
  readonly costUsd?: number;
  readonly durationMs: number;
  /** The runtime's own session id, when it has one, for resume and audit. */
  readonly sessionId?: string;
  readonly error?: string;
  /** Anything the adapter wants in the ledger for diagnosis. */
  readonly meta?: Record<string, unknown>;
}

export interface Availability {
  readonly available: boolean;
  /** Version string when the runtime reports one. */
  readonly version?: string;
  /** Why it is unavailable, and what the user should do about it. */
  readonly detail: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  /** Human-facing name used in reports and prompts. */
  readonly label: string;
  availability(): Promise<Availability>;
  /** Run one scoped turn to completion. Must never throw: failures come back as `ok: false`. */
  run(request: AgentRequest): Promise<AgentResult>;
  /** Release any host process this adapter owns. */
  dispose?(): Promise<void>;
}
