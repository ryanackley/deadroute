/**
 * Output writer — writes Jira and Confluence artifacts to disk
 * in a hierarchy that mirrors the data model.
 *
 * Jira: output/jira/<Project>/<Epic>/<Story>/<Sub-task>.json
 * Confluence: output/confluence/<SpaceKey>/<PageTitle>/<ChildPage>.json
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { JiraIssue, JiraComment } from "../types/jira.js";
import type { ConfluencePage, ConfluenceComment } from "../types/confluence.js";
import type { PersonaId, SimulationState } from "../types/simulation.js";
import type { IWriter, WriteResult } from "./writer-interface.js";

export class OutputWriter implements IWriter {
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

  async writeJiraIssue(
    issue: JiraIssue,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const filePath = this.getJiraIssuePath(issue, state);
    await mkdir(dirname(filePath), { recursive: true });

    // Also create directory for this issue if it's an epic or parent
    if (issue.type === "Epic") {
      await mkdir(join(dirname(filePath), issue.key), { recursive: true });
    }

    await writeFile(filePath, JSON.stringify(issue, null, 2));
    return { key: issue.key };
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
      description: { version: 1, type: "doc", content: [] },
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

  async writeConfluencePage(
    page: ConfluencePage,
    _actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const filePath = this.getConfluencePagePath(page);
    await mkdir(dirname(filePath), { recursive: true });

    // Create directory for this page (in case it has children later)
    const pageDir = join(dirname(filePath), sanitizeFilename(page.title));
    await mkdir(pageDir, { recursive: true });

    await writeFile(filePath, JSON.stringify(page, null, 2));
    return { id: page.id };
  }

  async appendComment(
    key: string,
    comment: JiraComment,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const issue = await this.readJiraIssue(key, state);
    if (!issue) {
      throw new Error(`Cannot append comment: issue ${key} not found on disk`);
    }
    issue.comments.push({ ...comment, reactions: comment.reactions || [] });
    issue.updated = comment.created;
    await this.writeJiraIssue(issue, state);
    return { id: comment.id };
  }

  async updateJiraIssueStatus(
    key: string,
    newStatus: string,
    by: string,
    date: string,
    state: SimulationState,
    _actingPersona?: PersonaId,
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

  async readConfluencePage(spaceKey: string, title: string): Promise<ConfluencePage | null> {
    const stub: ConfluencePage = {
      id: "",
      spaceKey: spaceKey as ConfluencePage["spaceKey"],
      title,
      author: "",
      body: { version: 1, type: "doc", content: [] },
      parentTitle: null,
      labels: [],
      created: "",
      updated: "",
      comments: [],
      reactions: [],
      linkedJiraKeys: [],
    };
    const filePath = this.getConfluencePagePath(stub);
    try {
      const data = await readFile(filePath, "utf-8");
      return JSON.parse(data) as ConfluencePage;
    } catch {
      return null;
    }
  }

  async appendConfluenceComment(
    spaceKey: string,
    title: string,
    comment: ConfluenceComment,
    _actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const page = await this.readConfluencePage(spaceKey, title);
    if (!page) {
      throw new Error(`Cannot append comment: page "${title}" in ${spaceKey} not found on disk`);
    }
    page.comments.push(comment);
    page.updated = comment.created;
    await this.writeConfluencePage(page);
    return { id: comment.id };
  }

  async addReactionToComment(
    issueKey: string,
    commentId: string,
    emoji: string,
    author: string,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    const issue = await this.readJiraIssue(issueKey, state);
    if (!issue) {
      throw new Error(`Cannot add reaction: issue ${issueKey} not found on disk`);
    }
    const comment = issue.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Cannot add reaction: comment ${commentId} not found on ${issueKey}`);
    }
    if (!comment.reactions) comment.reactions = [];
    comment.reactions.push({ emoji, author });
    issue.updated = new Date().toISOString();
    await this.writeJiraIssue(issue, state);
  }

  async startSprint(
    sprintName: string,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    if (state.currentSprint && state.currentSprint.name === sprintName) {
      state.currentSprint.state = "active";
    }
  }

  async closeSprint(
    sprintName: string,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    if (state.currentSprint && state.currentSprint.name === sprintName) {
      state.currentSprint.state = "closed";
    }
  }

  async moveToSprint(
    issueKeys: string[],
    sprintName: string,
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    for (const key of issueKeys) {
      const ticket = state.tickets[key];
      if (!ticket) continue;
      ticket.sprint = sprintName;
      // Update the JSON file on disk
      const issue = await this.readJiraIssue(key, state);
      if (issue) {
        issue.sprint = sprintName;
        await this.writeJiraIssue(issue, state);
      }
    }
  }

  async moveToBacklog(
    issueKeys: string[],
    state: SimulationState,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    for (const key of issueKeys) {
      const ticket = state.tickets[key];
      if (!ticket) continue;
      ticket.sprint = null;
      const issue = await this.readJiraIssue(key, state);
      if (issue) {
        issue.sprint = null;
        await this.writeJiraIssue(issue, state);
      }
    }
  }

  async addReactionToPage(
    spaceKey: string,
    title: string,
    emoji: string,
    author: string,
    _actingPersona?: PersonaId,
  ): Promise<void> {
    const page = await this.readConfluencePage(spaceKey, title);
    if (!page) {
      throw new Error(`Cannot add reaction: page "${title}" in ${spaceKey} not found on disk`);
    }
    if (!page.reactions) page.reactions = [];
    page.reactions.push({ emoji, author });
    await this.writeConfluencePage(page);
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200); // Avoid extremely long filenames
}
