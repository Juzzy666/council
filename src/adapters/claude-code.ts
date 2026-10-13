/**
 * The Claude Code seat.
 *
 * Drives the `claude` CLI in print mode. Verified against Claude Code 2.1.296:
 * `--output-format json` prints one object carrying `result` (the final text),
 * `total_cost_usd`, `session_id`, `is_error` and `subtype`; with `--json-schema`
 * the same object also carries `structured_output`.
 *
 * The prompt goes in on stdin, never as an argv word: a plan or a diff review
 * runs past any platform's argument limit.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { CLAUDE } from "../protocol.js";
import type { AgentAdapter, AgentRequest, AgentResult, Availability } from "./types.js";
import type { ClaudeSeatConfig } from "../config.js";

interface ClaudePrintResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly session_id?: string;
  readonly num_turns?: number;
  readonly terminal_reason?: string;
  readonly permission_denials?: unknown[];
  readonly structured_output?: unknown;
  readonly structuredOutput?: unknown;
}

/** Tools a read-only turn cannot have: anything that can change the repo. */
const READ_ONLY_DENY = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "KillShell"];

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = CLAUDE;
  readonly label = "Claude Code";
  readonly #config: ClaudeSeatConfig;
  /** Session keys already started, so a second turn resumes instead of colliding. */
  readonly #started = new Set<string>();

  constructor(config: ClaudeSeatConfig) {
    this.#config = config;
  }

  async availability(): Promise<Availability> {
    const probe = await runProcess(this.#config.bin, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    if (probe.code !== 0) {
      return {
        available: false,
        detail:
          `\`${this.#config.bin} --version\` failed (${probe.code ?? "signal"}). ` +
          "Install Claude Code and make sure the binary is on PATH.",
      };
    }
    return { available: true, version: probe.stdout.trim(), detail: "ready" };
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const args = this.#args(request);
    const probe = await runProcess(this.#config.bin, args, {
      cwd: request.workspace,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs ?? 15 * 60_000,
    });
    const durationMs = Date.now() - started;

    if (probe.timedOut) {
      return {
        ok: false,
        text: "",
        durationMs,
        error: `timed out after ${request.timeoutMs ?? 900_000}ms`,
        meta: { stderrTail: tail(probe.stderr) },
      };
    }

    const parsed = parseLastJsonObject<ClaudePrintResult>(probe.stdout);
    if (!parsed) {
      return {
        ok: false,
        text: probe.stdout.trim(),
        durationMs,
        error:
          probe.code === 0
            ? "claude printed no JSON result object"
            : `claude exited ${probe.code ?? "on a signal"}`,
        meta: { stderrTail: tail(probe.stderr) },
      };
    }

    const failed = probe.code !== 0 || parsed.is_error === true || parsed.subtype !== "success";
    const text = (parsed.result ?? "").trim();
    const structured = parsed.structured_output ?? parsed.structuredOutput;
    const json = structured ?? (request.jsonSchema ? safeJsonParse(text) : undefined);

    return {
      ok: !failed,
      text,
      ...(json === undefined ? {} : { json }),
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
      ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
      durationMs,
      ...(failed
        ? { error: parsed.subtype ?? parsed.terminal_reason ?? `exit ${probe.code}` }
        : {}),
      meta: {
        numTurns: parsed.num_turns,
        terminalReason: parsed.terminal_reason,
        permissionDenials: parsed.permission_denials?.length ?? 0,
        ...(failed ? { stderrTail: tail(probe.stderr) } : {}),
      },
    };
  }

  #args(request: AgentRequest): string[] {
    const args = ["-p", "--output-format", "json"];

    // Writes are a property of the TURN, not of the seat: planning and review
    // turns run read-only so a reviewer can never "fix" what it is judging.
    //
    // Read-only is enforced by removing the write tools, NOT by `--permission-mode
    // plan`. Verified against Claude Code 2.1.296: in plan mode an allow-listed
    // MCP tool is still auto-denied ("Plan mode is active and this session has no
    // way to approve the call"), which would cut the seat off from the peer
    // channel. With `manual` plus this deny-list, a write attempt comes back
    // BLOCKED with no file created, and the council tools still work.
    const allowed = request.mcp
      ? request.mcp.toolNames.map((name) => `mcp__council__${name}`)
      : [];
    if (request.allowWrites) {
      args.push("--permission-mode", this.#config.permissionMode);
      // An implementation turn has to be able to run the repo's own commands,
      // or it cannot check its work before handing it to a reviewer.
      allowed.push("Bash", "Read", "Grep", "Glob", "Edit", "Write");
    } else {
      args.push("--permission-mode", "manual");
      args.push("--disallowedTools", READ_ONLY_DENY.join(","));
      allowed.push("Read", "Grep", "Glob");
    }
    // Nobody is at the terminal. Anything that would still prompt is denied
    // rather than hanging the run.
    args.push("--permission-prompts", "none");
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));

    if (this.#config.model) args.push("--model", this.#config.model);
    if (this.#config.effort) args.push("--effort", this.#config.effort);
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
    if (request.jsonSchema) args.push("--json-schema", JSON.stringify(request.jsonSchema));
    if (typeof request.budgetUsd === "number") {
      args.push("--max-budget-usd", String(request.budgetUsd));
    }
    for (const dir of request.readDirs ?? []) args.push("--add-dir", dir);

    if (request.mcp) {
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            council: {
              command: process.execPath,
              args: [request.mcp.serverPath],
              env: request.mcp.env,
            },
          },
        }),
        // Only the council channel. A seat's own global MCP servers stay out of
        // a council run, so the two seats cannot reach different tools.
        "--strict-mcp-config",
      );
    }

    if (request.sessionKey) {
      // `--session-id` takes a UUID and nothing else — a readable key like
      // "task-claude" is rejected with "Invalid session ID. Must be a valid
      // UUID.", which fails the turn before the model is ever called. The key
      // is hashed into a stable UUID so the same seat on the same task keeps
      // one conversation across turns, and the SECOND turn resumes it rather
      // than trying to create an id that already exists.
      const id = uuidFromKey(request.sessionKey);
      args.push(this.#started.has(request.sessionKey) ? "--resume" : "--session-id", id);
      this.#started.add(request.sessionKey);
    } else {
      args.push("--no-session-persistence");
    }

    args.push(...this.#config.extraArgs);
    return args;
  }
}

export interface ProcessOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunProcessOptions {
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Spawn a child, feed it stdin, collect both streams, enforce a timeout. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // A runtime that ignores SIGTERM still has to go.
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, options.timeoutMs)
      : undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      stderr += `\n${(error as Error).message}`;
      finish(null, null);
    });
    child.on("close", finish);

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Take the last complete JSON object printed on stdout. Claude Code prints one
 * result object, but a warning line ahead of it must not break parsing.
 */
export function parseLastJsonObject<T>(stdout: string): T | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    const parsed = safeJsonParse(line);
    if (parsed !== undefined) return parsed as T;
  }
  // Fall back to the whole buffer: a pretty-printed object spans lines.
  const whole = safeJsonParse(stdout.trim());
  return whole === undefined ? null : (whole as T);
}

export function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function tail(text: string, limit = 2_000): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

/**
 * A stable RFC-4122 (version 5 shaped) UUID derived from a council session key.
 * Deterministic on purpose: the same seat on the same task resumes the same
 * Claude Code session after a restart, and a ledger replay names the same id.
 */
export function uuidFromKey(key: string): string {
  const digest = createHash("sha1").update(`council:${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
