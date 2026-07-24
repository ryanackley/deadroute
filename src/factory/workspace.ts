/**
 * Workspace manager — per-persona local git clones.
 *
 * Each dev persona (dev_lead, dev1, dev2) gets its own clone with its own
 * git identity and PAT-embedded remote, so commits and pushes are attributed
 * to that persona's GitHub account.
 *
 * The tester gets a source snapshot with the .git directory REMOVED —
 * it can run the app but has no git history and no credentials.
 */

import { mkdir, rm, access } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AIPersonaId } from "../types/factory.js";
import type { GitHubConfig } from "../types/github-config.js";
import { remoteUrlFor } from "../types/github-config.js";

const execFileAsync = promisify(execFile);

export interface GitIdentity {
  name: string;
  email: string;
}

export interface WorkspaceInfo {
  persona: AIPersonaId;
  /** The persona's private directory (agent cwd + confinement root) */
  dir: string;
  /** The git clone inside it */
  repoDir: string;
}

export class WorkspaceManager {
  constructor(
    private workspacesDir: string,
    private github: GitHubConfig,
  ) {}

  workspaceFor(persona: AIPersonaId): WorkspaceInfo {
    const dir = join(this.workspacesDir, persona);
    return { persona, dir, repoDir: join(dir, "repo") };
  }

  /**
   * Ensure the persona's clone exists and is configured. Idempotent —
   * existing clones are left as-is (branches in progress survive).
   */
  async ensureWorkspace(persona: AIPersonaId, identity: GitIdentity): Promise<WorkspaceInfo> {
    const ws = this.workspaceFor(persona);
    await mkdir(ws.dir, { recursive: true });

    if (!(await exists(join(ws.repoDir, ".git")))) {
      await git(ws.dir, ["clone", remoteUrlFor(this.github, persona), "repo"]);
    }

    // (Re)apply identity + remote on every run — PATs may rotate
    await git(ws.repoDir, ["config", "user.name", identity.name]);
    await git(ws.repoDir, ["config", "user.email", identity.email]);
    await git(ws.repoDir, ["remote", "set-url", "origin", remoteUrlFor(this.github, persona)]);
    return ws;
  }

  /**
   * Sync the clone's default branch to origin. Call before each dev session
   * so agents start from the latest merged state.
   */
  async syncDefaultBranch(persona: AIPersonaId): Promise<void> {
    const ws = this.workspaceFor(persona);
    const branch = this.github.defaultBranch;
    await git(ws.repoDir, ["fetch", "origin", branch]);
    await git(ws.repoDir, ["checkout", branch]);
    await git(ws.repoDir, ["reset", "--hard", `origin/${branch}`]);
  }

  /**
   * Build the tester's sandbox: a fresh snapshot of the default branch with
   * .git removed — no history, no credentials, no source-control tooling.
   * The tester still sees source files on disk (the app has to run), but the
   * safety hooks deny reading them; this removes the git-inspection hole.
   *
   * Cloned with the dev lead's PAT (an orchestrator action — the tester
   * itself has no GitHub credentials).
   */
  async prepareTesterSandbox(): Promise<WorkspaceInfo> {
    const ws = this.workspaceFor("tester");
    await rm(ws.repoDir, { recursive: true, force: true });
    await mkdir(ws.dir, { recursive: true });
    await git(ws.dir, [
      "clone",
      "--depth",
      "1",
      "--branch",
      this.github.defaultBranch,
      remoteUrlFor(this.github, "dev_lead"),
      "repo",
    ]);
    await rm(join(ws.repoDir, ".git"), { recursive: true, force: true });
    return ws;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    // Never leak PAT-bearing URLs into error messages
    const detail = (e.stderr || e.message || "git error").replace(
      /https:\/\/[^@\s]+@/g,
      "https://***@",
    );
    throw new Error(`git ${args[0]} failed in ${cwd}: ${detail}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
