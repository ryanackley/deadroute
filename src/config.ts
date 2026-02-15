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

  // Feature flags
  enableReactions: boolean;
  enableRag: boolean;
  maxReactionRounds: number;

  // Token pricing (per 1M tokens)
  pricing: {
    sonnetInput: number;
    sonnetOutput: number;
    haikuInput: number;
    haikuOutput: number;
    embeddingInput: number;
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",

    plannerModel: process.env.PLANNER_MODEL || "claude-sonnet-4-5-20250929",
    personaModel: process.env.PERSONA_MODEL || "claude-haiku-4-5-20251001",

    startDate: process.env.START_DATE || "2024-01-15",
    simulationDays: parseInt(process.env.SIMULATION_DAYS || "250", 10),
    outputDir: resolve(process.env.OUTPUT_DIR || "./output"),

    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || "5", 10),

    enableReactions: process.env.ENABLE_REACTIONS !== "false",
    enableRag: process.env.ENABLE_RAG !== "false",
    maxReactionRounds: parseInt(process.env.MAX_REACTION_ROUNDS || "3", 10),

    // Pricing as of early 2025 (per 1M tokens)
    pricing: {
      sonnetInput: 3.0,
      sonnetOutput: 15.0,
      haikuInput: 0.80,
      haikuOutput: 4.0,
      embeddingInput: 0.02, // text-embedding-3-small
    },

    ...overrides,
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (!config.anthropicApiKey) {
    errors.push("ANTHROPIC_API_KEY is required");
  }
  if (!config.openaiApiKey) {
    errors.push("OPENAI_API_KEY is required (for Vectra embeddings)");
  }
  return errors;
}
