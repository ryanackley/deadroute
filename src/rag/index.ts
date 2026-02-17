/**
 * Vectra RAG layer — local vector database for context retrieval.
 * Indexes generated artifacts and provides semantic search for persona agents.
 */

import { LocalDocumentIndex } from "vectra";
import OpenAI from "openai";
import { join } from "path";
import type { JiraIssue } from "../types/jira.js";
import type { ConfluencePage } from "../types/confluence.js";
import type { Config } from "../config.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import { extractTextFromAdf } from "../utils/adf.js";

export interface RagResult {
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export class RagIndex {
  private index: LocalDocumentIndex | null = null;
  private indexPath: string;
  private openai: OpenAI;
  private tokenTracker: TokenTracker | null;
  private config: Config;

  constructor(config: Config, tokenTracker: TokenTracker | null = null) {
    this.config = config;
    this.indexPath = join(config.outputDir, "vectra");
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.tokenTracker = tokenTracker;
  }

  async initialize(): Promise<void> {
    this.index = new LocalDocumentIndex({
      folderPath: this.indexPath,
      embeddings: {
        createEmbeddings: async (inputs: string | string[]) => {
          const inputArray = Array.isArray(inputs) ? inputs : [inputs];
          const response = await this.openai.embeddings.create({
            model: "text-embedding-3-small",
            input: inputArray,
          });

          // Track embedding token usage
          if (this.tokenTracker && response.usage) {
            this.tokenTracker.record({
              inputTokens: response.usage.total_tokens,
              outputTokens: 0,
              category: "embedding",
              model: "text-embedding-3-small",
            });
          }

          return {
            status: "success" as const,
            output: response.data.map((d) => d.embedding),
          };
        },
        maxTokens: 8191,
      },
    });

    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex();
    }
  }

  async indexJiraIssue(issue: JiraIssue): Promise<void> {
    if (!this.index) throw new Error("RAG index not initialized");

    const text = buildJiraDocument(issue);
    const metadata: Record<string, string> = {
      key: issue.key,
      project: issue.project,
      type: issue.type,
      reporter: issue.reporter,
      assignee: issue.assignee || "unassigned",
      status: issue.status,
      sprint: issue.sprint || "backlog",
      created: issue.created,
      artifactType: "jira",
    };

    await this.index.upsertDocument(issue.key, text, "text", metadata);
  }

  async indexConfluencePage(page: ConfluencePage): Promise<void> {
    if (!this.index) throw new Error("RAG index not initialized");

    const text = buildConfluenceDocument(page);
    const metadata: Record<string, string> = {
      id: page.id,
      spaceKey: page.spaceKey,
      title: page.title,
      author: page.author,
      created: page.created,
      artifactType: "confluence",
    };

    await this.index.upsertDocument(page.id, text, "text", metadata);
  }

  async query(queryText: string, maxResults: number = 5): Promise<RagResult[]> {
    if (!this.index) throw new Error("RAG index not initialized");

    const results = await this.index.queryDocuments(queryText, { maxDocuments: maxResults });
    const ragResults: RagResult[] = [];

    for (const r of results) {
      const sections = await r.renderAllSections(500);
      ragResults.push({
        text: sections.map((s) => s.text).join("\n"),
        score: r.score,
        metadata: {},
      });
    }

    return ragResults;
  }
}

function buildJiraDocument(issue: JiraIssue): string {
  const parts = [
    `[${issue.key}] ${issue.summary}`,
    `Type: ${issue.type} | Status: ${issue.status} | Priority: ${issue.priority}`,
    `Reporter: ${issue.reporter} | Assignee: ${issue.assignee || "Unassigned"}`,
    `Sprint: ${issue.sprint || "Backlog"}`,
    "",
    extractTextFromAdf(issue.description),
  ];

  if (issue.comments.length > 0) {
    parts.push("", "--- Comments ---");
    for (const c of issue.comments.slice(-5)) {
      // Index last 5 comments
      parts.push(`${c.author}: ${extractTextFromAdf(c.body)}`);
    }
  }

  return parts.join("\n");
}

function buildConfluenceDocument(page: ConfluencePage): string {
  const parts = [
    `[${page.spaceKey}] ${page.title}`,
    `Author: ${page.author} | Space: ${page.spaceKey}`,
    "",
    extractTextFromAdf(page.body),
  ];

  if (page.comments.length > 0) {
    parts.push("", "--- Comments ---");
    for (const c of page.comments.slice(-3)) {
      parts.push(`${c.author}: ${extractTextFromAdf(c.body)}`);
    }
  }

  return parts.join("\n");
}
