/**
 * Phase 2: Sprint Planning — the dev lead reads the PM's brief, creates
 * sprint tickets with acceptance criteria, assigns them across the dev
 * team, and starts the sprint.
 */

import chalk from "chalk";
import type { FactoryDeps } from "../deps.js";
import { toolContextFor } from "../deps.js";
import { runFactoryAgent } from "../../agents/factory-agent.js";
import { getFactoryProfile } from "../../personas/factory-profiles.js";
import { extractTextFromAdf } from "../../utils/adf.js";
import type { AIPersonaId } from "../../types/factory.js";

export async function runPlanning(deps: FactoryDeps, briefTitle: string): Promise<void> {
  const sprintN = deps.state.sprintNumber;
  const sprintName = `Sprint ${sprintN}`;
  console.log(chalk.blue(`\n── Phase: Sprint Planning (${sprintName}) ──`));

  // Give the writer real sprint dates for auto-created sprints
  const start = new Date();
  const end = new Date(start.getTime() + 14 * 24 * 3600 * 1000);
  deps.writerState.currentSprint = {
    name: sprintName,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    goal: `Deliver the Sprint ${sprintN} Brief requirements`,
    state: "future",
  };

  // Read the brief so planning starts from its full text
  let briefText = "";
  try {
    const page = await deps.writer.readConfluencePage("PROD", briefTitle);
    if (page) briefText = extractTextFromAdf(page.body);
  } catch {
    // brief may be missing; the agent can search for it
  }

  const context = `# ${sprintName} Planning

## The PM's Sprint Brief ("${briefTitle}")
${briefText || `(Could not load the brief page — read it yourself with get_confluence_page("PROD", "${briefTitle}").)`}

## Your Team
- dev_lead (you, Marcus): architecture-heavy and cross-cutting work
- dev1 (Cooper): fast, product-minded, strong on user-facing features
- dev2 (Priya): methodical, strong on data/backend and edge cases
- tester (TK): black-box tester — he can only see what the "How to Run & Test" doc tells him`;

  const task = `Plan ${sprintName}:

1. Break the brief into well-scoped Jira tickets (create_jira_ticket): Stories for features, Tasks for technical work. Every ticket needs concrete acceptance criteria in the description — the tester will verify against them black-box.
2. Assign every ticket (assignee parameter or assign_ticket): the hard/architectural ones to yourself (dev_lead), the rest split between dev1 and dev2 by their strengths. Keep the sprint achievable — quality over quantity.
3. If open bugs exist from earlier sprints (search_jira: 'project = DR AND type = Bug AND status != Done'), include the important ones in the sprint.
4. Move all sprint tickets into "${sprintName}" (move_to_sprint), then start it (start_sprint).
5. Finish with a report listing each ticket key, its summary, and its assignee.`;

  const result = await runFactoryAgent({
    profile: getFactoryProfile("dev_lead"),
    task,
    context,
    toolContext: toolContextFor(deps),
    mentionMap: deps.mentionMap,
    config: deps.config,
    tokenTracker: deps.tokenTracker,
  });

  // Record sprint tickets in factory state
  for (const t of result.atlassian.ticketsCreated) {
    deps.state.sprintTickets[t.key] = {
      key: t.key,
      summary: t.summary,
      type: t.type,
      status: "To Do",
      assignee: t.assignee,
    };
  }

  // Guarantee the sprint is actually started even if the agent forgot
  const started = result.atlassian.sprintOps.some((op) => op.action === "start");
  if (!started) {
    console.warn(chalk.yellow(`  Agent did not start the sprint — starting "${sprintName}" directly`));
    const keys = Object.keys(deps.state.sprintTickets);
    if (keys.length > 0) {
      await deps.writer.moveToSprint(keys, sprintName, deps.writerState, deps.binding.dev_lead);
    }
    await deps.writer.startSprint(sprintName, deps.writerState, deps.binding.dev_lead);
  }

  deps.state.activeSprintName = sprintName;
  const counts: Record<string, number> = {};
  for (const t of Object.values(deps.state.sprintTickets)) {
    const a = t.assignee || "unassigned";
    counts[a] = (counts[a] || 0) + 1;
  }
  console.log(
    chalk.green(
      `  ✓ ${Object.keys(deps.state.sprintTickets).length} ticket(s) planned: ` +
        Object.entries(counts)
          .map(([a, n]) => `${a}=${n}`)
          .join(", "),
    ),
  );
}

/** Tickets assigned to a given dev persona in the current sprint. */
export function ticketsFor(deps: FactoryDeps, persona: AIPersonaId): string[] {
  return Object.values(deps.state.sprintTickets)
    .filter((t) => t.assignee === persona)
    .map((t) => t.key);
}
