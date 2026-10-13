#!/usr/bin/env node
/**
 * The live peer channel, served to both seats as an MCP server over stdio.
 *
 * Phase boundaries are not enough. A seat halfway through implementing a unit
 * needs to ask its peer *now* — "you own the schema, does this column already
 * exist?" — and the answer has to come back inside the same turn. That is what
 * this channel is for, and it is the difference between two agents taking
 * turns and two agents working together.
 *
 * Both runtimes reach the same server, so both see the same ledger, the same
 * notes and the same peer. Three limits keep it from becoming a loop:
 *
 *  - `ask_peer` carries a depth, decremented on each hop; at zero it refuses.
 *  - A peer turn is always read-only: it may read and reason, never write.
 *  - Every question and answer lands in the ledger, so a human can see what
 *    the seats actually said to each other.
 *
 * Real-world actions (email, a booking, a purchase) are only ever *minted*
 * here for a human to approve. Nothing on this channel can fire one.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { Ledger, ledgerPath } from "../ledger.js";
import { createSeat } from "../adapters/factory.js";
import { MuseAppLane } from "../adapters/muse-app.js";
import type { LedgerEventType } from "../protocol.js";

interface ChannelEnv {
  readonly repoRoot: string;
  readonly councilHome: string;
  readonly taskId: string;
  readonly self: string;
  readonly peer: string;
  readonly depth: number;
}

function readEnv(): ChannelEnv {
  const repoRoot = process.env["COUNCIL_REPO_ROOT"];
  const taskId = process.env["COUNCIL_TASK_ID"];
  const self = process.env["COUNCIL_SELF"];
  if (!repoRoot || !taskId || !self) {
    throw new Error(
      "council MCP server needs COUNCIL_REPO_ROOT, COUNCIL_TASK_ID and COUNCIL_SELF in its environment",
    );
  }
  return {
    repoRoot,
    councilHome: process.env["COUNCIL_HOME"] ?? `${repoRoot}/.council`,
    taskId,
    self,
    peer: process.env["COUNCIL_PEER"] ?? "",
    depth: Number(process.env["COUNCIL_PEER_DEPTH"] ?? "1"),
  };
}

const TOOLS = [
  {
    name: "read_ledger",
    description:
      "Read the council's shared ledger for this task: plans, critiques, votes, " +
      "reviews, check results and notes, oldest first. Use it to find out what " +
      "your peer has already decided or tried instead of guessing.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many of the most recent events to return (default 40)." },
        type: { type: "string", description: "Optional event type filter, e.g. review_submitted." },
      },
    },
  },
  {
    name: "post_note",
    description:
      "Write a note into the shared ledger for your peer and for the human " +
      "reading this run afterwards. Use it for decisions and surprises, not for " +
      "progress chatter.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
  },
  {
    name: "ask_peer",
    description:
      "Ask the other council seat a question and wait for its answer. It runs " +
      "read-only, so it can read the repo and reason but cannot change " +
      "anything. Use it when the answer depends on code or a decision your " +
      "peer owns — not to delegate your own work.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        context: {
          type: "string",
          description: "What you are doing and what you already checked, so the answer is useful.",
        },
      },
    },
  },
  {
    name: "request_real_world_action",
    description:
      "Request a real-world action that only the consumer Muse app can take " +
      "(sending an email, booking something, a purchase). This does NOT perform " +
      "it: it records a request that a human must approve first. Expect to " +
      "finish your task without the result.",
    inputSchema: {
      type: "object",
      required: ["instruction", "rationale"],
      properties: {
        instruction: { type: "string", description: "Exactly what should be done, as you would say it to an assistant." },
        rationale: { type: "string", description: "Why this task needs it." },
      },
    },
  },
  {
    name: "flag_blocker",
    description:
      "Record that you are blocked on something the council cannot resolve by " +
      "itself. Does not stop the run; it marks the ledger so the human sees it.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" },
        needs: { type: "string", description: "What would unblock you." },
      },
    },
  },
] as const;

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) };
}

export async function main(): Promise<void> {
  const env = readEnv();
  const config = await loadConfig(env.repoRoot, { councilHome: env.councilHome });
  const ledger = new Ledger(ledgerPath(env.councilHome));
  await ledger.load();

  const record = (type: LedgerEventType, payload: unknown) =>
    ledger.append({ taskId: env.taskId, actor: env.self, type, payload });

  const server = new Server(
    { name: "council", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case "read_ledger": {
        const limit = Math.min(Math.max(Number(args["limit"] ?? 40), 1), 200);
        const filter = typeof args["type"] === "string" ? args["type"] : undefined;
        const events = (await ledger.readTask(env.taskId)).filter(
          (event) => !filter || event.type === filter,
        );
        const recent = events.slice(-limit).map((event) => ({
          seq: event.seq,
          ts: event.ts,
          actor: event.actor,
          type: event.type,
          payload: event.payload,
        }));
        return text(JSON.stringify(recent, null, 2));
      }

      case "post_note": {
        const body = String(args["text"] ?? "").trim();
        if (!body) return text("refused: empty note", true);
        const event = await record("note", { text: body, from: env.self });
        return text(`noted as ledger event ${event.seq}`);
      }

      case "ask_peer": {
        if (!env.peer) return text("refused: this run has no peer seat", true);
        if (env.depth <= 0) {
          return text(
            "refused: peer-question depth exhausted for this turn. Decide with " +
              "what you have, or post_note / flag_blocker so the council sees it.",
            true,
          );
        }
        const question = String(args["question"] ?? "").trim();
        if (!question) return text("refused: empty question", true);
        const context = String(args["context"] ?? "").trim();

        const asked = await record("peer_question", { to: env.peer, question, context });
        const peer = createSeat(env.peer, config);
        if (!peer) return text(`refused: unknown peer seat ${env.peer}`, true);

        const result = await peer.run({
          prompt: [
            `Your council peer (${env.self}) is mid-task and asks:`,
            "",
            question,
            context ? `\nTheir context: ${context}` : "",
            "",
            "Answer from the actual repository, briefly and concretely. If you do",
            "not know, say so — a confident wrong answer costs more than an",
            "admission. You cannot change any files in this turn.",
          ].join("\n"),
          workspace: env.repoRoot,
          allowWrites: false,
          budgetUsd: config.budget.perTurnUsd,
          timeoutMs: Math.min(config.limits.turnTimeoutMs, 5 * 60_000),
          // One hop less, so a chain of questions terminates.
          mcp:
            env.depth - 1 > 0
              ? {
                  serverPath: process.argv[1] ?? "",
                  env: {
                    COUNCIL_REPO_ROOT: env.repoRoot,
                    COUNCIL_HOME: env.councilHome,
                    COUNCIL_TASK_ID: env.taskId,
                    COUNCIL_SELF: env.peer,
                    COUNCIL_PEER: env.self,
                    COUNCIL_PEER_DEPTH: String(env.depth - 1),
                  },
                  toolNames: ["read_ledger", "post_note"],
                }
              : undefined,
        });
        await peer.dispose?.();

        await record("peer_answer", {
          from: env.peer,
          questionSeq: asked.seq,
          ok: result.ok,
          answer: result.text.slice(0, 8_000),
          error: result.error,
          costUsd: result.costUsd,
        });

        if (!result.ok) {
          return text(`your peer could not answer: ${result.error ?? "unknown failure"}`, true);
        }
        return text(result.text || "(your peer returned an empty answer)");
      }

      case "request_real_world_action": {
        const lane = new MuseAppLane(config.museApp);
        const instruction = String(args["instruction"] ?? "").trim();
        const rationale = String(args["rationale"] ?? "").trim();
        if (!instruction) return text("refused: empty instruction", true);
        const minted = lane.mint(env.taskId, env.self, instruction, rationale);
        await record("action_requested", { request: minted });
        return text(
          [
            `Recorded as ${minted.id} — pending human approval. Nothing has been sent.`,
            minted.irreversible ? "Marked irreversible: it will not be delivered without an explicit approval." : "",
            `A human approves it with: council actions approve ${minted.id}`,
            "Carry on without the result.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      case "flag_blocker": {
        const summary = String(args["summary"] ?? "").trim();
        if (!summary) return text("refused: empty summary", true);
        const event = await record("note", {
          blocker: true,
          text: summary,
          needs: String(args["needs"] ?? "").trim(),
          from: env.self,
        });
        return text(`blocker recorded as ledger event ${event.seq}`);
      }

      default:
        return text(`unknown tool ${request.params.name}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

// Only run when executed directly, so tests can import the module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`council mcp server failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
