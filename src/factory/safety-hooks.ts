/**
 * Safety hooks — PreToolUse guards that block catastrophic or out-of-policy
 * tool calls before they execute.
 *
 * Two layers of defense are used in factory mode:
 *  1. These hooks (fast, pattern-based, role-aware) — first line.
 *  2. The Agent SDK sandbox (OS-level Seatbelt/bubblewrap) — backstop for
 *     filesystem/network enforcement the hooks can't reliably parse.
 *
 * The hooks are intentionally conservative: they only DENY clearly dangerous
 * patterns and let everything else fall through to the sandbox layer.
 */

import { resolve, isAbsolute } from "path";
import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

export type FactoryRole = "pm" | "dev" | "tester";

export interface SafetyPolicy {
  role: FactoryRole;
  /** Absolute directory this agent is confined to (its workspace/sandbox). */
  workspaceDir: string;
}

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
}

// ─── Bash Command Rules ──────────────────────────────────────────────

interface DenyRule {
  pattern: RegExp;
  reason: string;
  /** Restrict rule to specific roles; applies to all when omitted. */
  roles?: FactoryRole[];
}

const DENY_RULES: DenyRule[] = [
  { pattern: /\bsudo\b/, reason: "sudo is not allowed" },
  { pattern: /\bsu\s+-?\w*/, reason: "switching users is not allowed" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, reason: "system power commands are not allowed" },
  { pattern: /\bmkfs\b/, reason: "filesystem formatting is not allowed" },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, reason: "writing to raw devices is not allowed" },
  { pattern: /:\(\)\s*\{[^}]*\}\s*;?\s*:/, reason: "fork bombs are not allowed" },
  { pattern: /\b(killall|pkill)\b/, reason: "mass process kills are not allowed; kill specific PIDs you own" },
  { pattern: /\bkill\b[^|;&]*\s-1\b/, reason: "killing all processes is not allowed" },
  { pattern: /(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, reason: "piping downloads into a shell is not allowed" },
  { pattern: /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, reason: "force pushes are not allowed" },
  { pattern: /\bgit\s+config\b[^|;&]*--global/, reason: "global git config changes are not allowed" },
  { pattern: /\b(npm|yarn|pnpm)\s+publish\b/, reason: "publishing packages is not allowed" },
  { pattern: /\b(crontab|launchctl|systemctl)\b/, reason: "modifying system services/schedules is not allowed" },
  { pattern: /~\/\.(ssh|aws|gnupg|config\/gh)\b|\bid_rsa\b|\/etc\/(passwd|shadow|sudoers)/, reason: "accessing credentials or system auth files is not allowed" },
  { pattern: /\bhistory\s+-c\b/, reason: "clearing history is not allowed" },
];

/** Commands that read file contents — denied for the tester on source files. */
const READ_COMMANDS =
  /\b(cat|bat|less|more|head|tail|nl|od|xxd|hexdump|strings|grep|egrep|fgrep|rg|ag|awk|sed|vi|vim|nano|emacs|pico|view|diff|cut|paste|tee)\b/;

const SOURCE_FILE_TOKEN =
  /\S+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|scala|sql|vue|svelte)\b/;

const GIT_INSPECTION = /\bgit\s+(log|diff|show|blame|grep)\b/;

/**
 * Destructive commands whose path arguments must stay inside the workspace.
 * rm/rmdir with recursive or force flags, mv/cp clobbering, chmod -R, chown -R.
 */
const DESTRUCTIVE_WITH_PATHS = /\b(rm|rmdir|mv|chmod|chown|shred|truncate)\b/;

export function evaluateBashCommand(command: string, policy: SafetyPolicy): SafetyVerdict {
  for (const rule of DENY_RULES) {
    if (rule.roles && !rule.roles.includes(policy.role)) continue;
    if (rule.pattern.test(command)) {
      return { allowed: false, reason: rule.reason };
    }
  }

  // Destructive commands: check every path-looking argument stays in-bounds
  if (DESTRUCTIVE_WITH_PATHS.test(command)) {
    const verdict = checkDestructivePaths(command, policy);
    if (!verdict.allowed) return verdict;
  }

  // Tester: zero source access — block reading source files or git inspection
  if (policy.role === "tester") {
    if (GIT_INSPECTION.test(command)) {
      return { allowed: false, reason: "Tester has zero repo access — git inspection is not allowed" };
    }
    if (READ_COMMANDS.test(command) && SOURCE_FILE_TOKEN.test(command)) {
      return {
        allowed: false,
        reason:
          "Tester has zero source access — you may run the app and read its OUTPUT, but not inspect source files. Test the product black-box.",
      };
    }
  }

  return { allowed: true };
}

/**
 * For destructive commands, extract path-ish arguments and verify each one
 * resolves inside the workspace (or /tmp). Relative paths are resolved
 * against the workspace since that's the agent's cwd.
 */
function checkDestructivePaths(command: string, policy: SafetyPolicy): SafetyVerdict {
  // Strip quoted strings' quotes but keep contents; split on whitespace and shell separators
  const tokens = command
    .replace(/["']/g, "")
    .split(/[\s;|&]+/)
    .filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith("-")) continue; // flags
    // Path-ish tokens: absolute, homedir, parent-relative, or bare root glob
    const pathish =
      isAbsolute(token) || token.startsWith("~") || token.includes("..") || token === "/" || token.startsWith("/*");
    if (!pathish) continue;

    if (token.startsWith("~")) {
      return { allowed: false, reason: `Path "${token}" touches the home directory — stay inside your workspace` };
    }
    const resolved = isAbsolute(token)
      ? resolve(token)
      : resolve(policy.workspaceDir, token);
    if (!isInside(resolved, policy.workspaceDir) && !isInside(resolved, "/tmp")) {
      return {
        allowed: false,
        reason: `Destructive command targets "${token}" outside your workspace (${policy.workspaceDir})`,
      };
    }
  }
  return { allowed: true };
}

// ─── File Tool Rules ─────────────────────────────────────────────────

export function evaluateFilePath(filePath: string, policy: SafetyPolicy): SafetyVerdict {
  const resolved = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(policy.workspaceDir, filePath);
  if (isInside(resolved, policy.workspaceDir) || isInside(resolved, "/tmp")) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Path "${filePath}" is outside your workspace (${policy.workspaceDir})`,
  };
}

function isInside(child: string, parent: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + "/");
}

// ─── Hook Assembly ───────────────────────────────────────────────────

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

/**
 * Build the PreToolUse hook set for an agent with the given policy.
 * Pass the result as `options.hooks` in the Agent SDK query() call.
 */
export function buildSafetyHooks(
  policy: SafetyPolicy,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hook = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const toolInput = (input.tool_input || {}) as Record<string, unknown>;

    let verdict: SafetyVerdict = { allowed: true };
    if (input.tool_name === "Bash") {
      const command = String(toolInput.command || "");
      verdict = evaluateBashCommand(command, policy);
    } else if (FILE_TOOLS.has(input.tool_name)) {
      const filePath = String(toolInput.file_path || toolInput.notebook_path || "");
      if (filePath) verdict = evaluateFilePath(filePath, policy);
    }

    if (!verdict.allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `BLOCKED by safety policy: ${verdict.reason}`,
        },
      };
    }
    return {};
  };

  return {
    PreToolUse: [{ hooks: [hook] }],
  };
}
