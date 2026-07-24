/**
 * Factory engine — the sprint state machine that turns CEO requirements
 * into shipped software.
 *
 * One sprint = human gate → pm_synthesis → planning → dev_loop → testing
 * (with fix cycles) → sprint_review → human gate → next sprint.
 *
 * State persists to <workspacesDir>/factory-state.json after every phase,
 * so a crashed or interrupted run resumes at the phase it left off.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";
import chalk from "chalk";

import type { Config } from "../config.js";
import type { FactoryState } from "../types/factory.js";
import { createInitialFactoryState, DEV_PERSONAS, AI_PERSONAS } from "../types/factory.js";
import { loadGitHubConfig, validateGitHubConfig } from "../types/github-config.js";
import { loadAtlassianConfig, validateAtlassianConfig } from "../types/atlassian-config.js";
import { AtlassianClient } from "../bootstrap/atlassian-client.js";
import { GitHubClient } from "../bootstrap/github-client.js";
import { AtlassianWriter } from "../output/atlassian-writer.js";
import { createInitialState } from "../simulation/state.js";
import { TokenTracker } from "../simulation/token-tracker.js";
import type { MentionMap } from "../agents/persona-agent.js";
import { FACTORY_PROFILES, atlassianBinding } from "../personas/factory-profiles.js";
import { WorkspaceManager } from "./workspace.js";
import type { FactoryDeps } from "./deps.js";
import { runPMSynthesis } from "./phases/pm-synthesis.js";
import { runPlanning } from "./phases/planning.js";
import { runDevLoop } from "./phases/dev-loop.js";
import { runTestingPhase, runFixCycle } from "./phases/testing.js";
import { runSprintReview } from "./phases/sprint-review.js";

export interface FactoryOptions {
  /** Number of sprints to run before exiting (default 1) */
  sprints?: number;
  /** Skip the human gates (for unattended smoke tests) */
  noPause?: boolean;
}

export async function runFactory(config: Config, options: FactoryOptions = {}): Promise<void> {
  console.log(chalk.bold(`\n🏭 ${config.factory.companyName} Software Factory\n`));

  const deps = await initFactory(config);
  const totalSprints = options.sprints ?? 1;
  let completed = 0;

  while (completed < totalSprints) {
    const { state } = deps;

    // ── Human gate: the CEO writes/updates requirements before each sprint ──
    if (state.phase === "idle") {
      if (!options.noPause) {
        console.log(
          chalk.bold(
            `\n👤 CEO input time. Write or update requirements in Confluence ` +
              `(${deps.atlassianConfig.host}) — pages, tickets, comments all count.`,
          ),
        );
        await pressEnter(`Press Enter to start Sprint ${state.sprintNumber + 1} `);
      }
      state.sprintNumber++;
      state.phase = "pm_synthesis";
      state.sprintTickets = {};
      state.prs = [];
      state.fixRound = 0;
      state.sprintBriefPageId = null;
      await deps.saveState();
    } else {
      console.log(chalk.yellow(`Resuming Sprint ${state.sprintNumber} at phase "${state.phase}"`));
    }

    // ── Phase: PM synthesis ──
    if (state.phase === "pm_synthesis") {
      const outcome = await runPMSynthesis(deps);
      state.sprintBriefPageId = outcome.briefPageId;
      state.phase = "planning";
      await deps.saveState();
    }

    // ── Phase: planning ──
    if (state.phase === "planning") {
      await runPlanning(deps, `Sprint ${state.sprintNumber} Brief`);
      state.phase = "dev_loop";
      await deps.saveState();
    }

    // ── Phase: dev loop ──
    if (state.phase === "dev_loop") {
      await runDevLoop(deps);
      state.phase = "testing";
      await deps.saveState();
    }

    // ── Phase: testing + fix cycles ──
    if (state.phase === "testing") {
      while (true) {
        const outcome = await runTestingPhase(deps);
        if (outcome.clean) break;
        if (state.fixRound >= config.factory.maxFixRounds) {
          console.warn(
            chalk.yellow(
              `  Fix-round cap (${config.factory.maxFixRounds}) reached with open bugs — escalating to the sprint review`,
            ),
          );
          break;
        }
        state.fixRound++;
        await deps.saveState();
        await runFixCycle(deps, outcome.bugsFiled);
        await deps.saveState();
      }
      state.phase = "sprint_review";
      await deps.saveState();
    }

    // ── Phase: sprint review ──
    if (state.phase === "sprint_review") {
      const summary = await runSprintReview(deps);
      state.sprintHistory.push({ sprint: state.sprintNumber, summary });
      state.lastSprintClosedAt = new Date().toISOString();
      state.phase = "idle";
      await deps.saveState();
    }

    completed++;
    await deps.tokenTracker.save();
    console.log(chalk.bold.green(`\n✓ Sprint ${state.sprintNumber} complete.`));
    console.log(
      chalk.dim(
        `  Review it: "Sprint ${state.sprintNumber} Review" in Confluence PROD, the Jira board, and the repo's merged PRs.`,
      ),
    );
  }

  console.log(chalk.bold(`\n🏭 Factory run finished (${completed} sprint(s)).\n`));
  console.log(chalk.dim(deps.tokenTracker.formatRunningTotal()));
}

// ─── Initialization ──────────────────────────────────────────────────

const DEFAULT_COMPANY_PROFILE = `# Company Profile

We are a small software startup. The company is real and the stakes are real:

- Team: a human CEO plus a five-person product team (PM, dev lead, two developers, QA).
- Runway: roughly 12 months. Every sprint must move the product toward something users want.
- Stage: early. Speed of learning beats polish, but broken software teaches nothing — it has to work.
- Culture: pragmatic engineering. Boring, reliable technology; small scopes shipped completely beat big scopes shipped half-done.

The product we are building is defined by the CEO's requirements in Confluence — that is the source of truth for WHAT we build. This profile is who we ARE.
`;

async function initFactory(config: Config): Promise<FactoryDeps> {
  // Company profile — editable markdown; write the default on first run
  let companyProfile: string;
  try {
    companyProfile = await readFile(config.factory.companyProfilePath, "utf-8");
  } catch {
    companyProfile = DEFAULT_COMPANY_PROFILE;
    try {
      await writeFile(config.factory.companyProfilePath, DEFAULT_COMPANY_PROFILE);
      console.log(chalk.dim(`  Created default company profile: ${config.factory.companyProfilePath} (edit it!)`));
    } catch {
      // read-only location — use the in-memory default
    }
  }

  // Atlassian config + validation
  let atlassianConfig;
  try {
    atlassianConfig = await loadAtlassianConfig();
  } catch {
    fail("Factory mode requires Atlassian:", [
      "atlassian-config.json not found — run `npm run bootstrap` first (see CLAUDE.md)",
    ]);
    throw new Error("unreachable");
  }
  const atlErrors = validateAtlassianConfig(atlassianConfig);
  if (atlErrors.length > 0) {
    fail("Atlassian config errors:", atlErrors);
  }

  // GitHub config + validation
  const github = loadGitHubConfig();
  const ghErrors = validateGitHubConfig(github);
  if (ghErrors.length > 0) {
    fail("GitHub config errors:", ghErrors);
  }

  // Admin client — the human CEO's own account
  const adminEmail = process.env.ATLASSIAN_ADMIN_EMAIL;
  const adminToken = process.env.ATLASSIAN_ADMIN_API_TOKEN;
  if (!adminEmail || !adminToken) {
    fail("Factory mode needs the CEO's Atlassian credentials:", [
      "ATLASSIAN_ADMIN_EMAIL and ATLASSIAN_ADMIN_API_TOKEN must be set (the human CEO's account)",
    ]);
  }
  const adminClient = new AtlassianClient(atlassianConfig.host, adminEmail!, adminToken!);
  const me = await adminClient.getMyself();
  const ceoAccountId = process.env.FACTORY_CEO_ACCOUNT_ID || me.accountId;
  console.log(chalk.dim(`  CEO account: ${me.displayName} (${ceoAccountId})`));

  // State (load or create)
  await mkdir(config.factory.workspacesDir, { recursive: true });
  const statePath = join(config.factory.workspacesDir, "factory-state.json");
  let state: FactoryState;
  let writerState = createInitialState(new Date().toISOString().slice(0, 10));
  try {
    const raw = JSON.parse(await readFile(statePath, "utf-8"));
    state = raw.factory as FactoryState;
    if (raw.writer) writerState = raw.writer;
    console.log(chalk.dim(`  Loaded state: sprint ${state.sprintNumber}, phase ${state.phase}`));
  } catch {
    state = createInitialFactoryState();
  }
  const saveState = async () => {
    await writeFile(statePath, JSON.stringify({ factory: state, writer: writerState }, null, 2));
  };

  // Writer (acts as each bound Atlassian user)
  const writer = new AtlassianWriter(atlassianConfig);
  await writer.init(writerState);

  // Binding + mention map (all 5 AI personas + the human CEO)
  const binding = atlassianBinding();
  const mentionMap: MentionMap = {
    ceo: { accountId: ceoAccountId, displayName: me.displayName },
  };
  for (const factoryId of AI_PERSONAS) {
    const user = atlassianConfig.users[binding[factoryId]];
    if (user) {
      mentionMap[factoryId] = { accountId: user.accountId, displayName: user.displayName };
    }
  }

  // Workspaces + per-persona GitHub clients
  const workspaces = new WorkspaceManager(config.factory.workspacesDir, github);
  const githubClients: FactoryDeps["githubClients"] = {};
  for (const persona of DEV_PERSONAS) {
    const pat = github.auth[persona]?.pat;
    if (pat) githubClients[persona] = new GitHubClient(pat, github.owner, github.repo);
    const profile = FACTORY_PROFILES[persona];
    await workspaces.ensureWorkspace(persona, {
      name: profile.gitName || profile.displayName,
      email: profile.gitEmail || `${persona}@deadroute.app`,
    });
  }
  console.log(chalk.dim(`  Workspaces ready: ${DEV_PERSONAS.join(", ")} → ${config.factory.workspacesDir}`));

  const tokenTracker = new TokenTracker(config);
  await tokenTracker.loadExisting();

  return {
    config,
    companyProfile,
    atlassianConfig,
    github,
    writer,
    writerState,
    adminClient,
    ceoAccountId,
    binding,
    mentionMap,
    workspaces,
    githubClients,
    tokenTracker,
    state,
    saveState,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fail(header: string, errors: string[]): void {
  console.error(chalk.red(header));
  for (const err of errors) console.error(chalk.red(`  - ${err}`));
  process.exit(1);
}

function pressEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    rl.question(chalk.bold(prompt), () => {
      rl.close();
      resolvePromise();
    });
  });
}
