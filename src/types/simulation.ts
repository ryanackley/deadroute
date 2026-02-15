/**
 * Simulation state types — tracks the world state as we step through days.
 */

import type { IssueStatus, JsmStatus, Sprint } from "./jira.js";

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
  | "internal_discussion";

export interface DayPlan {
  date: string; // YYYY-MM-DD
  dayOfWeek: string;
  sprint: string | null; // Current sprint name
  sprintDay: number | null; // Day within the sprint (1-10)
  narrativeBeats: string[]; // Plot beats active this week
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
