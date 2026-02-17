/**
 * Reaction system — inline rolling reactions with participation chance.
 *
 * After each activity executes, identifyInlineReactions() checks if any
 * personas would react to the newly created/modified artifacts. Each
 * reaction is a single-turn interaction (no multi-round conversations).
 *
 * Participation is probabilistic: leaders have high engagement in their
 * domain, individual devs have low engagement outside their own tickets.
 */

import type { PersonaId, ActivityResult } from "../types/simulation.js";
import type { JiraIssue } from "../types/jira.js";
import type { ConfluencePage, SpaceKey } from "../types/confluence.js";
import type { StateManager } from "./state.js";
import { extractTextFromAdf } from "../utils/adf.js";

export interface InlineReaction {
  reactor: PersonaId;
  targetType: "jira" | "confluence";
  targetKey: string; // Issue key or page title
  targetSummary: string;
  reason: string;
  spaceKey?: SpaceKey; // For confluence pages
}

// ─── Participation Chance ────────────────────────────────────────────

/**
 * Probability that a persona will actually react when a rule matches.
 * ownArea = the artifact is in their domain of responsibility.
 * otherArea = the artifact is outside their usual scope.
 */
const PARTICIPATION_CHANCE: Record<PersonaId, { ownArea: number; otherArea: number }> = {
  // Leaders (not CEO) — high participation in their area
  sasha:   { ownArea: 0.85, otherArea: 0.3 },
  marcus:  { ownArea: 0.80, otherArea: 0.25 },
  vanessa: { ownArea: 0.80, otherArea: 0.2 },
  tammy:   { ownArea: 0.75, otherArea: 0.15 },
  // Individual devs — low unless it's their own ticket or area of ownership
  cooper:  { ownArea: 0.4, otherArea: 0.1 },
  priya:   { ownArea: 0.4, otherArea: 0.1 },
  raj:     { ownArea: 0.45, otherArea: 0.12 },
  dana:    { ownArea: 0.35, otherArea: 0.08 },
  // Support — high for bugs/support, low otherwise
  tk:      { ownArea: 0.75, otherArea: 0.15 },
  // CEO — occasional drive-by excitement
  chad:    { ownArea: 0.2, otherArea: 0.05 },
};

interface CandidateReaction extends InlineReaction {
  isOwnArea: boolean;
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Identify which personas would react to the artifacts produced by a single activity.
 * Returns reactions filtered by participation chance and deduplicated.
 */
export function identifyInlineReactions(
  activityResult: ActivityResult,
  actingPersona: PersonaId,
  stateManager: StateManager
): InlineReaction[] {
  const candidates: CandidateReaction[] = [];

  // Check new issues
  for (const issue of activityResult.newIssues) {
    candidates.push(...getReactionsForIssue(issue));
  }

  // Check modified tickets (e.g., new comments or transitions)
  for (const key of activityResult.modifiedKeys) {
    const ticket = stateManager.getState().tickets[key];
    if (!ticket) continue;

    if (isCodeRelated(ticket.summary) && ticket.assignee !== "marcus") {
      candidates.push({
        reactor: "marcus",
        targetType: "jira",
        targetKey: key,
        targetSummary: `[${key}] ${ticket.summary}`,
        reason: "Marcus reviews all code-related ticket updates",
        isOwnArea: true,
      });
    }
  }

  // Check new Confluence pages
  for (const page of activityResult.newPages) {
    candidates.push(...getReactionsForPage(page));
  }

  // Deduplicate, filter self-reactions, apply participation chance
  const seen = new Set<string>();
  return candidates.filter((r) => {
    // No self-reactions
    if (r.reactor === actingPersona) return false;

    // Deduplicate by (reactor, targetKey)
    const dedupeKey = `${r.reactor}:${r.targetKey}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);

    // Roll against participation chance
    const chance = PARTICIPATION_CHANCE[r.reactor];
    const threshold = r.isOwnArea ? chance.ownArea : chance.otherArea;
    return Math.random() < threshold;
  });
}

// ─── Issue Reactions ─────────────────────────────────────────────────

function getReactionsForIssue(issue: JiraIssue): CandidateReaction[] {
  const reactions: CandidateReaction[] = [];
  const reporter = issue.reporter as PersonaId;

  // Marcus reviews every code-related ticket
  const descText = extractTextFromAdf(issue.description);
  if (isCodeRelated(issue.summary + " " + descText) && reporter !== "marcus") {
    reactions.push({
      reactor: "marcus",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Marcus reviews all code-related tickets and PRs",
      isOwnArea: true,
    });
  }

  // Sasha triages new tickets (assigns sprint, comments on priority)
  if (issue.project === "DR" && reporter !== "sasha" && issue.type !== "Sub-task") {
    reactions.push({
      reactor: "sasha",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Sasha triages all new DR tickets for sprint assignment and priority",
      isOwnArea: true,
    });
  }

  // TK reacts to bugs and support-related issues
  if (
    (issue.type === "Bug" || issue.labels.some((l) => l.includes("support") || l.includes("user"))) &&
    reporter !== "tk"
  ) {
    reactions.push({
      reactor: "tk",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "TK adds user impact context to bugs and support-related issues",
      isOwnArea: true,
    });
  }

  // Vanessa reacts to user-facing issues
  if (
    (issue.labels.some((l) => l.includes("user") || l.includes("ux") || l.includes("growth")) ||
      descText.toLowerCase().includes("user")) &&
    reporter !== "vanessa"
  ) {
    reactions.push({
      reactor: "vanessa",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Vanessa adds user feedback context to user-facing issues",
      isOwnArea: true,
    });
  }

  // Raj comments on code quality / testing issues
  if (
    (issue.labels.some((l) => l.includes("test") || l.includes("quality") || l.includes("standards")) ||
      descText.toLowerCase().includes("test coverage") ||
      descText.toLowerCase().includes("code quality")) &&
    reporter !== "raj"
  ) {
    reactions.push({
      reactor: "raj",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Raj comments on testing and code quality matters",
      isOwnArea: true,
    });
  }

  // Chad occasionally gets excited about features
  if (issue.type === "Story" && reporter !== "chad") {
    reactions.push({
      reactor: "chad",
      targetType: "jira",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Chad is excited about this feature and wants to add his vision",
      isOwnArea: true, // Chad's ownArea chance is already low (0.2)
    });
  }

  // Individual devs react to tickets in their technical area (low chance via otherArea)
  const devAreaPatterns: Record<string, RegExp> = {
    cooper: /ui|frontend|react|component|css|design/i,
    priya: /api|database|backend|endpoint|query|server|postgres/i,
    dana: /mobile|ios|android|design|ux|interface/i,
  };

  for (const [devId, pattern] of Object.entries(devAreaPatterns)) {
    if (reporter !== devId && pattern.test(issue.summary + " " + descText)) {
      reactions.push({
        reactor: devId as PersonaId,
        targetType: "jira",
        targetKey: issue.key,
        targetSummary: `[${issue.key}] ${issue.summary}`,
        reason: `${devId} noticed a ticket in their technical area`,
        isOwnArea: false, // Low chance for individual devs on others' tickets
      });
    }
  }

  return reactions;
}

// ─── Page Reactions ──────────────────────────────────────────────────

function getReactionsForPage(page: ConfluencePage): CandidateReaction[] {
  const reactions: CandidateReaction[] = [];
  const author = page.author as PersonaId;

  // Sasha reviews product docs
  if (page.spaceKey === "PROD" && author !== "sasha") {
    reactions.push({
      reactor: "sasha",
      targetType: "confluence",
      targetKey: page.title,
      targetSummary: `[${page.spaceKey}] ${page.title}`,
      reason: "Sasha reviews product documentation for roadmap alignment",
      spaceKey: page.spaceKey,
      isOwnArea: true,
    });
  }

  // Marcus reviews engineering docs
  if (page.spaceKey === "ENG" && author !== "marcus") {
    reactions.push({
      reactor: "marcus",
      targetType: "confluence",
      targetKey: page.title,
      targetSummary: `[${page.spaceKey}] ${page.title}`,
      reason: "Marcus reviews engineering documentation for accuracy",
      spaceKey: page.spaceKey,
      isOwnArea: true,
    });
  }

  // Vanessa reacts to marketing and user-related pages
  if (
    (page.spaceKey === "MKT" ||
      page.labels.some((l) => l.includes("user") || l.includes("growth") || l.includes("brand"))) &&
    author !== "vanessa"
  ) {
    reactions.push({
      reactor: "vanessa",
      targetType: "confluence",
      targetKey: page.title,
      targetSummary: `[${page.spaceKey}] ${page.title}`,
      reason: "Vanessa adds user perspective to marketing and user-related docs",
      spaceKey: page.spaceKey,
      isOwnArea: true,
    });
  }

  // Tammy reacts to ops pages
  if (page.spaceKey === "OPS" && author !== "tammy") {
    reactions.push({
      reactor: "tammy",
      targetType: "confluence",
      targetKey: page.title,
      targetSummary: `[${page.spaceKey}] ${page.title}`,
      reason: "Tammy reviews operations docs for accuracy and completeness",
      spaceKey: page.spaceKey,
      isOwnArea: true,
    });
  }

  // Individual devs react to ENG pages in their technical area
  const devPagePatterns: Record<string, RegExp> = {
    cooper: /frontend|react|ui|component|css/i,
    priya: /backend|database|api|server|postgres|migration/i,
    raj: /test|ci|deploy|infra|standard|quality/i,
    dana: /mobile|design|ux|interface|wireframe/i,
  };

  if (page.spaceKey === "ENG") {
    for (const [devId, pattern] of Object.entries(devPagePatterns)) {
      if (author !== devId && pattern.test(page.title + " " + extractTextFromAdf(page.body).substring(0, 500))) {
        reactions.push({
          reactor: devId as PersonaId,
          targetType: "confluence",
          targetKey: page.title,
          targetSummary: `[${page.spaceKey}] ${page.title}`,
          reason: `${devId} noticed an engineering doc in their area`,
          spaceKey: page.spaceKey,
          isOwnArea: true, // It's their technical area, use ownArea (still low for devs)
        });
      }
    }
  }

  return reactions;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isCodeRelated(text: string): boolean {
  const codeTerms = [
    "bug", "fix", "code", "refactor", "api", "endpoint", "component",
    "function", "database", "query", "deploy", "build", "test", "PR",
    "pull request", "merge", "branch", "crash", "error", "exception",
    "performance", "cache", "routing", "algorithm",
  ];
  const lower = text.toLowerCase();
  return codeTerms.some((term) => lower.includes(term));
}
