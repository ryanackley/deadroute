/**
 * Phase 5: Sprint Review — the PM writes the sprint summary for the human
 * CEO, and the engine closes the sprint deterministically.
 */

import chalk from "chalk";
import type { FactoryDeps } from "../deps.js";
import { toolContextFor } from "../deps.js";
import { runFactoryAgent } from "../../agents/factory-agent.js";
import { getFactoryProfile } from "../../personas/factory-profiles.js";

export async function runSprintReview(deps: FactoryDeps): Promise<string> {
  const sprintN = deps.state.sprintNumber;
  const sprintName = deps.state.activeSprintName || `Sprint ${sprintN}`;
  console.log(chalk.blue(`\n── Phase: Sprint Review (${sprintName}) ──`));

  const tickets = Object.values(deps.state.sprintTickets);
  const ticketLines = tickets.map((t) => `- ${t.key}: ${t.summary} (${t.assignee || "unassigned"})`).join("\n");
  const prLines = deps.state.prs
    .map((p) => `- PR #${p.number} "${p.title}" by ${p.author} — ${p.state}`)
    .join("\n");

  const context = `# ${sprintName} is wrapping up

## Sprint tickets (check current statuses yourself with search_jira)
${ticketLines || "(none recorded)"}

## Pull requests this sprint
${prLines || "(none)"}`;

  const task = `Write the sprint review for the CEO:

1. Get the real final state of the sprint: search_jira 'project = DR AND sprint in openSprints()' plus any bugs filed this sprint. Read anything you need for accuracy.
2. Create a Confluence page titled EXACTLY "Sprint ${sprintN} Review" in the PROD space, written FOR THE HUMAN CEO: what shipped (plain language, tied back to their requirements), what didn't and why, bugs found and their status, and open questions from the brief that still need their input.
3. Be honest — carryover and unfixed bugs are stated plainly, not spun.
4. End the page with a short "How to try it" section pointing at the "How to Run & Test" doc.

Finish with a 3-5 sentence summary of the sprint (this gets archived as team memory).`;

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

  // Close the sprint deterministically — the human gate follows
  try {
    await deps.writer.closeSprint(sprintName, deps.writerState, deps.binding.dev_lead);
    console.log(chalk.green(`  ✓ ${sprintName} closed`));
  } catch (err) {
    console.warn(chalk.yellow(`  Could not close sprint: ${err}`));
  }

  const summary = result.finalReport.slice(0, 800) || `Sprint ${sprintN} completed.`;
  return summary;
}
