/**
 * The peer channel, spoken to as a real MCP client.
 *
 * This matters because the channel is the one piece both runtimes talk to over
 * a wire protocol: if `tools/list` or `tools/call` is wrong, both seats lose
 * the ability to reach each other mid-turn and the council silently degrades
 * to taking turns. The official MCP client is used so the test fails the same
 * way Claude Code or Muse Code would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ledger, ledgerPath } from "../src/ledger.js";
import { makeRepo } from "./helpers.js";

const SERVER = resolve(import.meta.dirname, "../src/mcp/server.js");

interface TextContent {
  type: string;
  text: string;
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "council-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...(process.env as Record<string, string>), ...env },
    }),
  );
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: TextContent[] }).content ?? [];
  return content.map((part) => part.text).join("\n");
}

test("the channel serves its tools to a real MCP client", async () => {
  const repo = await makeRepo({ withCheck: false });
  const home = join(repo, ".council");
  const ledger = new Ledger(ledgerPath(home));
  await ledger.load();
  await ledger.append({
    taskId: "mcp1",
    actor: "engine",
    type: "task_opened",
    payload: {
      brief: {
        taskId: "mcp1",
        goal: "wire the channel",
        constraints: [],
        acceptance: [],
        repoRoot: repo,
        baseRef: "main",
        createdAt: new Date().toISOString(),
      },
    },
  });

  const client = await connect({
    COUNCIL_REPO_ROOT: repo,
    COUNCIL_HOME: home,
    COUNCIL_TASK_ID: "mcp1",
    COUNCIL_SELF: "claude",
    COUNCIL_PEER: "muse",
    COUNCIL_PEER_DEPTH: "0",
  });

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "ask_peer",
      "flag_blocker",
      "post_note",
      "read_ledger",
      "request_real_world_action",
    ]);
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a usable description`);
      assert.equal((tool.inputSchema as { type?: string }).type, "object");
    }

    // A note written through the channel lands in the shared ledger.
    const noted = await client.callTool({ name: "post_note", arguments: { text: "alpha is mine" } });
    assert.match(textOf(noted), /ledger event \d+/);
    const events = await ledger.readTask("mcp1");
    const note = events.find((event) => event.type === "note");
    assert.equal((note?.payload as { text: string }).text, "alpha is mine");
    assert.equal(note?.actor, "claude", "the note is attributed to the calling seat");

    // And the peer can read it back.
    const read = await client.callTool({ name: "read_ledger", arguments: { limit: 10 } });
    assert.match(textOf(read), /alpha is mine/);

    // Filtering works, so a seat can ask for just reviews without the noise.
    const filtered = await client.callTool({ name: "read_ledger", arguments: { type: "task_opened" } });
    assert.match(textOf(filtered), /wire the channel/);
    assert.doesNotMatch(textOf(filtered), /alpha is mine/);

    // Depth is exhausted: ask_peer must refuse rather than start a loop.
    const refused = await client.callTool({ name: "ask_peer", arguments: { question: "are you there?" } });
    assert.equal((refused as { isError?: boolean }).isError, true);
    assert.match(textOf(refused), /depth exhausted/);

    // Empty input is refused rather than recorded.
    const empty = await client.callTool({ name: "post_note", arguments: { text: "   " } });
    assert.equal((empty as { isError?: boolean }).isError, true);

    // A real-world action is only ever minted, never performed.
    const action = await client.callTool({
      name: "request_real_world_action",
      arguments: { instruction: "Email the client the new quote", rationale: "they asked for it in the brief" },
    });
    const body = textOf(action);
    assert.match(body, /pending human approval/);
    assert.match(body, /Nothing has been sent/);
    assert.match(body, /irreversible/, "an email is irreversible and must be flagged");
    const minted = (await ledger.readTask("mcp1")).find((event) => event.type === "action_requested");
    assert.ok(minted);
    assert.equal((minted.payload as { request: { status: string } }).request.status, "pending");

    const blocker = await client.callTool({
      name: "flag_blocker",
      arguments: { summary: "the migration needs a prod credential", needs: "a read-only DSN" },
    });
    assert.match(textOf(blocker), /blocker recorded/);

    assert.equal(await ledger.verifyChain(), null, "everything the channel wrote keeps the chain intact");
  } finally {
    await client.close();
  }
});

test("the channel refuses to start without its task environment", async () => {
  await assert.rejects(
    connect({
      COUNCIL_REPO_ROOT: "",
      COUNCIL_HOME: "",
      COUNCIL_TASK_ID: "",
      COUNCIL_SELF: "",
    }),
  );
});
