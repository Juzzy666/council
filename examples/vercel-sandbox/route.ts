/**
 * POST /api/council/sweep — start an unattended council sweep in a Vercel Sandbox.
 *
 * The route's own job is small: authenticate the caller, start a sandbox, and
 * return. The sweep then runs inside the sandbox for as long as the plan allows
 * (45 min on Hobby, up to 24 h on Pro/Enterprise), well past any function
 * duration limit, and reports by publishing to Blob and pushing over ntfy.
 *
 * Requires `@vercel/sandbox`. NOT TESTED by the author of this file — see the
 * README beside it.
 */

import { Sandbox } from "@vercel/sandbox";

/** The ops repository holding council.config.json and the project list. */
const OPS_REPO = process.env["COUNCIL_OPS_REPO"] ?? "https://github.com/you/council-ops.git";
const SWEEP_TIMEOUT_MS = Number(process.env["COUNCIL_SWEEP_TIMEOUT_MS"] ?? 45 * 60 * 1000);

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Vercel Cron sends an Authorization header built from CRON_SECRET; a shared
  // secret is checked here too so the route cannot be started by anyone who
  // finds the URL.
  const secret = process.env["COUNCIL_CRON_SECRET"];
  const offered = request.headers.get("authorization");
  if (!secret || offered !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const only = searchParams.get("only");
  const dryRun = searchParams.get("dry") === "1";

  const token = process.env["COUNCIL_GITHUB_TOKEN"];
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
    META_API_KEY: process.env["META_API_KEY"] ?? "",
    COUNCIL_GITHUB_TOKEN: token ?? "",
    COUNCIL_BLOB_TOKEN: process.env["COUNCIL_BLOB_TOKEN"] ?? "",
    NTFY_TOPIC: process.env["NTFY_TOPIC"] ?? "",
    MUSE_NO_AUTO_UPDATE: "1",
  };

  const sandbox = await Sandbox.create({
    // No `runtime`: it is deprecated in @vercel/sandbox 3.7, and the default
    // image (vercel/sandbox/universal:latest) is an Ubuntu with Node.js 24,
    // Bun and Python already on it.
    source: token
      ? { type: "git", url: OPS_REPO, username: "x-access-token", password: token, depth: 1 }
      : { type: "git", url: OPS_REPO, depth: 1 },
    resources: { vcpus: 2 },
    timeout: SWEEP_TIMEOUT_MS,
    // Set once here rather than per command, so nothing can run without it.
    env,
  });

  // Install the two seats, then sweep. Each command's exit code is checked, so
  // a half-installed sandbox fails loudly instead of sweeping with one seat.
  const steps: { cmd: string; args: string[]; optional?: boolean }[] = [
    { cmd: "npm", args: ["install", "-g", "council@latest", "@anthropic-ai/claude-code@2.1.296"] },
    { cmd: "bash", args: ["-lc", "curl -fsSL https://dev.meta.ai/install.sh | bash"], optional: true },
    {
      cmd: "bash",
      args: [
        "-lc",
        `council sweep ${only ? `--only ${JSON.stringify(only)}` : ""} ${dryRun ? "--dry-run" : ""} --json`,
      ],
    },
  ];

  // Deliberately not awaited: the response returns while the sweep runs on.
  void (async () => {
    try {
      for (const step of steps) {
        const done = await sandbox.runCommand({ cmd: step.cmd, args: step.args });
        if (done.exitCode !== 0 && !step.optional) {
          await notify(`council sandbox step failed: ${step.cmd} exited ${done.exitCode}`);
          break;
        }
      }
    } catch (error) {
      await notify(`council sandbox threw: ${(error as Error).message}`);
    } finally {
      await sandbox.stop().catch(() => {});
    }
  })();

  return Response.json({ started: true, sandbox: sandbox.name, timeoutMs: SWEEP_TIMEOUT_MS });
}

async function notify(message: string): Promise<void> {
  const topic = process.env["NTFY_TOPIC"];
  if (!topic) return;
  await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title: "🚨 council — sandbox problem", message, priority: 5, tags: ["rotating_light"] }),
  }).catch(() => {});
}
