/**
 * Narrative spine — loads and queries the pre-defined plot beats.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { NarrativeBeat } from "../types/simulation.js";

let cachedBeats: NarrativeBeat[] | null = null;

export async function loadNarrativeSpine(dataDir: string = "./data"): Promise<NarrativeBeat[]> {
  if (cachedBeats) return cachedBeats;
  const data = await readFile(join(dataDir, "narrative-spine.json"), "utf-8");
  cachedBeats = JSON.parse(data) as NarrativeBeat[];
  return cachedBeats;
}

export function getBeatsForWeek(beats: NarrativeBeat[], week: number): NarrativeBeat[] {
  return beats.filter((b) => b.week === week);
}

export function getBeatsForWeekRange(
  beats: NarrativeBeat[],
  startWeek: number,
  endWeek: number
): NarrativeBeat[] {
  return beats.filter((b) => b.week >= startWeek && b.week <= endWeek);
}

export function formatBeatsForPrompt(beats: NarrativeBeat[]): string {
  if (beats.length === 0) return "No specific narrative beats for this period.";

  return beats
    .map(
      (b) =>
        `- **Week ${b.week}: ${b.title}** — ${b.description}\n` +
        `  Involves: ${b.involvedPersonas.join(", ")}\n` +
        `  Expected artifacts: ${b.expectedArtifacts.join(", ")}`
    )
    .join("\n\n");
}
