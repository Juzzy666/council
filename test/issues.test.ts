import { test } from "node:test";
import assert from "node:assert/strict";
import { leadParagraph, sectionItems, taskIdFor, toTask } from "../src/sources/github-issues.js";
import type { GitHubIssue } from "../src/github.js";

const issue: GitHubIssue = {
  number: 42,
  title: "Retry loop should give up after 5 minutes",
  body: [
    "It currently retries forever and pins a core.",
    "",
    "## Constraints",
    "- do not change the public API",
    "- keep the existing log format",
    "",
    "## Acceptance",
    "- `npm test`",
    "- `npm run lint`",
  ].join("\n"),
  labels: ["council"],
  url: "https://github.com/o/r/issues/42",
  author: "juzzy666",
  updatedAt: "2026-10-13T00:00:00Z",
};

test("an issue becomes a brief with constraints and acceptance commands", () => {
  const task = toTask("o/r", issue);
  assert.match(task.brief.goal, /^Retry loop should give up after 5 minutes/);
  assert.match(task.brief.goal, /pins a core/);
  assert.deepEqual(task.brief.constraints, ["do not change the public API", "keep the existing log format"]);
  assert.deepEqual(task.brief.acceptance, ["npm test", "npm run lint"]);
  assert.equal(task.brief.taskId, "gh-o-r-42");
});

test("backticks are stripped so an acceptance item is a runnable command", () => {
  assert.deepEqual(sectionItems("## Checks\n- `pytest -q`", /^checks?$/i), ["pytest -q"]);
});

test("a section heading written any of the usual ways is found", () => {
  for (const heading of ["Acceptance", "Acceptance Criteria", "Done when", "Definition of Done", "checks"]) {
    const body = `## ${heading}\n- npm test`;
    assert.deepEqual(
      sectionItems(body, /^(acceptance|acceptance criteria|checks?|done when|definition of done)$/i),
      ["npm test"],
      `heading "${heading}" should be recognised`,
    );
  }
});

test("a single sentence under a heading counts, without being a list", () => {
  assert.deepEqual(sectionItems("### Constraints\nKeep it under 50 lines.", /^constraints?$/i), [
    "Keep it under 50 lines.",
  ]);
});

test("a bare issue still yields a usable brief", () => {
  const bare = { ...issue, body: "" };
  const task = toTask("o/r", bare);
  assert.equal(task.brief.goal, issue.title);
  assert.deepEqual(task.brief.constraints, []);
  assert.deepEqual(task.brief.acceptance, []);
});

test("prose after the last section is not mistaken for the lead", () => {
  assert.equal(leadParagraph("lead text\n\n## Constraints\n- a"), "lead text");
  assert.equal(leadParagraph("## Constraints\n- a"), "");
});

test("the task id is stable, so a re-run continues the same ledger thread", () => {
  assert.equal(taskIdFor("Juzzy666/Open-Tab", 7), taskIdFor("Juzzy666/Open-Tab", 7));
  assert.equal(taskIdFor("Juzzy666/Open-Tab", 7), "gh-juzzy666-open-tab-7");
  assert.notEqual(taskIdFor("o/r", 7), taskIdFor("o/r", 8));
});
