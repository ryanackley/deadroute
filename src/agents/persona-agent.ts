/**
 * Persona agent — roleplays as a specific team member to generate content.
 * Uses Claude Haiku via the Agent SDK for fast, cheap content generation.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { PersonaProfile } from "../personas/profiles.js";
import type { Activity, PersonaId } from "../types/simulation.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import type { JiraIssue, JiraComment, IssueStatus, IssuePriority } from "../types/jira.js";
import type { ConfluencePage } from "../types/confluence.js";

export interface PersonaResult {
  /** Newly created Jira issues */
  createdIssues: JiraIssue[];
  /** Comments added to existing issues */
  addedComments: { issueKey: string; comment: JiraComment }[];
  /** Status transitions performed */
  transitions: { issueKey: string; newStatus: IssueStatus; by: string }[];
  /** Newly created Confluence pages */
  createdPages: ConfluencePage[];
  /** Token usage */
  inputTokens: number;
  outputTokens: number;
}

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
You are roleplaying as this person. Generate content that authentically reflects their voice, style, and personality.
When creating Jira tickets, write the summary, description, and any comments in character.
When creating Confluence pages, write the body content in character.

Respond with ONLY a JSON object (no markdown, no code fences) in this format:
{
  "createdIssues": [
    {
      "type": "Bug",
      "priority": "High",
      "summary": "Routing algorithm sends users through Sector 12 horde zone",
      "description": "Got three reports this morning...",
      "labels": ["routing", "critical-safety"],
      "components": ["routing-engine"],
      "assignee": "marcus",
      "epicKey": "DR-15",
      "storyPoints": 5
    }
  ],
  "comments": [
    {
      "issueKey": "DR-42",
      "body": "Just looked into this — the issue is in the pathfinding cache..."
    }
  ],
  "transitions": [
    {
      "issueKey": "DR-38",
      "newStatus": "In Progress"
    }
  ],
  "createdPages": [
    {
      "spaceKey": "ENG",
      "title": "Things I Learned This Week - Week 5",
      "body": "## What I Learned\\n\\n### PostgreSQL Index Types...",
      "parentTitle": "Things I Learned This Week",
      "labels": ["learning", "database"]
    }
  ]
}

Only include the arrays that are relevant to the activity. Empty arrays can be omitted.
For issue types use: Epic, Story, Task, Bug, Sub-task
For priorities use: Highest, High, Medium, Low, Lowest
For statuses use: To Do, In Progress, In Review, Done, Won't Do
For assignees use persona IDs: chad, vanessa, tammy, sasha, marcus, cooper, priya, raj, dana, tk
For Confluence spaceKeys use: PROD, ENG, OPS, MKT`;
}

export async function executePersonaActivity(
  persona: PersonaProfile,
  activity: Activity,
  context: string,
  config: Config,
  tokenTracker: TokenTracker,
  category: "persona_generation" | "reaction" = "persona_generation"
): Promise<PersonaResult> {
  const systemPrompt = buildPersonaSystemPrompt(persona);
  const prompt = `${context}\n\n## Your Task\n${activity.description}\n\nGenerate the appropriate artifacts for this activity. Stay in character.`;

  let responseText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt,
      model: config.personaModel,
      permissionMode: "bypassPermissions",
      allowedTools: [], // Pure text generation
      maxTurns: 1,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      responseText = message.result;
    }
    if ("usage" in message && message.usage) {
      const usage = message.usage as { input_tokens?: number; output_tokens?: number };
      inputTokens += usage.input_tokens || 0;
      outputTokens += usage.output_tokens || 0;
    }
  }

  tokenTracker.record({
    inputTokens,
    outputTokens,
    category,
    model: config.personaModel,
    persona: persona.id,
  });

  return parsePersonaResponse(responseText, persona.id, activity, inputTokens, outputTokens);
}

function parsePersonaResponse(
  responseText: string,
  personaId: PersonaId,
  activity: Activity,
  inputTokens: number,
  outputTokens: number
): PersonaResult {
  const result: PersonaResult = {
    createdIssues: [],
    addedComments: [],
    transitions: [],
    createdPages: [],
    inputTokens,
    outputTokens,
  };

  try {
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    // Parse created issues
    if (parsed.createdIssues) {
      for (const raw of parsed.createdIssues) {
        result.createdIssues.push({
          key: "", // Will be assigned by state manager
          project: raw.project || "DR",
          type: raw.type || "Task",
          priority: raw.priority || "Medium",
          status: "To Do",
          summary: raw.summary || "Untitled",
          description: raw.description || "",
          reporter: personaId,
          assignee: raw.assignee || null,
          labels: raw.labels || [],
          components: raw.components || [],
          created: "", // Will be set by simulation engine
          updated: "", // Will be set by simulation engine
          resolved: null,
          sprint: raw.sprint || null,
          epicKey: raw.epicKey || null,
          parentKey: raw.parentKey || null,
          linkedIssues: raw.linkedIssues || [],
          comments: [],
          statusHistory: [],
          storyPoints: raw.storyPoints || null,
          customerEmail: raw.customerEmail || null,
          slaBreached: raw.slaBreached || null,
        });
      }
    }

    // Parse comments
    if (parsed.comments) {
      for (const raw of parsed.comments) {
        result.addedComments.push({
          issueKey: raw.issueKey,
          comment: {
            id: "", // Will be assigned
            author: personaId,
            body: raw.body || "",
            created: "", // Will be set by simulation engine
          },
        });
      }
    }

    // Parse transitions
    if (parsed.transitions) {
      for (const raw of parsed.transitions) {
        result.transitions.push({
          issueKey: raw.issueKey,
          newStatus: raw.newStatus as IssueStatus,
          by: personaId,
        });
      }
    }

    // Parse created pages
    if (parsed.createdPages) {
      for (const raw of parsed.createdPages) {
        result.createdPages.push({
          id: "", // Will be assigned
          spaceKey: raw.spaceKey || "ENG",
          title: raw.title || "Untitled",
          author: personaId,
          body: raw.body || "",
          parentTitle: raw.parentTitle || null,
          labels: raw.labels || [],
          created: "", // Will be set
          updated: "", // Will be set
          comments: [],
          linkedJiraKeys: raw.linkedJiraKeys || [],
        });
      }
    }
  } catch (err) {
    console.error(`Failed to parse persona response for ${personaId}:`, err);
    console.error("Response was:", responseText.substring(0, 500));
  }

  return result;
}
