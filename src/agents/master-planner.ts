/**
 * Master planner agent — plans each day's activities using Claude Sonnet.
 * Uses the Agent SDK with an in-process MCP tool for structured output.
 *
 * Receives a rolling multi-day summary to maintain narrative continuity.
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { DayPlan, Activity, NarrativeBeat, PersonaId } from "../types/simulation.js";
import type { SprintDefinition } from "../narrative/sprint-calendar.js";
import type { TokenTracker } from "../simulation/token-tracker.js";

const SYSTEM_PROMPT = `You are the master planner for a simulation of a fictional startup called DeadRoute.
DeadRoute is "Waze for the zombie apocalypse" — a crowdsourced navigation app for post-outbreak America.
The company operates out of a converted Jiffy Lube in Marietta, Georgia with 10 employees.

State of the world is isolated settlements that are coping with scarcity, military checkpoints without clear
chains of command. Zombie hoards roaming the areas between settlements. A barely functional US government. 
Surprisingly, there is still cell service for much of the local area. The office uses a StarLink to connect 
to the internet. There is still a functioning Internet. It's okay to bend plausiblity since this is meant to be
slightly humorous and not take itself too seriously. 

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
- start_sprint: Sasha activates/starts the new sprint (use on sprint planning day)
- close_sprint: Sasha completes/closes the current sprint (use on sprint review day)

## Output
Plan out an arc of the team's day. For example, meetings (impromptu or planed), slack convos, and uninterrupted work. You can include out of the office activities too. The idea is you're trying to build the bones for artifacts to be produced around. After you have the bones, use the output_day_plan tool to submit your planned activities. Include 10-30 activities per day
depending on how busy the day is. Sprint ceremony days should have more ceremony-related activities.
Activities should be in chronological order by time.
Each activity description should be specific enough for a persona agent to generate realistic content.
Include relatedKeys when the activity references existing tickets.

## Office Context
When calling output_day_plan, you MUST include an officeContext field: a concise 2-4 sentence "state of the office" brief.
This will be injected into every persona agent's prompt to ground their behavior in the company's current reality.

The officeContext MUST cover:
1. **Product phase**: What stage is the company at? (founding/hiring, building MVP, internal testing, first users, growing, scaling, crisis recovery, etc.)
2. **User count**: If the product has launched, approximate how many users/scouts exist. If it hasn't launched yet, say so explicitly ("no users yet, product is still being built").
3. **Team vibe**: General morale — excited, stressed, exhausted, celebrating, anxious, etc.
4. **Key recent context**: One sentence about the most relevant recent event.

Example for week 1:
"DeadRoute is in its founding week. The team is being assembled and there is no product and no users — the company is pure idea at this stage. Energy is high but chaotic as Chad pitches his vision and the first employees set up shop in a converted Jiffy Lube."

Example for week 8:
"DeadRoute has a working prototype deployed to roughly 100 users in the Marietta settlement. The app does basic routing and sighting reports but is buggy. The team is small-startup-scrappy: long hours, duct-tape solutions, everyone wearing multiple hats. Morale is cautiously optimistic."

Example for week 20:
"DeadRoute now serves around 2,000 users across several settlements. The routing engine is stable after the Great Outage recovery, but tech debt is piling up. The team is feeling the weight of scaling — more support tickets, more edge cases, more pressure from settlement leaders wanting features."`;


export interface PlannerResult {
  dayPlan: DayPlan;
  inputTokens: number;
  outputTokens: number;
}

// ─── MCP Tool Server Factory ────────────────────────────────────────

const PERSONA_IDS = ["chad","vanessa","tammy","sasha","marcus","cooper","priya","raj","dana","tk"] as const;
const ACTIVITY_TYPES = ["create_ticket","comment_ticket","transition_ticket","create_page","update_page","comment_page","sprint_ceremony","code_review","escalate_ticket","internal_discussion","start_sprint","close_sprint"] as const;

function createPlannerToolServer(
  capturedActivities: Activity[],
  captured: { officeContext: string }
) {
  const plannerTools = [
    tool(
      "output_day_plan",
      "Submit the planned activities for the day. Call this once with all activities.",
      {
        officeContext: z.string().describe(
          "2-4 sentence 'state of the office' brief. Cover: product phase (founding/building/alpha/launched/scaling/crisis), " +
          "approximate user count (or 'no users yet'), team morale/vibe, and key recent events. " +
          "This context will be shared with every persona agent to ground their behavior."
        ),
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
        captured.officeContext = args.officeContext;
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
  const captured = { officeContext: "" };
  const mcpServer = createPlannerToolServer(capturedActivities, captured);

  let inputTokens = 0;
  let outputTokens = 0;

  const q = query({
    prompt: prompt,
    options: {
      //model: config.plannerModel,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "deadroute-planner-tools": mcpServer },
      allowedTools: ["mcp__deadroute-planner-tools__output_day_plan"],
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
    officeContext: captured.officeContext || "The team is working on DeadRoute, a navigation app for the zombie apocalypse.",
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
      lines.push("Include a start_sprint activity for sasha to activate the new sprint.");
    }
    if (sprintDay === 12) {
      lines.push("**Sprint review day.** Include sprint review/demo activities.");
      lines.push("**Sprint retro day.** Include retrospective activities.");
      lines.push("Include a close_sprint activity for sasha to complete the current sprint.");
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

