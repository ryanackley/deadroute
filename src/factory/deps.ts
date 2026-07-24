/**
 * Shared dependency bundle passed to every factory phase.
 * Built once by the engine at startup.
 */

import type { Config } from "../config.js";
import type { AIPersonaId, FactoryState } from "../types/factory.js";
import type { PersonaId, SimulationState } from "../types/simulation.js";
import type { AtlassianConfig } from "../types/atlassian-config.js";
import type { GitHubConfig } from "../types/github-config.js";
import type { AtlassianWriter } from "../output/atlassian-writer.js";
import type { AtlassianClient } from "../bootstrap/atlassian-client.js";
import type { GitHubClient } from "../bootstrap/github-client.js";
import type { WorkspaceManager } from "./workspace.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import type { MentionMap } from "../agents/persona-agent.js";
import type { FactoryToolContext } from "../agents/factory-atlassian-tools.js";

export interface FactoryDeps {
  config: Config;
  /** Company profile markdown injected into every agent's system prompt */
  companyProfile: string;
  atlassianConfig: AtlassianConfig;
  github: GitHubConfig;
  writer: AtlassianWriter;
  /** Minimal SimulationState the AtlassianWriter uses for its ID caches */
  writerState: SimulationState;
  /** Admin-authenticated client for searches and discovery */
  adminClient: AtlassianClient;
  /** The human CEO's Atlassian account ID */
  ceoAccountId: string;
  /** factory persona → provisioned Atlassian user */
  binding: Record<AIPersonaId, PersonaId>;
  mentionMap: MentionMap;
  workspaces: WorkspaceManager;
  githubClients: Partial<Record<AIPersonaId, GitHubClient>>;
  tokenTracker: TokenTracker;
  state: FactoryState;
  saveState: () => Promise<void>;
}

/** The Atlassian tool wiring shared by all factory agent runs. */
export function toolContextFor(deps: FactoryDeps): Omit<FactoryToolContext, "log" | "persona"> {
  return {
    binding: deps.binding,
    writer: deps.writer,
    state: deps.writerState,
    searchClient: deps.adminClient,
  };
}
