/**
 * Phase 4: Adversarial Testing — the tester probes the merged product
 * black-box in a source-stripped sandbox and files bugs; the engine then
 * runs fix rounds (triage → fix → review → re-test) until clean or capped.
 */

import chalk from "chalk";
import type { FactoryDeps } from "../deps.js";
import { toolContextFor } from "../deps.js";
import { runFactoryAgent } from "../../agents/factory-agent.js";
import { getFactoryProfile } from "../../personas/factory-profiles.js";
import { runDevSession, refreshPRs } from "./dev-loop.js";
import type { AIPersonaId } from "../../types/factory.js";

const HOW_TO_RUN_TITLE = "How to Run & Test";

export interface TestingOutcome {
  bugsFiled: string[];
  clean: boolean;
}

export async function runTestingPhase(deps: FactoryDeps): Promise<TestingOutcome> {
  const sprintN = deps.state.sprintNumber;
  console.log(chalk.blue(`\n── Phase: Adversarial Testing (Sprint ${sprintN}, round ${deps.state.fixRound + 1}) ──`));

  const bugs = await runTesterSession(deps);
  if (bugs.length === 0) {
    console.log(chalk.green("  ✓ Tester found no bugs"));
    return { bugsFiled: [], clean: true };
  }

  console.log(chalk.yellow(`  Tester filed ${bugs.length} bug(s): ${bugs.join(", ")}`));
  return { bugsFiled: bugs, clean: false };
}

async function runTesterSession(deps: FactoryDeps): Promise<string[]> {
  console.log(chalk.dim("  Preparing tester sandbox (fresh snapshot, .git stripped)..."));
  const ws = await deps.workspaces.prepareTesterSandbox();

  const sprintTickets = Object.values(deps.state.sprintTickets)
    .map((t) => `- ${t.key}: ${t.summary}`)
    .join("\n");

  const retest =
    deps.state.fixRound > 0
      ? `\n\nThis is RE-TEST round ${deps.state.fixRound + 1}. Bugs you filed earlier may have been fixed — verify each one (search_jira: 'project = DR AND type = Bug AND reporter is not EMPTY AND status != Done'). Close the loop: comment on fixed bugs and transition them to Done; re-open discussion on ones that still fail.`
      : "";

  const context = `# Sprint ${deps.state.sprintNumber} testing

## Sprint tickets to verify
${sprintTickets || "(none recorded — check search_jira: 'project = DR AND sprint in openSprints()')"}

## Your inputs (read them in this order)
1. The CEO's requirements — search Confluence, starting from the pages cited in "Sprint ${deps.state.sprintNumber} Brief" (PROD space).
2. The Sprint Brief itself.
3. Each sprint ticket's acceptance criteria (get_jira_ticket).
4. "${HOW_TO_RUN_TITLE}" (ENG space) — your ONLY guide to running the product.

Your sandbox at ${ws.repoDir} contains the current product build. Zero source access is enforced.`;

  const task = `Test Sprint ${deps.state.sprintNumber} for COMPLETENESS against the requirements:

1. Read the requirements and brief; list what the product must do.
2. Follow "${HOW_TO_RUN_TITLE}" to install and run the product in your sandbox. If the doc is missing, wrong, or incomplete — that's a bug; file it.
3. Verify every sprint ticket against its acceptance criteria, black-box. Probe edges: bad input, empty input, wrong order, restarts.
4. File a Jira Bug (create_jira_ticket, type Bug, priority by severity) for every failure: exact reproduction steps, expected vs actual.
5. Tickets that pass: transition to "Done" with a comment on what you verified. Tickets that fail: leave them and reference the bug.${retest}

Finish with a verdict: what works, what's broken, what's missing.`;

  const result = await runFactoryAgent({
    profile: getFactoryProfile("tester"),
    task,
    context,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    workspace: { cwd: ws.repoDir, confineTo: ws.dir },
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  return result.atlassian.ticketsCreated.filter((t) => t.type === "Bug").map((t) => t.key);
}

// ─── Fix Loop ────────────────────────────────────────────────────────

/**
 * Triage (dev lead assigns bugs) → fix sessions per dev → review/merge.
 * Returns the personas that received bugs.
 */
export async function runFixCycle(deps: FactoryDeps, bugKeys: string[]): Promise<void> {
  console.log(chalk.blue(`\n── Fix cycle: ${bugKeys.length} bug(s) ──`));

  // 1. Dev lead triages
  const triage = await runFactoryAgent({
    profile: getFactoryProfile("dev_lead"),
    task: `The tester filed these bugs: ${bugKeys.join(", ")}.
For each: read it (get_jira_ticket), decide who fixes it, assign_ticket to that dev (dev_lead, dev1, or dev2 — take gnarly ones yourself), and comment with any guidance. If a bug is invalid or a duplicate, transition it to "Won't Do" with an explanation.
Finish with a report: each bug key → assignee (or Won't Do).`,
    context: `# Bug triage — Sprint ${deps.state.sprintNumber}`,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    githubClient: deps.githubClients.dev_lead,
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  // 2. Determine assignments from Jira (source of truth after triage)
  const assignments = new Map<AIPersonaId, string[]>();
  for (const key of bugKeys) {
    try {
      const issue = await deps.writer.readJiraIssue(key, deps.writerState);
      if (!issue || issue.status === "Won't Do") continue;
      const persona = personaForAtlassianUser(deps, issue.assignee);
      if (persona) {
        const list = assignments.get(persona) || [];
        list.push(key);
        assignments.set(persona, list);
        deps.state.sprintTickets[key] = {
          key,
          summary: issue.summary,
          type: "Bug",
          status: issue.status,
          assignee: persona,
        };
      }
    } catch {
      // unreadable bug — skip
    }
  }
  if (assignments.size === 0) {
    console.warn(chalk.yellow("  Triage produced no assignments — falling back to dev_lead for all bugs"));
    console.warn(chalk.dim(`  Triage report: ${triage.finalReport.slice(0, 300)}`));
    assignments.set("dev_lead", bugKeys);
  }

  // 3. Fix sessions (sequential, like the dev loop)
  for (const [persona, keys] of assignments) {
    await runDevSession(deps, persona, keys);
    await deps.saveState();
  }

  // 4. Review and merge the fixes
  const openPRs = await refreshPRs(deps);
  if (openPRs.length > 0) {
    const ws = deps.workspaces.workspaceFor("dev_lead");
    await runFactoryAgent({
      profile: getFactoryProfile("dev_lead"),
      task: `Review and merge the bug-fix PRs: ${openPRs.map((p) => `#${p.number}`).join(", ")}. Use get_pr_details, verify each fix addresses its bug, then APPROVE + merge (or REQUEST_CHANGES if it doesn't hold up — but prefer merging workable fixes; the tester re-tests next).`,
      context: `# Bug-fix review — Sprint ${deps.state.sprintNumber}`,
      companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
      githubClient: deps.githubClients.dev_lead,
      workspace: { cwd: ws.repoDir, confineTo: ws.dir },
      mentionMap: deps.mentionMap,
      config: deps.config,
      tokenTracker: deps.tokenTracker,
    });
    await refreshPRs(deps);
  }
}

/**
 * Map a Jira assignee back to a factory persona. The API returns display
 * names (e.g. "Marcus Chen"), so match on both the bound persona id and
 * the configured display name.
 */
function personaForAtlassianUser(deps: FactoryDeps, assignee: string | null): AIPersonaId | null {
  if (!assignee) return null;
  for (const [factory, atlassian] of Object.entries(deps.binding)) {
    const user = deps.atlassianConfig.users[atlassian];
    if (assignee === atlassian || (user && assignee === user.displayName)) {
      return factory as AIPersonaId;
    }
  }
  return null;
}
