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
import type { Activity, PersonaId } from "../types/simulation.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import type { JiraIssue, JiraComment, IssueStatus } from "../types/jira.js";
import type { ConfluencePage, SpaceKey } from "../types/confluence.js";

// ─── Result Types ────────────────────────────────────────────────────

export interface PersonaResult {
  createdIssues: JiraIssue[];
  addedComments: { issueKey: string; comment: JiraComment }[];
  transitions: { issueKey: string; newStatus: IssueStatus; by: string }[];
  createdPages: ConfluencePage[];
  daySummary: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── System Prompt Builder ───────────────────────────────────────────

function buildPersonaSystemPrompt(persona: PersonaProfile): string {
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

Write ALL content in character — your voice, your style, your quirks.

When you are done with all your tasks, call summarize_day with a 250-400 word recap of your day written in character. This summary will be used to provide context in future days.

IMPORTANT: Only reference ticket keys that exist in the context provided to you. Do not invent ticket keys.`;
}

// ─── MCP Tool Server Factory ────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10;

function createPersonaToolServer(personaId: PersonaId, result: PersonaResult) {
  const personaTools = [
    tool(
      "create_jira_ticket",
      "Create a new Jira issue. Use this for filing bugs, creating stories, tasks, epics, or sub-tasks.",
      {
        project: z.enum(["DR", "SUP"]).describe("Project key. DR for software development, SUP for customer support."),
        type: z.enum(["Epic", "Story", "Task", "Bug", "Sub-task"]),
        summary: z.string().describe("Short title for the ticket, written in your voice."),
        description: z.string().describe("Full description of the issue, written in your voice and style."),
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
          description: args.description,
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
        body: z.string().describe("Your comment, written in character."),
      },
      async (args) => {
        result.addedComments.push({
          issueKey: args.issueKey,
          comment: {
            id: "",
            author: personaId,
            body: args.body,
            created: "",
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
        body: z.string().describe("Page content in Markdown. Include headers, lists, tables, code blocks as appropriate."),
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
          body: args.body,
          parentTitle: args.parentTitle || null,
          labels: args.labels || [],
          created: "",
          updated: "",
          comments: [],
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
  category: "persona_generation" | "reaction" = "persona_generation"
): Promise<PersonaResult> {
  const result: PersonaResult = {
    createdIssues: [],
    addedComments: [],
    transitions: [],
    createdPages: [],
    daySummary: "",
    inputTokens: 0,
    outputTokens: 0,
  };

  const mcpServer = createPersonaToolServer(persona.id, result);
  const userMessage = `${context}\n\n## Your Task\n${activity.description}\n\nUse the tools to complete this task, then call summarize_day when done.`;

  const q = query({
    prompt: createPromptStream(userMessage),
    options: {
      model: config.personaModel,
      systemPrompt: buildPersonaSystemPrompt(persona),
      mcpServers: { "deadroute-persona-tools": mcpServer },
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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
