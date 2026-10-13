/**
 * Turning a GitHub issue into a council brief.
 *
 * The issue is the task: you file one from your phone with the label, and the
 * sweep picks it up. The title is the goal; optional `## Constraints` and
 * `## Acceptance` sections become the brief's constraints and acceptance
 * commands, which is what gives an autonomous run an objective gate the issue
 * author chose.
 *
 * The task id is derived from the repository and issue number, so a task that
 * is re-run appends to the same ledger thread instead of starting a new one.
 */

import type { BriefInput } from "../council.js";
import type { GitHubIssue } from "../github.js";

export interface IssueTask {
  readonly issue: GitHubIssue;
  readonly repo: string;
  readonly brief: BriefInput;
}

const SECTION = /^\s{0,3}#{1,6}\s*(.+?)\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

/** Collect the bullets (or plain lines) under any heading matching `pattern`. */
export function sectionItems(body: string, pattern: RegExp): string[] {
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = line.match(SECTION);
    if (heading) {
      inside = pattern.test(heading[1] ?? "");
      continue;
    }
    if (!inside) continue;
    const bullet = line.match(BULLET);
    if (bullet?.[1]) {
      items.push(stripFence(bullet[1]));
      continue;
    }
    // A non-empty, non-bullet line inside the section counts too, so a single
    // sentence does not need to be a list.
    const text = line.trim();
    if (text) items.push(stripFence(text));
  }
  return items;
}

function stripFence(text: string): string {
  return text.replace(/^`+|`+$/g, "").trim();
}

/** The prose before the first heading: extra goal detail the title could not hold. */
export function leadParagraph(body: string): string {
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (SECTION.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function taskIdFor(repo: string, issueNumber: number): string {
  return `gh-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${issueNumber}`;
}

export function toTask(repo: string, issue: GitHubIssue): IssueTask {
  const lead = leadParagraph(issue.body);
  const constraints = sectionItems(issue.body, /^(constraints?|rules?|limits?)$/i);
  const acceptance = sectionItems(issue.body, /^(acceptance|acceptance criteria|checks?|done when|definition of done)$/i);

  return {
    issue,
    repo,
    brief: {
      goal: lead ? `${issue.title}\n\n${lead}` : issue.title,
      constraints,
      acceptance,
      taskId: taskIdFor(repo, issue.number),
    },
  };
}
