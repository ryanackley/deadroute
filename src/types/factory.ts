/**
 * Factory mode types — the real software factory where AI personas build
 * actual software with a human CEO in the loop.
 *
 * Unlike the simulation's PersonaId (10 fictional teammates), the factory
 * has 6 identities: 1 human (the CEO) and 5 AI agents.
 */

export type AIPersonaId = "pm" | "dev_lead" | "dev1" | "dev2" | "tester";
export type FactoryPersonaId = "ceo" | AIPersonaId;

export const AI_PERSONAS: readonly AIPersonaId[] = [
  "pm",
  "dev_lead",
  "dev1",
  "dev2",
  "tester",
] as const;

/** Personas that get a local git clone and can execute code. */
export const DEV_PERSONAS: readonly AIPersonaId[] = ["dev_lead", "dev1", "dev2"] as const;

export const FACTORY_PERSONAS: readonly FactoryPersonaId[] = ["ceo", ...AI_PERSONAS] as const;

export function isDevPersona(id: FactoryPersonaId): boolean {
  return (DEV_PERSONAS as readonly string[]).includes(id);
}

// ─── Sprint State Machine ────────────────────────────────────────────

export type SprintPhase =
  | "idle"
  | "pm_synthesis"
  | "planning"
  | "dev_loop"
  | "testing"
  | "sprint_review";

export interface PRInfo {
  number: number;
  title: string;
  branch: string;
  author: AIPersonaId;
  /** Jira issue key this PR implements, if known */
  issueKey: string | null;
  state: "open" | "changes_requested" | "approved" | "merged" | "closed";
  reviewRounds: number;
}

export interface FactoryTicket {
  key: string;
  summary: string;
  type: string;
  status: string;
  assignee: AIPersonaId | null;
}

export interface FactoryState {
  /** 1-based sprint counter */
  sprintNumber: number;
  phase: SprintPhase;
  /** Jira Agile sprint ID for the active sprint */
  activeSprintId: string | null;
  activeSprintName: string | null;
  /** Confluence page ID of the current Sprint Brief */
  sprintBriefPageId: string | null;
  /** Confluence page ID of the "How to Run & Test" doc */
  howToRunPageId: string | null;
  /** ISO timestamp of when the previous sprint closed — the CEO-activity search window start */
  lastSprintClosedAt: string | null;
  /** Tickets in the current sprint keyed by issue key */
  sprintTickets: Record<string, FactoryTicket>;
  /** PRs opened during the current sprint */
  prs: PRInfo[];
  /** Current test→fix round (0 = first test pass) */
  fixRound: number;
  /** One-line summaries of past sprints for agent context */
  sprintHistory: { sprint: number; summary: string }[];
}

export function createInitialFactoryState(): FactoryState {
  return {
    sprintNumber: 0,
    phase: "idle",
    activeSprintId: null,
    activeSprintName: null,
    sprintBriefPageId: null,
    howToRunPageId: null,
    lastSprintClosedAt: null,
    sprintTickets: {},
    prs: [],
    fixRound: 0,
    sprintHistory: [],
  };
}

// ─── CEO Activity Digest ─────────────────────────────────────────────

export interface CEOActivityItem {
  source: "confluence_page" | "confluence_comment" | "jira_issue" | "jira_comment";
  /** Page title or issue key */
  ref: string;
  title: string;
  /** Plain-text content (extracted from ADF) */
  text: string;
  updatedAt: string;
}

export interface CEOActivityDigest {
  since: string | null;
  items: CEOActivityItem[];
}
