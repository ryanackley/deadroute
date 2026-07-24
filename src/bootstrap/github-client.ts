/**
 * HTTP client for the GitHub REST API (v3).
 * Mirrors the AtlassianClient pattern: Node fetch, retry on rate limits.
 *
 * Commits happen via local git in each dev's workspace, so this client only
 * covers what the API is needed for: PRs, reviews, merging, and CI status.
 */

export interface PullRequestResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  html_url: string;
}

export interface PullRequestFileResponse {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewResponse {
  id: number;
  user: { login: string };
  body: string | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at: string;
}

export interface ReviewCommentResponse {
  id: number;
  path: string;
  line: number | null;
  body: string;
  user: { login: string };
}

export interface CheckRunResponse {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  html_url: string;
}

export interface BranchResponse {
  name: string;
  commit: { sha: string };
}

export class GitHubClient {
  private baseUrl = "https://api.github.com";
  private authHeader: string;

  constructor(
    token: string,
    private owner: string,
    private repo: string,
  ) {
    this.authHeader = `Bearer ${token}`;
  }

  // ---- Low-level request with retry on rate limits ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let retries = 0;
    const maxRetries = 3;

    while (true) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: accept,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (rateLimited && retries < maxRetries) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "10", 10);
        retries++;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new GitHubApiError(method, path, res.status, text);
      }

      if (res.status === 204) return undefined as T;

      if (accept.includes("diff")) {
        return (await res.text()) as T;
      }
      return (await res.json()) as T;
    }
  }

  private repoPath(suffix: string): string {
    return `/repos/${this.owner}/${this.repo}${suffix}`;
  }

  // ---- Branches ----

  async getBranch(branch: string): Promise<BranchResponse> {
    return this.request<BranchResponse>(
      "GET",
      this.repoPath(`/branches/${encodeURIComponent(branch)}`),
    );
  }

  // ---- Pull Requests ----

  async createPullRequest(params: {
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }): Promise<PullRequestResponse> {
    return this.request<PullRequestResponse>("POST", this.repoPath("/pulls"), params);
  }

  async getPullRequest(prNumber: number): Promise<PullRequestResponse> {
    return this.request<PullRequestResponse>("GET", this.repoPath(`/pulls/${prNumber}`));
  }

  async listPullRequests(
    state: "open" | "closed" | "all" = "open",
  ): Promise<PullRequestResponse[]> {
    return this.request<PullRequestResponse[]>(
      "GET",
      this.repoPath(`/pulls?state=${state}&per_page=50`),
    );
  }

  async listPullRequestFiles(prNumber: number): Promise<PullRequestFileResponse[]> {
    return this.request<PullRequestFileResponse[]>(
      "GET",
      this.repoPath(`/pulls/${prNumber}/files?per_page=100`),
    );
  }

  /** Full unified diff of a PR (text). */
  async getPullRequestDiff(prNumber: number): Promise<string> {
    return this.request<string>(
      "GET",
      this.repoPath(`/pulls/${prNumber}`),
      undefined,
      "application/vnd.github.v3.diff",
    );
  }

  async createReview(
    prNumber: number,
    params: {
      body: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      comments?: { path: string; line: number; body: string }[];
    },
  ): Promise<ReviewResponse> {
    return this.request<ReviewResponse>(
      "POST",
      this.repoPath(`/pulls/${prNumber}/reviews`),
      params,
    );
  }

  async listReviews(prNumber: number): Promise<ReviewResponse[]> {
    return this.request<ReviewResponse[]>(
      "GET",
      this.repoPath(`/pulls/${prNumber}/reviews?per_page=50`),
    );
  }

  async listReviewComments(prNumber: number): Promise<ReviewCommentResponse[]> {
    return this.request<ReviewCommentResponse[]>(
      "GET",
      this.repoPath(`/pulls/${prNumber}/comments?per_page=100`),
    );
  }

  async mergePullRequest(
    prNumber: number,
    mergeMethod: "merge" | "squash" | "rebase" = "squash",
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    return this.request<{ merged: boolean; sha: string; message: string }>(
      "PUT",
      this.repoPath(`/pulls/${prNumber}/merge`),
      { merge_method: mergeMethod },
    );
  }

  /** Comment on the PR conversation (issue comment). */
  async addPullRequestComment(prNumber: number, body: string): Promise<{ id: number }> {
    return this.request<{ id: number }>(
      "POST",
      this.repoPath(`/issues/${prNumber}/comments`),
      { body },
    );
  }

  // ---- CI Status ----

  async getCheckRuns(ref: string): Promise<{ total_count: number; check_runs: CheckRunResponse[] }> {
    return this.request<{ total_count: number; check_runs: CheckRunResponse[] }>(
      "GET",
      this.repoPath(`/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`),
    );
  }
}

export class GitHubApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = "GitHubApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
