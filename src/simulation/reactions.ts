/**
 * Reaction system — round-robin conversation loops.
 *
 * After each day's planned activities, check which personas would react to
 * the generated artifacts, then execute multi-round conversations where
 * reactions can trigger counter-reactions.
 */

import type { PersonaId } from "../types/simulation.js";
import type { JiraIssue, JiraComment } from "../types/jira.js";
import type { ConfluencePage } from "../types/confluence.js";
import type { Config } from "../config.js";
import type { PersonaProfile } from "../personas/profiles.js";
import type { StateManager } from "./state.js";
import type { ContextBuilder } from "../rag/context-builder.js";
import type { TokenTracker } from "./token-tracker.js";
import { getPersona, PERSONAS } from "../personas/profiles.js";
import { executePersonaActivity } from "../agents/persona-agent.js";

export interface Reaction {
  reactor: PersonaId;
  targetKey: string; // Issue key or page ID being reacted to
  targetSummary: string;
  reason: string; // Why this persona would react
}

export interface ReactionResult {
  issueKey: string;
  comments: JiraComment[];
  rounds: number;
}

/**
 * Determine which personas would react to newly created/modified artifacts.
 */
export function identifyReactions(
  newIssues: JiraIssue[],
  modifiedIssueKeys: string[],
  newPages: ConfluencePage[],
  stateManager: StateManager
): Reaction[] {
  const reactions: Reaction[] = [];
  const state = stateManager.getState();

  for (const issue of newIssues) {
    const issueReactions = getReactionsForIssue(issue);
    reactions.push(...issueReactions);
  }

  // Also check modified tickets (new comments might trigger reactions)
  for (const key of modifiedIssueKeys) {
    const ticket = state.tickets[key];
    if (!ticket) continue;

    // Simplified: just check if Marcus would review code-related updates
    if (isCodeRelated(ticket.summary) && ticket.assignee !== "marcus") {
      reactions.push({
        reactor: "marcus",
        targetKey: key,
        targetSummary: ticket.summary,
        reason: "Marcus reviews all code-related ticket updates",
      });
    }
  }

  // Deduplicate — one reaction per (reactor, target) pair
  const seen = new Set<string>();
  return reactions.filter((r) => {
    const key = `${r.reactor}:${r.targetKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // Don't react to your own stuff
    return true;
  });
}

function getReactionsForIssue(issue: JiraIssue): Reaction[] {
  const reactions: Reaction[] = [];
  const reporter = issue.reporter as PersonaId;

  // Marcus reviews every code-related ticket
  if (isCodeRelated(issue.summary + " " + issue.description) && reporter !== "marcus") {
    reactions.push({
      reactor: "marcus",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Marcus reviews all code-related tickets and PRs",
    });
  }

  // Sasha triages new tickets (assigns sprint, comments on priority)
  if (issue.project === "DR" && reporter !== "sasha" && issue.type !== "Sub-task") {
    reactions.push({
      reactor: "sasha",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Sasha triages all new DR tickets for sprint assignment and priority",
    });
  }

  // TK reacts to bugs and support-related issues
  if (
    (issue.type === "Bug" || issue.labels.some((l) => l.includes("support") || l.includes("user"))) &&
    reporter !== "tk"
  ) {
    reactions.push({
      reactor: "tk",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "TK adds user impact context to bugs and support-related issues",
    });
  }

  // Vanessa reacts to user-facing issues
  if (
    (issue.labels.some((l) => l.includes("user") || l.includes("ux") || l.includes("growth")) ||
      issue.description.toLowerCase().includes("user")) &&
    reporter !== "vanessa"
  ) {
    reactions.push({
      reactor: "vanessa",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Vanessa adds user feedback context to user-facing issues",
    });
  }

  // Raj comments on code quality / testing issues
  if (
    (issue.labels.some((l) => l.includes("test") || l.includes("quality") || l.includes("standards")) ||
      issue.description.toLowerCase().includes("test coverage") ||
      issue.description.toLowerCase().includes("code quality")) &&
    reporter !== "raj"
  ) {
    reactions.push({
      reactor: "raj",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Raj comments on testing and code quality matters",
    });
  }

  // Chad occasionally comments on exciting features (30% chance)
  if (
    issue.type === "Story" &&
    reporter !== "chad" &&
    Math.random() < 0.3
  ) {
    reactions.push({
      reactor: "chad",
      targetKey: issue.key,
      targetSummary: `[${issue.key}] ${issue.summary}`,
      reason: "Chad is excited about this feature and wants to add his vision",
    });
  }

  return reactions;
}

/**
 * Execute a round-robin conversation for a set of reactions on the same ticket.
 */
export async function executeReactionConversation(
  reaction: Reaction,
  existingComments: JiraComment[],
  stateManager: StateManager,
  contextBuilder: ContextBuilder,
  config: Config,
  tokenTracker: TokenTracker
): Promise<ReactionResult> {
  const maxRounds = config.maxReactionRounds;
  const allComments: JiraComment[] = [];
  let conversationComments = existingComments.map(
    (c) => `**${c.author}**: ${c.body}`
  );
  const state = stateManager.getState();
  const date = state.currentDate;

  // Track who's in this conversation
  const participants = new Set<PersonaId>();
  for (const c of existingComments) {
    participants.add(c.author as PersonaId);
  }
  participants.add(reaction.reactor);

  let lastCommenter = reaction.reactor;

  for (let round = 0; round < maxRounds; round++) {
    // Determine who speaks this round
    const speaker = round === 0
      ? reaction.reactor
      : getNextSpeaker(lastCommenter, participants, reaction.targetKey, stateManager);

    if (!speaker) break; // Nobody wants to respond, conversation ends

    const persona = getPersona(speaker);
    const reactionContext = await contextBuilder.buildReactionContext(
      speaker,
      reaction.targetKey,
      reaction.targetSummary,
      conversationComments
    );

    const activityDesc = round === 0
      ? `React to ${reaction.targetKey}: ${reaction.reason}`
      : `Respond to the latest comment on ${reaction.targetKey} in the ongoing conversation`;

    const result = await executePersonaActivity(
      persona,
      {
        time: "12:00", // Reaction time doesn't matter much
        persona: speaker,
        type: "comment_ticket",
        description: activityDesc,
        relatedKeys: [reaction.targetKey],
      },
      reactionContext,
      config,
      tokenTracker,
      "reaction"
    );

    // Collect generated comments
    for (const { comment } of result.addedComments) {
      comment.created = `${date}T${12 + round}:00:00Z`;
      comment.id = `comment-${Date.now()}-${round}`;
      allComments.push(comment);
      conversationComments.push(`**${comment.author}**: ${comment.body}`);
      lastCommenter = speaker;
    }

    // If no comment was generated, the persona chose not to respond
    if (result.addedComments.length === 0) break;

    // After round 1+, add the assignee as potential responder
    const ticket = state.tickets[reaction.targetKey];
    if (ticket?.assignee) participants.add(ticket.assignee as PersonaId);
  }

  return {
    issueKey: reaction.targetKey,
    comments: allComments,
    rounds: allComments.length,
  };
}

/**
 * Determine who speaks next in a conversation.
 * Simple heuristic: the person most likely to respond to the last commenter.
 */
function getNextSpeaker(
  lastCommenter: PersonaId,
  participants: Set<PersonaId>,
  issueKey: string,
  stateManager: StateManager
): PersonaId | null {
  const state = stateManager.getState();
  const ticket = state.tickets[issueKey];
  if (!ticket) return null;

  // Likely responders based on role
  const responders: PersonaId[] = [];

  // The assignee should respond if they haven't spoken last
  if (ticket.assignee && ticket.assignee !== lastCommenter) {
    responders.push(ticket.assignee as PersonaId);
  }

  // Marcus responds to dev discussions
  if (lastCommenter !== "marcus" && isCodeRelated(ticket.summary)) {
    responders.push("marcus");
  }

  // Sasha responds to prioritization discussions
  if (lastCommenter !== "sasha" && participants.has("sasha")) {
    responders.push("sasha");
  }

  // The reporter responds if someone commented on their ticket
  const reporterCandidates = Object.values(PERSONAS)
    .filter((p) => participants.has(p.id) && p.id !== lastCommenter)
    .map((p) => p.id);
  responders.push(...reporterCandidates);

  // 50% chance any given person responds (keeps conversations from being too long)
  const filtered = responders.filter(() => Math.random() < 0.5);
  return filtered[0] || null;
}

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
