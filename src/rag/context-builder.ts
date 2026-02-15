/**
 * Context builder — assembles persona-specific "views" of the world.
 *
 * Each persona sees a filtered slice of reality based on their role:
 * - Developers see other devs' work, code tickets, technical details
 * - CEO sees high-level milestones, user metrics, feature demos
 * - Support sees the queue, user complaints, bug status
 * - PM sees everything at sprint level (most complete view)
 * etc.
 */

import type { RagIndex, RagResult } from "./index.js";
import type { StateManager } from "../simulation/state.js";
import type { PersonaId, Activity, TicketState } from "../types/simulation.js";
import { getPersona, getAllPersonaIds } from "../personas/profiles.js";

export interface PersonaContext {
  /** What this persona has been doing recently */
  recentActivity: string;
  /** What relevant teammates are doing */
  teammateActivity: string;
  /** Relevant tickets/pages found via semantic search */
  relevantArtifacts: string;
  /** Current sprint context */
  sprintContext: string;
  /** Full assembled context string for the prompt */
  assembled: string;
}

/**
 * Defines which other personas each role is most aware of.
 * People notice teammates whose work overlaps with theirs.
 */
const AWARENESS_MAP: Record<PersonaId, PersonaId[]> = {
  // Devs are aware of other devs + PM + support
  marcus: ["cooper", "priya", "raj", "dana", "sasha", "tk"],
  cooper: ["marcus", "raj", "dana", "priya", "sasha"],
  priya: ["marcus", "raj", "cooper", "tk"],
  raj: ["marcus", "cooper", "priya", "dana", "sasha"],
  dana: ["cooper", "marcus", "vanessa", "sasha"],
  // PM sees everyone but focuses on devs and support
  sasha: ["marcus", "cooper", "priya", "raj", "dana", "tk", "vanessa", "chad"],
  // Support sees devs (for escalations) and marketing (for user sentiment)
  tk: ["marcus", "cooper", "priya", "raj", "vanessa", "sasha"],
  // Marketing sees support, PM, and design
  vanessa: ["tk", "sasha", "dana", "chad"],
  // CEO sees high-level from PM and marketing
  chad: ["sasha", "vanessa", "marcus"],
  // Ops sees everyone at a surface level (notices burnout, logistics)
  tammy: ["sasha", "marcus", "tk", "chad", "vanessa"],
};

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

    // 1. This persona's own recent activity
    const recentActivities = this.stateManager.getRecentActivities(personaId);
    const recentActivity = recentActivities.length > 0
      ? `### Your Recent Activity\n${recentActivities.slice(-10).join("\n")}`
      : "### Your Recent Activity\nThis is your first day — no prior activity.";

    // 2. Teammate activity filtered by awareness
    const teammateActivity = this.buildTeammateView(personaId);

    // 3. RAG search for relevant artifacts
    let relevantArtifacts = "";
    try {
      const searchQuery = buildSearchQuery(personaId, activity);
      const results = await this.rag.query(searchQuery, 8);
      if (results.length > 0) {
        relevantArtifacts = formatRagResults(results);
      }
    } catch {
      relevantArtifacts = "No relevant artifacts found yet.";
    }

    // 4. Sprint context — filtered by what this persona cares about
    const sprintContext = this.buildSprintView(personaId);

    // 5. Assemble the persona's "view" of the world
    const assembled = [
      `## Context for ${persona.displayName} (${persona.role})`,
      `Current date: ${state.currentDate}`,
      "",
      recentActivity,
      "",
      teammateActivity,
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
      teammateActivity,
      relevantArtifacts,
      sprintContext,
      assembled,
    };
  }

  /**
   * Build a filtered view of what teammates are doing, based on awareness rules.
   */
  private buildTeammateView(personaId: PersonaId): string {
    const aware = AWARENESS_MAP[personaId] || [];
    if (aware.length === 0) return "";

    const lines: string[] = ["### What Your Teammates Are Up To"];

    for (const mateId of aware) {
      const mate = getPersona(mateId);
      const activities = this.stateManager.getRecentActivities(mateId);
      if (activities.length === 0) continue;

      // Show last 3-5 activities depending on how close the relationship is
      const closeTeammate = isCloseCollaborator(personaId, mateId);
      const recentCount = closeTeammate ? 5 : 3;
      const recent = activities.slice(-recentCount);

      lines.push(`**${mate.displayName}** (${mate.role}):`);
      for (const a of recent) {
        lines.push(`  ${a}`);
      }
      lines.push("");
    }

    return lines.length > 1 ? lines.join("\n") : "";
  }

  /**
   * Build sprint context filtered by what this persona role cares about.
   */
  private buildSprintView(personaId: PersonaId): string {
    const state = this.stateManager.getState();
    const sprint = state.currentSprint;
    if (!sprint) return "No active sprint.";

    const sprintTickets = this.stateManager.getTicketsBySprint(sprint.name);
    const done = sprintTickets.filter((t) => t.status === "Done").length;
    const inProgress = sprintTickets.filter((t) => t.status === "In Progress").length;

    const lines = [
      `### Current Sprint: ${sprint.name}`,
      `Goal: ${sprint.goal}`,
      `Progress: ${done}/${sprintTickets.length} done, ${inProgress} in progress`,
    ];

    // Filter tickets by what this persona cares about
    const relevantTickets = filterTicketsForPersona(personaId, sprintTickets);

    if (relevantTickets.length > 0) {
      lines.push("");
      lines.push("Relevant sprint tickets:");
      for (const t of relevantTickets.slice(0, 20)) {
        lines.push(`- ${t.key}: ${t.summary} [${t.status}] (${t.assignee || "unassigned"})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Build context for a reaction — focused on the artifact and conversation.
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

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Determines if two personas are close collaborators (see more of each other's work).
 */
function isCloseCollaborator(a: PersonaId, b: PersonaId): boolean {
  const closePairs = new Set([
    "marcus:cooper", "cooper:marcus",
    "marcus:raj", "raj:marcus",
    "marcus:priya", "priya:marcus",
    "cooper:dana", "dana:cooper",
    "cooper:raj", "raj:cooper",
    "sasha:marcus", "marcus:sasha",
    "tk:vanessa", "vanessa:tk",
    "sasha:chad", "chad:sasha",
  ]);
  return closePairs.has(`${a}:${b}`);
}

/**
 * Filter sprint tickets to what a specific persona would pay attention to.
 */
function filterTicketsForPersona(personaId: PersonaId, tickets: TicketState[]): TicketState[] {
  switch (personaId) {
    case "marcus":
      // Sees all technical tickets, especially ones assigned to his reports
      return tickets.filter((t) =>
        t.type !== "Epic" || t.assignee === "marcus" ||
        ["cooper", "priya", "raj", "dana"].includes(t.assignee || "")
      );

    case "cooper":
    case "dana":
      // Frontend/mobile devs see their own tickets + other frontend + bugs
      return tickets.filter((t) =>
        t.assignee === personaId ||
        t.type === "Bug" ||
        (t.summary + "").toLowerCase().match(/ui|frontend|mobile|design|component|react/)
      );

    case "priya":
      // Backend dev sees backend tickets + database + API
      return tickets.filter((t) =>
        t.assignee === personaId ||
        (t.summary + "").toLowerCase().match(/api|database|backend|endpoint|query|server/)
      );

    case "raj":
      // Full-stack sees everything technical, especially testing/infra
      return tickets.filter((t) =>
        t.assignee === personaId ||
        t.type === "Bug" ||
        (t.summary + "").toLowerCase().match(/test|ci|deploy|infra|standard|quality/)
      );

    case "sasha":
      // PM sees everything (most complete view)
      return tickets;

    case "tk":
      // Support sees bugs, support tickets, and user-facing issues
      return tickets.filter((t) =>
        t.project === "SUP" ||
        t.type === "Bug" ||
        (t.summary + "").toLowerCase().match(/user|support|crash|error|broken/)
      );

    case "vanessa":
      // Marketing sees user-facing features and bugs
      return tickets.filter((t) =>
        t.type === "Epic" ||
        t.type === "Story" ||
        (t.summary + "").toLowerCase().match(/user|ux|growth|feature|launch/)
      );

    case "chad":
      // CEO sees epics, features, and high-priority items only
      return tickets.filter((t) =>
        t.type === "Epic" ||
        (t.type === "Story" && t.status !== "Done") ||
        t.assignee === "chad"
      ).slice(0, 10); // Chad doesn't read that many tickets

    case "tammy":
      // Ops sees operational tickets and her own
      return tickets.filter((t) =>
        t.assignee === "tammy" ||
        (t.summary + "").toLowerCase().match(/office|supply|generator|facility|hr|onboard/)
      );

    default:
      return tickets;
  }
}

function buildSearchQuery(personaId: PersonaId, activity: Activity): string {
  const parts: string[] = [];

  if (activity.description) {
    parts.push(activity.description);
  }

  if (activity.relatedKeys?.length) {
    parts.push(`issues: ${activity.relatedKeys.join(" ")}`);
  }

  // Role-specific search terms
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
      const header = `(score: ${r.score.toFixed(2)})`;
      const text = r.text.length > 500 ? r.text.substring(0, 500) + "..." : r.text;
      return `${header}\n${text}`;
    })
    .join("\n\n");
}
