/** Shared fixtures: a throwaway git repo and a scripted council. */

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/adapters/claude-code.js";

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
