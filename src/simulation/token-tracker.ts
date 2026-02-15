/**
 * Token usage tracking and cost estimation.
 * Collects per-call metrics, aggregates by day, and reports costs.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { Config } from "../config.js";

export type AgentCategory = "master_planner" | "persona_generation" | "reaction" | "embedding";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  category: AgentCategory;
  model: string;
  persona?: string;
  timestamp: string;
}

export interface DailyTokenSummary {
  date: string;
  dayNumber: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  byCategory: Record<AgentCategory, { input: number; output: number; calls: number }>;
}

export interface TokenReport {
  startedAt: string;
  lastUpdated: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  totalCalls: number;
  dailySummaries: DailyTokenSummary[];
  byCategory: Record<AgentCategory, { input: number; output: number; calls: number; cost: number }>;
}

export class TokenTracker {
  private currentDay: string = "";
  private currentDayNumber: number = 0;
  private dayUsages: TokenUsage[] = [];
  private report: TokenReport;
  private outputDir: string;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.outputDir = config.outputDir;
    this.report = {
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      totalCalls: 0,
      dailySummaries: [],
      byCategory: {
        master_planner: { input: 0, output: 0, calls: 0, cost: 0 },
        persona_generation: { input: 0, output: 0, calls: 0, cost: 0 },
        reaction: { input: 0, output: 0, calls: 0, cost: 0 },
        embedding: { input: 0, output: 0, calls: 0, cost: 0 },
      },
    };
  }

  async loadExisting(): Promise<void> {
    try {
      const data = await readFile(join(this.outputDir, "token-report.json"), "utf-8");
      this.report = JSON.parse(data);
    } catch {
      // No existing report, start fresh
    }
  }

  startDay(date: string, dayNumber: number): void {
    this.currentDay = date;
    this.currentDayNumber = dayNumber;
    this.dayUsages = [];
  }

  record(usage: Omit<TokenUsage, "timestamp">): void {
    this.dayUsages.push({
      ...usage,
      timestamp: new Date().toISOString(),
    });
  }

  private estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    const { pricing } = this.config;
    const isHaiku = model.includes("haiku");
    const isSonnet = model.includes("sonnet");
    const isEmbedding = model.includes("embedding");

    if (isEmbedding) {
      return (inputTokens / 1_000_000) * pricing.embeddingInput;
    }
    if (isHaiku) {
      return (
        (inputTokens / 1_000_000) * pricing.haikuInput +
        (outputTokens / 1_000_000) * pricing.haikuOutput
      );
    }
    if (isSonnet) {
      return (
        (inputTokens / 1_000_000) * pricing.sonnetInput +
        (outputTokens / 1_000_000) * pricing.sonnetOutput
      );
    }
    // Default to Sonnet pricing
    return (
      (inputTokens / 1_000_000) * pricing.sonnetInput +
      (outputTokens / 1_000_000) * pricing.sonnetOutput
    );
  }

  endDay(): DailyTokenSummary {
    const byCategory: Record<AgentCategory, { input: number; output: number; calls: number }> = {
      master_planner: { input: 0, output: 0, calls: 0 },
      persona_generation: { input: 0, output: 0, calls: 0 },
      reaction: { input: 0, output: 0, calls: 0 },
      embedding: { input: 0, output: 0, calls: 0 },
    };

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const usage of this.dayUsages) {
      const cat = byCategory[usage.category];
      cat.input += usage.inputTokens;
      cat.output += usage.outputTokens;
      cat.calls += 1;
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
      totalCost += this.estimateCost(usage.inputTokens, usage.outputTokens, usage.model);
    }

    const summary: DailyTokenSummary = {
      date: this.currentDay,
      dayNumber: this.currentDayNumber,
      calls: this.dayUsages.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      estimatedCost: Math.round(totalCost * 10000) / 10000, // 4 decimal places
      byCategory,
    };

    // Update running totals
    this.report.totalInputTokens += totalInput;
    this.report.totalOutputTokens += totalOutput;
    this.report.totalEstimatedCost += totalCost;
    this.report.totalCalls += this.dayUsages.length;
    this.report.lastUpdated = new Date().toISOString();
    this.report.dailySummaries.push(summary);

    // Update category totals
    for (const cat of Object.keys(byCategory) as AgentCategory[]) {
      this.report.byCategory[cat].input += byCategory[cat].input;
      this.report.byCategory[cat].output += byCategory[cat].output;
      this.report.byCategory[cat].calls += byCategory[cat].calls;
      // Estimate cost per category
      const catModel = cat === "master_planner" ? this.config.plannerModel :
                       cat === "embedding" ? "text-embedding-3-small" : this.config.personaModel;
      this.report.byCategory[cat].cost += this.estimateCost(
        byCategory[cat].input,
        byCategory[cat].output,
        catModel
      );
    }

    return summary;
  }

  async save(): Promise<void> {
    const reportPath = join(this.outputDir, "token-report.json");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(this.report, null, 2));
  }

  getReport(): TokenReport {
    return this.report;
  }

  formatDailySummary(summary: DailyTokenSummary): string {
    return (
      `Day ${summary.dayNumber} (${summary.date}): ` +
      `${summary.inputTokens.toLocaleString()} input / ${summary.outputTokens.toLocaleString()} output tokens ` +
      `(${summary.calls} calls, ~$${summary.estimatedCost.toFixed(4)})`
    );
  }

  formatRunningTotal(): string {
    const r = this.report;
    return (
      `Running total: ${r.totalInputTokens.toLocaleString()} input / ${r.totalOutputTokens.toLocaleString()} output tokens ` +
      `(${r.totalCalls} calls, ~$${r.totalEstimatedCost.toFixed(2)})`
    );
  }
}
