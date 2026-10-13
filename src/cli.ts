#!/usr/bin/env node
/**
 * `council` — the command line.
 *
 * Deliberately boring output: a council run is something a human audits
 * afterwards, so every command prints facts (who said what, what passed, what
 * it cost) rather than a progress animation.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILENAME, loadConfig, type CouncilConfig } from "./config.js";
import { Council, defaultMcpServerPath, ensureCouncilHome } from "./council.js";
import { createSeats } from "./adapters/factory.js";
import { MuseAppLane } from "./adapters/muse-app.js";
import { writeMuseSettings } from "./adapters/muse-code.js";
import { Ledger, foldTask, ledgerPath } from "./ledger.js";
import { detectChecks } from "./checks.js";
import { currentBranch, isDirty, removeWorktree } from "./git.js";
import type { ActionRequest, LedgerEvent, TaskState } from "./protocol.js";

const USAGE = `council — a peer council between Claude Code and Meta's Muse

Usage:
  council run <goal...>        Convene the council on a task
  council plan <goal...>       Stop once a plan is agreed; touch nothing
  council doctor               Check both seats, the repo and the wiring
  council init                 Write ${CONFIG_FILENAME} and the Muse MCP snippet
  council status [taskId]      Where a task got to (latest task by default)
  council replay <taskId>      The full timeline, event by event
  council verify               Check the ledger's hash chain
  council actions [list|approve <id>|deny <id>]
                               The human gate for real-world Muse actions
  council clean <taskId>       Remove that task's worktrees
  council serve-mcp            Serve the peer channel (agents call this, not you)

Options for run/plan:
  --constraint <text>   Repeatable. A limit the plan may not trade away.
  --accept <command>    Repeatable. A command that proves the work.
  --base <ref>          Branch the work from this ref (default: HEAD)
  --budget <usd>        Ceiling for the whole task (default: config)
  --seat <id>           Repeatable. Restrict the table to these seats.
  --push                Push the integration branch when checks pass
  --repo <path>         Repository to work in (default: cwd)
  --json                Machine-readable result on stdout
`;

interface Args {
  readonly command: string;
  readonly rest: string[];
  readonly flags: Record<string, string[]>;
  readonly bools: Set<string>;
}

function parseArgs(argv: readonly string[]): Args {
  const [command = "help", ...tail] = argv;
  const rest: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  const valued = new Set(["constraint", "accept", "base", "budget", "seat", "repo", "task"]);
  for (let i = 0; i < tail.length; i += 1) {
    const token = tail[i]!;
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const name = token.slice(2);
    if (valued.has(name)) {
      const value = tail[i + 1];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      (flags[name] ??= []).push(value);
      i += 1;
    } else {
      bools.add(name);
    }
  }
  return { command, rest, flags, bools };
}

async function configFor(args: Args): Promise<CouncilConfig> {
  const repoRoot = resolve(args.flags["repo"]?.[0] ?? process.cwd());
  const overrides: Partial<CouncilConfig> = {};
  const base = args.flags["base"]?.[0];
  if (base) (overrides as { baseRef?: string }).baseRef = base;
  const budget = args.flags["budget"]?.[0];
  if (budget) (overrides as { budget?: CouncilConfig["budget"] }).budget = { perTaskUsd: Number(budget), perTurnUsd: Number(budget) / 4 };
  if (args.bools.has("push")) (overrides as { push?: boolean }).push = true;
  const config = await loadConfig(repoRoot, overrides);

  const seats = args.flags["seat"];
  if (!seats || seats.length === 0) return config;
  return {
    ...config,
    seats: {
      claude: { ...config.seats.claude, enabled: seats.includes("claude") },
      muse: { ...config.seats.muse, enabled: seats.includes("muse") },
    },
  };
}

function describeEvent(event: LedgerEvent): string {
  const p = event.payload as Record<string, unknown>;
  const head = `#${String(event.seq).padStart(3, "0")} ${event.ts.slice(11, 19)} ${event.actor.padEnd(7)} ${event.type}`;
  switch (event.type) {
    case "task_opened":
      return `${head} — ${(p["brief"] as { goal?: string } | undefined)?.goal ?? ""}`;
    case "phase_entered":
      return `${head} → ${String(p["phase"])}`;
    case "plan_submitted": {
      const plan = p["plan"] as { steps?: unknown[]; summary?: string };
      return `${head} — ${plan.steps?.length ?? 0} steps: ${(plan.summary ?? "").slice(0, 90)}`;
    }
    case "critique_submitted": {
      const critique = p["critique"] as { verdict?: string; findings?: unknown[]; targetAgent?: string };
      return `${head} — ${critique.verdict} on ${critique.targetAgent}, ${critique.findings?.length ?? 0} finding(s)`;
    }
    case "vote_cast": {
      const vote = p["vote"] as { position?: string; planHash?: string };
      return `${head} — ${vote.position} on ${String(vote.planHash).slice(0, 12)}`;
    }
    case "plan_agreed":
      return `${head} — ${p["unanimous"] ? "unanimous" : `tie-broken by ${p["tiebreakBy"] ?? "?"}`}, hash ${String(p["planHash"]).slice(0, 12)}`;
    case "unit_created": {
      const unit = p["unit"] as { id?: string; owner?: string; title?: string };
      return `${head} — ${unit.id} → ${unit.owner}: ${(unit.title ?? "").slice(0, 70)}`;
    }
    case "unit_implemented":
      return `${head} — ${p["unitId"]}${p["emptyDiff"] ? " (no diff!)" : ""} commits=${(p["commits"] as unknown[] | undefined)?.length ?? 0}`;
    case "review_submitted": {
      const review = p["review"] as { verdict?: string; unitId?: string; findings?: unknown[] };
      return `${head} — ${review.unitId}: ${review.verdict}, ${review.findings?.length ?? 0} finding(s)`;
    }
    case "check_run": {
      const result = p["result"] as { command?: string; ok?: boolean };
      return `${head} — ${result.ok ? "pass" : "FAIL"}: ${result.command}`;
    }
    case "peer_question":
      return `${head} → ${p["to"]}: ${String(p["question"]).slice(0, 80)}`;
    case "peer_answer":
      return `${head} ← ${p["from"]}: ${String(p["answer"] ?? "").slice(0, 80)}`;
    case "note":
      return `${head} — ${p["blocker"] ? "BLOCKER: " : ""}${String(p["text"] ?? "").slice(0, 100)}`;
    case "action_requested":
      return `${head} — ${(p["request"] as ActionRequest).id}: ${(p["request"] as ActionRequest).instruction.slice(0, 70)}`;
    case "escalated":
      return `${head} — ${String((p["escalation"] as { reason?: string }).reason)}`;
    case "integration_result":
      return `${head} — ${p["ok"] ? "merged + green" : "needs a human"} (${p["branch"]})`;
    case "spend":
      return `${head} — $${Number(p["usd"]).toFixed(4)}`;
    case "agent_error":
      return `${head} — ${String(p["error"]).slice(0, 100)}`;
    case "task_closed":
      return `${head} — ${p["phase"]}`;
    default:
      return head;
  }
}

function summarize(state: TaskState): string {
  const lines: string[] = [];
  lines.push(`task      ${state.brief.taskId}`);
  lines.push(`goal      ${state.brief.goal}`);
  lines.push(`phase     ${state.phase}`);
  lines.push(`seats     ${Object.keys(state.plans).join(", ") || "(none submitted a plan)"}`);
  if (state.agreedPlanHash) {
    lines.push(`plan      ${state.agreedPlanHash.slice(0, 12)} (${state.agreedPlan?.steps.length ?? 0} steps)`);
  }
  if (state.units.length > 0) {
    lines.push("units");
    for (const unit of state.units) {
      lines.push(`  ${unit.id.padEnd(18)} ${unit.owner.padEnd(7)} ${unit.status}`);
    }
  }
  if (state.reviews.length > 0) {
    lines.push("reviews");
    for (const review of state.reviews) {
      const blockers = review.findings.filter((f) => f.severity === "blocker" || f.severity === "major").length;
      lines.push(`  ${review.unitId.padEnd(18)} by ${review.agent.padEnd(7)} ${review.verdict} (${blockers} blocking)`);
    }
  }
  if (state.checks.length > 0) {
    lines.push("checks");
    for (const check of state.checks) {
      lines.push(`  ${check.ok ? "pass" : "FAIL"}  ${check.command}`);
    }
  }
  const spend = Object.entries(state.spendUsd);
  if (spend.length > 0) {
    lines.push(`spend     ${spend.map(([seat, usd]) => `${seat} $${usd.toFixed(4)}`).join("  ")}`);
    lines.push("          (Muse Code reports no cost on the wire; its turns are not in this figure)");
  }
  if (state.integrationBranch) lines.push(`branch    ${state.integrationBranch}`);
  if (state.escalation) {
    lines.push("");
    lines.push(`ESCALATED: ${state.escalation.reason}`);
    for (const [agent, position] of Object.entries(state.escalation.positions)) {
      lines.push(`  ${agent}: ${position}`);
    }
    lines.push(`  → ${state.escalation.question}`);
  }
  const pending = state.actionRequests.filter((request) => request.status === "pending");
  if (pending.length > 0) {
    lines.push("");
    lines.push("pending real-world actions (nothing was sent):");
    for (const request of pending) {
      lines.push(`  ${request.id}  ${request.irreversible ? "[irreversible] " : ""}${request.instruction}`);
    }
  }
  return lines.join("\n");
}

async function latestTaskId(ledger: Ledger): Promise<string | null> {
  const events = await ledger.read();
  const opens = events.filter((event) => event.type === "task_opened");
  return opens.at(-1)?.taskId ?? null;
}

async function cmdRun(args: Args, planOnly: boolean): Promise<number> {
  const goal = args.rest.join(" ").trim();
  if (!goal) {
    process.stderr.write("A goal is required: council run \"make the retry loop give up\"\n");
    return 2;
  }
  const config = await configFor(args);
  const adapters = createSeats(config);
  if (adapters.length === 0) {
    process.stderr.write("No seats are enabled. Check council.config.json or --seat.\n");
    return 2;
  }

  for (const adapter of adapters) {
    const availability = await adapter.availability();
    if (!availability.available) {
      process.stderr.write(`seat ${adapter.id} is not usable: ${availability.detail}\n`);
      process.stderr.write("Run `council doctor` for the full picture, or --seat to run with one seat.\n");
      return 2;
    }
  }

  process.stdout.write(`convening ${adapters.map((a) => a.label).join(" + ")} on: ${goal}\n\n`);
  const council = new Council({
    config,
    adapters,
    planOnly,
    onEvent: (event) => process.stdout.write(`${describeEvent(event)}\n`),
  });
  const state = await council.run({
    goal,
    constraints: args.flags["constraint"] ?? [],
    acceptance: args.flags["accept"] ?? [],
  });

  process.stdout.write(`\n${summarize(state)}\n`);
  if (args.bools.has("json")) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return state.phase === "done" ? 0 : 1;
}

async function cmdDoctor(args: Args): Promise<number> {
  const config = await configFor(args);
  const lines: string[] = [];
  let ok = true;

  lines.push(`repo      ${config.repoRoot}`);
  if (!existsSync(join(config.repoRoot, ".git"))) {
    lines.push("          NOT a git repository — the council needs one for worktrees");
    ok = false;
  } else {
    lines.push(`branch    ${await currentBranch(config.repoRoot)}${(await isDirty(config.repoRoot)) ? " (dirty — untouched by the council)" : ""}`);
  }
  lines.push(`home      ${config.councilHome}`);
  lines.push(`node      ${process.version}`);

  for (const adapter of createSeats(config)) {
    const availability = await adapter.availability();
    lines.push(
      `seat      ${adapter.id.padEnd(7)} ${availability.available ? "ready" : "UNAVAILABLE"} ${availability.version ?? ""} ${availability.available ? "" : `— ${availability.detail}`}`,
    );
    if (!availability.available) ok = false;
  }

  const checks = config.checks.length > 0 ? [...config.checks] : await detectChecks(config.repoRoot);
  lines.push(`checks    ${checks.length > 0 ? checks.join(" | ") : "none detected — the council will have no objective gate"}`);
  lines.push(`budget    $${config.budget.perTaskUsd} per task, $${config.budget.perTurnUsd} per turn`);
  lines.push(`tiebreak  ${config.tiebreak}`);
  lines.push(`museApp   ${config.museApp.enabled ? (config.museApp.bridgeCmd ? `bridge: ${config.museApp.bridgeCmd}` : "enabled, manual paste") : "disabled"}`);

  const ledger = new Ledger(ledgerPath(config.councilHome));
  if (existsSync(ledger.path)) {
    const broken = await ledger.verifyChain();
    lines.push(`ledger    ${broken ? `CHAIN BROKEN at #${broken.seq}: ${broken.reason}` : "chain intact"}`);
    if (broken) ok = false;
  } else {
    lines.push("ledger    none yet");
  }

  lines.push(`mcp       ${defaultMcpServerPath()}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

async function cmdInit(args: Args): Promise<number> {
  const config = await configFor(args);
  const path = join(config.repoRoot, CONFIG_FILENAME);
  if (existsSync(path) && !args.bools.has("force")) {
    process.stdout.write(`${CONFIG_FILENAME} already exists (pass --force to overwrite)\n`);
  } else {
    const seed = {
      baseRef: config.baseRef,
      seats: config.seats,
      budget: config.budget,
      limits: config.limits,
      tiebreak: config.tiebreak,
      checks: config.checks.length > 0 ? config.checks : await detectChecks(config.repoRoot),
      museApp: config.museApp,
      push: config.push,
    };
    await writeFile(path, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${path}\n`);
  }

  await ensureCouncilHome(config.councilHome);
  const settings = await writeMuseSettings(join(config.councilHome, "muse-config"), {
    serverPath: defaultMcpServerPath(),
    env: {
      COUNCIL_REPO_ROOT: config.repoRoot,
      COUNCIL_HOME: config.councilHome,
      COUNCIL_TASK_ID: "<set per run>",
      COUNCIL_SELF: "muse",
      COUNCIL_PEER: "claude",
      COUNCIL_PEER_DEPTH: String(config.limits.peerDepth),
    },
    toolNames: [],
  });
  process.stdout.write(
    [
      `wrote ${settings}`,
      "",
      "A run writes its own copy of that file with the live task id, so you do",
      "not need to wire Muse by hand. It is written here too so you can see",
      "exactly what Muse Code is handed, and copy it into your own",
      "~/.config/muse/settings.json if you would rather wire it permanently.",
      "",
      `Claude Code needs no setup: the council passes --mcp-config inline.`,
      "",
      "Next: council doctor",
    ].join("\n") + "\n",
  );
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const config = await configFor(args);
  const ledger = new Ledger(ledgerPath(config.councilHome));
  const taskId = args.rest[0] ?? (await latestTaskId(ledger));
  if (!taskId) {
    process.stdout.write("No council runs in this repository yet.\n");
    return 0;
  }
  const state = foldTask(await ledger.readTask(taskId));
  if (!state) {
    process.stderr.write(`No such task: ${taskId}\n`);
    return 2;
  }
  process.stdout.write(`${summarize(state)}\n`);
  if (args.bools.has("json")) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

async function cmdReplay(args: Args): Promise<number> {
  const config = await configFor(args);
  const ledger = new Ledger(ledgerPath(config.councilHome));
  const taskId = args.rest[0] ?? (await latestTaskId(ledger));
  if (!taskId) {
    process.stdout.write("No council runs in this repository yet.\n");
    return 0;
  }
  const events = await ledger.readTask(taskId);
  for (const event of events) process.stdout.write(`${describeEvent(event)}\n`);
  if (args.bools.has("json")) process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
  return 0;
}

async function cmdVerify(args: Args): Promise<number> {
  const config = await configFor(args);
  const ledger = new Ledger(ledgerPath(config.councilHome));
  if (!existsSync(ledger.path)) {
    process.stdout.write("No ledger yet.\n");
    return 0;
  }
  const broken = await ledger.verifyChain();
  if (broken) {
    process.stderr.write(`ledger chain broken at #${broken.seq}: ${broken.reason}\n`);
    return 1;
  }
  const events = await ledger.read();
  process.stdout.write(`ledger chain intact across ${events.length} event(s)\n`);
  return 0;
}

async function cmdActions(args: Args): Promise<number> {
  const config = await configFor(args);
  const ledger = new Ledger(ledgerPath(config.councilHome));
  await ledger.load();
  const [sub = "list", id] = args.rest;

  const all = await ledger.read();
  const requests = new Map<string, ActionRequest>();
  for (const event of all) {
    if (event.type === "action_requested") {
      const request = (event.payload as { request: ActionRequest }).request;
      requests.set(request.id, { ...request });
    }
    if (event.type === "action_decided") {
      const payload = event.payload as { id: string; status: ActionRequest["status"] };
      const existing = requests.get(payload.id);
      if (existing) existing.status = payload.status;
    }
  }

  if (sub === "list") {
    if (requests.size === 0) {
      process.stdout.write("No real-world action requests.\n");
      return 0;
    }
    for (const request of requests.values()) {
      process.stdout.write(
        `${request.id}  ${request.status.padEnd(9)} ${request.irreversible ? "[irreversible] " : ""}${request.instruction}\n    asked by ${request.requestedBy}: ${request.rationale}\n`,
      );
    }
    return 0;
  }

  if (!id) {
    process.stderr.write(`council actions ${sub} <id>\n`);
    return 2;
  }
  const request = requests.get(id);
  if (!request) {
    process.stderr.write(`No such action request: ${id}\n`);
    return 2;
  }
  if (sub === "deny") {
    await ledger.append({
      taskId: request.taskId,
      actor: "human",
      type: "action_decided",
      payload: { id, status: "denied", decidedBy: "cli" },
    });
    process.stdout.write(`${id} denied; nothing was sent.\n`);
    return 0;
  }
  if (sub !== "approve") {
    process.stderr.write(`Unknown subcommand: council actions ${sub}\n`);
    return 2;
  }

  const approved: ActionRequest = { ...request, status: "approved" };
  await ledger.append({
    taskId: request.taskId,
    actor: "human",
    type: "action_decided",
    payload: { id, status: "approved", decidedBy: "cli" },
  });
  const lane = new MuseAppLane(config.museApp);
  const outcome = await lane.deliver(approved);
  await ledger.append({
    taskId: request.taskId,
    actor: "human",
    type: "action_decided",
    payload: {
      id,
      status: outcome.delivered ? "delivered" : "approved",
      decidedBy: "cli",
      deliveryNote: outcome.note,
    },
  });
  process.stdout.write(`${outcome.delivered ? "delivered" : "approved but not delivered"}\n${outcome.note}\n`);
  return 0;
}

async function cmdClean(args: Args): Promise<number> {
  const config = await configFor(args);
  const taskId = args.rest[0];
  if (!taskId) {
    process.stderr.write("council clean <taskId>\n");
    return 2;
  }
  const base = join(config.councilHome, "worktrees", taskId);
  if (!existsSync(base)) {
    process.stdout.write(`Nothing to clean for ${taskId}.\n`);
    return 0;
  }
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(base)) {
    await removeWorktree(config.repoRoot, join(base, entry));
    process.stdout.write(`removed worktree ${entry}\n`);
  }
  process.stdout.write("Branches are left in place: `git branch -D council/<task>/<seat>` to drop them.\n");
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  switch (args.command) {
    case "run":
      return cmdRun(args, false);
    case "plan":
      return cmdRun(args, true);
    case "doctor":
      return cmdDoctor(args);
    case "init":
      return cmdInit(args);
    case "status":
      return cmdStatus(args);
    case "replay":
      return cmdReplay(args);
    case "verify":
      return cmdVerify(args);
    case "actions":
      return cmdActions(args);
    case "clean":
      return cmdClean(args);
    case "serve-mcp": {
      const { main: serve } = await import("./mcp/server.js");
      await serve();
      return 0;
    }
    case "version": {
      const pkg = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      process.stdout.write(`council ${pkg.version}\n`);
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return args.command === "help" || args.command === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    // serve-mcp keeps the process alive on purpose; everything else exits.
    if (process.argv[2] !== "serve-mcp") process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(`council failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
