/**
 * Persona agent — roleplays as a specific team member using the Claude Agent SDK
 * with in-process MCP tools for deterministic structured output.
 *
 * The agent calls tools (create_jira_ticket, add_comment, etc.) which produce
 * deterministic structured output. The Agent SDK manages the tool loop
 * automatically. The agent finishes by calling summarize_day.
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { PersonaProfile } from "../personas/profiles.js";
import type { Activity, PersonaId, SimulationState, SprintOperation } from "../types/simulation.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import type { JiraIssue, JiraComment, IssueStatus } from "../types/jira.js";
import type { ConfluencePage, ConfluenceComment, SpaceKey } from "../types/confluence.js";
import type { IWriter } from "../output/writer-interface.js";
import { adfToolSchema, extractTextFromAdf } from "../utils/adf.js";

// ─── Result Types ────────────────────────────────────────────────────

export interface EmojiReaction {
  targetType: "jira_comment" | "confluence_page";
  targetKey: string;
  emoji: string;
  commentId?: string;
  spaceKey?: string;
}

export interface PersonaResult {
  createdIssues: JiraIssue[];
  addedComments: { issueKey: string; comment: JiraComment }[];
  confluenceComments: { spaceKey: string; pageTitle: string; comment: ConfluenceComment }[];
  transitions: { issueKey: string; newStatus: IssueStatus; by: string }[];
  createdPages: ConfluencePage[];
  editedIssues: { issueKey: string; newDescription: object; newSummary?: string }[];
  editedPages: { spaceKey: string; pageTitle: string; newBody: object }[];
  emojiReactions: EmojiReaction[];
  sprintOperations: SprintOperation[];
  daySummary: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface MentionEntry {
  accountId: string;
  displayName: string;
}

/** Maps persona ID → Atlassian account info for ADF @mentions. */
export type MentionMap = Record<string, MentionEntry>;

// ─── System Prompt Builder ───────────────────────────────────────────

function buildPersonaSystemPrompt(persona: PersonaProfile, mentionMap?: MentionMap): string {
  let mentionSection = "";
  if (mentionMap && Object.keys(mentionMap).length > 0) {
    const rows = Object.entries(mentionMap)
      .map(([id, { accountId, displayName }]) => `| ${id} | ${displayName} | ${accountId} |`)
      .join("\n");
    mentionSection = `

## @Mentions
When you need to mention a teammate in ADF content (descriptions, comments, pages), use a mention node instead of plain text.

ADF mention node format:
\`\`\`json
{ "type": "mention", "attrs": { "id": "<accountId>", "text": "@Display Name", "accessLevel": "" } }
\`\`\`

Place mention nodes inline alongside text nodes within a paragraph's content array.

Team account IDs:
| Persona | Display Name | Account ID |
|---------|-------------|------------|
${rows}

Example — a paragraph mentioning Marcus:
\`\`\`json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "Hey " },
    { "type": "mention", "attrs": { "id": "${mentionMap["marcus"]?.accountId || "<accountId>"}", "text": "@${mentionMap["marcus"]?.displayName || "Marcus Chen"}", "accessLevel": "" } },
    { "type": "text", "text": " can you review this?" }
  ]
}
\`\`\``;
  }

  return `You are ${persona.displayName}, ${persona.role} at DeadRoute — a scrappy startup that makes "Waze for the zombie apocalypse."

## Your Background
${persona.background}

## Your Writing Style
${persona.writingStyle}

## Your Work Patterns
### Jira
${persona.jiraPatterns}

### Confluence
${persona.confluencePatterns}

### How You React to Others
${persona.reactionPatterns}

## Your Quirks
${persona.quirks.map((q) => `- ${q}`).join("\n")}

## Instructions
You are roleplaying as this person. Use the provided tools to take actions:
- Use create_jira_ticket to file new issues
- Use add_comment to comment on existing tickets
- Use transition_ticket to move tickets between statuses
- Use create_confluence_page to create documentation
- Use add_confluence_comment to comment on existing Confluence pages
- Use edit_jira_description to update a ticket's description (and optionally summary) — use this instead of commenting when you need to amend ticket content
- Use edit_confluence_page to update a page's body content — use this instead of commenting when you need to amend page content
- Use get_jira_ticket to look up details of an existing ticket
- Use get_confluence_page to look up an existing Confluence page
- Use react_to_artifact to add an emoji reaction to a comment or page, or indicate you'll leave a full comment
- Use start_sprint to activate/start a sprint. Don't forget to pull some issues into the sprint before starting. Use move_to_sprint
- Use close_sprint to complete/close a sprint
- Use move_to_sprint to pull issues from the backlog into a sprint. Don't forget to do this before starting a sprint.
- Use move_to_backlog to drop issues from a sprint back to the backlog

Write ALL content in character — your voice, your style, your quirks.

In the real world comments are rarely over 100 words (add_comment, add_confluence_comment). If you find yourself creating a very verbose comment. Do one of the following.
* If it's on a confluence page, consider editing the page or creating new one and linking to it from your comment.
* If it's a Jira comment, write a Confluence page in the appropriate space, then link to it from inside the Jira comment.

When you are done with all your tasks, call summarize_day with a 250-400 word recap of your day written in character. This summary will be used to provide context in future days.

IMPORTANT: Only reference ticket keys that exist in the context provided to you. Do not invent ticket keys.${mentionSection}`;
}

// ─── MCP Tool Server Factory ────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10;

function createPersonaToolServer(
  personaId: PersonaId,
  result: PersonaResult,
  writer?: IWriter,
  state?: SimulationState
) {
  const personaTools = [
    tool(
      "create_jira_ticket",
      "Create a new Jira issue. Use this for filing bugs, creating stories, tasks, epics, or sub-tasks.",
      {
        project: z.enum(["DR", "SUP"]).describe("Project key. DR for software development, SUP for customer support."),
        type: z.enum(["Epic", "Story", "Task", "Bug", "Sub-task"]),
        summary: z.string().describe("Short title for the ticket, written in your voice."),
        description: adfToolSchema.describe("Full description of the issue in ADF format, written in your voice and style."),
        priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
        assignee: z.enum(["chad", "vanessa", "tammy", "sasha", "marcus", "cooper", "priya", "raj", "dana", "tk"]).optional().describe("Who should work on this. Use persona ID."),
        labels: z.array(z.string()).optional().describe("Labels like 'routing', 'mobile', 'ux', 'critical-safety', etc."),
        components: z.array(z.string()).optional().describe("Components like 'routing-engine', 'mobile-app', 'web-app', 'api', 'database'."),
        epicKey: z.string().optional().describe("Parent epic key (e.g., 'DR-5') if this belongs to an epic."),
        parentKey: z.string().optional().describe("Parent issue key for sub-tasks only."),
        storyPoints: z.number().optional().describe("Story point estimate (1, 2, 3, 5, 8, 13)."),
        customerEmail: z.string().optional().describe("For SUP tickets only — the customer's email or settlement name."),
      },
      async (args) => {
        const issue: JiraIssue = {
          key: "",
          project: args.project,
          type: args.type,
          priority: args.priority,
          status: "To Do",
          summary: args.summary,
          description: args.description as object,
          reporter: personaId,
          assignee: args.assignee || null,
          labels: args.labels || [],
          components: args.components || [],
          created: "",
          updated: "",
          resolved: null,
          sprint: null,
          epicKey: args.epicKey || null,
          parentKey: args.parentKey || null,
          linkedIssues: [],
          comments: [],
          statusHistory: [],
          storyPoints: args.storyPoints || null,
          customerEmail: args.customerEmail || null,
          slaBreached: null,
        };
        result.createdIssues.push(issue);
        return {
          content: [{
            type: "text" as const,
            text: `Ticket created. Key will be assigned (position ${result.createdIssues.length} in today's batch).`,
          }],
        };
      }
    ),

    tool(
      "add_comment",
      "Add a comment to an existing Jira issue. Write in your voice and style.",
      {
        issueKey: z.string().describe("The ticket key (e.g., 'DR-42' or 'SUP-15')."),
        body: adfToolSchema.describe("Your comment in ADF format, written in character."),
      },
      async (args) => {
        result.addedComments.push({
          issueKey: args.issueKey,
          comment: {
            id: "",
            author: personaId,
            body: args.body as object,
            created: "",
            reactions: [],
          },
        });
        return {
          content: [{
            type: "text" as const,
            text: `Comment added to ${args.issueKey}.`,
          }],
        };
      }
    ),

    tool(
      "transition_ticket",
      "Change the status of a Jira issue (e.g., move to In Progress, Done, etc.).",
      {
        issueKey: z.string().describe("The ticket key to transition."),
        newStatus: z.enum(["To Do", "In Progress", "In Review", "Done", "Won't Do"]).describe("The new status."),
      },
      async (args) => {
        result.transitions.push({
          issueKey: args.issueKey,
          newStatus: args.newStatus as IssueStatus,
          by: personaId,
        });
        return {
          content: [{
            type: "text" as const,
            text: `${args.issueKey} moved to "${args.newStatus}".`,
          }],
        };
      }
    ),

    tool(
      "create_confluence_page",
      "Create a new Confluence page. Write content in your voice and style.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]).describe("PROD=Product, ENG=Engineering, OPS=Operations, MKT=Marketing."),
        title: z.string().describe("Page title."),
        body: adfToolSchema.describe("Page content in ADF format. Include headings, paragraphs, lists, tables, code blocks, panels, and task lists as appropriate."),
        parentTitle: z.string().optional().describe("Title of the parent page if this is a child page."),
        labels: z.array(z.string()).optional().describe("Page labels/tags."),
        linkedJiraKeys: z.array(z.string()).optional().describe("Jira issue keys referenced in this page."),
      },
      async (args) => {
        const page: ConfluencePage = {
          id: "",
          spaceKey: args.spaceKey as SpaceKey,
          title: args.title,
          author: personaId,
          body: args.body as object,
          parentTitle: args.parentTitle || null,
          labels: args.labels || [],
          created: "",
          updated: "",
          comments: [],
          reactions: [],
          linkedJiraKeys: args.linkedJiraKeys || [],
        };
        result.createdPages.push(page);
        return {
          content: [{
            type: "text" as const,
            text: `Page "${args.title}" created in ${args.spaceKey} space.`,
          }],
        };
      }
    ),

    tool(
      "add_confluence_comment",
      "Add a comment to an existing Confluence page. Write in your voice and style.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]).describe("The Confluence space key."),
        pageTitle: z.string().describe("The exact title of the page to comment on."),
        body: adfToolSchema.describe("Your comment in ADF format, written in character."),
      },
      async (args) => {
        const comment: ConfluenceComment = {
          id: "",
          author: personaId,
          body: args.body as object,
          created: "",
        };
        result.confluenceComments.push({
          spaceKey: args.spaceKey,
          pageTitle: args.pageTitle,
          comment,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Comment added to page "${args.pageTitle}" in ${args.spaceKey} space.`,
          }],
        };
      }
    ),

    tool(
      "start_sprint",
      "Activate/start the current sprint. Only use when explicitly told to start a sprint.",
      {
        sprintName: z.string().describe("The sprint name to start (e.g., 'Sprint 5')."),
      },
      async (args) => {
        result.sprintOperations.push({ action: "start", sprintName: args.sprintName });
        return {
          content: [{ type: "text" as const, text: `Sprint "${args.sprintName}" started.` }],
        };
      }
    ),

    tool(
      "close_sprint",
      "Complete/close the current sprint. Only use when explicitly told to close a sprint.",
      {
        sprintName: z.string().describe("The sprint name to close (e.g., 'Sprint 5')."),
      },
      async (args) => {
        result.sprintOperations.push({ action: "close", sprintName: args.sprintName });
        return {
          content: [{ type: "text" as const, text: `Sprint "${args.sprintName}" completed.` }],
        };
      }
    ),

    tool(
      "move_to_sprint",
      "Move one or more existing issues into a sprint. Use during sprint planning to pull items from the backlog.",
      {
        sprintName: z.string().describe("The sprint name to move issues into (e.g., 'Sprint 5')."),
        issueKeys: z.array(z.string()).describe("Issue keys to move (e.g., ['DR-10', 'DR-15'])."),
      },
      async (args) => {
        result.sprintOperations.push({ action: "move_to_sprint", sprintName: args.sprintName, issueKeys: args.issueKeys });
        return {
          content: [{ type: "text" as const, text: `Moved ${args.issueKeys.join(", ")} to ${args.sprintName}.` }],
        };
      }
    ),

    tool(
      "move_to_backlog",
      "Move one or more issues from a sprint back to the backlog. Use to descope items from the current sprint.",
      {
        issueKeys: z.array(z.string()).describe("Issue keys to move to backlog (e.g., ['DR-10', 'DR-15'])."),
      },
      async (args) => {
        result.sprintOperations.push({ action: "move_to_backlog", sprintName: "Backlog", issueKeys: args.issueKeys });
        return {
          content: [{ type: "text" as const, text: `Moved ${args.issueKeys.join(", ")} to backlog.` }],
        };
      }
    ),

    tool(
      "summarize_day",
      "Provide a 250-400 word in-character summary of your day. Call this ONCE after completing all your tasks.",
      {
        summary: z.string().describe("250-400 word summary of your day's work, written in your voice. What did you work on? What progress was made? Any blockers or notable events?"),
      },
      async (args) => {
        result.daySummary = args.summary;
        return {
          content: [{
            type: "text" as const,
            text: "Day summary recorded.",
          }],
        };
      }
    ),

    tool(
      "get_jira_ticket",
      "Look up an existing Jira ticket by its key. Returns details including summary, description, status, assignee, and recent comments.",
      {
        issueKey: z.string().describe("The ticket key (e.g., 'DR-42' or 'SUP-15')."),
      },
      async (args) => {
        if (!writer || !state) {
          return { content: [{ type: "text" as const, text: "Artifact retrieval not available." }] };
        }
        const issue = await writer.readJiraIssue(args.issueKey, state);
        if (!issue) {
          return { content: [{ type: "text" as const, text: `Ticket ${args.issueKey} not found.` }] };
        }
        const recentComments = issue.comments.slice(-5).map(
          (c: { author: string; created: string; body: object }) => `  ${c.author} (${c.created}): ${extractTextFromAdf(c.body)}`
        ).join("\n");
        const descText = extractTextFromAdf(issue.description);
        const text = [
          `[${issue.key}] ${issue.summary}`,
          `Type: ${issue.type} | Status: ${issue.status} | Priority: ${issue.priority}`,
          `Reporter: ${issue.reporter} | Assignee: ${issue.assignee || "Unassigned"}`,
          `Sprint: ${issue.sprint || "Backlog"}`,
          `Labels: ${issue.labels.join(", ") || "none"}`,
          "",
          descText.length > 2000 ? descText.substring(0, 2000) + "..." : descText,
          "",
          issue.comments.length > 0 ? `Recent comments (${issue.comments.length} total):\n${recentComments}` : "No comments yet.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }
    ),

    tool(
      "get_confluence_page",
      "Look up an existing Confluence page by its title and space. Returns the page content and comments.",
      {
        title: z.string().describe("The page title to look up."),
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]).describe("The Confluence space key."),
      },
      async (args) => {
        if (!writer) {
          return { content: [{ type: "text" as const, text: "Artifact retrieval not available." }] };
        }
        const page = await writer.readConfluencePage(args.spaceKey, args.title);
        if (!page) {
          return { content: [{ type: "text" as const, text: `Page "${args.title}" not found in ${args.spaceKey} space.` }] };
        }
        const bodyText = extractTextFromAdf(page.body);
        const body = bodyText.length > 2000 ? bodyText.substring(0, 2000) + "..." : bodyText;
        const recentComments = page.comments.slice(-3).map(
          (c: { author: string; body: object }) => `  ${c.author}: ${extractTextFromAdf(c.body)}`
        ).join("\n");
        const text = [
          `[${page.spaceKey}] ${page.title}`,
          `Author: ${page.author} | Created: ${page.created}`,
          `Labels: ${page.labels.join(", ") || "none"}`,
          "",
          body,
          "",
          page.comments.length > 0 ? `Comments:\n${recentComments}` : "No comments.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }
    ),

    tool(
      "edit_jira_description",
      "Edit/update the description (and optionally summary) of an existing Jira issue. Use this instead of adding a comment when you need to amend or rewrite the ticket's description. Read the ticket first with get_jira_ticket.",
      {
        issueKey: z.string().describe("The ticket key (e.g., 'DR-42' or 'SUP-15')."),
        description: adfToolSchema.describe("The new/updated description in ADF format, written in your voice and style."),
        summary: z.string().optional().describe("Optionally update the ticket summary/title too."),
      },
      async (args) => {
        result.editedIssues.push({
          issueKey: args.issueKey,
          newDescription: args.description as object,
          newSummary: args.summary,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Description updated on ${args.issueKey}.`,
          }],
        };
      }
    ),

    tool(
      "edit_confluence_page",
      "Edit/update the body content of an existing Confluence page. Use this instead of adding a comment when you need to amend or rewrite the page content. Read the page first with get_confluence_page.",
      {
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]).describe("The Confluence space key."),
        pageTitle: z.string().describe("The exact title of the page to edit."),
        body: adfToolSchema.describe("The new/updated page body in ADF format. This replaces the entire page body."),
      },
      async (args) => {
        result.editedPages.push({
          spaceKey: args.spaceKey,
          pageTitle: args.pageTitle,
          newBody: args.body as object,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Page "${args.pageTitle}" in ${args.spaceKey} updated.`,
          }],
        };
      }
    ),

    tool(
      "react_to_artifact",
      "React to a Jira comment or Confluence page with an emoji, or indicate you want to leave a full comment instead. Use this after reading an artifact with get_jira_ticket or get_confluence_page.",
      {
        action: z.enum(["comment", "emoji"]).describe("'emoji' to add an emoji reaction, 'comment' if you want to write a full comment instead (then use add_comment)."),
        emoji: z.string().optional().describe("The emoji to react with (e.g., '👍', '🔥', '👀', '❤️', '🚀', '😬'). Required when action is 'emoji'."),
        targetType: z.enum(["jira_comment", "confluence_page"]).describe("What you're reacting to."),
        targetKey: z.string().describe("Issue key (for jira_comment) or page title (for confluence_page)."),
        commentId: z.string().optional().describe("For jira_comment: the ID of the comment to react to."),
        spaceKey: z.enum(["PROD", "ENG", "OPS", "MKT"]).optional().describe("For confluence_page: the space key."),
      },
      async (args) => {
        if (args.action === "emoji") {
          const emoji = args.emoji || "👍";
          result.emojiReactions.push({
            targetType: args.targetType,
            targetKey: args.targetKey,
            emoji,
            commentId: args.commentId,
            spaceKey: args.spaceKey,
          });
          return {
            content: [{ type: "text" as const, text: `Reacted with ${emoji} to ${args.targetKey}.` }],
          };
        }
        // action === "comment"
        return {
          content: [{ type: "text" as const, text: "OK, use add_comment to write your comment." }],
        };
      }
    ),
  ];

  return createSdkMcpServer({
    name: "deadroute-persona-tools",
    version: "1.0.0",
    tools: personaTools,
  });
}

// ─── Streaming Prompt ───────────────────────────────────────────────

async function* createPromptStream(message: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: message },
    parent_tool_use_id: null,
    session_id: "deadroute-persona",
  };
}

// ─── Agent Execution ────────────────────────────────────────────────

export async function executePersonaActivity(
  persona: PersonaProfile,
  activity: Activity,
  context: string,
  config: Config,
  tokenTracker: TokenTracker,
  category: "persona_generation" | "reaction" = "persona_generation",
  writer?: IWriter,
  state?: SimulationState,
  mentionMap?: MentionMap
): Promise<PersonaResult> {
  const result: PersonaResult = {
    createdIssues: [],
    addedComments: [],
    confluenceComments: [],
    transitions: [],
    createdPages: [],
    editedIssues: [],
    editedPages: [],
    emojiReactions: [],
    sprintOperations: [],
    daySummary: "",
    inputTokens: 0,
    outputTokens: 0,
  };

  const mcpServer = createPersonaToolServer(persona.id, result, writer, state);
  const userMessage = `${context}\n\n## Your Task\n${activity.description}\n\nUse the tools to complete this task, then call summarize_day when done.`;

  const q = query({
    prompt: createPromptStream(userMessage),
    options: {
      model: config.plannerModel,
      systemPrompt: buildPersonaSystemPrompt(persona, mentionMap),
      mcpServers: { "deadroute-persona-tools": mcpServer },
      allowedTools: [
        "mcp__deadroute-persona-tools__create_jira_ticket",
        "mcp__deadroute-persona-tools__add_comment",
        "mcp__deadroute-persona-tools__transition_ticket",
        "mcp__deadroute-persona-tools__create_confluence_page",
        "mcp__deadroute-persona-tools__add_confluence_comment",
        "mcp__deadroute-persona-tools__summarize_day",
        "mcp__deadroute-persona-tools__edit_jira_description",
        "mcp__deadroute-persona-tools__edit_confluence_page",
        "mcp__deadroute-persona-tools__get_jira_ticket",
        "mcp__deadroute-persona-tools__get_confluence_page",
        "mcp__deadroute-persona-tools__react_to_artifact",
        "mcp__deadroute-persona-tools__start_sprint",
        "mcp__deadroute-persona-tools__close_sprint",
        "mcp__deadroute-persona-tools__move_to_sprint",
        "mcp__deadroute-persona-tools__move_to_backlog",
      ],
      maxTurns: MAX_TOOL_ROUNDS,
      persistSession: false,
    },
  });

  for await (const message of q) {
    if (message.type === "result") {
      for (const modelData of Object.values(message.modelUsage)) {
        result.inputTokens += modelData.inputTokens;
        result.outputTokens += modelData.outputTokens;
      }
    }
  }

  tokenTracker.record({
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    category,
    model: config.personaModel,
    persona: persona.id,
  });

  return result;
}
