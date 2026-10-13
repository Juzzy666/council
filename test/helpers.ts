/** Shared fixtures: a throwaway git repo and a scripted council. */

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/adapters/claude-code.js";
import type { AgentRequest } from "../src/adapters/types.js";

export async function makeRepo(options: { withCheck?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "council-test-"));
  const git = (args: string[]) => runProcess("git", args, { cwd: root, timeoutMs: 60_000 });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@council.local"]);
  await git(["config", "user.name", "council test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "seed.txt"), "seed\n", "utf8");
  if (options.withCheck !== false) {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: {
            // Passes only once BOTH seats' files exist, so it can only go green
            // after the integration merge — exactly what we want to prove.
            test: "node -e \"const fs=require('fs');if(!fs.existsSync('src/alpha.txt')||!fs.existsSync('src/beta.txt')){console.error('missing seat output');process.exit(1)}console.log('ok')\"",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "seed"]);
  return root;
}

export function planJson(agent: string, steps: { id: string; title: string; files: string[]; owner?: string }[]): string {
  return JSON.stringify({
    summary: `${agent}'s approach`,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      detail: `write ${step.files.join(", ")}`,
      files: step.files,
      risk: "low",
      ...(step.owner ? { suggestedOwner: step.owner } : {}),
    })),
    risks: [],
    acceptanceChecks: ["npm test --silent"],
    openQuestions: [],
  });
}

export type TurnKind = "plan" | "critique" | "vote" | "implement" | "review" | "judge" | "unknown";

/** Which turn is this? Taken from the schema the engine asked for. */
export function turnKind(request: AgentRequest): TurnKind {
  const required = (request.jsonSchema?.["required"] as string[] | undefined) ?? [];
  if (required.includes("mergedPlan")) return "critique";
  if (required.includes("votes")) return "vote";
  if (required.includes("filesTouched")) return "implement";
  if (required.includes("findings") && required.includes("summary")) return "review";
  if (required.includes("steps")) return "plan";
  if (required.includes("planHash")) return "judge";
  return "unknown";
}

/**
 * The file this turn's own unit is about. Read from the `UNIT <id>:` line, not
 * from the prompt as a whole: the prompt also carries the agreed plan and the
 * peer's units, so a substring search picks up the other seat's files.
 */
export function unitFile(prompt: string): string {
  const id = prompt.match(/^UNIT (\S+):/m)?.[1] ?? "alpha";
  return `src/${id}.txt`;
}

/** Every planHash on a vote ballot. */
export function ballotHashes(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/planHash ([0-9a-f]{64})/g)].map((m) => m[1]!))];
}

/** A bare repo to push to, plus a working clone of it — a whole remote, offline. */
export async function makeRemoteAndClone(files: Record<string, string>): Promise<{ origin: string; work: string }> {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const origin = await mkdtemp(join(tmpdir(), "council-origin-"));
  await runProcess("git", ["init", "-q", "--bare", "-b", "main", origin], { cwd: origin, timeoutMs: 60_000 });

  const work = await mkdtemp(join(tmpdir(), "council-work-"));
  await runProcess("git", ["clone", "-q", `file://${origin}`, work], { cwd: work, timeoutMs: 120_000 });
  const git = (args: string[]) => runProcess("git", args, { cwd: work, timeoutMs: 60_000 });
  await git(["config", "user.email", "test@council.local"]);
  await git(["config", "user.name", "council test"]);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(work, dirname(path)), { recursive: true });
    await writeFile(join(work, path), body, "utf8");
  }
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "seed"]);
  await git(["push", "-q", "origin", "main"]);
  return { origin, work };
}
