/**
 * Centralized configuration loaded from environment + defaults.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "path";

loadDotenv();

export interface Config {
  // API keys
  anthropicApiKey: string;
  openaiApiKey: string;

  // Model selections
  plannerModel: string;
  personaModel: string;

  // Simulation parameters
  startDate: string;
  simulationDays: number;
  outputDir: string;

  // Concurrency
  maxConcurrentAgents: number;

  // Output mode
  outputMode: "file" | "atlassian";

  // Feature flags
  enableReactions: boolean;
  enableRag: boolean;
  maxReactionsPerActivity: number;

  // Token pricing (per 1M tokens)
  pricing: {
    sonnetInput: number;
    sonnetOutput: number;
    haikuInput: number;
    haikuOutput: number;
    embeddingInput: number;
  };

  // Factory mode (real software production)
  factory: FactoryModeConfig;
}

export interface FactoryModeConfig {
  /** Where per-persona git clones live */
  workspacesDir: string;
  /** Model for all factory agents (real code needs a strong model) */
  agentModel: string;
  /** Max conversation turns per agent session (dev loops need headroom) */
  maxAgentTurns: number;
  /** Max review→fix rounds per PR before escalating */
  maxReviewRounds: number;
  /** Max test→fix cycles per sprint before escalating to the human */
  maxFixRounds: number;
  /** OS-level sandbox for agent Bash (Seatbelt/bubblewrap via Agent SDK) */
  sandboxEnabled: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",

    plannerModel: process.env.PLANNER_MODEL || "claude-sonnet-4-6",
    personaModel: process.env.PERSONA_MODEL || "claude-haiku-4-5",

    startDate: process.env.START_DATE || "2024-01-15",
    simulationDays: parseInt(process.env.SIMULATION_DAYS || "250", 10),
    outputDir: resolve(process.env.OUTPUT_DIR || "./output"),

    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || "5", 10),

    outputMode: (process.env.OUTPUT_MODE === "atlassian" ? "atlassian" : "file") as "file" | "atlassian",

    enableReactions: process.env.ENABLE_REACTIONS !== "false",
    enableRag: process.env.ENABLE_RAG !== "false",
    maxReactionsPerActivity: parseInt(process.env.MAX_REACTIONS_PER_ACTIVITY || "3", 10),

    // Pricing as of early 2025 (per 1M tokens)
    pricing: {
      sonnetInput: 3.0,
      sonnetOutput: 15.0,
      haikuInput: 0.80,
      haikuOutput: 4.0,
      embeddingInput: 0.02, // text-embedding-3-small
    },

    factory: {
      workspacesDir: resolve(process.env.FACTORY_WORKSPACES_DIR || "./factory-workspaces"),
      agentModel: process.env.FACTORY_AGENT_MODEL || "claude-sonnet-4-6",
      maxAgentTurns: parseInt(process.env.FACTORY_MAX_AGENT_TURNS || "100", 10),
      maxReviewRounds: parseInt(process.env.FACTORY_MAX_REVIEW_ROUNDS || "3", 10),
      maxFixRounds: parseInt(process.env.FACTORY_MAX_FIX_ROUNDS || "3", 10),
      sandboxEnabled: process.env.FACTORY_SANDBOX !== "false",
    },

    ...overrides,
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  // if (!config.anthropicApiKey) {
  //   errors.push("ANTHROPIC_API_KEY is required");
  // }
  if (!config.openaiApiKey) {
    errors.push("OPENAI_API_KEY is required (for Vectra embeddings)");
  }
  return errors;
}
