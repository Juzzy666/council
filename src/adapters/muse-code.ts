/**
 * The Muse Code seat — Meta's terminal coding agent.
 *
 * Driven over the Muse Session Protocol with the official `@muse-code/sdk`
 * (verified against 1.4.7): spawn a `muse serve` host, `startSession`,
 * `sendUserTurn`, fold the turn's items, await its server-authored outcome.
 *
 * Two honest gaps, both handled rather than hidden:
 *
 *  - **No structured-output verb.** MSP's `turn/start` has no JSON-schema
 *    member, so a schema is asked for in the prompt and the answer is parsed
 *    out of the reply text.
 *  - **No cost on the wire.** `turn/completed` reports duration and terminal,
 *    not dollars, so this seat contributes no spend figure. The engine budgets
 *    it by turns instead, and says so rather than inventing a number.
 *
 * The SDK is an optional dependency: it is imported on first use so a
 * Claude-only council runs on a machine that has never seen Muse.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MUSE } from "../protocol.js";
import type { AgentAdapter, AgentRequest, AgentResult, Availability, McpWiring } from "./types.js";
import type { MuseSeatConfig } from "../config.js";
import { runProcess, tail } from "./claude-code.js";
import { extractJsonObject } from "../json.js";
import type { MuseClient, Session } from "@muse-code/sdk";

type SdkModule = typeof import("@muse-code/sdk");

let sdkModule: SdkModule | null = null;
let sdkError: string | null = null;

async function loadSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  if (sdkError) throw new Error(sdkError);
  try {
    sdkModule = (await import("@muse-code/sdk")) as SdkModule;
    return sdkModule;
  } catch (error) {
    sdkError =
      "@muse-code/sdk is not installed. Run `npm install @muse-code/sdk` " +
      `(optional dependency) to seat Muse Code. Underlying error: ${(error as Error).message}`;
    throw new Error(sdkError);
  }
}

interface LiveSession {
  readonly client: MuseClient;
  readonly session: Session;
}

export class MuseCodeAdapter implements AgentAdapter {
  readonly id = MUSE;
  readonly label = "Muse Code";
  readonly #config: MuseSeatConfig;
  /** One host per workspace: a worktree is a different workspace root. */
  readonly #sessions = new Map<string, LiveSession>();
  readonly #stderr = new Map<string, string>();

  constructor(config: MuseSeatConfig) {
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
          "Install Muse Code with Meta's installer and put `muse` on PATH.",
      };
    }
    try {
      await loadSdk();
    } catch (error) {
      return { available: false, version: probe.stdout.trim(), detail: (error as Error).message };
    }
    return { available: true, version: probe.stdout.trim(), detail: "ready" };
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    try {
      const { session } = await this.#open(request);
      const prompt = request.jsonSchema
        ? `${request.prompt}\n\n${schemaInstruction(request.jsonSchema)}`
        : request.prompt;

      const turn = await session.sendUserTurn({
        input: [{ type: "text", text: prompt }],
        displayText: `council: ${request.sessionKey ?? "turn"}`,
      });

      const collected: string[] = [];
      const timeoutMs = request.timeoutMs ?? 15 * 60_000;
      const outcome = await withTimeout(
        (async () => {
          // Items first: `items()` replays what the session already holds and
          // then follows the live tail, so nothing emitted before we attached
          // is lost.
          const drain = (async () => {
            for await (const item of turn.items()) {
              if (item.kind === "agentMessage" && typeof item.text === "string") {
                collected.push(item.text);
              }
            }
          })();
          const result = await turn.completed;
          await Promise.race([drain, delay(250)]);
          return result;
        })(),
        timeoutMs,
      );

      const durationMs = Date.now() - started;
      if (outcome === TIMEOUT) {
        // No interrupt verb is exposed on the facade, so the host goes down —
        // that is the only way to guarantee the turn stops.
        await this.#close(request.workspace);
        return {
          ok: false,
          text: collected.join("\n").trim(),
          durationMs,
          error: `timed out after ${timeoutMs}ms`,
          meta: { stderrTail: tail(this.#stderr.get(request.workspace) ?? "") },
        };
      }

      const text = collected.join("\n").trim();
      const json = request.jsonSchema ? extractJsonObject(text) : undefined;
      const ok = outcome.kind === "completed" && outcome.params.terminal === "completed";

      return {
        ok,
        text,
        ...(json === undefined ? {} : { json }),
        durationMs,
        sessionId: session.sessionId,
        ...(ok
          ? {}
          : {
              error:
                outcome.kind === "completed"
                  ? `turn ${outcome.params.terminal}${
                      outcome.params.reason ? `: ${outcome.params.reason}` : ""
                    }`
                  : outcome.kind === "unqueued"
                    ? "turn was unqueued before it launched"
                    : "turn ended without a terminal (host lost)",
            }),
        meta: {
          turnId: turn.turnId,
          terminal: outcome.kind === "completed" ? outcome.params.terminal : outcome.kind,
          // Deliberately no costUsd: MSP does not report one.
          costReported: false,
          ...(ok ? {} : { stderrTail: tail(this.#stderr.get(request.workspace) ?? "") }),
        },
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        durationMs: Date.now() - started,
        error: (error as Error).message,
        meta: { stderrTail: tail(this.#stderr.get(request.workspace) ?? "") },
      };
    }
  }

  async dispose(): Promise<void> {
    for (const workspace of [...this.#sessions.keys()]) await this.#close(workspace);
  }

  async #open(request: AgentRequest): Promise<LiveSession> {
    const existing = this.#sessions.get(request.workspace);
    if (existing) return existing;

    const sdk = await loadSdk();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (request.mcp) {
      // The facade's `StartSessionOptions` omits `config`, so per-session
      // `mcpServers` cannot be sent through it even though MSP defines the
      // member. The host's own settings file is the supported path: point the
      // child at a council-managed config home holding just our channel.
      const configHome = join(dirname(request.mcp.serverPath), "..", ".muse-config");
      await writeMuseSettings(configHome, request.mcp);
      env["XDG_CONFIG_HOME"] = configHome;
    }
    // Auto-update mid-run would swap the binary under a live council.
    env["MUSE_NO_AUTO_UPDATE"] = "1";

    const client = await sdk.MuseClient.spawn({
      museBin: this.#config.bin,
      args: [...this.#config.args],
      cwd: request.workspace,
      env,
      clientInfo: { name: "council", version: "0.1.0" },
      onStderr: (chunk) => {
        const prior = this.#stderr.get(request.workspace) ?? "";
        this.#stderr.set(request.workspace, tail(prior + chunk, 8_000));
      },
    });

    const session = await client.startSession({
      workspaceRoot: request.workspace,
      // A read-only turn gets a mode that cannot be talked into writing.
      approvalMode: request.allowWrites ? this.#config.approvalMode : "denyUnmatched",
      ...(this.#config.modelId ? { modelId: this.#config.modelId } : {}),
      ...(this.#config.permissionProfile
        ? { permissionProfile: this.#config.permissionProfile, requirePermissionProfile: true }
        : {}),
    });

    session.onApproval(async (approval) => {
      const choices = approval.availableChoices;
      const toolName = approval.toolName || approval.subject?.toolName || "";
      const allowed =
        request.allowWrites &&
        this.#config.autoApproveTools.some((name) => toolName.toLowerCase().includes(name));
      // Only ever a choice the request itself offered: a decision it never
      // offered is refused by the SDK and reported, not sent.
      const wanted = allowed
        ? choices.find((c) => c.decision === "approved" && c.scope === "once") ??
          choices.find((c) => c.decision === "approved")
        : choices.find((c) => c.decision === "denied");
      const fallback = choices.find((c) => c.decision === "denied") ?? choices[0];
      const choice = wanted ?? fallback;
      return {
        choiceId: choice?.choiceId ?? "",
        feedback: allowed ? undefined : "council: denied by policy for a read-only turn",
      };
    });

    const live: LiveSession = { client, session };
    this.#sessions.set(request.workspace, live);
    return live;
  }

  async #close(workspace: string): Promise<void> {
    const live = this.#sessions.get(workspace);
    if (!live) return;
    this.#sessions.delete(workspace);
    try {
      await live.client.close();
    } catch {
      // The host may already be gone; closing is best-effort by design.
    }
  }
}

/**
 * Write the council channel into a Muse settings file.
 *
 * Meta's published settings shape could not be read from this build environment
 * (dev.meta.ai was unreachable), so both spellings seen in the wild are written:
 * `mcp_servers` as the settings docs describe, and `mcpServers` as the MSP wire
 * schema names it. `council doctor` prints the file so a mismatch is visible
 * rather than silent.
 */
export async function writeMuseSettings(configHome: string, mcp: McpWiring): Promise<string> {
  const dir = join(configHome, "muse");
  await mkdir(dir, { recursive: true });
  const server = {
    transport: "stdio" as const,
    command: process.execPath,
    args: [mcp.serverPath],
    env: mcp.env,
    mode: "optional" as const,
  };
  const path = join(dir, "settings.json");
  await writeFile(
    path,
    `${JSON.stringify({ schema_version: 1, mcp_servers: { council: server }, mcpServers: { council: server } }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "Reply with a single JSON object and nothing else — no prose, no code fence.",
    "It must satisfy this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

const TIMEOUT = Symbol("timeout");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
