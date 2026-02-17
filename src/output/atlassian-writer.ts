/**
 * Atlassian API writer — implements IWriter by calling Jira and Confluence REST APIs.
 * Each persona's writes are authenticated as that user via per-user AtlassianClient instances.
 */

import chalk from "chalk";

import type { JiraIssue, JiraComment, IssueStatus, JsmStatus } from "../types/jira.js";
import type { ConfluencePage, ConfluenceComment, SpaceKey } from "../types/confluence.js";
import type { PersonaId, SimulationState } from "../types/simulation.js";
import type { IWriter, WriteResult } from "./writer-interface.js";
import type {
  AtlassianConfig,
  AtlassianUserConfig,
} from "../types/atlassian-config.js";
import {
  AtlassianClient,
  type JiraIssueApiResponse,
} from "../bootstrap/atlassian-client.js";
import { extractTextFromAdf } from "../utils/adf.js";

export class AtlassianWriter implements IWriter {
  private config: AtlassianConfig;
  /** Per-user API clients, keyed by persona ID */
  private clients: Map<PersonaId, AtlassianClient> = new Map();
  /** Persona → Atlassian account ID */
  private accountIds: Map<PersonaId, string> = new Map();
  /** Space key → Atlassian space ID (numeric) */
  private spaceIds: Map<SpaceKey, string> = new Map();
  /** "SPACEKEY::Title" → Confluence page ID */
  private pageIdMap: Map<string, string> = new Map();
  /** Issue key (e.g. "DR-42") → Jira internal issue ID */
  private jiraIssueIds: Map<string, string> = new Map();
  /** Project key → (issue type name → issue type id) */
  private issueTypeIds: Map<string, Map<string, string>> = new Map();
  /** DR project board ID (Agile API) */
  private boardId: string | null = null;
  /** Sprint name → Jira sprint ID */
  private sprintIdMap: Map<string, string> = new Map();
  /** Default client (admin / marcus) for read-only operations */
  private defaultClient: AtlassianClient;
  /** Atlassian cloud instance ID (for GraphQL mutations) */
  private cloudId: string | null = null;

  constructor(config: AtlassianConfig) {
    this.config = config;

    // Build per-user clients
    const personaIds: PersonaId[] = [
      "chad", "vanessa", "tammy", "sasha", "marcus",
      "cooper", "priya", "raj", "dana", "tk",
    ];

    for (const id of personaIds) {
      const user = config.users[id];
      if (user?.apiToken) {
        this.clients.set(
          id,
          new AtlassianClient(config.host, user.email, user.apiToken),
        );
        this.accountIds.set(id, user.accountId);
      }
    }

    // Default client uses marcus (admin)
    const marcus = config.users.marcus;
    this.defaultClient = new AtlassianClient(
      config.host,
      marcus.email,
      marcus.apiToken,
    );

    // Populate space IDs from config
    for (const [key, space] of Object.entries(config.spaces)) {
      this.spaceIds.set(key as SpaceKey, space.id);
    }
  }

  /** Initialize discovery caches — call once after construction. */
  async init(state?: SimulationState): Promise<void> {
    // Restore page and issue ID maps from state if resuming
    if (state?.confluencePageIds) {
      for (const [key, id] of Object.entries(state.confluencePageIds)) {
        this.pageIdMap.set(key, id);
      }
    }
    if (state?.jiraIssueIds) {
      for (const [key, id] of Object.entries(state.jiraIssueIds)) {
        this.jiraIssueIds.set(key, id);
      }
    }
    if (state?.sprintIds) {
      for (const [name, id] of Object.entries(state.sprintIds)) {
        this.sprintIdMap.set(name, id);
      }
    }

    // Discover cloud ID for GraphQL mutations (reactions)
    if (this.config.cloudId) {
      this.cloudId = this.config.cloudId;
    } else {
      try {
        const info = await this.defaultClient.getServerInfo();
        this.cloudId = info.cloudId;
        console.log(chalk.dim(`  Discovered cloudId: ${this.cloudId}`));
      } catch (err) {
        console.warn(chalk.yellow(`  Could not discover cloudId (reactions will be skipped): ${err}`));
      }
    }

    // Discover board and existing sprints for DR project
    try {
      const boards = await this.defaultClient.getBoards("DR");
      if (boards.values.length > 0) {
        this.boardId = String(boards.values[0].id);
        console.log(chalk.dim(`  Discovered board: ${boards.values[0].name} (id=${this.boardId})`));

        const sprints = await this.defaultClient.getBoardSprints(this.boardId);
        for (const s of sprints.values) {
          this.sprintIdMap.set(s.name, String(s.id));
        }
        if (sprints.values.length > 0) {
          console.log(chalk.dim(`  Discovered ${sprints.values.length} existing sprint(s)`));
        }
      }
    } catch (err) {
      console.warn(chalk.yellow(`  Could not discover board/sprints: ${err}`));
    }

    // Discover issue types per project
    for (const projectKey of ["DR", "SUP"] as const) {
      try {
        const types = await this.defaultClient.getIssueTypesForProject(projectKey);
        const typeMap = new Map<string, string>();
        for (const t of types.issueTypes) {
          typeMap.set(t.name, t.id);
        }
        this.issueTypeIds.set(projectKey, typeMap);
        console.log(
          chalk.dim(`  Discovered ${types.issueTypes.length} issue types for ${projectKey}: ${types.issueTypes.map((t) => t.name).join(", ")}`),
        );
      } catch (err) {
        console.error(chalk.red(`  Failed to discover issue types for ${projectKey}: ${err}`));
      }
    }
  }

  /** Persist the current page/issue/sprint ID maps back into simulation state. */
  syncToState(state: SimulationState): void {
    state.confluencePageIds = Object.fromEntries(this.pageIdMap);
    state.jiraIssueIds = Object.fromEntries(this.jiraIssueIds);
    state.sprintIds = Object.fromEntries(this.sprintIdMap);
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getClient(persona?: PersonaId): AtlassianClient {
    if (persona) {
      const client = this.clients.get(persona);
      if (client) return client;
    }
    return this.defaultClient;
  }

  private getAccountId(personaId: string): string | undefined {
    return this.accountIds.get(personaId as PersonaId);
  }

  private getIssueTypeId(projectKey: string, typeName: string): string | undefined {
    const typeMap = this.issueTypeIds.get(projectKey);
    if (!typeMap) return undefined;

    // Exact match first
    const exact = typeMap.get(typeName);
    if (exact) return exact;

    // Normalize: lowercase, strip hyphens/spaces (handles "Sub-task" vs "Subtask" etc.)
    const normalize = (s: string) => s.toLowerCase().replace(/[-\s]/g, "");
    const target = normalize(typeName);
    for (const [name, id] of typeMap) {
      if (normalize(name) === target) return id;
    }
    return undefined;
  }

  private pageMapKey(spaceKey: string, title: string): string {
    return `${spaceKey}::${title}`;
  }

  // ─── Jira Issue CRUD ───────────────────────────────────────────────

  async writeJiraIssue(
    issue: JiraIssue,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const client = this.getClient(actingPersona);

    // Map fields to Jira API format
    const fields: Record<string, unknown> = {
      project: { key: issue.project },
      summary: issue.summary,
      description: issue.description, // ADF — Jira v3 accepts natively
      priority: { name: issue.priority },
      labels: issue.labels,
    };

    // Issue type — look up ID from discovery cache
    const typeId = this.getIssueTypeId(issue.project, issue.type);
    if (typeId) {
      fields.issuetype = { id: typeId };
    } else {
      // Fall back to name-based (works in many configurations)
      fields.issuetype = { name: issue.type };
    }

    // Reporter
    // const reporterAccountId = this.getAccountId(issue.reporter);
    // if (reporterAccountId) {
    //   fields.reporter = { id: reporterAccountId };
    // }

    // Assignee
    if (issue.assignee) {
      const assigneeAccountId = this.getAccountId(issue.assignee);
      if (assigneeAccountId) {
        fields.assignee = { id: assigneeAccountId };
      }
    }

    // Parent (epic or parent issue for sub-tasks)
    if (issue.parentKey) {
      const parentId = this.jiraIssueIds.get(issue.parentKey);
      if (parentId) {
        fields.parent = { id: parentId };
      } else {
        fields.parent = { key: issue.parentKey };
      }
    } else if (issue.epicKey) {
      const epicId = this.jiraIssueIds.get(issue.epicKey);
      if (epicId) {
        fields.parent = { id: epicId };
      } else {
        fields.parent = { key: issue.epicKey };
      }
    }

    try {
      const result = await client.createIssue(fields);

      // Cache the server-assigned key and ID
      this.jiraIssueIds.set(result.key, result.id);
      this.syncToState(state);

      // Update the issue object with the server-assigned key
      issue.key = result.key;

      return { key: result.key, id: result.id };
    } catch (err) {
      // If the parent hierarchy is invalid, retry without the parent link
      const isHierarchyError =
        err instanceof Error &&
        err.message.includes("does not belong to appropriate hierarchy");
      if (isHierarchyError && fields.parent) {
        console.warn(chalk.yellow(`  Invalid parent hierarchy for "${issue.summary}", retrying without parent`));
        delete fields.parent;
        const result = await client.createIssue(fields);
        this.jiraIssueIds.set(result.key, result.id);
        this.syncToState(state);
        issue.key = result.key;
        issue.epicKey = null;
        issue.parentKey = null;
        return { key: result.key, id: result.id };
      }
      console.error(chalk.red(`  Failed to create issue "${issue.summary}": ${err}`));
      throw err;
    }
  }

  async readJiraIssue(
    key: string,
    state: SimulationState,
  ): Promise<JiraIssue | null> {
    try {
      const apiResponse = await this.defaultClient.getIssue(key);
      return this.mapApiResponseToJiraIssue(apiResponse);
    } catch {
      return null;
    }
  }

  async appendComment(
    issueKey: string,
    comment: JiraComment,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const client = this.getClient(actingPersona);

    const result = await client.addComment(issueKey, comment.body);

    // Update comment with server-assigned ID
    comment.id = result.id;

    return { id: result.id };
  }

  async updateJiraIssueStatus(
    key: string,
    newStatus: IssueStatus | JsmStatus | string,
    by: string,
    date: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    const client = this.getClient(actingPersona);

    // Get available transitions for this issue
    const { transitions } = await client.getTransitions(key);

    // Find a transition whose target status name matches
    const match = transitions.find(
      (t) => t.to.name.toLowerCase() === newStatus.toLowerCase(),
    );

    if (!match) {
      console.warn(
        chalk.yellow(
          `  No transition to "${newStatus}" available for ${key}. ` +
          `Available: ${transitions.map((t) => `${t.name} → ${t.to.name}`).join(", ")}`,
        ),
      );
      return;
    }

    await client.doTransition(key, match.id);
  }

  // ─── Confluence Pages ──────────────────────────────────────────────

  async writeConfluencePage(
    page: ConfluencePage,
    actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const client = this.getClient(actingPersona);
    const spaceId = this.spaceIds.get(page.spaceKey);

    if (!spaceId) {
      throw new Error(`No space ID found for space key "${page.spaceKey}"`);
    }

    // Resolve parent page ID if this page has a parent
    let parentId: string | undefined;
    if (page.parentTitle) {
      parentId = this.pageIdMap.get(this.pageMapKey(page.spaceKey, page.parentTitle));
      if (!parentId) {
        // Try to find it via API
        const parentPage = await this.defaultClient.getPageByTitle(spaceId, page.parentTitle);
        if (parentPage) {
          parentId = parentPage.id;
          this.pageIdMap.set(this.pageMapKey(page.spaceKey, page.parentTitle), parentId);
        }
      }
    }

    let pageId: string;
    try {
      const result = await client.createPage({
        spaceId,
        title: page.title,
        body: {
          representation: "atlas_doc_format" as const,
          value: JSON.stringify(page.body),
        },
        parentId,
      });
      pageId = result.id;
    } catch (err: unknown) {
      // If a page with this title already exists, look it up and return its ID
      const isConflict =
        err instanceof Error &&
        err.message.includes("A page with this title already exists");
      if (isConflict) {
        const existing = await this.defaultClient.getPageByTitle(spaceId, page.title);
        if (existing) {
          console.log(chalk.dim(`  Page "${page.title}" already exists (id=${existing.id}), reusing`));
          pageId = existing.id;
        } else {
          throw err; // Title conflict but can't find the page — re-throw
        }
      } else {
        throw err;
      }
    }

    // Cache the page ID
    const mapKey = this.pageMapKey(page.spaceKey, page.title);
    this.pageIdMap.set(mapKey, pageId);
    page.id = pageId;

    return { id: pageId };
  }

  async readConfluencePage(
    spaceKey: string,
    title: string,
  ): Promise<ConfluencePage | null> {
    const spaceId = this.spaceIds.get(spaceKey as SpaceKey);
    if (!spaceId) return null;

    // Check our cache first
    const cachedId = this.pageIdMap.get(this.pageMapKey(spaceKey, title));
    if (cachedId) {
      try {
        const apiPage = await this.defaultClient.getPage(cachedId);
        return this.mapApiResponseToConfluencePage(apiPage, spaceKey as SpaceKey);
      } catch {
        return null;
      }
    }

    // Fallback: search by title
    const found = await this.defaultClient.getPageByTitle(spaceId, title);
    if (!found) return null;

    this.pageIdMap.set(this.pageMapKey(spaceKey, title), found.id);

    try {
      // Re-fetch with body
      const fullPage = await this.defaultClient.getPage(found.id);
      return this.mapApiResponseToConfluencePage(fullPage, spaceKey as SpaceKey);
    } catch {
      return null;
    }
  }

  async appendConfluenceComment(
    spaceKey: string,
    pageTitle: string,
    comment: ConfluenceComment,
    actingPersona?: PersonaId,
  ): Promise<WriteResult> {
    const client = this.getClient(actingPersona);
    const spaceId = this.spaceIds.get(spaceKey as SpaceKey);
    if (!spaceId) {
      throw new Error(`No space ID found for space key "${spaceKey}"`);
    }

    // Find the page ID
    let pageId = this.pageIdMap.get(this.pageMapKey(spaceKey, pageTitle));
    if (!pageId) {
      const page = await this.defaultClient.getPageByTitle(spaceId, pageTitle);
      if (!page) {
        throw new Error(`Page "${pageTitle}" not found in space ${spaceKey}`);
      }
      pageId = page.id;
      this.pageIdMap.set(this.pageMapKey(spaceKey, pageTitle), pageId);
    }

    const result = await client.addPageComment(pageId, {
      representation: "atlas_doc_format" as const,
      value: JSON.stringify(comment.body),
    });

    comment.id = result.id;
    return { id: result.id };
  }

  // ─── Sprint Operations (Agile API) ─────────────────────────────────

  async startSprint(
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    const client = this.getClient(actingPersona);
    let sprintId = this.sprintIdMap.get(sprintName);

    if (!sprintId && this.boardId) {
      // Sprint doesn't exist yet — create it in "future" state first
      const sprint = state.currentSprint;
      const created = await client.createSprint({
        name: sprintName,
        originBoardId: parseInt(this.boardId),
        startDate: sprint?.startDate,
        endDate: sprint?.endDate,
        goal: sprint?.goal,
      });
      sprintId = String(created.id);
      this.sprintIdMap.set(sprintName, sprintId);
      console.log(chalk.dim(`  Created sprint "${sprintName}" (id=${sprintId})`));
    }

    if (sprintId) {
      const sprint = state.currentSprint;
      await client.updateSprint(sprintId, {
        name: sprintName,
        state: "active",
        startDate: sprint?.startDate,
        endDate: sprint?.endDate,
      });
      console.log(chalk.dim(`  Started sprint "${sprintName}"`));
    }
  }

  async closeSprint(
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    const client = this.getClient(actingPersona);
    const sprintId = this.sprintIdMap.get(sprintName);

    if (sprintId) {
      const sprint = state.currentSprint;
      await client.updateSprint(sprintId, {
        name: sprintName,
        state: "closed",
        startDate: sprint?.startDate,
        endDate: sprint?.endDate,
      });
      console.log(chalk.dim(`  Closed sprint "${sprintName}"`));
    } else {
      console.warn(chalk.yellow(`  Cannot close sprint "${sprintName}": no sprint ID found`));
    }
  }

  async moveToSprint(
    issueKeys: string[],
    sprintName: string,
    state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    const client = this.getClient(actingPersona);
    let sprintId = this.sprintIdMap.get(sprintName);

    if (!sprintId && this.boardId) {
      // Sprint doesn't exist yet — create it so we can move issues into it
      const sprint = state.currentSprint;
      const created = await client.createSprint({
        name: sprintName,
        originBoardId: parseInt(this.boardId),
        startDate: sprint?.startDate,
        endDate: sprint?.endDate,
        goal: sprint?.goal,
      });
      sprintId = String(created.id);
      this.sprintIdMap.set(sprintName, sprintId);
      console.log(chalk.dim(`  Created sprint "${sprintName}" (id=${sprintId})`));
    }

    if (sprintId) {
      await client.moveIssuesToSprint(sprintId, issueKeys);
      console.log(chalk.dim(`  Moved ${issueKeys.join(", ")} to ${sprintName}`));
    } else {
      console.warn(chalk.yellow(`  Cannot move issues to "${sprintName}": no sprint ID found (no board discovered)`));
    }
  }

  async moveToBacklog(
    issueKeys: string[],
    _state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    const client = this.getClient(actingPersona);
    await client.moveIssuesToBacklog(issueKeys);
    console.log(chalk.dim(`  Moved ${issueKeys.join(", ")} to backlog`));
  }

  // ─── Reactions ─────────────────────────────────────────────────────

  async addReactionToComment(
    issueKey: string,
    commentId: string,
    emoji: string,
    _author: string,
    _state: SimulationState,
    actingPersona?: PersonaId,
  ): Promise<void> {
    if (!this.cloudId) return;

    const client = this.getClient(actingPersona);
    const issueId = this.jiraIssueIds.get(issueKey);
    if (!issueId) return;

    const emojiId = emojiToCodePoint(emoji);
    if (!emojiId) return;

    try {
      await client.addJiraCommentReaction({
        cloudId: this.cloudId,
        issueId,
        commentId,
        emojiId,
      });
    } catch {
      // Silently skip failed reactions
    }
  }

  async addReactionToPage(
    spaceKey: string,
    title: string,
    emoji: string,
    _author: string,
    actingPersona?: PersonaId,
  ): Promise<void> {
    if (!this.cloudId) return; // No cloudId — skip silently

    const client = this.getClient(actingPersona);
    const spaceId = this.spaceIds.get(spaceKey as SpaceKey);
    if (!spaceId) return;

    const pageId = this.pageIdMap.get(this.pageMapKey(spaceKey, title));
    if (!pageId) return;

    const emojiId = emojiToCodePoint(emoji);
    if (!emojiId) return;

    try {
      await client.addConfluenceReaction({
        cloudId: this.cloudId,
        contentId: parseInt(pageId, 10),
        contentType: "PAGE",
        containerId: parseInt(spaceId, 10),
        containerType: "SPACE",
        emojiId,
      });
    } catch {
      // Silently skip failed reactions
    }
  }

  // ─── API response mapping ──────────────────────────────────────────

  private mapApiResponseToJiraIssue(api: JiraIssueApiResponse): JiraIssue {
    const f = api.fields;

    // Extract comments from the API response
    const commentsData = f.comment as { comments?: Array<{
      id: string;
      author?: { displayName?: string; accountId?: string };
      body?: object;
      created?: string;
    }> } | undefined;

    const comments: JiraComment[] = (commentsData?.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName || c.author?.accountId || "unknown",
      body: c.body || { version: 1, type: "doc", content: [] },
      created: c.created || "",
      reactions: [],
    }));

    // Extract status history from changelog if available
    const statusHistory: JiraIssue["statusHistory"] = [];

    return {
      key: api.key,
      project: api.key.split("-")[0] as "DR" | "SUP",
      type: (f.issuetype as { name: string })?.name as JiraIssue["type"] || "Task",
      priority: (f.priority as { name: string })?.name as JiraIssue["priority"] || "Medium",
      status: (f.status as { name: string })?.name as JiraIssue["status"] || "To Do",
      summary: (f.summary as string) || "",
      description: (f.description as object) || { version: 1, type: "doc", content: [] },
      reporter: (f.reporter as { displayName?: string })?.displayName || "",
      assignee: (f.assignee as { displayName?: string })?.displayName || null,
      labels: (f.labels as string[]) || [],
      components: ((f.components as Array<{ name: string }>) || []).map((c) => c.name),
      created: (f.created as string) || "",
      updated: (f.updated as string) || "",
      resolved: (f.resolutiondate as string) || null,
      sprint: null, // Sprint info requires Agile API
      epicKey: (f.parent as { key?: string })?.key || null,
      parentKey: (f.parent as { key?: string })?.key || null,
      linkedIssues: [],
      comments,
      statusHistory,
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };
  }

  private mapApiResponseToConfluencePage(
    api: { id: string; title: string; status: string; spaceId: string; parentId: string | null; authorId: string; body?: { atlas_doc_format?: { value: string } } },
    spaceKey: SpaceKey,
  ): ConfluencePage {
    let body: object = { version: 1, type: "doc", content: [] };
    if (api.body?.atlas_doc_format?.value) {
      try {
        body = JSON.parse(api.body.atlas_doc_format.value);
      } catch {
        // Keep default empty ADF
      }
    }

    return {
      id: api.id,
      spaceKey,
      title: api.title,
      author: api.authorId,
      body,
      parentTitle: null, // Would need additional lookup
      labels: [],
      created: "",
      updated: "",
      comments: [],
      reactions: [],
      linkedJiraKeys: [],
    };
  }
}

// ─── Emoji Helpers ──────────────────────────────────────────────────

/** Well-known emoji name → Unicode code point hex. */
const EMOJI_NAME_MAP: Record<string, string> = {
  heart: "2764",
  thumbsup: "1f44d",
  "+1": "1f44d",
  thumbsdown: "1f44e",
  "-1": "1f44e",
  clap: "1f44f",
  tada: "1f389",
  fire: "1f525",
  eyes: "1f440",
  thinking: "1f914",
  rocket: "1f680",
  100: "1f4af",
  laugh: "1f602",
  smile: "1f604",
  pray: "1f64f",
  raised_hands: "1f64c",
  muscle: "1f4aa",
  warning: "26a0",
  check: "2705",
  x: "274c",
  star: "2b50",
  wave: "1f44b",
  skull: "1f480",
  zombie: "1f9df",
  brain: "1f9e0",
};

/**
 * Convert an emoji string to its Unicode code point hex for the Confluence
 * reaction GraphQL API. Handles both actual emoji characters ("❤️") and
 * text names ("heart", ":thumbsup:").
 */
function emojiToCodePoint(emoji: string): string | null {
  // Strip surrounding colons (":thumbsup:" → "thumbsup")
  const cleaned = emoji.replace(/^:|:$/g, "").trim();

  // Check name map first
  const mapped = EMOJI_NAME_MAP[cleaned.toLowerCase()];
  if (mapped) return mapped;

  // Try interpreting as an actual emoji character — get its first code point
  const codePoint = cleaned.codePointAt(0);
  if (codePoint && codePoint > 0x7f) {
    return codePoint.toString(16);
  }

  return null;
}
