/**
 * Simulation engine — the main day-by-day loop that orchestrates everything.
 *
 * For each working day:
 * 1. Update sprint context
 * 2. Get narrative beats
 * 3. Call master planner → day plan
 * 4. Execute each activity via persona agents
 * 5. Run reaction pass
 * 6. Save state, report tokens
 */

import { addDays, format, isWeekend, parseISO } from "date-fns";
import pLimit from "p-limit";
import chalk from "chalk";

import type { Config } from "../config.js";
import type { JiraIssue, JiraComment } from "../types/jira.js";
import type { ConfluencePage } from "../types/confluence.js";
import type { Activity, DayPlan, PersonaId } from "../types/simulation.js";
import { StateManager } from "./state.js";
import { TokenTracker } from "./token-tracker.js";
import { OutputWriter } from "../output/writer.js";
import { RagIndex } from "../rag/index.js";
import { ContextBuilder } from "../rag/context-builder.js";
import {
  generateSprintCalendar,
  getSprintForDate,
  getSprintDay,
  getWeekNumber,
  type SprintDefinition,
} from "../narrative/sprint-calendar.js";
import { loadNarrativeSpine, getBeatsForWeek, formatBeatsForPrompt } from "../narrative/spine.js";
import { planDay } from "../agents/master-planner.js";
import { executePersonaActivity } from "../agents/persona-agent.js";
import { getPersona } from "../personas/profiles.js";
import { identifyReactions, executeReactionConversation } from "./reactions.js";

export interface EngineOptions {
  /** Start from a specific day number (1-based, for resuming) */
  fromDay?: number;
  /** Run in dry-run mode (plan only, no content generation) */
  dryRun?: boolean;
}

export async function runSimulation(config: Config, options: EngineOptions = {}): Promise<void> {
  console.log(chalk.bold("\n🧟 DeadRoute Sample Data Generator\n"));
  console.log(`Start date: ${config.startDate}`);
  console.log(`Simulation days: ${config.simulationDays}`);
  console.log(`Output: ${config.outputDir}`);
  console.log(`Planner model: ${config.plannerModel}`);
  console.log(`Persona model: ${config.personaModel}`);
  console.log(`Dry run: ${options.dryRun || false}\n`);

  // Initialize components
  const stateManager = await StateManager.loadOrCreate(config.outputDir, config.startDate);
  const tokenTracker = new TokenTracker(config);
  await tokenTracker.loadExisting();
  const writer = new OutputWriter(config.outputDir);
  const sprints = generateSprintCalendar(config.startDate);
  const narrativeBeats = await loadNarrativeSpine();

  let rag: RagIndex | null = null;
  let contextBuilder: ContextBuilder | null = null;

  if (config.enableRag && !options.dryRun) {
    rag = new RagIndex(config, tokenTracker);
    await rag.initialize();
    contextBuilder = new ContextBuilder(rag, stateManager);
  }

  const concurrencyLimit = pLimit(config.maxConcurrentAgents);
  let dayNumber = 0;
  let currentDate = parseISO(config.startDate);
  let yesterdaySummary = "";

  // Advance to start day if resuming
  const startFromDay = options.fromDay || 1;
  let simulatedDays = 0;

  console.log(chalk.dim("─".repeat(60)));

  while (simulatedDays < config.simulationDays) {
    const dateStr = format(currentDate, "yyyy-MM-dd");
    const dayOfWeek = format(currentDate, "EEEE");

    // Skip weekends
    if (isWeekend(currentDate)) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    dayNumber++;

    // Skip days before startFromDay
    if (dayNumber < startFromDay) {
      currentDate = addDays(currentDate, 1);
      simulatedDays++;
      continue;
    }

    // Update sprint context
    const sprint = getSprintForDate(dateStr, sprints);
    const sprintDay = sprint ? getSprintDay(dateStr, sprint) : null;
    stateManager.setCurrentDate(dateStr);
    stateManager.setCurrentSprint(sprint);

    // Get narrative beats for this week
    const week = getWeekNumber(dateStr, config.startDate);
    const weekBeats = getBeatsForWeek(narrativeBeats, week);

    console.log(
      chalk.blue(`\nDay ${dayNumber}`) +
      chalk.dim(` | ${dayOfWeek}, ${dateStr}`) +
      (sprint ? chalk.yellow(` | ${sprint.name} (day ${sprintDay})`) : "") +
      (weekBeats.length > 0 ? chalk.magenta(` | ${weekBeats.length} narrative beats`) : "")
    );

    // Start token tracking for this day
    tokenTracker.startDay(dateStr, dayNumber);

    // === PHASE 1: PLAN THE DAY ===
    const stateSummary = stateManager.buildStateSummary();
    const planResult = await planDay(
      dateStr,
      dayOfWeek,
      sprint,
      sprintDay,
      weekBeats,
      stateSummary,
      yesterdaySummary,
      config,
      tokenTracker
    );

    const { dayPlan } = planResult;
    console.log(chalk.dim(`  Planned ${dayPlan.activities.length} activities`));

    if (options.dryRun) {
      // In dry-run mode, just log the plan
      for (const act of dayPlan.activities) {
        console.log(chalk.dim(`    ${act.time} [${act.persona}] ${act.type}: ${act.description.substring(0, 80)}`));
      }
      const summary = tokenTracker.endDay();
      console.log(chalk.dim(`  ${tokenTracker.formatDailySummary(summary)}`));
      await tokenTracker.save();
      currentDate = addDays(currentDate, 1);
      simulatedDays++;
      continue;
    }

    // === PHASE 2: EXECUTE ACTIVITIES ===
    const dayNewIssues: JiraIssue[] = [];
    const dayModifiedKeys: string[] = [];
    const dayNewPages: ConfluencePage[] = [];
    const activitySummaries: string[] = [];

    for (const activity of dayPlan.activities) {
      try {
        const result = await executeActivity(
          activity,
          dateStr,
          stateManager,
          writer,
          rag,
          contextBuilder,
          config,
          tokenTracker,
          sprint
        );

        dayNewIssues.push(...result.newIssues);
        dayModifiedKeys.push(...result.modifiedKeys);
        dayNewPages.push(...result.newPages);
        activitySummaries.push(result.summary);

        console.log(chalk.dim(`    ${activity.time} [${activity.persona}] ${result.summary}`));
      } catch (err) {
        console.error(chalk.red(`    Error executing activity: ${err}`));
      }
    }

    // === PHASE 3: REACTIONS ===
    if (config.enableReactions && (dayNewIssues.length > 0 || dayModifiedKeys.length > 0)) {
      const reactions = identifyReactions(dayNewIssues, dayModifiedKeys, dayNewPages, stateManager);
      console.log(chalk.dim(`  ${reactions.length} reactions identified`));

      for (const reaction of reactions) {
        if (!contextBuilder) continue;

        try {
          // Get existing comments for this ticket
          const existingIssue = await writer.readJiraIssue(reaction.targetKey, stateManager.getState());
          const existingComments = existingIssue?.comments || [];

          const result = await executeReactionConversation(
            reaction,
            existingComments,
            stateManager,
            contextBuilder,
            config,
            tokenTracker
          );

          // Write reaction comments to disk
          for (const comment of result.comments) {
            await writer.appendComment(reaction.targetKey, comment, stateManager.getState());
            stateManager.recordComment();
            stateManager.logActivity(
              comment.author as PersonaId,
              `Commented on ${reaction.targetKey}`
            );
          }

          if (result.rounds > 0) {
            console.log(
              chalk.dim(`    💬 ${reaction.reactor} → ${reaction.targetKey}: ${result.rounds} round(s)`)
            );
          }
        } catch (err) {
          console.error(chalk.red(`    Reaction error: ${err}`));
        }
      }
    }

    // === PHASE 4: END OF DAY ===
    yesterdaySummary = buildDaySummary(activitySummaries, dayNewIssues, dayNewPages);
    const daySummary = tokenTracker.endDay();
    await stateManager.save();
    await tokenTracker.save();

    console.log(chalk.green(`  ✓ ${tokenTracker.formatDailySummary(daySummary)}`));
    console.log(chalk.dim(`  ${tokenTracker.formatRunningTotal()}`));

    currentDate = addDays(currentDate, 1);
    simulatedDays++;
  }

  // Final report
  const report = tokenTracker.getReport();
  console.log(chalk.bold("\n" + "═".repeat(60)));
  console.log(chalk.bold("Simulation Complete"));
  console.log(chalk.bold("═".repeat(60)));
  console.log(`Days simulated: ${dayNumber}`);
  console.log(`Total tickets: ${stateManager.getState().metrics.totalTicketsCreated}`);
  console.log(`Total comments: ${stateManager.getState().metrics.totalCommentsAdded}`);
  console.log(`Total pages: ${stateManager.getState().metrics.totalPagesCreated}`);
  console.log(`Total API calls: ${report.totalCalls}`);
  console.log(`Total tokens: ${report.totalInputTokens.toLocaleString()} input / ${report.totalOutputTokens.toLocaleString()} output`);
  console.log(chalk.bold(`Estimated cost: $${report.totalEstimatedCost.toFixed(2)}`));
  console.log("");
  console.log("Breakdown by category:");
  for (const [cat, data] of Object.entries(report.byCategory)) {
    if (data.calls > 0) {
      console.log(`  ${cat}: ${data.calls} calls, $${data.cost.toFixed(2)}`);
    }
  }
}

interface ActivityResult {
  newIssues: JiraIssue[];
  modifiedKeys: string[];
  newPages: ConfluencePage[];
  summary: string;
}

async function executeActivity(
  activity: Activity,
  date: string,
  stateManager: StateManager,
  writer: OutputWriter,
  rag: RagIndex | null,
  contextBuilder: ContextBuilder | null,
  config: Config,
  tokenTracker: TokenTracker,
  sprint: SprintDefinition | null
): Promise<ActivityResult> {
  const persona = getPersona(activity.persona);
  const state = stateManager.getState();
  const timestamp = `${date}T${activity.time}:00Z`;

  // Build context
  let context = "";
  if (contextBuilder) {
    const ctx = await contextBuilder.buildContext(activity.persona, activity);
    context = ctx.assembled;
  } else {
    // Minimal context without RAG
    context = `Date: ${date}\nYour role: ${persona.role}\nSprint: ${sprint?.name || "none"}`;
  }

  // Execute persona agent
  const result = await executePersonaActivity(persona, activity, context, config, tokenTracker);

  const actResult: ActivityResult = {
    newIssues: [],
    modifiedKeys: [],
    newPages: [],
    summary: "",
  };

  // Process created issues
  for (const issue of result.createdIssues) {
    issue.key = stateManager.allocateTicketKey(issue.project);
    issue.created = timestamp;
    issue.updated = timestamp;
    if (sprint && issue.project === "DR") {
      issue.sprint = sprint.name;
    }
    await writer.writeJiraIssue(issue, state);
    stateManager.registerTicket(issue);
    stateManager.logActivity(activity.persona, `Created ${issue.key}: ${issue.summary}`);
    actResult.newIssues.push(issue);

    // Index in RAG
    if (rag) await rag.indexJiraIssue(issue);
  }

  // Process comments
  for (const { issueKey, comment } of result.addedComments) {
    if (!state.tickets[issueKey]) continue; // Skip if ticket doesn't exist
    comment.id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    comment.created = timestamp;
    await writer.appendComment(issueKey, comment, state);
    stateManager.recordComment();
    stateManager.logActivity(activity.persona, `Commented on ${issueKey}`);
    actResult.modifiedKeys.push(issueKey);
  }

  // Process transitions
  for (const { issueKey, newStatus, by } of result.transitions) {
    if (!state.tickets[issueKey]) continue;
    await writer.updateJiraIssueStatus(issueKey, newStatus, by, timestamp, state);
    stateManager.updateTicketStatus(issueKey, newStatus);
    stateManager.logActivity(activity.persona, `Moved ${issueKey} to ${newStatus}`);
    actResult.modifiedKeys.push(issueKey);
  }

  // Process pages
  for (const page of result.createdPages) {
    page.id = stateManager.allocatePageId();
    page.created = timestamp;
    page.updated = timestamp;
    await writer.writeConfluencePage(page);
    stateManager.recordPage();
    stateManager.logActivity(activity.persona, `Created page: ${page.title}`);
    actResult.newPages.push(page);

    // Index in RAG
    if (rag) await rag.indexConfluencePage(page);
  }

  // Build summary
  const parts: string[] = [];
  if (actResult.newIssues.length > 0) {
    parts.push(`+${actResult.newIssues.length} issue(s)`);
  }
  if (result.addedComments.length > 0) {
    parts.push(`${result.addedComments.length} comment(s)`);
  }
  if (result.transitions.length > 0) {
    parts.push(`${result.transitions.length} transition(s)`);
  }
  if (actResult.newPages.length > 0) {
    parts.push(`+${actResult.newPages.length} page(s)`);
  }
  actResult.summary = parts.length > 0
    ? `${activity.type}: ${parts.join(", ")}`
    : `${activity.type}: (no artifacts)`;

  return actResult;
}

function buildDaySummary(
  activities: string[],
  newIssues: JiraIssue[],
  newPages: ConfluencePage[]
): string {
  const lines = ["Yesterday's activities:"];
  for (const a of activities.slice(0, 20)) {
    lines.push(`- ${a}`);
  }
  if (newIssues.length > 0) {
    lines.push(`\nNew tickets: ${newIssues.map((i) => `${i.key}: ${i.summary}`).join("; ")}`);
  }
  if (newPages.length > 0) {
    lines.push(`\nNew pages: ${newPages.map((p) => p.title).join("; ")}`);
  }
  return lines.join("\n");
}
