/**
 * Git plumbing for the council.
 *
 * Each seat implements in its own worktree on its own branch. That is what
 * makes two agents editing the same repo at the same time safe: they cannot
 * overwrite each other's files, the diff under review is exactly one seat's
 * work, and the integration merge is a real merge with real conflicts rather
 * than a last-writer-wins race.
 *
 * The user's own checkout is never touched: the council only ever adds
 * worktrees under its home directory and branches under `council/`.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, tail } from "./adapters/claude-code.js";

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<GitOutcome> {
  const outcome = await runProcess("git", args, { cwd, timeoutMs });
  return {
    ok: outcome.code === 0 && !outcome.timedOut,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    code: outcome.code,
  };
}

export async function assertRepo(repoRoot: string): Promise<void> {
  const outcome = await git(repoRoot, ["rev-parse", "--git-dir"]);
  if (!outcome.ok) throw new Error(`${repoRoot} is not a git repository`);
}

export async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  const outcome = await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!outcome.ok) throw new Error(`cannot resolve ref ${ref}: ${tail(outcome.stderr, 300)}`);
  return outcome.stdout.trim();
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const outcome = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return outcome.ok ? outcome.stdout.trim() : "HEAD";
}

export async function isDirty(repoRoot: string): Promise<boolean> {
  const outcome = await git(repoRoot, ["status", "--porcelain"]);
  return outcome.ok && outcome.stdout.trim().length > 0;
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

/** Add a worktree on a fresh branch cut from `baseSha`. Idempotent per branch name. */
export async function addWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<Worktree> {
  await mkdir(join(path, ".."), { recursive: true });
  const existing = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  const args = existing.ok
    ? ["worktree", "add", "-f", path, branch]
    : ["worktree", "add", "-f", "-b", branch, path, baseSha];
  const outcome = await git(repoRoot, args, 180_000);
  if (!outcome.ok) {
    throw new Error(`git worktree add failed for ${branch}: ${tail(outcome.stderr, 500)}`);
  }
  return { path, branch, baseSha };
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", path], 120_000);
  await rm(path, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"]);
}

/** Stage everything and commit. Returns the new sha, or null when there was nothing to commit. */
export async function commitAll(
  worktree: string,
  message: string,
  author = "council <council@local>",
): Promise<string | null> {
  const add = await git(worktree, ["add", "-A"]);
  if (!add.ok) throw new Error(`git add failed: ${tail(add.stderr, 300)}`);
  const status = await git(worktree, ["status", "--porcelain"]);
  if (status.ok && status.stdout.trim() === "") return null;
  const commit = await git(worktree, [
    "-c",
    `user.name=${author.split(" <")[0]}`,
    "-c",
    `user.email=${author.match(/<(.*)>/)?.[1] ?? "council@local"}`,
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
  if (!commit.ok) throw new Error(`git commit failed: ${tail(commit.stderr, 500)}`);
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

export interface DiffView {
  readonly files: readonly string[];
  /** Unified diff, truncated to keep a review prompt inside a sane budget. */
  readonly patch: string;
  readonly truncated: boolean;
  readonly insertions: number;
  readonly deletions: number;
}

export async function diffAgainst(
  worktree: string,
  baseSha: string,
  maxChars = 60_000,
): Promise<DiffView> {
  const names = await git(worktree, ["diff", "--name-only", `${baseSha}...HEAD`]);
  const stat = await git(worktree, ["diff", "--shortstat", `${baseSha}...HEAD`]);
  const patch = await git(worktree, ["diff", `${baseSha}...HEAD`], 180_000);
  const body = patch.stdout;
  const match = /(\d+) insertion|(\d+) deletion/g;
  let insertions = 0;
  let deletions = 0;
  for (const part of stat.stdout.matchAll(/(\d+) (insertion|deletion)/g)) {
    const count = Number(part[1] ?? 0);
    if (part[2] === "insertion") insertions = count;
    else deletions = count;
  }
  void match;
  return {
    files: names.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    patch: body.length > maxChars ? `${body.slice(0, maxChars)}\n…[diff truncated]` : body,
    truncated: body.length > maxChars,
    insertions,
    deletions,
  };
}

export interface MergeReport {
  readonly branch: string;
  readonly merged: readonly string[];
  readonly conflicts: readonly { branch: string; files: readonly string[] }[];
  readonly worktree: string;
}

/**
 * Build the integration branch in its own worktree and merge each seat's branch
 * into it, in order. A conflict is reported with its files rather than resolved
 * blindly — resolution is a decision, and decisions belong to the council or a
 * human, not to a merge driver.
 */
export async function integrate(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
  branches: readonly string[],
): Promise<MergeReport> {
  const tree = await addWorktree(repoRoot, worktreePath, branch, baseSha);
  const merged: string[] = [];
  const conflicts: { branch: string; files: readonly string[] }[] = [];
  for (const source of branches) {
    const outcome = await git(tree.path, [
      "-c",
      "user.name=council",
      "-c",
      "user.email=council@local",
      "merge",
      "--no-ff",
      "--no-edit",
      source,
    ], 180_000);
    if (outcome.ok) {
      merged.push(source);
      continue;
    }
    const files = await git(tree.path, ["diff", "--name-only", "--diff-filter=U"]);
    conflicts.push({
      branch: source,
      files: files.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    });
    await git(tree.path, ["merge", "--abort"]);
  }
  return { branch, merged, conflicts, worktree: tree.path };
}

/**
 * Per-command GitHub credentials.
 *
 * Passed as `-c` arguments rather than written into the checkout's config, so a
 * token never ends up in `.git/config` where a later command, a backup or a
 * careless `cat` would find it.
 */
export function authArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}
