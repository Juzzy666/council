/**
 * Acceptance checks: the part of the council that is not an opinion.
 *
 * Two agents agreeing is not evidence. A run only reaches `done` when the
 * repo's own checks pass on the integrated result, so the deciding vote is
 * always the repository's.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "./protocol.js";
import { runProcess, tail } from "./adapters/claude-code.js";

/**
 * Work out what this repo runs to prove itself. Conservative on purpose: only
 * commands the repo itself declares, never a guess like `npm test` in a repo
 * with no test script.
 */
export async function detectChecks(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      for (const name of ["typecheck", "lint", "test"]) {
        // The plain form, exactly what a contributor types. No `--silent`: the
        // runner captures the output either way, and a quiet check that fails
        // is harder to diagnose from the ledger.
        if (scripts[name]) found.push(`npm run ${name}`);
      }
    } catch {
      // A malformed package.json is the repo's problem to report, not ours to
      // crash on: fall through to the other detectors.
    }
  }
  if (existsSync(join(repoRoot, "Makefile"))) {
    const makefile = await readFile(join(repoRoot, "Makefile"), "utf8").catch(() => "");
    for (const target of ["lint", "test"]) {
      if (new RegExp(`^${target}:`, "m").test(makefile)) found.push(`make ${target}`);
    }
  }
  if (existsSync(join(repoRoot, "pyproject.toml")) || existsSync(join(repoRoot, "pytest.ini"))) {
    found.push("python3 -m pytest -q");
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) found.push("cargo test --quiet");
  if (existsSync(join(repoRoot, "go.mod"))) found.push("go test ./...");
  return [...new Set(found)];
}

export async function runCheck(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await runProcess("/bin/sh", ["-c", command], { cwd, timeoutMs });
  return {
    command,
    cwd,
    ok: outcome.code === 0 && !outcome.timedOut,
    exitCode: outcome.code,
    durationMs: Date.now() - started,
    outputTail: tail(`${outcome.stdout}\n${outcome.stderr}`.trim(), 4_000),
  };
}

export async function runChecks(
  commands: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    // Sequential: checks commonly share ports, databases and build output.
    results.push(await runCheck(command, cwd, timeoutMs));
  }
  return results;
}

export function allPassed(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.ok);
}
