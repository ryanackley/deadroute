/**
 * Bootstrap CLI command — provisions an Atlassian Cloud site with users,
 * Jira projects, and Confluence spaces for DeadRoute.
 */

import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { runBootstrap } from "./provisioner.js";

loadDotenv();

export function registerBootstrapCommand(program: Command): void {
  program
    .command("bootstrap")
    .description(
      "Provision Atlassian Cloud site with users, projects, and spaces",
    )
    .option(
      "--host <url>",
      "Atlassian Cloud site URL (e.g., https://your-site.atlassian.net)",
      process.env.ATLASSIAN_HOST,
    )
    .option(
      "--admin-email <email>",
      "Admin user email",
      process.env.ATLASSIAN_ADMIN_EMAIL,
    )
    .option(
      "--admin-token <token>",
      "Admin API token",
      process.env.ATLASSIAN_ADMIN_API_TOKEN,
    )
    .option("--output-dir <dir>", "Output directory", "./output")
    .option("--dry-run", "Show what would be created without making API calls")
    .action(async (options) => {
      const host = options.host;
      const adminEmail = options.adminEmail;
      const adminToken = options.adminToken;

      if (!host || !adminEmail || !adminToken) {
        const missing: string[] = [];
        if (!host) missing.push("--host (or ATLASSIAN_HOST)");
        if (!adminEmail)
          missing.push("--admin-email (or ATLASSIAN_ADMIN_EMAIL)");
        if (!adminToken)
          missing.push("--admin-token (or ATLASSIAN_ADMIN_API_TOKEN)");
        console.error(`Missing required options: ${missing.join(", ")}`);
        process.exit(1);
      }

      await runBootstrap({
        host,
        adminEmail,
        adminApiToken: adminToken,
        outputDir: resolve(options.outputDir),
        dryRun: options.dryRun,
      });
    });
}
