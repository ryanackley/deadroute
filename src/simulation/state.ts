/**
 * Simulation state manager — tracks the world state as we step through days.
 * Persists to disk for resumability.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  SimulationState,
  PersonaId,
  TicketState,
} from "../types/simulation.js";
import type { JiraIssue, IssueStatus, JsmStatus } from "../types/jira.js";
import type { SprintDefinition } from "../narrative/sprint-calendar.js";

const RECENT_ACTIVITY_LIMIT = 20;

export function createInitialState(startDate: string): SimulationState {
  const recentActivity: Record<PersonaId, string[]> = {
    chad: [],
    vanessa: [],
    tammy: [],
    sasha: [],
    marcus: [],
    cooper: [],
    priya: [],
    raj: [],
    dana: [],
    tk: [],
  };

  return {
    currentDate: startDate,
    currentSprint: null,
    nextTicketNumber: { DR: 1, SUP: 1 },
    nextConfluenceId: 1,
    tickets: {},
    recentActivity,
    metrics: {
      totalTicketsCreated: 0,
      totalCommentsAdded: 0,
      totalPagesCreated: 0,
      ticketsByStatus: {},
    },
  };
}

export class StateManager {
  private state: SimulationState;
  private outputDir: string;

  constructor(state: SimulationState, outputDir: string) {
    this.state = state;
    this.outputDir = outputDir;
  }

  static async loadOrCreate(outputDir: string, startDate: string): Promise<StateManager> {
    const statePath = join(outputDir, "state.json");
    try {
      const data = await readFile(statePath, "utf-8");
      const state = JSON.parse(data) as SimulationState;
      return new StateManager(state, outputDir);
    } catch {
      const state = createInitialState(startDate);
      return new StateManager(state, outputDir);
    }
  }

  getState(): SimulationState {
    return this.state;
  }

  getCurrentDate(): string {
    return this.state.currentDate;
  }

  setCurrentDate(date: string): void {
    this.state.currentDate = date;
  }

  setCurrentSprint(sprint: SprintDefinition | null): void {
    this.state.currentSprint = sprint
      ? {
          name: sprint.name,
          goal: sprint.goal,
          state: sprint.state,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
        }
      : null;
  }

  /** Allocate the next ticket key for a project. */
  allocateTicketKey(project: "DR" | "SUP"): string {
    const num = this.state.nextTicketNumber[project];
    this.state.nextTicketNumber[project] = num + 1;
    return `${project}-${num}`;
  }

  /** Allocate the next Confluence page ID. */
  allocatePageId(): string {
    const id = this.state.nextConfluenceId;
    this.state.nextConfluenceId = id + 1;
    return `page-${id}`;
  }

  /** Register a newly created ticket in the state. */
  registerTicket(issue: JiraIssue): void {
    this.state.tickets[issue.key] = {
      key: issue.key,
      project: issue.project,
      summary: issue.summary,
      status: issue.status,
      assignee: issue.assignee,
      type: issue.type,
      epicKey: issue.epicKey,
      sprint: issue.sprint,
      created: issue.created,
    };
    this.state.metrics.totalTicketsCreated += 1;
    this.updateStatusCount(issue.status, 1);
  }

  /** Update a ticket's status. */
  updateTicketStatus(key: string, newStatus: IssueStatus | JsmStatus): void {
    const ticket = this.state.tickets[key];
    if (!ticket) return;
    const oldStatus = ticket.status;
    ticket.status = newStatus;
    this.updateStatusCount(oldStatus, -1);
    this.updateStatusCount(newStatus, 1);
  }

  /** Assign a ticket to a sprint. */
  assignTicketToSprint(key: string, sprintName: string): void {
    const ticket = this.state.tickets[key];
    if (ticket) ticket.sprint = sprintName;
  }

  /** Record that a comment was added. */
  recordComment(): void {
    this.state.metrics.totalCommentsAdded += 1;
  }

  /** Record that a page was created. */
  recordPage(): void {
    this.state.metrics.totalPagesCreated += 1;
  }

  /** Log an activity for a persona. */
  logActivity(persona: PersonaId, description: string): void {
    const activities = this.state.recentActivity[persona];
    activities.push(`[${this.state.currentDate}] ${description}`);
    if (activities.length > RECENT_ACTIVITY_LIMIT) {
      activities.shift();
    }
  }

  /** Get recent activities for a persona. */
  getRecentActivities(persona: PersonaId): string[] {
    return this.state.recentActivity[persona];
  }

  /** Get tickets in a given status. */
  getTicketsByStatus(status: IssueStatus | JsmStatus): TicketState[] {
    return Object.values(this.state.tickets).filter((t) => t.status === status);
  }

  /** Get tickets assigned to a persona. */
  getTicketsByAssignee(assignee: string): TicketState[] {
    return Object.values(this.state.tickets).filter((t) => t.assignee === assignee);
  }

  /** Get tickets in a sprint. */
  getTicketsBySprint(sprintName: string): TicketState[] {
    return Object.values(this.state.tickets).filter((t) => t.sprint === sprintName);
  }

  /** Get all open tickets (not Done/Closed/Won't Do/Resolved). */
  getOpenTickets(): TicketState[] {
    const closedStatuses = new Set(["Done", "Won't Do", "Resolved", "Closed"]);
    return Object.values(this.state.tickets).filter((t) => !closedStatuses.has(t.status));
  }

  /** Get all epics. */
  getEpics(project: "DR" | "SUP" = "DR"): TicketState[] {
    return Object.values(this.state.tickets).filter(
      (t) => t.project === project && t.type === "Epic"
    );
  }

  /** Build a summary of current state for the master planner prompt. */
  buildStateSummary(): string {
    const open = this.getOpenTickets();
    const sprint = this.state.currentSprint;
    const sprintTickets = sprint ? this.getTicketsBySprint(sprint.name) : [];
    const sprintDone = sprintTickets.filter((t) => t.status === "Done").length;

    const lines: string[] = [];
    lines.push(`## Current State`);
    lines.push(`Date: ${this.state.currentDate}`);
    lines.push(`Sprint: ${sprint?.name || "No active sprint"} (${sprint?.goal || ""})`);
    lines.push(`Total tickets created: ${this.state.metrics.totalTicketsCreated}`);
    lines.push(`Open tickets: ${open.length}`);
    if (sprint) {
      lines.push(`Sprint tickets: ${sprintTickets.length} (${sprintDone} done)`);
    }
    lines.push("");
    lines.push("### Status Distribution");
    for (const [status, count] of Object.entries(this.state.metrics.ticketsByStatus)) {
      if (count > 0) lines.push(`- ${status}: ${count}`);
    }
    lines.push("");
    lines.push("### Open Tickets (recent 30)");
    const recentOpen = open.slice(-30);
    for (const t of recentOpen) {
      lines.push(`- ${t.key}: ${t.summary} [${t.status}] (${t.type}, assignee: ${t.assignee || "unassigned"})`);
    }
    return lines.join("\n");
  }

  getRollingSummaries(): { date: string; summary: string }[] {
    return this.state.rollingSummaries ?? [];
  }

  setRollingSummaries(summaries: { date: string; summary: string }[]): void {
    this.state.rollingSummaries = summaries;
  }

  private updateStatusCount(status: string, delta: number): void {
    const counts = this.state.metrics.ticketsByStatus;
    counts[status] = (counts[status] || 0) + delta;
    if (counts[status] <= 0) delete counts[status];
  }

  async save(): Promise<void> {
    const statePath = join(this.outputDir, "state.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(this.state, null, 2));
  }
}
