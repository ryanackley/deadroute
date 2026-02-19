/**
 * Writer interface — abstracts artifact persistence so the simulation engine
 * can write to local files or to Atlassian Cloud APIs.
 */

import type { JiraIssue, JiraComment, IssueStatus, JsmStatus } from "../types/jira.js";
import type { ConfluencePage, ConfluenceComment, SpaceKey } from "../types/confluence.js";
import type { PersonaId, SimulationState } from "../types/simulation.js";

export interface WriteResult {
  /** Server-assigned issue key (e.g. "DR-42") */
  key?: string;
  /** Server-assigned ID for comments or pages */
  id?: string;
}

export interface IWriter {
  writeJiraIssue(
    issue: JiraIssue,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<WriteResult>;

  readJiraIssue(
    key: string,
    state: SimulationState,
  ): Promise<JiraIssue | null>;

  appendComment(
    issueKey: string,
    comment: JiraComment,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<WriteResult>;

  updateJiraIssueStatus(
    key: string,
    newStatus: IssueStatus | JsmStatus | string,
    by: string,
    date: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  updateIssueDescription(
    key: string,
    description: object,
    summary: string | undefined,
    date: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  writeConfluencePage(
    page: ConfluencePage,
    actingPersona?: PersonaId,
  ): Promise<WriteResult>;

  readConfluencePage(
    spaceKey: string,
    title: string,
  ): Promise<ConfluencePage | null>;

  updateConfluencePageBody(
    spaceKey: string,
    pageTitle: string,
    body: object,
    date: string,
    actingPersona?: PersonaId,
  ): Promise<void>;

  appendConfluenceComment(
    spaceKey: string,
    pageTitle: string,
    comment: ConfluenceComment,
    actingPersona?: PersonaId,
  ): Promise<WriteResult>;

  addReactionToComment(
    issueKey: string,
    commentId: string,
    emoji: string,
    author: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  addReactionToPage(
    spaceKey: string,
    title: string,
    emoji: string,
    author: string,
    actingPersona?: PersonaId,
  ): Promise<void>;

  startSprint(
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  closeSprint(
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  moveToSprint(
    issueKeys: string[],
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;

  moveToBacklog(
    issueKeys: string[],
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void>;
}
