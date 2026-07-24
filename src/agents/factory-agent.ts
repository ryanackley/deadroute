/**
 * Factory agent runner — executes one AI persona task via the Claude Agent SDK.
 *
 * Role-specific configuration:
 *  - pm:       no built-in tools, Atlassian search/read/write-pages tools only
 *  - dev_lead: full dev tools + GitHub review/merge + sprint operations
 *  - dev:      Bash/file tools in their workspace + GitHub PR tools
 *  - tester:   Bash ONLY in its sandbox (zero source access), Atlassian bug filing
 *
 * Every agent runs headless (bypassPermissions) behind two safety layers:
 * PreToolUse hooks (safety-hooks.ts) and, when enabled, the SDK's OS-level
 * sandbox (Seatbelt on macOS, bubblewrap on Linux).
 */

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { AIPersonaId } from "../types/factory.js";
import type { FactoryProfile } from "../personas/factory-profiles.js";
import type { TokenTracker } from "../simulation/token-tracker.js";
import type { GitHubClient } from "../bootstrap/github-client.js";
import type { MentionMap } from "./persona-agent.js";
import {
  createFactoryAtlassianTools,
  createAtlassianActionLog,
  type AtlassianActionLog,
  type FactoryToolContext,
  type FactoryAtlassianToolName,
} from "./factory-atlassian-tools.js";
import {
  createDevGitHubTools,
  createLeadGitHubTools,
  createGitHubActionLog,
  type GitHubActionLog,
} from "./github-tools.js";
import { buildSafetyHooks, type FactoryRole } from "../factory/safety-hooks.js";

// ─── Role Policies ───────────────────────────────────────────────────

const ATLASSIAN_TOOLS_BY_PERSONA: Record<AIPersonaId, FactoryAtlassianToolName[]> = {
  pm: [
    "search_jira",
    "search_confluence",
    "get_jira_ticket",
    "get_confluence_page",
    "create_confluence_page",
    "edit_confluence_page",
    "add_comment",
  ],
  dev_lead: [
    "create_jira_ticket",
    "add_comment",
    "transition_ticket",
    "assign_ticket",
    "get_jira_ticket",
    "search_jira",
    "get_confluence_page",
    "create_confluence_page",
    "edit_confluence_page",
    "search_confluence",
    "start_sprint",
    "close_sprint",
    "move_to_sprint",
  ],
  dev1: [
    "get_jira_ticket",
    "search_jira",
    "add_comment",
    "transition_ticket",
    "get_confluence_page",
    "create_confluence_page",
    "edit_confluence_page",
  ],
  dev2: [
    "get_jira_ticket",
    "search_jira",
    "add_comment",
    "transition_ticket",
    "get_confluence_page",
    "create_confluence_page",
    "edit_confluence_page",
  ],
  tester: [
    "get_jira_ticket",
    "search_jira",
    "get_confluence_page",
    "search_confluence",
    "create_jira_ticket",
    "add_comment",
    "transition_ticket",
  ],
};

const BUILTIN_TOOLS_BY_PERSONA: Record<AIPersonaId, string[]> = {
  pm: [],
  dev_lead: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  dev1: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  dev2: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  tester: ["Bash"],
};

function safetyRoleFor(persona: AIPersonaId): FactoryRole {
  if (persona === "pm") return "pm";
  if (persona === "tester") return "tester";
  return "dev";
}

// ─── Result ──────────────────────────────────────────────────────────

export interface FactoryAgentResult {
  atlassian: AtlassianActionLog;
  github: GitHubActionLog;
  /** The agent's final text — its report of what it did / found */
  finalReport: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FactoryAgentRun {
  profile: FactoryProfile;
  /** The task instructions for this session */
  task: string;
  /** Assembled context (sprint brief, tickets, digests, etc.) */
  context: string;
  /** Atlassian tool wiring (log is created per-run) */
  toolContext: Omit<FactoryToolContext, "log" | "persona">;
  /** GitHub client authenticated as this persona (dev personas only) */
  githubClient?: GitHubClient;
  /** Workspace: cwd for the session + confinement root for safety hooks */
  workspace?: { cwd: string; confineTo: string };
  mentionMap?: MentionMap;
  config: Config;
  tokenTracker: TokenTracker;
}

// ─── System Prompt ───────────────────────────────────────────────────

function buildSystemPrompt(profile: FactoryProfile, run: FactoryAgentRun): string {
  let mentionSection = "";
  if (run.mentionMap && Object.keys(run.mentionMap).length > 0) {
    const rows = Object.entries(run.mentionMap)
      .map(([id, { accountId, displayName }]) => `| ${id} | ${displayName} | ${accountId} |`)
      .join("\n");
    mentionSection = `

## @Mentions
When mentioning a teammate in ADF content (descriptions, comments, pages), use a mention node inline in a paragraph's content array:
\`\`\`json
{ "type": "mention", "attrs": { "id": "<accountId>", "text": "@Display Name", "accessLevel": "" } }
\`\`\`

| Persona | Display Name | Account ID |
|---------|-------------|------------|
${rows}`;
  }

  let workspaceSection = "";
  if (run.workspace) {
    workspaceSection = `

## Your Workspace
Your working directory is ${run.workspace.cwd}. Stay inside it — the safety policy blocks anything else.
${
  profile.id === "tester"
    ? "This sandbox contains a running copy of the product. You may execute it and read its OUTPUT (logs, CLI output, HTTP responses), but you may NOT read source files or inspect version control — that is enforced, and trying wastes your turns."
    : "This is your own git clone. Use git normally: branch, commit, push (your remote is authenticated as you). Never force-push, never touch git global config."
}`;
  }

  return `You are ${profile.displayName}, ${profile.role} at DeadRoute — a real software team building "Waze for the zombie apocalypse."

This is NOT a simulation. Your Jira tickets, Confluence pages, code, and pull requests are real work product on real systems. Quality matters.

## Your Personality
${profile.personality}

## Your Mandate
${profile.mandate}${workspaceSection}${mentionSection}

## Working Rules
- Keep Jira/Confluence comments under 100 words; put longer content in pages or ticket descriptions.
- Only reference ticket keys and page titles that actually exist (from your context or tool results). Never invent keys.
- When you finish, end with a concise report of what you did: artifacts created (with keys), decisions made, and anything blocking you.`;
}

// ─── Execution ───────────────────────────────────────────────────────

async function* promptStream(message: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: message },
    parent_tool_use_id: null,
    session_id: "deadroute-factory",
  };
}

export async function runFactoryAgent(run: FactoryAgentRun): Promise<FactoryAgentResult> {
  const { profile, config } = run;
  const persona = profile.id;

  const atlassianLog = createAtlassianActionLog();
  const githubLog = createGitHubActionLog();

  // Assemble MCP tools per role
  const toolCtx: FactoryToolContext = { ...run.toolContext, persona, log: atlassianLog };
  const tools = [
    ...createFactoryAtlassianTools(toolCtx, ATLASSIAN_TOOLS_BY_PERSONA[persona]),
    ...(run.githubClient
      ? persona === "dev_lead"
        ? createLeadGitHubTools(run.githubClient, githubLog)
        : createDevGitHubTools(run.githubClient, githubLog)
      : []),
  ];

  const mcpServer = createSdkMcpServer({ name: "factory-tools", tools });
  const mcpToolNames = tools.map((t) => `mcp__factory-tools__${t.name}`);

  const builtinTools = BUILTIN_TOOLS_BY_PERSONA[persona];
  const hooks = run.workspace
    ? buildSafetyHooks({ role: safetyRoleFor(persona), workspaceDir: run.workspace.confineTo })
    : undefined;

  // Minimal env: secrets stay out of agent shells. The PAT lives only in
  // each clone's git remote config, scoped to that persona.
  const cleanEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GIT_TERMINAL_PROMPT: "0",
  };

  const sandboxEnabled = config.factory.sandboxEnabled && builtinTools.includes("Bash");

  const q = query({
    prompt: promptStream(`${run.context}\n\n## Your Task\n${run.task}`),
    options: {
      model: config.factory.agentModel,
      systemPrompt: buildSystemPrompt(profile, run),
      cwd: run.workspace?.cwd,
      tools: builtinTools,
      mcpServers: { "factory-tools": mcpServer },
      allowedTools: [...builtinTools, ...mcpToolNames],
      hooks,
      env: cleanEnv,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(sandboxEnabled
        ? {
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              network: {
                allowedDomains: [
                  "github.com",
                  "*.github.com",
                  "*.githubusercontent.com",
                  "registry.npmjs.org",
                  "*.atlassian.net",
                  "localhost",
                ],
                allowLocalBinding: true,
              },
            },
          }
        : {}),
      maxTurns: config.factory.maxAgentTurns,
      persistSession: false,
    },
  });

  let finalReport = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const message of q) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        finalReport = message.result;
      }
      for (const modelData of Object.values(message.modelUsage)) {
        inputTokens += modelData.inputTokens;
        outputTokens += modelData.outputTokens;
      }
    }
  }

  run.tokenTracker.record({
    inputTokens,
    outputTokens,
    category: "persona_generation",
    model: config.factory.agentModel,
    persona,
  });

  return { atlassian: atlassianLog, github: githubLog, finalReport, inputTokens, outputTokens };
}
