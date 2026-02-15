/**
 * Sprint calendar — 26 two-week sprints across 12 months.
 * Start date: January 15, 2024 (a Monday).
 */

import { addDays, format, isWithinInterval, parseISO, differenceInCalendarDays } from "date-fns";
import type { Sprint } from "../types/jira.js";

export interface SprintDefinition extends Sprint {
  number: number;
  /** Day 1 = sprint planning, Day 10 = retro (working days) */
  ceremonies: {
    planning: string; // ISO date
    retro: string; // ISO date
    review: string; // ISO date (day before retro)
  };
}

const SPRINT_GOALS: string[] = [
  "Foundation — Stand up core infrastructure, get first build deployed",
  "First Routes — Basic routing algorithm, initial map UI",
  "Sighting Reports — User sighting submission flow, threat data pipeline",
  "Real Users — Bug fixes from first 100 users, stability",
  "Routing v1.1 — Fix the near-death routing bugs, improve algorithm",
  "Scale Prep — Database indexing, API optimization, basic monitoring",
  "Recovery — Post-Great-Outage hardening, monitoring, backup procedures",
  "Code Quality — Test coverage push, code review standards, linting",
  "Danger Zones v2 — Enhanced danger zone detection and display",
  "Offline Mode — Core offline capability for low-connectivity zones",
  "Data Integrity — Database migration fixes, data validation layer",
  "Performance — Caching layer, API response time optimization",
  "Scout Tools — Power user features for DeadRoute Scouts",
  "API Versioning — Proper API versioning, deprecation plan",
  "Summit Prep — Stabilize for settlement leaders demo",
  "Security — Emergency security patches, route data exposure fix",
  "Settlement Dashboard — Admin dashboard for settlement leaders",
  "Refactor Phase 1 — Routing engine refactor, tech debt cleanup",
  "Refactor Phase 2 — Continue routing refactor, improve test coverage",
  "Performance v2 — Low-connectivity optimization, image compression",
  "App Store Push — Polish, performance, stability for featuring attempt",
  "Government Integration — Military data format integration, compliance prep",
  "Quarantine Zones — Quarantine zone mapping and display",
  "Data Ethics — Privacy controls, data sharing permissions, audit logging",
  "Tech Debt Reckoning — Pay down top 20 tech debt items",
  "Year End — Stabilization, documentation, roadmap prep for year 2",
];

export function generateSprintCalendar(startDate: string = "2024-01-15"): SprintDefinition[] {
  const sprints: SprintDefinition[] = [];
  let currentStart = parseISO(startDate);

  for (let i = 0; i < 26; i++) {
    const sprintEnd = addDays(currentStart, 13); // 14 days total (2 weeks), end on Sunday
    const planning = currentStart; // Day 1 (Monday)
    const review = addDays(currentStart, 11); // Friday of week 2
    const retro = addDays(currentStart, 11); // Same day as review (afternoon)

    sprints.push({
      number: i + 1,
      name: `Sprint ${i + 1}`,
      goal: SPRINT_GOALS[i] || `Sprint ${i + 1} — Continued development`,
      state: "closed", // Will be updated dynamically
      startDate: format(currentStart, "yyyy-MM-dd"),
      endDate: format(sprintEnd, "yyyy-MM-dd"),
      ceremonies: {
        planning: format(planning, "yyyy-MM-dd"),
        retro: format(retro, "yyyy-MM-dd"),
        review: format(review, "yyyy-MM-dd"),
      },
    });

    currentStart = addDays(sprintEnd, 1); // Next sprint starts the following Monday
  }

  return sprints;
}

export function getSprintForDate(
  date: string,
  sprints: SprintDefinition[]
): SprintDefinition | null {
  const d = parseISO(date);
  return (
    sprints.find((s) =>
      isWithinInterval(d, {
        start: parseISO(s.startDate),
        end: parseISO(s.endDate),
      })
    ) ?? null
  );
}

export function getSprintDay(date: string, sprint: SprintDefinition): number {
  const d = parseISO(date);
  const start = parseISO(sprint.startDate);
  return differenceInCalendarDays(d, start) + 1;
}

export function isCeremonyDay(
  date: string,
  sprint: SprintDefinition
): { planning: boolean; review: boolean; retro: boolean } {
  return {
    planning: date === sprint.ceremonies.planning,
    review: date === sprint.ceremonies.review,
    retro: date === sprint.ceremonies.retro,
  };
}

export function getWeekNumber(date: string, startDate: string = "2024-01-15"): number {
  const d = parseISO(date);
  const start = parseISO(startDate);
  return Math.floor(differenceInCalendarDays(d, start) / 7) + 1;
}
