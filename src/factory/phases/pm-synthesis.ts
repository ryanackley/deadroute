/**
 * Phase 1: PM Synthesis — the PM hunts for the CEO's direction across all
 * Atlassian surfaces and synthesizes it into a Sprint Brief page.
 */

import chalk from "chalk";
import type { FactoryDeps } from "../deps.js";
import { toolContextFor } from "../deps.js";
import { buildCEOActivityDigest, formatCEODigest } from "../ceo-activity.js";
import { runFactoryAgent } from "../../agents/factory-agent.js";
import { getFactoryProfile } from "../../personas/factory-profiles.js";

export interface PMSynthesisOutcome {
  briefTitle: string;
  briefPageId: string | null;
  report: string;
}

export async function runPMSynthesis(deps: FactoryDeps): Promise<PMSynthesisOutcome> {
  const sprintN = deps.state.sprintNumber;
  console.log(chalk.blue(`\n── Phase: PM Synthesis (Sprint ${sprintN}) ──`));

  console.log(chalk.dim("  Hunting for CEO activity..."));
  const digest = await buildCEOActivityDigest(
    deps.adminClient,
    deps.ceoAccountId,
    deps.state.lastSprintClosedAt,
  );
  console.log(chalk.dim(`  Found ${digest.items.length} CEO-authored item(s)`));

  const history =
    deps.state.sprintHistory.length > 0
      ? `## Previous Sprints\n${deps.state.sprintHistory
          .slice(-5)
          .map((h) => `Sprint ${h.sprint}: ${h.summary}`)
          .join("\n")}`
      : "This is the team's first sprint.";

  const briefTitle = `Sprint ${sprintN} Brief`;

  const context = `# Sprint ${sprintN} is starting.

${history}

## CEO Activity Digest (pre-gathered for you)
${formatCEODigest(digest)}`;

  const task = `Prepare the team for Sprint ${sprintN}:

1. Review the CEO activity digest above. Use search_confluence and search_jira to hunt for anything it may have missed — the CEO's account ID is "${deps.ceoAccountId}". Read any promising page fully with get_confluence_page before relying on it.
2. Synthesize everything into a Confluence page titled EXACTLY "${briefTitle}" in the PROD space. Structure it with: Sprint Goal, Requirements (in priority order, each with acceptance criteria and a citation of where the CEO said it), and Open Questions.
3. If CEO feedback references specific tickets or past work, look those up so the brief has concrete context.

The dev lead plans the whole sprint from your brief — completeness beats speed.`;

  const result = await runFactoryAgent({
    profile: getFactoryProfile("pm"),
    task,
    context,
    companyProfile: deps.companyProfile,
    toolContext: toolContextFor(deps),
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  const briefPage =
    result.atlassian.pagesCreated.find((p) => p.title === briefTitle) ||
    result.atlassian.pagesCreated[0] ||
    null;

  if (briefPage) {
    console.log(chalk.green(`  ✓ Brief created: "${briefPage.title}" (${briefPage.id})`));
  } else {
    console.warn(chalk.yellow("  PM did not create a brief page — planning will use the PM's report text"));
  }

  return {
    briefTitle: briefPage?.title || briefTitle,
    briefPageId: briefPage?.id || null,
    report: result.finalReport,
  };
}
