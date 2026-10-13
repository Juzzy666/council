/**
 * A small GitHub REST client: issues in, pull requests out.
 *
 * Hand-rolled over `fetch` rather than pulling in a client library, for two
 * reasons: this needs exactly nine calls, and `fetch` is injectable, so the
 * whole autonomous path can be tested offline against a scripted transport
 * instead of against github.com.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly url: string;
  readonly author: string;
  readonly updatedAt: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

export interface GitHubClientOptions {
  readonly token: string;
  /** Override for GitHub Enterprise, or for tests. */
  readonly baseUrl?: string;
  readonly fetcher?: Fetcher;
  readonly userAgent?: string;
}

export class GitHubClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetcher;
  readonly #userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#fetch = options.fetcher ?? ((url, init) => fetch(url, init));
    this.#userAgent = options.userAgent ?? "council/0.1";
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.#userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubError(
        response.status,
        text,
        `${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Open issues carrying every one of `labels`. Pull requests are filtered out. */
  async listIssues(repo: string, labels: readonly string[], limit = 20): Promise<GitHubIssue[]> {
    const query = new URLSearchParams({
      state: "open",
      per_page: String(Math.min(limit, 100)),
      sort: "created",
      direction: "asc",
    });
    if (labels.length > 0) query.set("labels", labels.join(","));
    const raw = await this.#request<
      {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        updated_at: string;
        user?: { login?: string };
        labels: ({ name?: string } | string)[];
        pull_request?: unknown;
      }[]
    >("GET", `/repos/${repo}/issues?${query.toString()}`);

    return raw
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")),
        url: issue.html_url,
        author: issue.user?.login ?? "unknown",
        updatedAt: issue.updated_at,
      }));
  }

  async addLabels(repo: string, issue: number, labels: readonly string[]): Promise<void> {
    await this.#request("POST", `/repos/${repo}/issues/${issue}/labels`, { labels });
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    try {
      await this.#request("DELETE", `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      // Removing a label the issue no longer carries is not a failure: the
      // sweep must stay idempotent after a crash mid-claim.
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }
  }

  async comment(repo: string, issue: number, body: string): Promise<void> {
    await this.#request("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
  }

  async closeIssue(repo: string, issue: number, reason: "completed" | "not_planned" = "completed"): Promise<void> {
    await this.#request("PATCH", `/repos/${repo}/issues/${issue}`, { state: "closed", state_reason: reason });
  }

  async createPullRequest(
    repo: string,
    input: { title: string; head: string; base: string; body: string; draft?: boolean },
  ): Promise<PullRequest> {
    const raw = await this.#request<{ number: number; html_url: string; draft?: boolean }>(
      "POST",
      `/repos/${repo}/pulls`,
      { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft ?? false },
    );
    return {
      number: raw.number,
      url: raw.html_url,
      head: input.head,
      base: input.base,
      draft: raw.draft ?? input.draft ?? false,
    };
  }

  /** Merge a pull request. Returns false when GitHub refuses (branch protection, conflict, not mergeable). */
  async mergePullRequest(
    repo: string,
    number: number,
    method: "merge" | "squash" | "rebase",
    title?: string,
  ): Promise<{ merged: boolean; reason?: string }> {
    try {
      await this.#request("PUT", `/repos/${repo}/pulls/${number}/merge`, {
        merge_method: method,
        ...(title ? { commit_title: title } : {}),
      });
      return { merged: true };
    } catch (error) {
      if (error instanceof GitHubError) return { merged: false, reason: `${error.status}: ${error.body.slice(0, 200)}` };
      throw error;
    }
  }

  async defaultBranch(repo: string): Promise<string> {
    const raw = await this.#request<{ default_branch: string }>("GET", `/repos/${repo}`);
    return raw.default_branch;
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.#request("DELETE", `/repos/${repo}/git/refs/heads/${branch}`);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }
  }
}

/** Resolve a token from the environment. Named so a failure says what to set. */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env["COUNCIL_GITHUB_TOKEN"] ?? env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? null;
}
