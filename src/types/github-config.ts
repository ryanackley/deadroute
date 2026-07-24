/**
 * GitHub configuration for factory mode — repo coordinates and per-persona
 * personal access tokens so each dev commits under their own identity.
 */

import type { AIPersonaId } from "./factory.js";
import { DEV_PERSONAS } from "./factory.js";

export interface GitHubPersonaAuth {
  /** Personal access token used for git push and API calls */
  pat: string;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** PATs keyed by persona. Dev personas (dev_lead, dev1, dev2) are required. */
  auth: Partial<Record<AIPersonaId, GitHubPersonaAuth>>;
}

const PAT_ENV_VARS: Record<string, AIPersonaId> = {
  GITHUB_PAT_DEV_LEAD: "dev_lead",
  GITHUB_PAT_DEV1: "dev1",
  GITHUB_PAT_DEV2: "dev2",
};

export function loadGitHubConfig(): GitHubConfig {
  const auth: Partial<Record<AIPersonaId, GitHubPersonaAuth>> = {};
  for (const [envVar, persona] of Object.entries(PAT_ENV_VARS)) {
    const pat = process.env[envVar];
    if (pat) auth[persona] = { pat };
  }

  return {
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
    defaultBranch: process.env.GITHUB_DEFAULT_BRANCH || "main",
    auth,
  };
}

export function validateGitHubConfig(config: GitHubConfig): string[] {
  const errors: string[] = [];
  if (!config.owner) errors.push("GITHUB_OWNER is required for factory mode");
  if (!config.repo) errors.push("GITHUB_REPO is required for factory mode");
  for (const persona of DEV_PERSONAS) {
    if (!config.auth[persona]?.pat) {
      const envVar = Object.entries(PAT_ENV_VARS).find(([, p]) => p === persona)?.[0];
      errors.push(`Missing GitHub PAT for "${persona}" (set ${envVar})`);
    }
  }
  return errors;
}

/** HTTPS remote URL with embedded PAT for a persona's clone. */
export function remoteUrlFor(config: GitHubConfig, persona: AIPersonaId): string {
  const pat = config.auth[persona]?.pat;
  if (!pat) throw new Error(`No GitHub PAT configured for persona "${persona}"`);
  return `https://x-access-token:${pat}@github.com/${config.owner}/${config.repo}.git`;
}
