/**
 * Timestamp event ledger types — records every timestamped event
 * for post-import timestamp restoration in Atlassian instances.
 */

import type { PersonaId } from "./simulation.js";
import type { SpaceKey } from "./confluence.js";

interface BaseLedgerEvent {
  ts: string; // ISO 8601 timestamp
}

export interface IssueCreatedEvent extends BaseLedgerEvent {
  event: "issue_created";
  key: string;
  actor: PersonaId;
}

export interface IssueUpdatedEvent extends BaseLedgerEvent {
  event: "issue_updated";
  key: string;
  actor: PersonaId;
}

export interface IssueResolvedEvent extends BaseLedgerEvent {
  event: "issue_resolved";
  key: string;
  actor: PersonaId;
}

export interface CommentAddedEvent extends BaseLedgerEvent {
  event: "comment_added";
  key: string;
  commentId: string;
  actor: PersonaId;
}

export interface StatusChangeEvent extends BaseLedgerEvent {
  event: "status_change";
  key: string;
  from: string;
  to: string;
  actor: PersonaId;
}

export interface PageCreatedEvent extends BaseLedgerEvent {
  event: "page_created";
  pageId: string;
  spaceKey: SpaceKey;
  title: string;
  actor: PersonaId;
}

export interface PageUpdatedEvent extends BaseLedgerEvent {
  event: "page_updated";
  pageId: string;
  spaceKey: SpaceKey;
  actor: PersonaId;
}

export interface PageCommentAddedEvent extends BaseLedgerEvent {
  event: "page_comment_added";
  pageId: string;
  spaceKey: SpaceKey;
  commentId: string;
  actor: PersonaId;
}

export interface SprintStartedEvent extends BaseLedgerEvent {
  event: "sprint_started";
  sprintName: string;
  startDate: string;
  endDate: string;
}

export interface SprintClosedEvent extends BaseLedgerEvent {
  event: "sprint_closed";
  sprintName: string;
}

export type LedgerEvent =
  | IssueCreatedEvent
  | IssueUpdatedEvent
  | IssueResolvedEvent
  | CommentAddedEvent
  | StatusChangeEvent
  | PageCreatedEvent
  | PageUpdatedEvent
  | PageCommentAddedEvent
  | SprintStartedEvent
  | SprintClosedEvent;
