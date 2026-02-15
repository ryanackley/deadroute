/**
 * Master planner agent — plans each day's activities using Claude Sonnet.
 * Uses the Anthropic SDK directly for structured JSON output.
 *
 * Receives a rolling multi-day summary to maintain narrative continuity.
 */

import Anthropic from "@anthropic-ai/sdk";
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

## Output Format
Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{
  "activities": [
    {
      "time": "09:00",
      "persona": "sasha",
      "type": "sprint_ceremony",
      "description": "Sprint planning for Sprint 5 — review backlog, assign stories, set sprint goal",
      "relatedKeys": ["DR-45", "DR-52"],
      "narrativeBeat": "Sprint 5 focuses on danger zones v2"
    }
  ]
}

Activities should be in chronological order by time. Include 10-30 activities per day depending on
how busy the day is. Sprint ceremony days should have more ceremony-related activities.
Each activity description should be specific enough for a persona agent to generate realistic content.
Include relatedKeys when the activity references existing tickets.`;

export interface PlannerResult {
  dayPlan: DayPlan;
  inputTokens: number;
  outputTokens: number;
}

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
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const prompt = buildPlannerPrompt(
    date,
    dayOfWeek,
    sprint,
    sprintDay,
    narrativeBeats,
    stateSummary,
    rollingSummary
  );

  const response = await client.messages.create({
    model: config.plannerModel,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  tokenTracker.record({
    inputTokens,
    outputTokens,
    category: "master_planner",
    model: config.plannerModel,
  });

  // Extract text from the response
  let responseText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      responseText += block.text;
    }
  }

  const activities = parseActivities(responseText, date);

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

function parseActivities(responseText: string, date: string): Activity[] {
  try {
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);
    const activities: Activity[] = (parsed.activities || []).map((a: any) => ({
      time: a.time || "09:00",
      persona: a.persona as PersonaId,
      type: a.type,
      description: a.description || "",
      relatedKeys: a.relatedKeys || [],
      narrativeBeat: a.narrativeBeat || undefined,
    }));

    return activities;
  } catch (err) {
    console.error(`Failed to parse master planner response for ${date}:`, err);
    console.error("Response was:", responseText.substring(0, 500));
    return [
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
  }
}
