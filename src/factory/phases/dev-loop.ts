/**
 * Phase 3: Dev Loop — devs implement their tickets in local clones and
 * open PRs; the dev lead reviews every PR; change requests loop back to
 * the author until merged or the round cap is hit.
 *
 * Dev sessions run SEQUENTIALLY (not in parallel): agents verify their work
 * by actually running it, and concurrent dev servers would fight over ports
 * and confuse everyone.
 */

import chalk from "chalk";
import type { FactoryDeps } from "../deps.js";
import { toolContextFor } from "../deps.js";
import { runFactoryAgent } from "../../agents/factory-agent.js";
import { getFactoryProfile, FACTORY_PROFILES } from "../../personas/factory-profiles.js";
import { DEV_PERSONAS, type AIPersonaId, type PRInfo } from "../../types/factory.js";
import { ticketsFor } from "./planning.js";

const HOW_TO_RUN_TITLE = "How to Run & Test";

export async function runDevLoop(deps: FactoryDeps): Promise<void> {
  const sprintName = deps.state.activeSprintName || `Sprint ${deps.state.sprintNumber}`;
  console.log(chalk.blue(`\n── Phase: Development (${sprintName}) ──`));

  // ── Implementation sessions, one dev at a time ──
  for (const persona of DEV_PERSONAS) {
    const tickets = ticketsFor(deps, persona);
    if (tickets.length === 0) continue;
    await runDevSession(deps, persona, tickets);
    await deps.saveState();
  }

  // ── Review rounds ──
  for (let round = 1; round <= deps.config.factory.maxReviewRounds; round++) {
    const openPRs = await refreshPRs(deps);
    if (openPRs.length === 0) break;

    console.log(chalk.blue(`  Review round ${round}: ${openPRs.length} open PR(s)`));
    await runReviewSession(deps, openPRs);

    // PRs still open after review → authors address feedback
    const remaining = await refreshPRs(deps);
    if (remaining.length === 0) break;

    if (round === deps.config.factory.maxReviewRounds) {
      console.warn(
        chalk.yellow(
          `  ${remaining.length} PR(s) still open after ${round} review round(s) — escalating to the sprint report`,
        ),
      );
      break;
    }

    const byAuthor = new Map<AIPersonaId, PRInfo[]>();
    for (const pr of remaining) {
      const list = byAuthor.get(pr.author) || [];
      list.push(pr);
      byAuthor.set(pr.author, list);
    }
    for (const [author, prs] of byAuthor) {
      await runFixSession(deps, author, prs);
      await deps.saveState();
    }
  }
}

// ─── Sessions ────────────────────────────────────────────────────────

export async function runDevSession(
  deps: FactoryDeps,
  persona: AIPersonaId,
  ticketKeys: string[],
): Promise<void> {
  const profile = getFactoryProfile(persona);
  console.log(chalk.cyan(`  [${persona}] implementing: ${ticketKeys.join(", ")}`));

  await deps.workspaces.ensureWorkspace(persona, {
    name: profile.gitName || profile.displayName,
    email: profile.gitEmail || `${persona}@deadroute.app`,
  });
  await deps.workspaces.syncDefaultBranch(persona);
  const ws = deps.workspaces.workspaceFor(persona);

  const ticketLines = ticketKeys
    .map((k) => `- ${k}: ${deps.state.sprintTickets[k]?.summary || "(look it up)"}`)
    .join("\n");

  const context = `# ${deps.state.activeSprintName} — your assigned tickets

${ticketLines}

The Sprint Brief is the Confluence page "Sprint ${deps.state.sprintNumber} Brief" in PROD.
The team's run instructions live in the Confluence page "${HOW_TO_RUN_TITLE}" in ENG — create it if it doesn't exist, update it if your work changes how the product is run or tested. The tester can ONLY see that doc, never the code.`;

  const task = `Implement your assigned tickets, one at a time:

For each ticket:
1. get_jira_ticket for the full requirements; transition it to "In Progress".
2. Create a feature branch off ${deps.github.defaultBranch} (git checkout -b feature/<KEY>-short-name).
3. Implement. VERIFY your work: build it, run it, run the tests. Do not push unverified code.
4. Commit (message referencing the ticket key), push the branch, open a PR (create_pull_request, base "${deps.github.defaultBranch}").
5. Transition the ticket to "In Review" and comment with the PR number.

Before finishing: make sure the "${HOW_TO_RUN_TITLE}" page in ENG accurately covers how to install, run, and exercise everything you built. Write it for someone who cannot read the code.`;

  const result = await runFactoryAgent({
    profile,
    task,
    context,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    githubClient: deps.githubClients[persona],
    workspace: { cwd: ws.repoDir, confineTo: ws.dir },
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  for (const pr of result.github.prsCreated) {
    deps.state.prs.push({
      number: pr.number,
      title: pr.title,
      branch: pr.branch,
      author: persona,
      issueKey: matchTicketKey(pr.title, ticketKeys),
      state: "open",
      reviewRounds: 0,
    });
  }
  const howTo = result.atlassian.pagesCreated.find((p) => p.title === HOW_TO_RUN_TITLE);
  if (howTo) deps.state.howToRunPageId = howTo.id;

  console.log(
    chalk.dim(
      `    [${persona}] ${result.github.prsCreated.length} PR(s) opened; ` +
        `${result.atlassian.transitions.length} transition(s)`,
    ),
  );
}

async function runReviewSession(deps: FactoryDeps, openPRs: PRInfo[]): Promise<void> {
  const profile = getFactoryProfile("dev_lead");
  await deps.workspaces.syncDefaultBranch("dev_lead");
  const ws = deps.workspaces.workspaceFor("dev_lead");

  const prLines = openPRs
    .map((p) => `- PR #${p.number} "${p.title}" by ${p.author}${p.issueKey ? ` (${p.issueKey})` : ""}`)
    .join("\n");

  const context = `# Code review — open PRs\n\n${prLines}`;
  const task = `Review every open PR listed above:

1. get_pr_details for the full diff. Read it carefully against the ticket's acceptance criteria (get_jira_ticket).
2. If the code is correct and consistent: review_pull_request with APPROVE, then merge_pull_request.
3. If not: review_pull_request with REQUEST_CHANGES and specific, actionable comments (inline comments where they help).
4. Your own PRs: self-review honestly — state in the review body what you checked — then approve and merge if it holds up.
5. When a PR merges, comment on its Jira ticket that it's merged and awaiting testing (the ticket stays "In Review" until the tester passes it).`;

  await runFactoryAgent({
    profile,
    task,
    context,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    githubClient: deps.githubClients.dev_lead,
    workspace: { cwd: ws.repoDir, confineTo: ws.dir },
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });
}

async function runFixSession(deps: FactoryDeps, persona: AIPersonaId, prs: PRInfo[]): Promise<void> {
  const profile = getFactoryProfile(persona);
  console.log(chalk.cyan(`  [${persona}] addressing review feedback on ${prs.map((p) => `#${p.number}`).join(", ")}`));

  const ws = deps.workspaces.workspaceFor(persona);
  const prLines = prs.map((p) => `- PR #${p.number} "${p.title}" (branch ${p.branch})`).join("\n");

  const context = `# Review feedback to address\n\n${prLines}`;
  const task = `The dev lead requested changes on your PR(s) above. For each:
1. get_pr_feedback to read the review comments.
2. Check out the PR's branch in your clone, make the requested changes, and VERIFY them (build/run/test).
3. Commit and push to the same branch, then comment on the PR summarizing what you changed.`;

  await runFactoryAgent({
    profile,
    task,
    context,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    githubClient: deps.githubClients[persona],
    workspace: { cwd: ws.repoDir, confineTo: ws.dir },
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  for (const pr of prs) {
    const tracked = deps.state.prs.find((p) => p.number === pr.number);
    if (tracked) tracked.reviewRounds++;
  }
}

// ─── PR State Sync ───────────────────────────────────────────────────

/**
 * Refresh PR states from GitHub and return the PRs (tracked this sprint)
 * that are still open.
 */
export async function refreshPRs(deps: FactoryDeps): Promise<PRInfo[]> {
  const client = deps.githubClients.dev_lead;
  if (!client) return [];

  const open: PRInfo[] = [];
  for (const tracked of deps.state.prs) {
    if (tracked.state === "merged" || tracked.state === "closed") continue;
    try {
      const pr = await client.getPullRequest(tracked.number);
      if (pr.merged) {
        tracked.state = "merged";
      } else if (pr.state === "closed") {
        tracked.state = "closed";
      } else {
        const reviews = await client.listReviews(tracked.number);
        const latest = reviews.filter((r) => r.state !== "COMMENTED").pop();
        tracked.state = latest?.state === "CHANGES_REQUESTED" ? "changes_requested" : "open";
        open.push(tracked);
      }
    } catch (err) {
      console.warn(chalk.yellow(`  Could not refresh PR #${tracked.number}: ${err}`));
    }
  }
  return open;
}

function matchTicketKey(prTitle: string, candidates: string[]): string | null {
  for (const key of candidates) {
    if (prTitle.toUpperCase().includes(key.toUpperCase())) return key;
  }
  const m = prTitle.match(/\b(DR-\d+)\b/i);
  return m ? m[1].toUpperCase() : null;
}
