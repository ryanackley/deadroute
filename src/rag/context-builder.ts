/**
 * Context builder — assembles RAG-retrieved context packages for persona agents.
 * Each persona agent gets a focused slice of the world relevant to their activity.
 */

import type { RagIndex, RagResult } from "./index.js";
import type { StateManager } from "../simulation/state.js";
import type { PersonaId, Activity } from "../types/simulation.js";
import { getPersona } from "../personas/profiles.js";

export interface PersonaContext {
  /** What this persona has been doing recently */
  recentActivity: string;
  /** Relevant tickets/pages found via semantic search */
  relevantArtifacts: string;
  /** Current sprint context */
  sprintContext: string;
  /** Full assembled context string for the prompt */
  assembled: string;
}

export class ContextBuilder {
  private rag: RagIndex;
  private stateManager: StateManager;

  constructor(rag: RagIndex, stateManager: StateManager) {
    this.rag = rag;
    this.stateManager = stateManager;
  }

  async buildContext(
    personaId: PersonaId,
    activity: Activity
  ): Promise<PersonaContext> {
    const persona = getPersona(personaId);
    const state = this.stateManager.getState();

    // 1. Recent activity for this persona
    const recentActivities = this.stateManager.getRecentActivities(personaId);
    const recentActivity = recentActivities.length > 0
      ? `### Your Recent Activity\n${recentActivities.slice(-10).join("\n")}`
      : "### Your Recent Activity\nThis is your first day — no prior activity.";

    // 2. RAG search for relevant artifacts
    let relevantArtifacts = "";
    try {
      const searchQuery = buildSearchQuery(personaId, activity);
      const results = await this.rag.query(searchQuery, 8);
      if (results.length > 0) {
        relevantArtifacts = formatRagResults(results);
      }
    } catch {
      // RAG may not have enough indexed content yet, especially early in simulation
      relevantArtifacts = "No relevant artifacts found yet.";
    }

    // 3. Sprint context
    const sprint = state.currentSprint;
    let sprintContext = "No active sprint.";
    if (sprint) {
      const sprintTickets = this.stateManager.getTicketsBySprint(sprint.name);
      const done = sprintTickets.filter((t) => t.status === "Done").length;
      const inProgress = sprintTickets.filter((t) => t.status === "In Progress").length;
      sprintContext = [
        `### Current Sprint: ${sprint.name}`,
        `Goal: ${sprint.goal}`,
        `Tickets: ${sprintTickets.length} total, ${done} done, ${inProgress} in progress, ${sprintTickets.length - done - inProgress} remaining`,
        "",
        "Sprint tickets:",
        ...sprintTickets.slice(0, 20).map(
          (t) => `- ${t.key}: ${t.summary} [${t.status}] (${t.assignee || "unassigned"})`
        ),
      ].join("\n");
    }

    // 4. Assemble everything
    const assembled = [
      `## Context for ${persona.displayName} (${persona.role})`,
      `Current date: ${state.currentDate}`,
      "",
      recentActivity,
      "",
      sprintContext,
      "",
      "### Relevant Existing Artifacts",
      relevantArtifacts || "None found.",
      "",
      `### Activity to Perform`,
      `Time: ${activity.time}`,
      `Type: ${activity.type}`,
      `Description: ${activity.description}`,
      activity.relatedKeys?.length
        ? `Related issues: ${activity.relatedKeys.join(", ")}`
        : "",
      activity.narrativeBeat
        ? `Narrative context: ${activity.narrativeBeat}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      recentActivity,
      relevantArtifacts,
      sprintContext,
      assembled,
    };
  }

  /**
   * Build context for a reaction — simpler than a planned activity.
   * Focuses on the artifact being reacted to and the reactor's recent history.
   */
  async buildReactionContext(
    reactorId: PersonaId,
    artifactKey: string,
    artifactSummary: string,
    recentComments: string[]
  ): Promise<string> {
    const reactor = getPersona(reactorId);
    const recentActivities = this.stateManager.getRecentActivities(reactorId);

    const lines = [
      `## Reaction Context for ${reactor.displayName}`,
      "",
      `### Artifact: ${artifactKey}`,
      artifactSummary,
      "",
    ];

    if (recentComments.length > 0) {
      lines.push("### Conversation so far:");
      lines.push(...recentComments);
      lines.push("");
    }

    lines.push("### Your Recent Activity");
    lines.push(...recentActivities.slice(-5));

    return lines.join("\n");
  }
}

function buildSearchQuery(personaId: PersonaId, activity: Activity): string {
  // Construct a semantic search query based on the activity
  const parts: string[] = [];

  if (activity.description) {
    parts.push(activity.description);
  }

  if (activity.relatedKeys?.length) {
    parts.push(`issues: ${activity.relatedKeys.join(" ")}`);
  }

  // Add role-specific search terms
  switch (personaId) {
    case "marcus":
      parts.push("code review architecture technical debt");
      break;
    case "tk":
      parts.push("support user complaint bug report escalation");
      break;
    case "sasha":
      parts.push("sprint planning roadmap prioritization");
      break;
    case "cooper":
      parts.push("frontend React UI component");
      break;
    case "priya":
      parts.push("backend database API endpoint");
      break;
    case "raj":
      parts.push("testing CI/CD standards infrastructure");
      break;
    case "dana":
      parts.push("design UI UX mobile interface");
      break;
    case "vanessa":
      parts.push("users growth marketing Scout feedback");
      break;
    case "chad":
      parts.push("feature idea vision product");
      break;
    case "tammy":
      parts.push("operations office HR policy");
      break;
  }

  return parts.join(" ").substring(0, 500);
}

function formatRagResults(results: RagResult[]): string {
  return results
    .map((r) => {
      const meta = r.metadata;
      const header = meta.key
        ? `[${meta.key}] (${meta.artifactType}, score: ${r.score.toFixed(2)})`
        : `[${meta.title || meta.id}] (${meta.artifactType}, score: ${r.score.toFixed(2)})`;
      // Truncate text to keep context manageable
      const text = r.text.length > 500 ? r.text.substring(0, 500) + "..." : r.text;
      return `${header}\n${text}`;
    })
    .join("\n\n");
}
