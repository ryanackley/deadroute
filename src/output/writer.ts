/**
 * Output writer — writes Jira and Confluence artifacts to disk
 * in a hierarchy that mirrors the data model.
 *
 * Jira: output/jira/<Project>/<Epic>/<Story>/<Sub-task>.json
 * Confluence: output/confluence/<SpaceKey>/<PageTitle>/<ChildPage>.json
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { JiraIssue } from "../types/jira.js";
import type { ConfluencePage } from "../types/confluence.js";
import type { SimulationState, TicketState } from "../types/simulation.js";

export class OutputWriter {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * Compute the file path for a Jira issue based on its hierarchy.
   *
   * - Epics: output/jira/DR/DR-1.json (top-level)
   * - Stories under epic: output/jira/DR/DR-1/DR-5.json
   * - Sub-tasks: output/jira/DR/DR-1/DR-5/DR-12.json
   * - Standalone (no epic): output/jira/DR/DR-50.json
   * - SUP tickets: output/jira/SUP/SUP-1.json (flat)
   */
  getJiraIssuePath(issue: JiraIssue, state: SimulationState): string {
    const projectDir = join(this.outputDir, "jira", issue.project);

    if (issue.project === "SUP") {
      // JSM tickets are flat
      return join(projectDir, `${issue.key}.json`);
    }

    if (issue.type === "Epic" || (!issue.epicKey && !issue.parentKey)) {
      // Epics and standalone issues are top-level
      return join(projectDir, `${issue.key}.json`);
    }

    if (issue.type === "Sub-task" && issue.parentKey) {
      // Sub-tasks nest under their parent
      const parent = state.tickets[issue.parentKey];
      if (parent?.epicKey) {
        // Parent is under an epic: epic/parent/sub-task
        return join(projectDir, parent.epicKey, issue.parentKey, `${issue.key}.json`);
      }
      // Parent has no epic: parent/sub-task
      return join(projectDir, issue.parentKey, `${issue.key}.json`);
    }

    if (issue.epicKey) {
      // Story/task/bug under an epic
      return join(projectDir, issue.epicKey, `${issue.key}.json`);
    }

    // Fallback: top-level
    return join(projectDir, `${issue.key}.json`);
  }

  /**
   * Compute the file path for a Confluence page based on its page tree.
   *
   * - Top-level: output/confluence/ENG/Coding Standards.json
   * - Child page: output/confluence/ENG/Architecture/System Overview.json
   */
  getConfluencePagePath(page: ConfluencePage): string {
    const spaceDir = join(this.outputDir, "confluence", page.spaceKey);

    if (!page.parentTitle) {
      return join(spaceDir, `${sanitizeFilename(page.title)}.json`);
    }

    return join(spaceDir, sanitizeFilename(page.parentTitle), `${sanitizeFilename(page.title)}.json`);
  }

  async writeJiraIssue(issue: JiraIssue, state: SimulationState): Promise<string> {
    const filePath = this.getJiraIssuePath(issue, state);
    await mkdir(dirname(filePath), { recursive: true });

    // Also create directory for this issue if it's an epic or parent
    if (issue.type === "Epic") {
      await mkdir(join(dirname(filePath), issue.key), { recursive: true });
    }

    await writeFile(filePath, JSON.stringify(issue, null, 2));
    return filePath;
  }

  async readJiraIssue(key: string, state: SimulationState): Promise<JiraIssue | null> {
    const ticketState = state.tickets[key];
    if (!ticketState) return null;

    // Reconstruct a minimal issue to compute path
    const stubIssue: JiraIssue = {
      key,
      project: ticketState.project,
      type: ticketState.type as JiraIssue["type"],
      epicKey: ticketState.epicKey,
      parentKey: null,
      // Fill remaining required fields with placeholders — we only need the path
      priority: "Medium",
      status: ticketState.status as JiraIssue["status"],
      summary: ticketState.summary,
      description: "",
      reporter: "",
      assignee: null,
      labels: [],
      components: [],
      created: "",
      updated: "",
      resolved: null,
      sprint: null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };

    const filePath = this.getJiraIssuePath(stubIssue, state);
    try {
      const data = await readFile(filePath, "utf-8");
      return JSON.parse(data) as JiraIssue;
    } catch {
      return null;
    }
  }

  async writeConfluencePage(page: ConfluencePage): Promise<string> {
    const filePath = this.getConfluencePagePath(page);
    await mkdir(dirname(filePath), { recursive: true });

    // Create directory for this page (in case it has children later)
    const pageDir = join(dirname(filePath), sanitizeFilename(page.title));
    await mkdir(pageDir, { recursive: true });

    await writeFile(filePath, JSON.stringify(page, null, 2));
    return filePath;
  }

  async appendComment(
    key: string,
    comment: { id: string; author: string; body: string; created: string },
    state: SimulationState
  ): Promise<void> {
    const issue = await this.readJiraIssue(key, state);
    if (!issue) {
      throw new Error(`Cannot append comment: issue ${key} not found on disk`);
    }
    issue.comments.push(comment);
    issue.updated = comment.created;
    await this.writeJiraIssue(issue, state);
  }

  async updateJiraIssueStatus(
    key: string,
    newStatus: string,
    by: string,
    date: string,
    state: SimulationState
  ): Promise<void> {
    const issue = await this.readJiraIssue(key, state);
    if (!issue) {
      throw new Error(`Cannot update status: issue ${key} not found on disk`);
    }
    const oldStatus = issue.status;
    issue.status = newStatus as JiraIssue["status"];
    issue.updated = date;
    if (newStatus === "Done" || newStatus === "Resolved" || newStatus === "Closed") {
      issue.resolved = date;
    }
    issue.statusHistory.push({
      from: oldStatus,
      to: newStatus as JiraIssue["status"],
      by,
      date,
    });
    await this.writeJiraIssue(issue, state);
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200); // Avoid extremely long filenames
}
