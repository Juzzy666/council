# Running the sweep on your own Vercel infrastructure

A council run needs minutes to hours, a git checkout, several worktrees and two
CLI binaries. That rules out a normal Vercel Function: Fluid compute on Pro
defaults to 300s and tops out at 800s (1800s on an extended, beta setting), and
the filesystem is not yours to keep.

**Vercel Sandbox is the piece that does fit.** It is an ephemeral Linux VM you
create from your own code, it runs arbitrary commands, it can be created from a
git repository, and its timeout is set per sandbox — up to 45 minutes on Hobby
and 24 hours on Pro/Enterprise. So the shape is:

```
Vercel Cron  ──▶  /api/council/sweep  ──▶  Sandbox (45 min … 24 h)
 (your site)        (returns at once)         ├─ install node, claude, muse
                                              ├─ council sweep
                                              └─ council publish ──▶ Blob
                                                                      │
                            hq/council.html  ◀───────────────────────┘
```

The route returns as soon as the sandbox is started, so the function's own
duration limit never applies to the run. The sandbox reports by publishing the
sweep report to Blob and by pushing notifications over ntfy, exactly as it does
when the sweep runs in GitHub Actions.

> **Typechecked, never executed.** `route.ts` compiles cleanly against
> `@vercel/sandbox` 3.7.0 under `--strict`, so the API calls are real ones —
> but it has never run: this was built in an environment with no Vercel
> credentials, and the Sandbox API needs a real project. Everything else in
> this repository was executed and tested. Run it once with `--dry-run` and
> `maxTasksPerRepo: 1`, and check the current Sandbox docs for your plan's
> duration cap before trusting the schedule.

## Environment the project needs

| variable | why |
|---|---|
| `ANTHROPIC_API_KEY` | the Claude Code seat |
| `META_API_KEY` | the Muse Code seat (omit for a Claude-only council) |
| `COUNCIL_GITHUB_TOKEN` | a PAT with repo scope on every project |
| `COUNCIL_BLOB_TOKEN` | publishes the report the status page reads |
| `NTFY_TOPIC` | optional push notifications |
| `COUNCIL_CRON_SECRET` | so only your cron can start a run |

## Cron

```json
{
  "crons": [{ "path": "/api/council/sweep", "schedule": "17 */6 * * *" }]
}
```

Hobby accounts are limited in how often cron may fire; if that bites, keep the
schedule in GitHub Actions (see `../github-actions/`) and let it call this route
instead — the sandbox still does the work on your own infrastructure.

## The config the sandbox reads

Put a `council.config.json` in the repository the sandbox clones (the "ops"
repo), listing the projects and the autonomy you want:

```json
{
  "autonomy": { "mode": "autonomous", "mergeWhenGreen": true },
  "sweep": { "labels": ["council"], "budgetUsd": 20, "maxTasksPerRepo": 2 },
  "notify": { "ntfyTopic": "your-topic" },
  "publish": { "blobPath": "council/sweep.json" },
  "projects": [{ "repo": "you/project-a" }, { "repo": "you/project-b" }]
}
```
