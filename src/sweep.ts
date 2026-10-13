/**
 * The sweep: one pass over every configured project, unattended.
 *
 * For each repository the sweep is allowed to touch, it finds labelled issues,
 * claims one at a time, convenes the council on it, and lands the result —
 * merging when the repository's own checks pass on the merged branch, opening a
 * pull request when they do not, and saying which it did on the issue and over
 * ntfy.
 *
 * Three properties make this safe to leave running:
 *
 *  - **Nothing is implicit.** A repository is worked on only if it is listed in
 *    `projects`, and only issues carrying the configured label are tasks.
 *  - **A task is claimed before it is worked.** The label swap means a second
 *    sweep (a cron overlapping a long run) cannot pick up the same issue.
 *  - **The budget spans the sweep**, not just a task, so a bad night costs what
 *    you configured rather than what the issues happened to add up to.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Council } from "./council.js";
import { createSeats } from "./adapters/factory.js";
import type { AgentAdapter } from "./adapters/types.js";
import { loadConfig, type CouncilConfig, type ProjectConfig } from "./config.js";
import { GitHubClient, GitHubError, tokenFromEnv, type Fetcher, type GitHubIssue } from "./github.js";
import { Notifier } from "./notify.js";
import { blobTokenFromEnv, publishJson } from "./publish.js";
import { decideLanding, describeRun } from "./landing.js";
import { authArgs, git } from "./git.js";
import { toTask } from "./sources/github-issues.js";
import type { TaskState } from "./protocol.js";

export interface SweepTaskResult {
  readonly repo: string;
  readonly issue: number;
  readonly taskId: string;
  readonly phase: TaskState["phase"];
  readonly action: "merged" | "pull_request" | "parked" | "skipped" | "failed";
  readonly branch?: string;
  readonly pullRequest?: string;
  readonly why: string;
  readonly spendUsd: number;
}

export interface SweepReport {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly results: readonly SweepTaskResult[];
  readonly spendUsd: number;
  readonly budgetUsd: number;
  readonly budgetExhausted: boolean;
  readonly errors: readonly string[];
}

export interface SweepOptions {
  readonly config: CouncilConfig;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetcher?: Fetcher;
  readonly token?: string;
  /** Narrow this pass to one repository. */
  readonly onlyRepo?: string;
  /** Plan and report, but neither claim an issue nor write to GitHub. */
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
  /**
   * How to build the seats for a project. Defaults to the configured runtimes;
   * tests substitute scripted seats so the whole unattended path — claim, run,
   * push, merge, close, notify — can be exercised with no API key and no
   * network.
   */
  readonly makeSeats?: (config: CouncilConfig) => AgentAdapter[];
}

export async function sweep(options: SweepOptions): Promise<SweepReport> {
  const startedAt = new Date().toISOString();
  const log = options.log ?? (() => {});
  const config = options.config;
  const results: SweepTaskResult[] = [];
  const errors: string[] = [];
  let spend = 0;

  const token = options.token ?? tokenFromEnv();
  if (!token) {
    return {
      startedAt,
      endedAt: new Date().toISOString(),
      results,
      spendUsd: 0,
      budgetUsd: config.sweep.budgetUsd,
      budgetExhausted: false,
      errors: [
        "No GitHub token: set COUNCIL_GITHUB_TOKEN (or GITHUB_TOKEN). The sweep " +
          "reads issues and writes pull requests, so it cannot run without one.",
      ],
    };
  }

  const github = new GitHubClient({ token, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const notifier = new Notifier(config.notify, options.fetcher);
  const workRoot = config.sweep.workRoot ?? join(config.councilHome, "checkouts");

  const projects = config.projects.filter(
    (project) => project.enabled !== false && (!options.onlyRepo || project.repo === options.onlyRepo),
  );
  if (projects.length === 0) errors.push("No projects configured: nothing to sweep.");

  for (const project of projects) {
    if (spend >= config.sweep.budgetUsd) break;
    try {
      const labels = project.labels ?? config.sweep.labels;
      const issues = await github.listIssues(project.repo, labels, config.sweep.maxTasksPerRepo * 2);
      const open = issues.filter((issue) => !issue.labels.includes(config.sweep.runningLabel));
      log(`${project.repo}: ${open.length} task(s) labelled ${labels.join("+")}`);

      let worked = 0;
      for (const issue of open) {
        if (worked >= config.sweep.maxTasksPerRepo) break;
        if (spend >= config.sweep.budgetUsd) {
          log(`budget exhausted ($${spend.toFixed(2)}/$${config.sweep.budgetUsd}); stopping`);
          break;
        }
        const outcome = await runOneTask({
          project,
          issue,
          github,
          notifier,
          baseConfig: config,
          workRoot,
          token,
          dryRun: options.dryRun ?? false,
          remainingUsd: config.sweep.budgetUsd - spend,
          makeSeats: options.makeSeats ?? createSeats,
          log,
        });
        results.push(outcome);
        spend += outcome.spendUsd;
        worked += 1;
      }
    } catch (error) {
      const message = `${project.repo}: ${(error as Error).message}`;
      errors.push(message);
      log(`error — ${message}`);
      await notifier.send({
        title: "⚠️ council — project failed",
        message,
        urgency: "attention",
      });
    }
  }

  const report: SweepReport = {
    startedAt,
    endedAt: new Date().toISOString(),
    results,
    spendUsd: spend,
    budgetUsd: config.sweep.budgetUsd,
    budgetExhausted: spend >= config.sweep.budgetUsd,
    errors: [...errors, ...notifier.failures.map((failure) => `notify: ${failure}`)],
  };

  await writeReport(config, report);

  // Publishing is reporting, not the work: a failure is recorded in the report
  // that was already written to disk, never thrown into the sweep.
  const blobToken = blobTokenFromEnv();
  if (config.publish.blobPath && blobToken) {
    const published = await publishJson(report, {
      token: blobToken,
      path: config.publish.blobPath,
      ...(config.publish.cacheMaxAge === undefined ? {} : { cacheMaxAge: config.publish.cacheMaxAge }),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    log(published.ok ? `published ${published.url ?? config.publish.blobPath}` : `publish failed: ${published.error}`);
    if (!published.ok) {
      return { ...report, errors: [...report.errors, `publish: ${published.error}`] };
    }
  }

  return report;
}

interface TaskRunOptions {
  readonly project: ProjectConfig;
  readonly issue: GitHubIssue;
  readonly github: GitHubClient;
  readonly notifier: Notifier;
  readonly baseConfig: CouncilConfig;
  readonly workRoot: string;
  readonly token: string;
  readonly dryRun: boolean;
  readonly remainingUsd: number;
  readonly makeSeats: (config: CouncilConfig) => AgentAdapter[];
  readonly log: (line: string) => void;
}

async function runOneTask(options: TaskRunOptions): Promise<SweepTaskResult> {
  const { project, issue, github, notifier, baseConfig, dryRun, log } = options;
  const task = toTask(project.repo, issue);
  const base = { repo: project.repo, issue: issue.number, taskId: task.brief.taskId! };
  log(`${project.repo}#${issue.number}: ${issue.title}`);

  if (dryRun) {
    return { ...base, phase: "briefing", action: "skipped", why: "dry run", spendUsd: 0 };
  }

  // Claim first. If the run dies halfway, the task stays claimed and a human
  // sees `council:running` rather than the next sweep repeating the work.
  await github.addLabels(project.repo, issue.number, [baseConfig.sweep.runningLabel]);
  for (const label of project.labels ?? baseConfig.sweep.labels) {
    await github.removeLabel(project.repo, issue.number, label);
  }

  let checkout: string;
  try {
    checkout = await ensureCheckout(options);
  } catch (error) {
    const why = `could not prepare a checkout: ${(error as Error).message}`;
    await github.comment(project.repo, issue.number, `Council could not start: ${why}`);
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    return { ...base, phase: "failed", action: "failed", why, spendUsd: 0 };
  }

  // The repository's own council.config.json wins for anything it sets: its
  // tests, its seats, its budget. The sweep only supplies what it owns.
  const config = await loadConfig(checkout, {
    ...project.overrides,
    budget: {
      perTaskUsd: Math.min(baseConfig.budget.perTaskUsd, options.remainingUsd),
      perTurnUsd: baseConfig.budget.perTurnUsd,
      ...project.overrides?.budget,
    },
    autonomy: { ...baseConfig.autonomy, ...project.overrides?.autonomy },
    notify: baseConfig.notify,
  });

  const adapters = options.makeSeats(config);
  const available: AgentAdapter[] = [];
  for (const adapter of adapters) {
    const availability = await adapter.availability();
    if (availability.available) available.push(adapter);
    else log(`  seat ${adapter.id} unavailable: ${availability.detail}`);
  }
  if (available.length === 0) {
    const why = "no seat is available on this machine";
    await github.comment(project.repo, issue.number, `Council could not start: ${why}.`);
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    return { ...base, phase: "failed", action: "failed", why, spendUsd: 0 };
  }

  const state = await new Council({ config, adapters: available }).run(task.brief);
  const spendUsd = Object.values(state.spendUsd).reduce((sum, value) => sum + value, 0);
  const integrationCwd = state.integrationBranch
    ? join(config.councilHome, "worktrees", task.brief.taskId!, "integration")
    : undefined;
  const decision = decideLanding(state, config.autonomy, integrationCwd);
  const body = describeRun(state, issue.url);

  // Push whatever exists before deciding what to do with it: an escalated run's
  // branch is still worth keeping.
  let pushed = false;
  if (state.integrationBranch) {
    const push = await git(
      checkout,
      [...authArgs(options.token), "push", "-u", "origin", state.integrationBranch],
      300_000,
    );
    pushed = push.ok;
    if (!push.ok) log(`  push failed: ${push.stderr.slice(-200)}`);
  }

  if (!pushed || decision.kind === "nothing") {
    const why = pushed ? decision.why : "nothing was pushed, so there is nothing to land";
    await github.comment(project.repo, issue.number, `${body}\n\n**Not landed.** ${why}`);
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    await notifier.send({
      title: `⚠️ council parked ${project.repo}#${issue.number}`,
      message: why,
      urgency: "attention",
      url: issue.url,
      data: { ...base, phase: state.phase },
    });
    return { ...base, phase: state.phase, action: "parked", why, spendUsd, branch: state.integrationBranch };
  }

  const defaultBranch = await github.defaultBranch(project.repo);
  let pr;
  try {
    pr = await github.createPullRequest(project.repo, {
      title: `${issue.title} (council #${issue.number})`,
      head: state.integrationBranch!,
      base: defaultBranch,
      body,
      draft: decision.kind === "pull_request" ? decision.draft : false,
    });
  } catch (error) {
    const why = `pull request could not be opened: ${
      error instanceof GitHubError ? error.body.slice(0, 200) : (error as Error).message
    }`;
    await github.comment(project.repo, issue.number, `${body}\n\n**Not landed.** ${why}`);
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    return { ...base, phase: state.phase, action: "parked", why, spendUsd, branch: state.integrationBranch };
  }

  if (decision.kind === "pull_request") {
    await github.comment(
      project.repo,
      issue.number,
      `Council opened ${pr.url}${decision.draft ? " as a draft" : ""} — **not merged**: ${decision.why}`,
    );
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    await notifier.send({
      title: `📝 council needs you — ${project.repo}#${issue.number}`,
      message: `${decision.why}\n${pr.url}`,
      urgency: "attention",
      url: pr.url,
      data: { ...base, pr: pr.url, phase: state.phase },
    });
    return {
      ...base,
      phase: state.phase,
      action: "pull_request",
      why: decision.why,
      branch: state.integrationBranch,
      pullRequest: pr.url,
      spendUsd,
    };
  }

  const merge = await options.github.mergePullRequest(
    project.repo,
    pr.number,
    config.autonomy.mergeMethod,
    `${issue.title} (council #${issue.number})`,
  );
  if (!merge.merged) {
    const why = `merge refused by GitHub: ${merge.reason ?? "unknown"}`;
    await github.comment(project.repo, issue.number, `${pr.url} is open but **not merged** — ${why}`);
    await github.addLabels(project.repo, issue.number, [baseConfig.sweep.parkedLabel]);
    await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
    await notifier.send({
      title: `⚠️ council could not merge ${project.repo}#${issue.number}`,
      message: why,
      urgency: "attention",
      url: pr.url,
    });
    return {
      ...base,
      phase: state.phase,
      action: "pull_request",
      why,
      pullRequest: pr.url,
      branch: state.integrationBranch,
      spendUsd,
    };
  }

  await github.comment(project.repo, issue.number, `Merged ${pr.url} — ${decision.why}.`);
  await github.removeLabel(project.repo, issue.number, baseConfig.sweep.runningLabel);
  if (config.autonomy.closeIssueOnMerge) await github.closeIssue(project.repo, issue.number);
  if (config.autonomy.deleteBranchOnMerge) {
    await github.deleteBranch(project.repo, state.integrationBranch!);
  }
  await notifier.send({
    title: `✅ council merged ${project.repo}#${issue.number}`,
    message: `${issue.title}\n${pr.url}`,
    urgency: "info",
    url: pr.url,
    data: { ...base, pr: pr.url, spendUsd },
  });

  return {
    ...base,
    phase: state.phase,
    action: "merged",
    why: decision.why,
    branch: state.integrationBranch,
    pullRequest: pr.url,
    spendUsd,
  };
}

/** A clean checkout at the repository's default branch, cloned if needed. */
async function ensureCheckout(options: TaskRunOptions): Promise<string> {
  const { project, workRoot, token } = options;
  if (project.dir) {
    if (!existsSync(join(project.dir, ".git"))) {
      throw new Error(`${project.dir} is not a git checkout`);
    }
    await resetToDefault(project.dir, project.repo, options);
    return project.dir;
  }

  await mkdir(workRoot, { recursive: true });
  const dir = join(workRoot, project.repo.replace("/", "__"));
  if (!existsSync(join(dir, ".git"))) {
    // The token goes in the URL for the clone and is then replaced by a
    // credential-free remote, so it is never left sitting in .git/config.
    const clone = await git(workRoot, [
      "clone",
      `https://x-access-token:${token}@github.com/${project.repo}.git`,
      dir,
    ], 600_000);
    if (!clone.ok) throw new Error(`clone failed: ${clone.stderr.slice(-300)}`);
    await git(dir, ["remote", "set-url", "origin", `https://github.com/${project.repo}.git`]);
  }
  await resetToDefault(dir, project.repo, options);
  return dir;
}

async function resetToDefault(dir: string, repo: string, options: TaskRunOptions): Promise<void> {
  const branch = await options.github.defaultBranch(repo);
  const auth = authArgs(options.token);
  const fetched = await git(dir, [...auth, "fetch", "origin", branch, "--depth", "50"], 300_000);
  if (!fetched.ok) throw new Error(`fetch failed: ${fetched.stderr.slice(-300)}`);
  await git(dir, ["checkout", "-B", branch, `origin/${branch}`]);
  await git(dir, ["reset", "--hard", `origin/${branch}`]);
  await git(dir, ["clean", "-fd", "-e", ".council"]);
}

/** The machine-readable sweep report: what a dashboard reads. */
async function writeReport(config: CouncilConfig, report: SweepReport): Promise<void> {
  await mkdir(config.councilHome, { recursive: true });
  await writeFile(join(config.councilHome, "sweep.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
