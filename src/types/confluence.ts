/**
 * Confluence data types for the DeadRoute sample data generator.
 */

export type SpaceKey = "PROD" | "ENG" | "OPS" | "MKT";

export interface ConfluenceComment {
  id: string;
  author: string;
  body: object; // ADF document
  created: string; // ISO 8601
}

export interface ConfluencePage {
  id: string;
  spaceKey: SpaceKey;
  title: string;
  author: string;
  body: object; // ADF document
  parentTitle: string | null; // For page hierarchy
  labels: string[];
  created: string; // ISO 8601
  updated: string; // ISO 8601
  comments: ConfluenceComment[];
  reactions: { emoji: string; author: string }[];
  // Cross-references to Jira
  linkedJiraKeys: string[];
}

export interface ConfluenceSpace {
  key: SpaceKey;
  name: string;
  description: string;
}

export const SPACES: ConfluenceSpace[] = [
  {
    key: "PROD",
    name: "Product",
    description: "PRDs, roadmap, feature specs, meeting notes, retrospectives",
  },
  {
    key: "ENG",
    name: "Engineering",
    description:
      "Architecture docs, ADRs, runbooks, API docs, coding standards, learning posts",
  },
  {
    key: "OPS",
    name: "Operations",
    description:
      "Onboarding guide, office policies, generator schedule, HR docs, facility management",
  },
  {
    key: "MKT",
    name: "Marketing",
    description:
      "Brand guidelines, user research, growth metrics, Scout program, outreach",
  },
];
