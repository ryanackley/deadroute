/**
 * Jira data types for the DeadRoute sample data generator.
 * These represent the JSON artifacts written to disk.
 */

export type IssueType = "Epic" | "Story" | "Task" | "Bug" | "Sub-task";

export type IssuePriority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

export type IssueStatus =
  | "To Do"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Won't Do";

export type JsmStatus =
  | "Waiting for support"
  | "Waiting for customer"
  | "In progress"
  | "Escalated"
  | "Resolved"
  | "Closed";

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string; // ISO 8601
}

export interface StatusTransition {
  from: IssueStatus | JsmStatus;
  to: IssueStatus | JsmStatus;
  by: string;
  date: string; // ISO 8601
}

export interface JiraIssue {
  key: string; // e.g., "DR-42" or "SUP-17"
  project: "DR" | "SUP";
  type: IssueType;
  priority: IssuePriority;
  status: IssueStatus | JsmStatus;
  summary: string;
  description: string;
  reporter: string;
  assignee: string | null;
  labels: string[];
  components: string[];
  created: string; // ISO 8601
  updated: string; // ISO 8601
  resolved: string | null; // ISO 8601
  sprint: string | null; // Sprint name
  epicKey: string | null; // Parent epic key
  parentKey: string | null; // Parent issue key (for sub-tasks)
  linkedIssues: LinkedIssue[];
  comments: JiraComment[];
  statusHistory: StatusTransition[];
  storyPoints: number | null;
  // JSM-specific fields
  customerEmail: string | null;
  slaBreached: boolean | null;
}

export interface LinkedIssue {
  type: "blocks" | "is blocked by" | "relates to" | "duplicates" | "is duplicated by" | "causes" | "is caused by";
  key: string;
}

export interface Sprint {
  name: string;
  goal: string;
  state: "closed" | "active" | "future";
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
}
