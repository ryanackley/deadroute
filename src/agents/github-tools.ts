/**
 * GitHub MCP tools for factory agents — PR lifecycle over the GitHub API.
 *
 * Commits and pushes happen via git in the agent's local workspace (Bash);
 * these tools cover what needs the API: opening PRs, reading review
 * feedback, and (dev lead only) reviewing and merging.
 *
 * Tools execute immediately against GitHub and return real results, and
 * record what happened into a shared GitHubActionLog for the engine.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GitHubClient } from "../bootstrap/github-client.js";

export interface GitHubActionLog {
  prsCreated: { number: number; title: string; branch: string }[];
  reviews: { prNumber: number; event: string }[];
  merges: number[];
}

export function createGitHubActionLog(): GitHubActionLog {
  return { prsCreated: [], reviews: [], merges: [] };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errText(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return text(`ERROR ${context}: ${msg}`);
}

// ─── Dev Tools (dev1, dev2, dev_lead) ────────────────────────────────

export function createDevGitHubTools(client: GitHubClient, log: GitHubActionLog) {
  return [
    tool(
      "create_pull_request",
      "Open a pull request from your pushed feature branch. Reference the Jira ticket key in the title.",
      {
        title: z.string().describe("PR title, e.g. 'DR-42: Add panic button endpoint'"),
        head: z.string().describe("Your feature branch name (must already be pushed)."),
        base: z.string().describe("Target branch, usually 'main'."),
        body: z.string().describe("PR description: what changed, why, how you verified it, and the Jira ticket key."),
      },
      async (args) => {
        try {
          const pr = await client.createPullRequest(args);
          log.prsCreated.push({ number: pr.number, title: pr.title, branch: args.head });
          return text(`PR #${pr.number} opened: ${pr.html_url}`);
        } catch (err) {
          return errText("creating PR", err);
        }
      },
    ),

    tool(
      "get_pr_feedback",
      "Read the reviews and review comments on one of your pull requests, to address requested changes.",
      {
        prNumber: z.number().describe("The pull request number."),
      },
      async (args) => {
        try {
          const [pr, reviews, comments] = await Promise.all([
            client.getPullRequest(args.prNumber),
            client.listReviews(args.prNumber),
            client.listReviewComments(args.prNumber),
          ]);
          const lines: string[] = [
            `PR #${pr.number} "${pr.title}" — state: ${pr.state}${pr.merged ? " (merged)" : ""}`,
          ];
          for (const r of reviews) {
            lines.push(`\n[${r.state}] review by ${r.user.login}:\n${r.body || "(no summary)"}`);
          }
          for (const c of comments) {
            lines.push(`\n${c.path}${c.line ? `:${c.line}` : ""} — ${c.body}`);
          }
          if (reviews.length === 0 && comments.length === 0) lines.push("No reviews yet.");
          return text(lines.join("\n"));
        } catch (err) {
          return errText("reading PR feedback", err);
        }
      },
    ),

    tool(
      "get_ci_status",
      "Check CI (GitHub Actions check runs) for a branch or commit SHA.",
      {
        ref: z.string().describe("Branch name or commit SHA."),
      },
      async (args) => {
        try {
          const { check_runs } = await client.getCheckRuns(args.ref);
          if (check_runs.length === 0) return text(`No check runs for ${args.ref} (CI may not be configured).`);
          const lines = check_runs.map(
            (c) => `${c.name}: ${c.status}${c.conclusion ? ` → ${c.conclusion}` : ""}`,
          );
          return text(lines.join("\n"));
        } catch (err) {
          return errText("checking CI status", err);
        }
      },
    ),
  ];
}

// ─── Dev Lead Tools (review + merge) ─────────────────────────────────

export function createLeadGitHubTools(client: GitHubClient, log: GitHubActionLog) {
  return [
    ...createDevGitHubTools(client, log),

    tool(
      "list_open_prs",
      "List all open pull requests in the repository.",
      {},
      async () => {
        try {
          const prs = await client.listPullRequests("open");
          if (prs.length === 0) return text("No open PRs.");
          const lines = prs.map(
            (p) => `#${p.number} "${p.title}" — branch ${p.head.ref} by ${p.user.login}${p.draft ? " (draft)" : ""}`,
          );
          return text(lines.join("\n"));
        } catch (err) {
          return errText("listing PRs", err);
        }
      },
    ),

    tool(
      "get_pr_details",
      "Get full details of a pull request including the complete diff, for code review.",
      {
        prNumber: z.number().describe("The pull request number."),
      },
      async (args) => {
        try {
          const [pr, files, diff] = await Promise.all([
            client.getPullRequest(args.prNumber),
            client.listPullRequestFiles(args.prNumber),
            client.getPullRequestDiff(args.prNumber),
          ]);
          const fileList = files
            .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
            .join("\n");
          // Cap very large diffs so the context stays manageable
          const cappedDiff = diff.length > 60_000 ? diff.slice(0, 60_000) + "\n... [diff truncated]" : diff;
          return text(
            `PR #${pr.number} "${pr.title}" by ${pr.user.login}\n` +
              `${pr.head.ref} → ${pr.base.ref} | mergeable: ${pr.mergeable}\n\n` +
              `Description:\n${pr.body || "(none)"}\n\nFiles:\n${fileList}\n\nDiff:\n${cappedDiff}`,
          );
        } catch (err) {
          return errText("reading PR details", err);
        }
      },
    ),

    tool(
      "review_pull_request",
      "Submit a code review on a pull request: approve, request changes, or comment.",
      {
        prNumber: z.number().describe("The pull request number."),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
        body: z.string().describe("Your review summary. For REQUEST_CHANGES, be specific and actionable."),
        comments: z
          .array(
            z.object({
              path: z.string().describe("File path in the diff."),
              line: z.number().describe("Line number in the file (new side of the diff)."),
              body: z.string().describe("The inline comment."),
            }),
          )
          .optional()
          .describe("Optional inline comments anchored to specific lines."),
      },
      async (args) => {
        try {
          await client.createReview(args.prNumber, {
            body: args.body,
            event: args.event,
            comments: args.comments,
          });
          log.reviews.push({ prNumber: args.prNumber, event: args.event });
          return text(`Review submitted on PR #${args.prNumber}: ${args.event}`);
        } catch (err) {
          return errText("submitting review", err);
        }
      },
    ),

    tool(
      "merge_pull_request",
      "Merge an approved pull request (squash merge).",
      {
        prNumber: z.number().describe("The pull request number."),
      },
      async (args) => {
        try {
          const result = await client.mergePullRequest(args.prNumber, "squash");
          log.merges.push(args.prNumber);
          return text(`PR #${args.prNumber} merged (${result.sha.slice(0, 7)}).`);
        } catch (err) {
          return errText("merging PR", err);
        }
      },
    ),
  ];
}
