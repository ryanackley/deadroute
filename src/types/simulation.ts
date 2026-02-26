/**
 * Simulation state types — tracks the world state as we step through days.
 */

import type { IssueStatus, JsmStatus, Sprint, JiraIssue } from "./jira.js";
import type { ConfluencePage } from "./confluence.js";

export type PersonaId =
  | "chad"
  | "vanessa"
  | "tammy"
  | "sasha"
  | "marcus"
  | "cooper"
  | "priya"
  | "raj"
  | "dana"
  | "tk";

export interface Activity {
  time: string; // HH:MM format
  persona: PersonaId;
  type: ActivityType;
  description: string;
  /** Optional references to existing artifacts that this activity relates to */
  relatedKeys?: string[];
  /** Narrative beat driving this activity, if any */
  narrativeBeat?: string;
}

export type ActivityType =
  | "create_ticket"
  | "comment_ticket"
  | "transition_ticket"
  | "create_page"
  | "update_page"
  | "comment_page"
  | "sprint_ceremony"
  | "code_review"
  | "escalate_ticket"
  | "internal_discussion"
  | "start_sprint"
  | "close_sprint";

export interface DayPlan {
  date: string; // YYYY-MM-DD
  dayOfWeek: string;
  sprint: string | null; // Current sprint name
  sprintDay: number | null; // Day within the sprint (1-10)
  narrativeBeats: string[]; // Plot beats active this week
  /** 2-4 sentence "state of the office" brief: product phase, user count, team vibe, key events */
  officeContext: string;
  activities: Activity[];
}

export interface TicketState {
  key: string;
  project: "DR" | "SUP";
  summary: string;
  status: IssueStatus | JsmStatus;
  assignee: string | null;
  type: string;
  epicKey: string | null;
  sprint: string | null;
  created: string;
}

export interface SimulationState {
  currentDate: string;
  dayNumber?: number;
  currentSprint: Sprint | null;
  nextTicketNumber: { DR: number; SUP: number };
  nextConfluenceId: number;
  tickets: Record<string, TicketState>; // keyed by issue key
  /** Recent activity log per persona (last N activities) */
  recentActivity: Record<PersonaId, string[]>;
  /** Running counters for metrics */
  metrics: {
    totalTicketsCreated: number;
    totalCommentsAdded: number;
    totalPagesCreated: number;
    ticketsByStatus: Record<string, number>;
  };
  /** Confluence page IDs by "SPACEKEY::Title" (API mode only) */
  confluencePageIds?: Record<string, string>;
  /** Jira issue IDs by key, e.g. "DR-42" → "10001" (API mode only) */
  jiraIssueIds?: Record<string, string>;
  /** Sprint name → Jira sprint ID (API mode only) */
  sprintIds?: Record<string, string>;
  /** Rolling day summaries for narrative continuity (last N days) */
  rollingSummaries?: { date: string; summary: string }[];
}

export interface NarrativeBeat {
  week: number;
  title: string;
  description: string;
  involvedPersonas: PersonaId[];
  /** Types of artifacts this beat should generate */
  expectedArtifacts: ActivityType[];
}

export interface NarrativeSpine {
  companyStartDate: string; // YYYY-MM-DD
  beats: NarrativeBeat[];
}

export interface SprintOperation {
  action: "start" | "close" | "move_to_sprint" | "move_to_backlog";
  sprintName: string;
  issueKeys?: string[];
}

export interface ActivityResult {
  newIssues: JiraIssue[];
  modifiedKeys: string[];
  newPages: ConfluencePage[];
  sprintOperations: SprintOperation[];
  summary: string;
  daySummary: string;
}
