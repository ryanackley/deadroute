/**
 * Master planner agent — plans each day's activities using Claude Sonnet.
 * Uses the Agent SDK with an in-process MCP tool for structured output.
 *
 * Receives a rolling multi-day summary to maintain narrative continuity.
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DayPlan, Activity, NarrativeBeat, PersonaId } from "../types/simulation.js";
import type { SprintDefinition } from "../narrative/sprint-calendar.js";
import type { TokenTracker } from "../simulation/token-tracker.js";

const SYSTEM_PROMPT = `You are the master planner for a simulation of a fictional startup called DeadRoute.
DeadRoute is "Waze for the zombie apocalypse" — a crowdsourced navigation app for post-outbreak America.
The company operates out of a converted Jiffy Lube in Marietta, Georgia with 10 employees.

Your job is to plan a realistic day of work activities for the team. You output a JSON array of activities
that will drive content generation. Each activity will be executed by a persona agent who roleplays as
that team member.

## Team Members
- chad: CEO/Founder. Former used car dealer. Files unhinged feature requests at 2AM. Buzzwords.
- vanessa: Head of Marketing. "USERS ARE SAYING..." bug reports. Manages Scout network.
- tammy: HR/Office Manager. Perfectly formatted tickets. Operations. Apocalypse cornbread.
- sasha: Product Manager. Manages Jira board, sprints, roadmap. Diplomatic. Imposter syndrome.
- marcus: Dev Lead. Reviews every PR. Architecture decisions. Thoughtful, patient, occasionally overwhelmed.
- cooper: Frontend Dev. Self-taught, chaotic, talented. "stuff" commit messages. Age 22.
- priya: Backend Dev. Former IT support, learning fast. "Things I Learned This Week" posts.
- raj: Full-Stack Dev. Former CS student. Pushes for "proper" practices. Tension with Cooper.
- dana: Mobile Dev/Designer. Quiet. Communicates through annotated screenshots.
- tk: Support Engineer. Former Jiffy Lube mechanic. Translates rage into perfect bug reports.

## Realism Rules
- Not every sprint ticket gets completed. Realistic velocity is 60-80% of planned scope.
- Some tickets carry over sprint to sprint. Some go stale and never get done.
- Bugs get reopened after being marked fixed. Stories get split mid-sprint.
- Blocked tickets stay blocked for realistic durations (days, sometimes weeks).
- Not every day is productive — some days are mostly meetings, firefighting, or slow.
- People have different active hours (Cooper: late starts, Chad: 2AM ideas, TK: early bird).
- Some days are heavy on certain activity types (sprint planning day = lots of ceremony).
- Support tickets arrive irregularly — some days TK is slammed, some days are quiet.
- Activities should build on what happened in previous days. Use the running summary to maintain continuity.

## Activity Types
- create_ticket: Create a new Jira issue (epic, story, task, bug, sub-task)
- comment_ticket: Add a comment to an existing ticket
- transition_ticket: Change a ticket's status (To Do → In Progress, etc.)
- create_page: Create a new Confluence page
- update_page: Update an existing Confluence page
- comment_page: Add a comment to a Confluence page
- sprint_ceremony: Sprint planning, retro, review, standup notes
- code_review: Review code / comment on implementation
- escalate_ticket: TK escalates a support ticket to the dev team
- internal_discussion: Slack-style discussion captured in a ticket comment

## Output
Use the output_day_plan tool to submit your planned activities. Include 10-30 activities per day
depending on how busy the day is. Sprint ceremony days should have more ceremony-related activities.
Activities should be in chronological order by time.
Each activity description should be specific enough for a persona agent to generate realistic content.
Include relatedKeys when the activity references existing tickets.`;

export interface PlannerResult {
  dayPlan: DayPlan;
  inputTokens: number;
  outputTokens: number;
}

// ─── MCP Tool Server Factory ────────────────────────────────────────

const PERSONA_IDS = ["chad","vanessa","tammy","sasha","marcus","cooper","priya","raj","dana","tk"] as const;
const ACTIVITY_TYPES = ["create_ticket","comment_ticket","transition_ticket","create_page","update_page","comment_page","sprint_ceremony","code_review","escalate_ticket","internal_discussion"] as const;

function createPlannerToolServer(capturedActivities: Activity[]) {
  const plannerTools = [
    tool(
      "output_day_plan",
      "Submit the planned activities for the day. Call this once with all activities.",
      {
        activities: z.array(z.object({
          time: z.string().describe("HH:MM format"),
          persona: z.enum(PERSONA_IDS).describe("Team member ID"),
          type: z.enum(ACTIVITY_TYPES).describe("Activity type"),
          description: z.string().describe("Specific description for the persona agent to execute"),
          relatedKeys: z.array(z.string()).optional().describe("Existing ticket keys referenced"),
          narrativeBeat: z.string().optional().describe("Narrative beat this activity relates to"),
        })),
      },
      async (args) => {
        capturedActivities.push(...args.activities.map((a) => ({
          time: a.time,
          persona: a.persona as PersonaId,
          type: a.type,
          description: a.description,
          relatedKeys: a.relatedKeys || [],
          narrativeBeat: a.narrativeBeat || undefined,
        })));
        return {
          content: [{ type: "text" as const, text: "Plan recorded." }],
        };
      }
    ),
  ];

  return createSdkMcpServer({
    name: "deadroute-planner-tools",
    version: "1.0.0",
    tools: plannerTools,
  });
}



// ─── Agent Execution ────────────────────────────────────────────────

export async function planDay(
  date: string,
  dayOfWeek: string,
  sprint: SprintDefinition | null,
  sprintDay: number | null,
  narrativeBeats: NarrativeBeat[],
  stateSummary: string,
  rollingSummary: string,
  config: Config,
  tokenTracker: TokenTracker
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(
    date,
    dayOfWeek,
    sprint,
    sprintDay,
    narrativeBeats,
    stateSummary,
    rollingSummary
  );

  const capturedActivities: Activity[] = [];
  const mcpServer = createPlannerToolServer(capturedActivities);

  let inputTokens = 0;
  let outputTokens = 0;

  const q = query({
    prompt: prompt,
    options: {
      model: config.plannerModel,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "deadroute-planner-tools": mcpServer },
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 3,
      persistSession: false,
    },
  });

  for await (const message of q) {
    if (message.type === "result") {
      for (const modelData of Object.values(message.modelUsage)) {
        inputTokens += modelData.inputTokens;
        outputTokens += modelData.outputTokens;
      }
    }
  }

  tokenTracker.record({
    inputTokens,
    outputTokens,
    category: "master_planner",
    model: config.plannerModel,
  });

  // Fallback if the tool was never called
  const activities: Activity[] = capturedActivities.length > 0
    ? capturedActivities
    : [
        {
          time: "09:00",
          persona: "sasha",
          type: "create_ticket",
          description: "Triage and organize the backlog for the day",
        },
        {
          time: "09:30",
          persona: "tk",
          type: "escalate_ticket",
          description: "Review overnight support queue and escalate any critical issues",
        },
      ];

  const dayPlan: DayPlan = {
    date,
    dayOfWeek,
    sprint: sprint?.name || null,
    sprintDay,
    narrativeBeats: narrativeBeats.map((b) => b.title),
    activities,
  };

  return { dayPlan, inputTokens, outputTokens };
}

function buildPlannerPrompt(
  date: string,
  dayOfWeek: string,
  sprint: SprintDefinition | null,
  sprintDay: number | null,
  narrativeBeats: NarrativeBeat[],
  stateSummary: string,
  rollingSummary: string
): string {
  const lines: string[] = [];

  lines.push(`Plan the activities for ${dayOfWeek}, ${date}.`);
  lines.push("");

  if (sprint) {
    lines.push(`## Sprint: ${sprint.name}`);
    lines.push(`Goal: ${sprint.goal}`);
    lines.push(`Sprint day: ${sprintDay} of 14`);
    if (sprintDay === 1) {
      lines.push("**This is sprint planning day.** Include sprint planning ceremony activities.");
    }
    if (sprintDay === 12) {
      lines.push("**Sprint review day.** Include sprint review/demo activities.");
      lines.push("**Sprint retro day.** Include retrospective activities.");
    }
    lines.push("");
  }

  if (narrativeBeats.length > 0) {
    lines.push("## Narrative Beats Active This Week");
    for (const beat of narrativeBeats) {
      lines.push(`- **${beat.title}**: ${beat.description}`);
      lines.push(`  Key personas: ${beat.involvedPersonas.join(", ")}`);
    }
    lines.push("");
  }

  if (rollingSummary) {
    lines.push("## Recent Days Summary");
    lines.push("Use this to maintain continuity — build on what happened previously.");
    lines.push(rollingSummary);
    lines.push("");
  }

  lines.push(stateSummary);

  return lines.join("\n");
}

