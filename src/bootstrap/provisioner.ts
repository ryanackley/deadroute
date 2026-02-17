/**
 * Bootstrapper orchestration — creates users, Jira projects, and Confluence spaces
 * on an Atlassian Cloud site, then writes the config file.
 */

import chalk from "chalk";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { PERSONAS } from "../personas/profiles.js";
import { SPACES } from "../types/confluence.js";
import type { PersonaId } from "../types/simulation.js";
import type { SpaceKey } from "../types/confluence.js";
import type {
  AtlassianConfig,
  AtlassianUserConfig,
  AtlassianProjectConfig,
  AtlassianSpaceConfig,
} from "../types/atlassian-config.js";
import { AtlassianClient, AtlassianApiError } from "./atlassian-client.js";

/** Marcus is the admin account (10-user free plan limit). */
const ADMIN_PERSONA: PersonaId = "marcus";

interface BootstrapOptions {
  host: string;
  adminEmail: string;
  adminApiToken: string;
  outputDir: string;
  dryRun?: boolean;
}

interface BootstrapSummary {
  usersCreated: string[];
  usersExisting: string[];
  usersFailed: string[];
  projectsCreated: string[];
  projectsExisting: string[];
  projectsFailed: string[];
  spacesCreated: string[];
  spacesExisting: string[];
  spacesFailed: string[];
}

const PROJECT_DEFINITIONS = [
  {
    key: "DR" as const,
    name: "DeadRoute",
    projectTypeKey: "software" as const,
    projectTemplateKey:
      "com.pyxis.greenhopper.jira:gh-simplified-agility-scrum",
    description: "DeadRoute app development — Waze for the zombie apocalypse",
  },
  {
    key: "SUP" as const,
    name: "DeadRoute Support",
    projectTypeKey: "service_desk" as const,
    projectTemplateKey:
      "com.atlassian.servicedesk:simplified-general-service-desk",
    description: "Customer support and field issue management",
  },
];

export async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const { host, adminEmail, adminApiToken, outputDir, dryRun } = options;

  console.log(chalk.bold("\n  DeadRoute Atlassian Bootstrapper\n"));
  console.log(`  Host:  ${host}`);
  console.log(`  Admin: ${adminEmail}`);
  if (dryRun) console.log(chalk.yellow("  Mode:  DRY RUN (no API calls)\n"));
  else console.log("");

  const client = new AtlassianClient(host, adminEmail, adminApiToken);
  let config = await loadExistingConfig(outputDir);

  if (!config) {
    config = createEmptyConfig(host);
  }

  const summary: BootstrapSummary = {
    usersCreated: [],
    usersExisting: [],
    usersFailed: [],
    projectsCreated: [],
    projectsExisting: [],
    projectsFailed: [],
    spacesCreated: [],
    spacesExisting: [],
    spacesFailed: [],
  };

  // Step 1: Map admin account to marcus
  console.log(chalk.bold("  Mapping admin account..."));
  if (dryRun) {
    console.log(
      `    ${chalk.dim("~")} ${PERSONAS[ADMIN_PERSONA].displayName} (admin account) → would fetch /myself`,
    );
    summary.usersExisting.push(ADMIN_PERSONA);
  } else {
    try {
      const myself = await client.getMyself();
      config.users[ADMIN_PERSONA] = {
        accountId: myself.accountId,
        email: adminEmail,
        displayName: PERSONAS[ADMIN_PERSONA].displayName,
        apiToken: adminApiToken,
      };
      console.log(
        `    ${chalk.green("✓")} ${PERSONAS[ADMIN_PERSONA].displayName} (admin) → ${myself.accountId}`,
      );
      summary.usersExisting.push(ADMIN_PERSONA);
      await saveConfig(config, outputDir);
    } catch (err) {
      console.log(
        `    ${chalk.red("✗")} Failed to fetch admin account: ${err instanceof Error ? err.message : err}`,
      );
      summary.usersFailed.push(ADMIN_PERSONA);
    }
  }

  // Step 2: Create 9 remaining users
  console.log(chalk.bold("\n  Creating users..."));
  const personaIds = Object.keys(PERSONAS) as PersonaId[];

  for (const id of personaIds) {
    if (id === ADMIN_PERSONA) continue;

    const persona = PERSONAS[id];

    // Already in config from a previous run?
    if (config.users[id]?.accountId) {
      console.log(
        `    ${chalk.dim("~")} ${persona.displayName} already provisioned (${config.users[id].accountId})`,
      );
      summary.usersExisting.push(id);
      continue;
    }

    if (dryRun) {
      console.log(
        `    ${chalk.dim("~")} ${persona.displayName} (${persona.email}) → would create`,
      );
      summary.usersCreated.push(id);
      continue;
    }

    try {
      // Check if user already exists on the server
      const existing = await client.searchUsers(persona.email);
      const match = existing.find(
        (u) => u.emailAddress === persona.email,
      );

      if (match) {
        config.users[id] = {
          accountId: match.accountId,
          email: persona.email,
          displayName: persona.displayName,
          apiToken: "",
        };
        console.log(
          `    ${chalk.dim("~")} ${persona.displayName} already exists → ${match.accountId}`,
        );
        summary.usersExisting.push(id);
      } else {
        const user = await client.createUser(
          persona.email,
          persona.displayName,
          ["jira-software", "jira-servicedesk"],
        );
        config.users[id] = {
          accountId: user.accountId,
          email: persona.email,
          displayName: persona.displayName,
          apiToken: "",
        };
        console.log(
          `    ${chalk.green("✓")} ${persona.displayName} (${persona.email}) → ${user.accountId}`,
        );
        summary.usersCreated.push(id);
      }

      await saveConfig(config, outputDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `    ${chalk.red("✗")} ${persona.displayName}: ${msg}`,
      );
      summary.usersFailed.push(id);
    }
  }

  // Step 3: Create Jira projects
  console.log(chalk.bold("\n  Creating Jira projects..."));
  const leadAccountId = config.users[ADMIN_PERSONA]?.accountId;

  // Fetch existing projects for idempotency
  let existingProjectKeys = new Set<string>();
  if (!dryRun) {
    try {
      const projectSearch = await client.searchProjects();
      existingProjectKeys = new Set(projectSearch.values.map((p) => p.key));
    } catch {
      // If search fails, we'll try creating and handle the error
    }
  }

  for (const def of PROJECT_DEFINITIONS) {
    // Already in config from a previous run?
    if (config.projects[def.key]?.id) {
      console.log(
        `    ${chalk.dim("~")} ${def.key} (${def.name}) already provisioned`,
      );
      summary.projectsExisting.push(def.key);
      continue;
    }

    if (existingProjectKeys.has(def.key)) {
      console.log(
        `    ${chalk.dim("~")} ${def.key} (${def.name}) already exists on server`,
      );
      summary.projectsExisting.push(def.key);
      // We don't have the project ID; we could fetch it but the key is
      // what we use in practice. Store a placeholder.
      config.projects[def.key] = {
        id: "",
        key: def.key,
        name: def.name,
        projectTypeKey: def.projectTypeKey,
      };
      await saveConfig(config, outputDir);
      continue;
    }

    if (dryRun) {
      console.log(
        `    ${chalk.dim("~")} ${def.key} (${def.name}) → would create as ${def.projectTypeKey}`,
      );
      summary.projectsCreated.push(def.key);
      continue;
    }

    try {
      const project = await client.createProject({
        key: def.key,
        name: def.name,
        projectTypeKey: def.projectTypeKey,
        projectTemplateKey: def.projectTemplateKey,
        leadAccountId: leadAccountId || "",
        description: def.description,
      });
      config.projects[def.key] = {
        id: String(project.id),
        key: project.key,
        name: def.name,
        projectTypeKey: def.projectTypeKey,
      };
      console.log(
        `    ${chalk.green("✓")} ${def.key} (${def.name}) — ${def.projectTypeKey}`,
      );
      summary.projectsCreated.push(def.key);
      await saveConfig(config, outputDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ${chalk.red("✗")} ${def.key}: ${msg}`);
      summary.projectsFailed.push(def.key);
    }
  }

  // Step 4: Create Confluence spaces
  console.log(chalk.bold("\n  Creating Confluence spaces..."));

  // Fetch existing spaces for idempotency
  let existingSpaceKeys = new Set<string>();
  if (!dryRun) {
    try {
      const spaceSearch = await client.getSpaces();
      existingSpaceKeys = new Set(spaceSearch.results.map((s) => s.key));
    } catch {
      // If search fails, we'll try creating and handle the error
    }
  }

  for (const space of SPACES) {
    const key = space.key as SpaceKey;

    // Already in config from a previous run?
    if (config.spaces[key]?.id) {
      console.log(
        `    ${chalk.dim("~")} ${space.key} (${space.name}) already provisioned`,
      );
      summary.spacesExisting.push(space.key);
      continue;
    }

    if (existingSpaceKeys.has(space.key)) {
      console.log(
        `    ${chalk.dim("~")} ${space.key} (${space.name}) already exists on server`,
      );
      summary.spacesExisting.push(space.key);
      config.spaces[key] = { id: "", key: space.key, name: space.name };
      await saveConfig(config, outputDir);
      continue;
    }

    if (dryRun) {
      console.log(
        `    ${chalk.dim("~")} ${space.key} (${space.name}) → would create`,
      );
      summary.spacesCreated.push(space.key);
      continue;
    }

    try {
      const created = await client.createSpace({
        key: space.key,
        name: space.name,
        description: {
          value: space.description,
          representation: "plain",
        },
      });
      config.spaces[key] = {
        id: String(created.id),
        key: created.key,
        name: created.name,
      };
      console.log(
        `    ${chalk.green("✓")} ${space.key} (${space.name})`,
      );
      summary.spacesCreated.push(space.key);
      await saveConfig(config, outputDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ${chalk.red("✗")} ${space.key}: ${msg}`);
      summary.spacesFailed.push(space.key);
    }
  }

  // Step 5: Final save
  if (!dryRun) {
    config.bootstrapCompleted = new Date().toISOString();
    await saveConfig(config, outputDir);
  }

  // Step 6: Summary
  printSummary(summary, dryRun ?? false, outputDir);
}

// ---- Helpers ----

async function loadExistingConfig(
  _outputDir: string,
): Promise<AtlassianConfig | null> {
  try {
    const data = await readFile(
      join(process.cwd(), "atlassian-config.json"),
      "utf-8",
    );
    return JSON.parse(data) as AtlassianConfig;
  } catch {
    return null;
  }
}

function createEmptyConfig(host: string): AtlassianConfig {
  return {
    host,
    users: {} as Record<PersonaId, AtlassianUserConfig>,
    projects: {} as Record<"DR" | "SUP", AtlassianProjectConfig>,
    spaces: {} as Record<SpaceKey, AtlassianSpaceConfig>,
    bootstrapCompleted: "",
  };
}

async function saveConfig(
  config: AtlassianConfig,
  _outputDir: string,
): Promise<void> {
  await writeFile(
    join(process.cwd(), "atlassian-config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

function printSummary(
  summary: BootstrapSummary,
  dryRun: boolean,
  _outputDir: string,
): void {
  const totalFailed =
    summary.usersFailed.length +
    summary.projectsFailed.length +
    summary.spacesFailed.length;

  console.log(chalk.bold("\n  Summary"));
  console.log(
    `    Users:    ${summary.usersCreated.length} created, ${summary.usersExisting.length} existing, ${summary.usersFailed.length} failed`,
  );
  console.log(
    `    Projects: ${summary.projectsCreated.length} created, ${summary.projectsExisting.length} existing, ${summary.projectsFailed.length} failed`,
  );
  console.log(
    `    Spaces:   ${summary.spacesCreated.length} created, ${summary.spacesExisting.length} existing, ${summary.spacesFailed.length} failed`,
  );

  if (!dryRun && totalFailed === 0) {
    console.log(
      chalk.dim(`\n  Config saved to atlassian-config.json`),
    );
    console.log(chalk.bold("\n  Next steps:"));
    console.log(
      "    1. Each of the 9 created users will receive an invitation email",
    );
    console.log("    2. Accept each invitation and set a password");
    console.log("    3. For each user, generate an API token at:");
    console.log(
      "       https://id.atlassian.com/manage-profile/security/api-tokens",
    );
    console.log(
      `    4. Edit atlassian-config.json and fill in the`,
    );
    console.log("       apiToken field for each user");
    console.log("    5. Run: npm run generate\n");
  } else if (totalFailed > 0) {
    console.log(
      chalk.yellow(`\n  ${totalFailed} operation(s) failed. Re-run to retry.\n`),
    );
  } else {
    console.log("");
  }
}
