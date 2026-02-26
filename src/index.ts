#!/usr/bin/env node

/**
 * DeadRoute — Atlassian Sample Data Generator CLI
 * "Waze for the zombie apocalypse" sample dataset generator
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, validateConfig } from "./config.js";
import { runSimulation } from "./simulation/engine.js";
import { StateManager } from "./simulation/state.js";
import { TokenTracker } from "./simulation/token-tracker.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { extractTextFromAdf } from "./utils/adf.js";
import { adfZodSchema } from "./types/adf.js";
import { registerBootstrapCommand } from "./bootstrap/index.js";

const program = new Command();

program
  .name("deadroute")
  .description("AI-powered Atlassian sample data generator — Waze for the zombie apocalypse")
  .version("0.1.0");

program
  .command("generate")
  .description("Run the simulation to generate sample data")
  .option("--from-day <number>", "Resume from a specific day number", parseInt)
  .option("--dry-run", "Plan days without generating content (master planner only)")
  .option("--days <number>", "Override number of simulation days", parseInt)
  .option("--output-mode <mode>", "Output mode: file or atlassian", "file")
  .action(async (options) => {
    const overrides: Record<string, unknown> = {};
    if (options.days) overrides.simulationDays = options.days;
    if (options.outputMode) overrides.outputMode = options.outputMode;
    const config = loadConfig(overrides);

    const errors = validateConfig(config);
    if (errors.length > 0 && !options.dryRun) {
      console.error(chalk.red("Configuration errors:"));
      for (const err of errors) {
        console.error(chalk.red(`  - ${err}`));
      }
      console.error(chalk.dim("\nCopy .env.example to .env and fill in your API keys."));
      process.exit(1);
    }

    await runSimulation(config, {
      fromDay: options.fromDay,
      dryRun: options.dryRun,
    });
  });

program
  .command("stats")
  .description("Show generation progress and metrics")
  .action(async () => {
    const config = loadConfig();
    const stateManager = await StateManager.loadOrCreate(config.outputDir, config.startDate);
    const state = stateManager.getState();

    console.log(chalk.bold("\n📊 DeadRoute Generation Stats\n"));
    console.log(`Current date: ${state.currentDate}`);
    console.log(`Day number: ${state.dayNumber ?? "unknown (pre-tracking state)"}`);
    console.log(`Sprint: ${state.currentSprint?.name || "none"}`);
    console.log("");
    console.log(chalk.bold("Tickets:"));
    console.log(`  Total created: ${state.metrics.totalTicketsCreated}`);
    console.log(`  DR project: ${state.nextTicketNumber.DR - 1} issues`);
    console.log(`  SUP project: ${state.nextTicketNumber.SUP - 1} issues`);
    console.log("");
    console.log(chalk.bold("Status Distribution:"));
    for (const [status, count] of Object.entries(state.metrics.ticketsByStatus)) {
      console.log(`  ${status}: ${count}`);
    }
    console.log("");
    console.log(`Comments: ${state.metrics.totalCommentsAdded}`);
    console.log(`Confluence pages: ${state.metrics.totalPagesCreated}`);

    // Token report
    try {
      const tokenData = await readFile(join(config.outputDir, "token-report.json"), "utf-8");
      const report = JSON.parse(tokenData);
      console.log("");
      console.log(chalk.bold("Token Usage:"));
      console.log(`  Total calls: ${report.totalCalls}`);
      console.log(`  Input tokens: ${report.totalInputTokens.toLocaleString()}`);
      console.log(`  Output tokens: ${report.totalOutputTokens.toLocaleString()}`);
      console.log(chalk.bold(`  Estimated cost: $${report.totalEstimatedCost.toFixed(2)}`));
    } catch {
      // No token report yet
    }
  });

program
  .command("inspect <key>")
  .description("Pretty-print a specific Jira ticket or Confluence page")
  .action(async (key: string) => {
    const config = loadConfig();
    const stateManager = await StateManager.loadOrCreate(config.outputDir, config.startDate);
    const state = stateManager.getState();

    const ticket = state.tickets[key];
    if (!ticket) {
      console.error(chalk.red(`Ticket ${key} not found in state.`));
      process.exit(1);
    }

    // Find and read the JSON file
    const { OutputWriter } = await import("./output/writer.js");
    const writer = new OutputWriter(config.outputDir);
    const issue = await writer.readJiraIssue(key, state);

    if (!issue) {
      console.error(chalk.red(`Could not read issue file for ${key}.`));
      process.exit(1);
    }

    console.log(chalk.bold(`\n${issue.key}: ${issue.summary}\n`));
    console.log(`Type: ${issue.type} | Priority: ${issue.priority} | Status: ${issue.status}`);
    console.log(`Reporter: ${issue.reporter} | Assignee: ${issue.assignee || "Unassigned"}`);
    console.log(`Sprint: ${issue.sprint || "Backlog"}`);
    if (issue.epicKey) console.log(`Epic: ${issue.epicKey}`);
    if (issue.storyPoints) console.log(`Story Points: ${issue.storyPoints}`);
    console.log(`Created: ${issue.created} | Updated: ${issue.updated}`);
    console.log("");
    console.log(chalk.bold("Description:"));
    console.log(extractTextFromAdf(issue.description) || "(empty)");

    if (issue.comments.length > 0) {
      console.log("");
      console.log(chalk.bold(`Comments (${issue.comments.length}):`));
      for (const c of issue.comments) {
        console.log(chalk.dim(`\n  --- ${c.author} (${c.created}) ---`));
        console.log(`  ${extractTextFromAdf(c.body).replace(/\n/g, "\n  ")}`);
      }
    }

    if (issue.statusHistory.length > 0) {
      console.log("");
      console.log(chalk.bold("Status History:"));
      for (const t of issue.statusHistory) {
        console.log(`  ${t.date}: ${t.from} → ${t.to} (by ${t.by})`);
      }
    }
  });

registerBootstrapCommand(program);

program.parse();
