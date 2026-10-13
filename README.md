# council

Claude Code and Meta's Muse working one task together as peers — planning
independently, arguing about the plan, splitting the work into isolated git
worktrees, reviewing each other's diffs, and only landing when the repository's
own tests pass on the merged result.

Not a wrapper that asks two models the same question and keeps the nicer
answer. The point of a second seat is the **power to refuse**: a plan ships only
if both agents vote for it, and a diff lands only after the other agent has
tried to find what is wrong with it.

```
                 brief
                   │
        ┌──────────┴──────────┐        neither seat can see
     plan (Claude)      plan (Muse)    the other's plan yet
        └──────────┬──────────┘
                cross-critique         each judges the other, and
                   │                   returns the plan it would sign
              unanimous vote           ─── no unanimity ──▶ another round,
                   │                        then a human (or a judge seat)
            split into units
                   │
        ┌──────────┴──────────┐        separate worktrees,
    build (Claude)      build (Muse)   separate branches,
        └──────────┬──────────┘        live peer channel open
               cross-review            nobody reviews their own work
                   │
         the repo's own checks          ◀── the deciding vote
                   │
          integration merge
```

Everything either agent says is appended to a **hash-chained ledger**, so a run
can be replayed, audited, and shown not to have been quietly rewritten.

## Requirements

| | |
|---|---|
| Node | 20 or newer (verified on 22.22) |
| Claude Code | the `claude` CLI on `PATH` (verified against **2.1.296**) |
| Muse Code | the `muse` CLI on `PATH`, plus `npm i @muse-code/sdk` (optional dependency, verified against **1.4.7**) |

Muse Code installs with Meta's own installer (`curl -fsSL https://dev.meta.ai/install.sh | bash`,
per Meta's docs) and needs `META_API_KEY` for non-interactive use. A council
with only one of the two installed still runs — it says in the ledger that it
degraded to a single seat, and skips the critique and review phases rather than
pretending to have held them.

## Install

```sh
git clone <this repo> && cd council
npm install
npm run build
npm link            # or call dist/cli.js directly
```

## Use

```sh
cd ~/your-project
council init        # writes council.config.json and the Muse MCP snippet
council doctor      # are both seats reachable? what will be used as the gate?

council plan "make the retry loop give up after 5 minutes"     # plan only, touches nothing
council run  "make the retry loop give up after 5 minutes"

council status      # where the last run got to
council replay <taskId>   # the whole timeline, event by event
council verify      # is the ledger's hash chain intact?
```

A finished run leaves an integration branch, `council/<task>/integration`, with
one commit per work unit and a merge commit per seat. Nothing is pushed unless
you pass `--push`.

### What a run looks like

A real single-seat run on a two-function fixture, for $0.0422:

```
#016 claude  spend — $0.0110
#017 claude  unit_implemented — verify (no diff!) commits=0
#021 engine  phase_entered → verification
#022 claude  check_run — pass: npm test
#024 engine  check_run — pass: npm test
#025 engine  integration_result — merged + green (council/t_mv63vi6v/integration)
#026 engine  task_closed — done
```

## The live peer channel

Phase boundaries are not enough. A seat halfway through a unit needs to ask its
peer *now* — "you own the schema, does this column already exist?" — and get the
answer inside the same turn. Both seats are handed the same MCP server:

| tool | what it does |
|---|---|
| `read_ledger` | read what the peer has planned, built, reviewed or noted |
| `post_note` | write a decision or a surprise into the shared ledger |
| `ask_peer` | ask the other seat a question and wait for its answer |
| `request_real_world_action` | mint a real-world action for a human to approve |
| `flag_blocker` | record being stuck, without derailing the run |

`ask_peer` carries a depth that decrements on each hop and refuses at zero, the
answering turn is always read-only, and every question and answer lands in the
ledger.

Claude Code needs no setup: the council passes `--mcp-config` inline, per run.
Muse Code is wired through a council-managed config home (`XDG_CONFIG_HOME`) —
see **Known limits** for why that is the path rather than per-session config.

## Safety model

- **Each seat writes only in its own worktree.** Two agents in one checkout can
  silently clobber each other. In worktrees the worst case is a merge conflict,
  which the council reports with the conflicting files instead of resolving
  blind. There is a test for exactly this: a seat that edits outside its unit is
  caught at integration, and the other seat's branch is provably untouched.
- **Read-only turns are enforced by removing the tools**, not by asking nicely.
  Planning, critique, voting and review turns run without `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`, `Bash` or `KillShell` on the Claude seat, and
  under MSP `approvalMode: "denyUnmatched"` on the Muse seat.
- **Your checkout is never touched.** Uncommitted changes are noted and ignored;
  the council only adds worktrees under its own home and branches under
  `council/`.
- **The council home ignores itself** (a `.gitignore` containing `*`), so a run
  never shows up as untracked noise in the repository it is working on.
- **Budget ceilings** are enforced per task and per turn, and a turn that would
  cross the task ceiling is refused rather than started.
- **Nothing in the real world fires itself.** See below.

## The two Muses

Meta shipped two different products under the name, and this repo treats them as
different things:

- **Muse Code** — the terminal coding agent (beta 5 Aug 2026, out of beta 31 Aug
  2026), driven over the Muse Session Protocol with the official SDK. This is
  the **seat at the table**.
- **Muse** — the consumer personal agent app (launched 8 Sep 2026; iOS, Android,
  muse.ai and WhatsApp) that sends email, books travel, fills forms and checks
  out purchases. This is **not** a seat, and the council cannot drive it.

There is no official automation API for the consumer app, so the council never
pretends to have one. A seat that needs a real-world action calls
`request_real_world_action`, which **mints a request and stops**:

```sh
council actions list
council actions approve act_1a2b3c      # a human, every time
council actions deny    act_1a2b3c
```

Approved requests are either printed for you to paste into Muse, or handed to a
bridge command you configured yourself (`museApp.bridgeCmd`, unofficial by
definition). Anything that looks irreversible — buy, pay, send, book, delete,
transfer — is flagged as such and cannot be delivered without an explicit
approval. Meta's own position is that prompt injection remains unsolved and a
separate agent must approve outgoing actions; a council that fired purchases off
the back of repository text would be that hazard with extra steps.

## Configuration

`council.config.json` in the repository root. Everything is optional.

```jsonc
{
  "baseRef": "HEAD",                  // what the seats branch from
  "seats": {
    "claude": {
      "enabled": true,
      "bin": "claude",
      "model": "opus",                // omit for the CLI's own default
      "permissionMode": "acceptEdits",
      "effort": "high",
      "extraArgs": []
    },
    "muse": {
      "enabled": true,
      "bin": "muse",
      "args": ["serve"],              // the MSP host the SDK drives
      "modelId": null,
      "approvalMode": "promptUnmatched",
      "autoApproveTools": ["read", "grep", "edit", "write", "shell"],
      "permissionProfile": null
    }
  },
  "budget": { "perTaskUsd": 10, "perTurnUsd": 2.5 },
  "limits": {
    "critiqueRounds": 2,              // rounds before a deadlock is escalated
    "reviewRounds": 2,                // fix-and-re-review rounds per unit
    "peerDepth": 2,                   // ask_peer hops allowed inside one turn
    "turnTimeoutMs": 900000
  },
  "tiebreak": "human",                // or "judge" + "judgeSeat"
  "checks": [],                       // empty = detect from the repo
  "requireChecks": true,              // no gate at all => escalate, never "done"
  "museApp": { "enabled": false, "requireHumanApproval": true },
  "push": false
}
```

`COUNCIL_BUDGET_USD`, `COUNCIL_PEER_DEPTH` and `COUNCIL_PUSH` override the file,
so CI can cap a run without editing a tracked file.

## Tests

```sh
npm test                                        # 67 offline tests, no API key, no network
COUNCIL_LIVE=1 COUNCIL_LIVE_MODEL=haiku \
  node --test dist-test/test/live.test.js       # 4 tests against the real claude CLI
```

The offline suite runs the **whole council** with scripted seats — real git
worktrees, a real merge, and the fixture repo's own test command deciding the
outcome. The fixture's test passes only when both seats' files are present, so a
green run proves the integration merge actually happened. The peer channel is
tested by connecting to it with the official MCP client, the same way a real
runtime does.

## Running it unattended

A council you have to sit with is a demo. The sweep is the part that runs
without you: it reads labelled GitHub issues across the repositories you list,
convenes the council on each, and lands the result.

```sh
council sweep                 # one pass over every configured project
council sweep --dry-run       # what it would do; claims nothing, writes nothing
council sweep --only you/repo # one project
council publish               # push the report to Vercel Blob for a status page
```

**A task is an issue.** File one with the `council` label; the title is the
goal. Two optional sections make the run much better:

```markdown
The retry loop pins a core and never gives up.

## Constraints
- do not change the public API

## Acceptance
- `npm test`
- `npm run lint`
```

The acceptance commands become the objective gate for that task — the thing
that decides whether the work is merged or handed back to you.

**What it does with the result**, set by `autonomy`:

| situation | what happens |
|---|---|
| done, every unit approved, repo's checks green | merged, issue commented and closed, branch deleted |
| checks failed, or the seats escalated | branch pushed, **draft** PR opened, issue labelled `council:parked`, you are notified |
| repository declares no checks | branch pushed, PR opened, **never merged** — nothing verified it (`mergeWithoutChecks` overrides this) |
| GitHub refuses the merge (branch protection, conflict) | reported once on the issue, never retried in a loop |

A task is claimed by label swap (`council` → `council:running`) *before* the
work starts, so an overlapping sweep cannot pick up the same issue. The
`sweep.budgetUsd` ceiling spans the whole pass, not one task. A repository that
is not listed in `projects` is never touched.

### Where the loop runs

The sweep needs a git checkout, worktrees and two CLI binaries for minutes at a
time, so it needs real compute. Three ways, same command:

- **GitHub Actions** — `examples/github-actions/` has a scheduled sweep and a
  watchdog that redispatches it if a cron is dropped.
- **Vercel Sandbox** — `examples/vercel-sandbox/` has a route that starts a
  sandbox (45 min on Hobby, up to 24 h on Pro/Enterprise) and returns at once,
  so the function's own duration limit never applies to the run.
- **Anything with cron** — `council sweep` on a timer on a machine you own.

### Seeing it without reading logs

`council publish` uploads the sweep report to Vercel Blob, and
`examples/dashboard/council.html` is a single static page that renders it: what
merged, what is waiting for you and why, and what it cost. Drop it into a site
you already host and point `BLOB_URL` at the published object.

## Known limits

Stated rather than hidden, because each one would otherwise look like a bug:

- **The Muse seat has never been executed.** This is the big one. The adapter is
  written against the published `@muse-code/sdk` 1.4.7 types and the committed
  MSP protocol schema and typechecks against both, but Meta's installer host was
  unreachable from the machine this was built on, so not one live Muse turn has
  run. Everything demonstrated end to end — plans, worktrees, cross-review, the
  merge, the peer channel — was the Claude seat. Do a supervised two-seat run
  (`council plan` is cheapest) before trusting an unattended one.
- **Muse Code reports no cost.** `turn/completed` carries duration and a
  terminal, not dollars, so the spend figure covers the Claude seat only. The
  CLI says so wherever it prints spend, instead of implying the Muse turns were
  free.
- **Muse's per-session MCP config is not reachable through the SDK facade.** MSP
  defines `SessionConfig.mcpServers`, but `StartSessionOptions` omits `config`
  (`@muse-code/sdk` 1.4.7), so the council writes a settings file into a private
  config home and points the host at it with `XDG_CONFIG_HOME`. Meta's own
  settings documentation was unreachable from the machine this was built on
  (`dev.meta.ai` is not resolvable there), so the file carries both spellings
  seen in the wild — `mcp_servers` and `mcpServers` — and `council doctor`
  prints the path so a mismatch is visible rather than silent. **Verify this
  against Meta's current docs before relying on mid-turn `ask_peer` from the
  Muse seat.** Everything else about the Muse seat works without it: plans,
  critiques, votes, implementation and review all go through the engine.
- **No structured-output verb on MSP.** `turn/start` has no JSON-schema member,
  so the Muse seat is asked for JSON in the prompt and the answer is parsed out
  of the reply. The Claude seat uses `--json-schema` and gets
  `structured_output` back.
- **MCP protocol revision.** The server is built on the official TypeScript SDK
  (1.32.1), whose `LATEST_PROTOCOL_VERSION` is `2025-11-25`. Press reporting
  describes a larger `2026-07-28` revision that removes the initialize
  handshake; that could not be confirmed against the official specification
  from this environment, and the SDK does not list it. Version negotiation is
  the SDK's.
- **A repository with no checks cannot be verified.** `requireChecks` (on by
  default) makes that an escalation rather than a pass: the branch is merged and
  kept, but the run is never called `done` on the strength of agreement alone.
- **Single-seat runs are not councils.** With one seat there is no critique and
  no cross-review. The ledger records that as a degraded run.

## Two things learned the hard way

Both cost a real run, and both are now covered by tests:

1. **`--permission-mode plan` auto-denies MCP tools.** A read-only turn in plan
   mode cannot call the council channel at all ("Plan mode is active and this
   session has no way to approve the call"). Read-only is therefore enforced
   with `manual` plus a tool deny-list, which leaves the peer channel reachable
   while a write attempt still comes back `BLOCKED` with no file created.
2. **`claude --session-id` takes a UUID and nothing else.** A readable key like
   `t_abc-claude` fails the turn before the model is called. Keys are hashed into
   stable UUIDs, and a second turn on the same key `--resume`s rather than trying
   to create an id that already exists.

## Layout

```
src/protocol.ts      the vocabulary both seats speak
src/ledger.ts        append-only, hash-chained, replayable
src/council.ts       the phase engine
src/consensus.ts     plan hashing, unanimity, work splitting
src/prompts.ts       the seats' instructions and JSON contracts
src/git.ts           worktrees, per-unit diffs, the integration merge
src/checks.ts        detecting and running the repo's own gate
src/adapters/        claude-code · muse-code · muse-app · fake
src/mcp/server.ts    the live peer channel
src/cli.ts           the command line

src/sweep.ts         the unattended pass over every project
src/landing.ts       what an autonomous run may do to a repository
src/github.ts        issues in, pull requests out
src/sources/         turning a GitHub issue into a brief
src/notify.ts        ntfy and webhook reporting
src/publish.ts       the sweep report, for a status page

examples/github-actions/   scheduled sweep + watchdog
examples/vercel-sandbox/   run it on your own Vercel infrastructure
examples/dashboard/        a static status page
```

## License

MIT
