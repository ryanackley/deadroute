/**
 * Atlassian MCP tools for factory agents.
 *
 * Unlike the simulation's persona tools (which accumulate results for the
 * engine to write later), factory tools write IMMEDIATELY via the
 * AtlassianWriter and return real server-assigned keys/IDs — agents need
 * read-back consistency (e.g. the dev lead creates tickets, then moves
 * those exact keys into the sprint).
 *
 * Each factory persona acts as its bound Atlassian user (see
 * factory-profiles.ts); searches use the admin client.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AIPersonaId } from "../types/factory.js";
import type { PersonaId, SimulationState } from "../types/simulation.js";
import type { JiraIssue } from "../types/jira.js";
import type { ConfluencePage, SpaceKey } from "../types/confluence.js";
import type { AtlassianWriter } from "../output/atlassian-writer.js";
import type { AtlassianClient } from "../bootstrap/atlassian-client.js";
import { adfToolSchema, extractTextFromAdf } from "../utils/adf.js";

export interface AtlassianActionLog {
  ticketsCreated: { key: string; summary: string; type: string; assignee: AIPersonaId | null }[];
  comments: { issueKey: string }[];
  transitions: { issueKey: string; newStatus: string }[];
  pagesCreated: { spaceKey: string; title: string; id: string }[];
  pagesEdited: { spaceKey: string; title: string }[];
  sprintOps: { action: string; sprintName: string; issueKeys?: string[] }[];
}

export function createAtlassianActionLog(): AtlassianActionLog {
  return {
    ticketsCreated: [],
    comments: [],
    transitions: [],
    pagesCreated: [],
    pagesEdited: [],
    sprintOps: [],
  };
}

export interface FactoryToolContext {
  /** The factory persona this tool server acts as */
  persona: AIPersonaId;
  /** factory persona → provisioned Atlassian user */
  binding: Record<AIPersonaId, PersonaId>;
  writer: AtlassianWriter;
  state: SimulationState;
  /** Admin client used for JQL/CQL searches */
  searchClient: AtlassianClient;
  log: AtlassianActionLog;
}

export type FactoryAtlassianToolName =
  | "create_jira_ticket"
  | "add_comment"
  | "transition_ticket"
  | "assign_ticket"
  | "get_jira_ticket"
  | "search_jira"
  | "create_confluence_page"
  | "edit_confluence_page"
  | "get_confluence_page"
  | "search_confluence"
  | "start_sprint"
  | "close_sprint"
  | "move_to_sprint";

const FACTORY_ASSIGNEES = ["pm", "dev_lead", "dev1", "dev2", "tester"] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errText(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return text(`ERROR ${context}: ${msg}`);
}

/**
 * Build the requested subset of Atlassian tools for one factory persona.
 */
export function createFactoryAtlassianTools(
  ctx: FactoryToolContext,
  include: FactoryAtlassianToolName[],
) {
  const acting = ctx.binding[ctx.persona];
  const now = () => new Date().toISOString();

  const all = {
    create_jira_ticket: tool(
      "create_jira_ticket",
      "Create a Jira issue in the DR project. Returns the real issue key.",
      {
        type: z.enum(["Epic", "Story", "Task", "Bug", "Sub-task"]),
        summary: z.string().describe("Short, specific title."),
        description: adfToolSchema.describe(
          "Full description in ADF. For stories/tasks include acceptance criteria. For bugs include steps to reproduce, expected vs actual.",
        ),
        priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
        assignee: z.enum(FACTORY_ASSIGNEES).optional().describe("Team member to assign (factory persona id)."),
        labels: z.array(z.string()).optional(),
        epicKey: z.string().optional().describe("Parent epic key if this belongs to an epic."),
        storyPoints: z.number().optional(),
      },
      async (args) => {
        try {
          const issue: JiraIssue = {
            key: "",
            project: "DR",
            type: args.type,
            priority: args.priority,
            status: "To Do",
            summary: args.summary,
            description: args.description as object,
            reporter: acting,
            assignee: args.assignee ? ctx.binding[args.assignee] : null,
            labels: args.labels || [],
            components: [],
            created: now(),
            updated: now(),
            resolved: null,
            sprint: null,
            epicKey: args.epicKey || null,
            parentKey: null,
            linkedIssues: [],
            comments: [],
            statusHistory: [],
            storyPoints: args.storyPoints || null,
            customerEmail: null,
            slaBreached: null,
          };
          const result = await ctx.writer.writeJiraIssue(issue, ctx.state, acting);
          ctx.log.ticketsCreated.push({
            key: result.key || issue.key,
            summary: args.summary,
            type: args.type,
            assignee: args.assignee || null,
          });
          return text(`Created ${result.key}: "${args.summary}"${args.assignee ? ` assigned to ${args.assignee}` : ""}`);
        } catch (err) {
          return errText("creating ticket", err);
        }
      },
    ),

    add_comment: tool(
      "add_comment",
      "Add a comment to an existing Jira issue.",
      {
        issueKey: z.string().describe("The issue key, e.g. 'DR-42'."),
        body: adfToolSchema.describe("Comment body in ADF."),
      },
      async (args) => {
        try {
          await ctx.writer.appendComment(
            args.issueKey,
            { id: "", author: acting, body: args.body as object, created: now(), reactions: [] },
            ctx.state,
            acting,
          );
          ctx.log.comments.push({ issueKey: args.issueKey });
          return text(`Comment added to ${args.issueKey}.`);
        } catch (err) {
          return errText(`commenting on ${args.issueKey}`, err);
        }
      },
    ),

    transition_ticket: tool(
      "transition_ticket",
      "Move a Jira issue to a new status.",
      {
        issueKey: z.string(),
        newStatus: z.enum(["To Do", "In Progress", "In Review", "Done", "Won't Do"]),
      },
      async (args) => {
        try {
          await ctx.writer.updateJiraIssueStatus(
            args.issueKey,
            args.newStatus,
            acting,
            now(),
            ctx.state,
            acting,
          );
          ctx.log.transitions.push({ issueKey: args.issueKey, newStatus: args.newStatus });
          return text(`${args.issueKey} → "${args.newStatus}".`);
        } catch (err) {
          return errText(`transitioning ${args.issueKey}`, err);
        }
      },
    ),

    assign_ticket: tool(
      "assign_ticket",
      "Assign a Jira issue to a team member.",
      {
        issueKey: z.string(),
        assignee: z.enum(FACTORY_ASSIGNEES).describe("Factory persona id of the new assignee."),
      },
      async (args) => {
        try {
          await ctx.writer.assignIssue(args.issueKey, ctx.binding[args.assignee], acting);
          return text(`${args.issueKey} assigned to ${args.assignee}.`);
        } catch (err) {
          return errText(`assigning ${args.issueKey}`, err);
        }
      },
    ),

    get_jira_ticket: tool(
      "get_jira_ticket",
      "Read an existing Jira issue: summary, status, description, and comments.",
      {
        issueKey: z.string(),
      },
      async (args) => {
        try {
          const issue = await ctx.writer.readJiraIssue(args.issueKey, ctx.state);
          if (!issue) return text(`Issue ${args.issueKey} not found.`);
          const comments = issue.comments
            .map((c) => `--- ${c.author} (${c.created}) ---\n${extractTextFromAdf(c.body)}`)
            .join("\n");
          return text(
            `${issue.key}: ${issue.summary}\n` +
              `Type: ${issue.type} | Status: ${issue.status} | Priority: ${issue.priority}\n` +
              `Assignee: ${issue.assignee || "unassigned"} | Reporter: ${issue.reporter}\n` +
              `Labels: ${issue.labels.join(", ") || "none"}\n\n` +
              `Description:\n${extractTextFromAdf(issue.description) || "(empty)"}\n\n` +
              (comments ? `Comments:\n${comments}` : "No comments."),
          );
        } catch (err) {
          return errText(`reading ${args.issueKey}`, err);
        }
      },
    ),

    search_jira: tool(
      "search_jira",
      "Search Jira issues with JQL. Useful queries: 'project = DR AND sprint in openSprints()', 'reporter = <accountId> AND updated >= -14d', 'type = Bug AND status != Done'.",
      {
        jql: z.string().describe("The JQL query."),
        maxResults: z.number().optional().describe("Default 25."),
      },
      async (args) => {
        try {
          const { issues } = await ctx.searchClient.searchIssues(args.jql, {
            maxResults: args.maxResults || 25,
          });
          if (issues.length === 0) return text("No issues match.");
          const lines = issues.map((i) => {
            const f = i.fields as Record<string, any>;
            return `${i.key}: ${f.summary} [${f.status?.name || "?"}] ${f.issuetype?.name || ""}${f.assignee ? ` → ${f.assignee.displayName}` : ""}`;
          });
          return text(lines.join("\n"));
        } catch (err) {
          return errText("searching Jira", err);
        }
      },
    ),

    create_confluence_page: tool(
      "create_confluence_page",
      "Create a Confluence page. Returns the page ID.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]),
        title: z.string(),
        body: adfToolSchema.describe("Page content in ADF: headings, lists, tables, code blocks as appropriate."),
        parentTitle: z.string().optional(),
        labels: z.array(z.string()).optional(),
      },
      async (args) => {
        try {
          const page: ConfluencePage = {
            id: "",
            spaceKey: args.spaceKey as SpaceKey,
            title: args.title,
            author: acting,
            body: args.body as object,
            parentTitle: args.parentTitle || null,
            labels: args.labels || [],
            created: now(),
            updated: now(),
            comments: [],
            reactions: [],
            linkedJiraKeys: [],
          };
          const result = await ctx.writer.writeConfluencePage(page, acting);
          ctx.log.pagesCreated.push({ spaceKey: args.spaceKey, title: args.title, id: result.id || "" });
          return text(`Page "${args.title}" created in ${args.spaceKey} (id: ${result.id}).`);
        } catch (err) {
          return errText(`creating page "${args.title}"`, err);
        }
      },
    ),

    edit_confluence_page: tool(
      "edit_confluence_page",
      "Replace the body of an existing Confluence page. Use get_confluence_page first to read the current content, then submit the full updated body.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]),
        title: z.string().describe("Exact title of the page to edit."),
        body: adfToolSchema.describe("The complete new page body in ADF."),
      },
      async (args) => {
        try {
          await ctx.writer.updateConfluencePageBody(
            args.spaceKey,
            args.title,
            args.body as object,
            now(),
            acting,
          );
          ctx.log.pagesEdited.push({ spaceKey: args.spaceKey, title: args.title });
          return text(`Page "${args.title}" updated.`);
        } catch (err) {
          return errText(`editing page "${args.title}"`, err);
        }
      },
    ),

    get_confluence_page: tool(
      "get_confluence_page",
      "Read an existing Confluence page by space and title.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]),
        title: z.string(),
      },
      async (args) => {
        try {
          const page = await ctx.writer.readConfluencePage(args.spaceKey, args.title);
          if (!page) return text(`Page "${args.title}" not found in ${args.spaceKey}.`);
          return text(
            `[${page.spaceKey}] ${page.title} (by ${page.author})\n\n${extractTextFromAdf(page.body)}`,
          );
        } catch (err) {
          return errText(`reading page "${args.title}"`, err);
        }
      },
    ),

    search_confluence: tool(
      "search_confluence",
      "Search Confluence content with CQL. Useful queries: 'type = page AND creator = <accountId>', 'type = page AND lastmodified >= \"2026-01-01\"', 'text ~ \"requirements\"'.",
      {
        cql: z.string().describe("The CQL query."),
        limit: z.number().optional().describe("Default 15."),
      },
      async (args) => {
        try {
          const { results } = await ctx.searchClient.searchConfluence(args.cql, args.limit || 15);
          if (results.length === 0) return text("No content matches.");
          const lines = results.map(
            (r) =>
              `[${r.content?.type || "?"}] ${r.content?.title || r.title} (id: ${r.content?.id || "?"})${r.lastModified ? ` — modified ${r.lastModified}` : ""}${r.excerpt ? `\n  ${r.excerpt.replace(/@@@\w+@@@/g, "")}` : ""}`,
          );
          return text(lines.join("\n"));
        } catch (err) {
          return errText("searching Confluence", err);
        }
      },
    ),

    start_sprint: tool(
      "start_sprint",
      "Start (activate) a sprint. Move issues into it first with move_to_sprint.",
      {
        sprintName: z.string(),
      },
      async (args) => {
        try {
          await ctx.writer.startSprint(args.sprintName, ctx.state, acting);
          ctx.log.sprintOps.push({ action: "start", sprintName: args.sprintName });
          return text(`Sprint "${args.sprintName}" started.`);
        } catch (err) {
          return errText(`starting sprint`, err);
        }
      },
    ),

    close_sprint: tool(
      "close_sprint",
      "Complete/close a sprint.",
      {
        sprintName: z.string(),
      },
      async (args) => {
        try {
          await ctx.writer.closeSprint(args.sprintName, ctx.state, acting);
          ctx.log.sprintOps.push({ action: "close", sprintName: args.sprintName });
          return text(`Sprint "${args.sprintName}" closed.`);
        } catch (err) {
          return errText(`closing sprint`, err);
        }
      },
    ),

    move_to_sprint: tool(
      "move_to_sprint",
      "Move issues from the backlog into a sprint.",
      {
        issueKeys: z.array(z.string()),
        sprintName: z.string(),
      },
      async (args) => {
        try {
          await ctx.writer.moveToSprint(args.issueKeys, args.sprintName, ctx.state, acting);
          ctx.log.sprintOps.push({ action: "move_to_sprint", sprintName: args.sprintName, issueKeys: args.issueKeys });
          return text(`Moved ${args.issueKeys.join(", ")} into "${args.sprintName}".`);
        } catch (err) {
          return errText(`moving issues to sprint`, err);
        }
      },
    ),
  };

  return include.map((name) => all[name]);
}
