#!/usr/bin/env npx tsx
/**
 * Integration test script for AtlassianWriter — makes real API calls.
 *
 * Usage:
 *   npx tsx scripts/test-atlassian-writer.ts
 *
 * Prerequisites:
 *   - atlassian-config.json in project root (from bootstrap)
 *   - At least one user (marcus) has a valid apiToken
 *
 * This creates real artifacts in your Atlassian site and cleans them up
 * at the end. If cleanup fails, look for items prefixed with "[TEST]".
 */

import { loadAtlassianConfig } from "../src/types/atlassian-config.js";
import { AtlassianWriter } from "../src/output/atlassian-writer.js";
import type { AtlassianConfig } from "../src/types/atlassian-config.js";
import type { JiraIssue, JiraComment } from "../src/types/jira.js";
import type { ConfluencePage, ConfluenceComment } from "../src/types/confluence.js";
import type { SimulationState } from "../src/types/simulation.js";
import type { AdfDocument } from "../src/utils/adf.js";

/** Raw fetch helper for cleanup (delete) calls — avoids needing public access to AtlassianClient.request */
async function atlassianDelete(config: AtlassianConfig, path: string): Promise<void> {
  const url = `${config.host}${path}`;
  const auth = "Basic " + Buffer.from(
    `${config.users.marcus.email}:${config.users.marcus.apiToken}`,
  ).toString("base64");

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`DELETE ${path} → ${res.status}: ${text}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function makeAdf(text: string): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function makeRichAdf(): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Test Heading" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "This is " },
          { type: "text", text: "bold text", marks: [{ type: "strong" }] },
          { type: "text", text: " and " },
          { type: "text", text: "italic text", marks: [{ type: "em" }] },
          { type: "text", text: "." },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First item" }] },
            ],
          },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Second item" }] },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [{ type: "text", text: "const x = 42;" }],
      },
    ],
  };
}

function makeMentionAdf(text: string, mentionId: string, mentionText: string): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `${text} ` },
          { type: "mention", attrs: { id: mentionId, text: mentionText, accessLevel: "" } },
          { type: "text", text: " can you take a look?" },
        ],
      },
    ],
  };
}

function emptyState(): SimulationState {
  return {
    currentDate: "2024-01-15",
    currentSprint: null,
    nextTicketNumber: { DR: 9000, SUP: 9000 },
    nextConfluenceId: 9000,
    tickets: {},
    recentActivity: {
      chad: [], vanessa: [], tammy: [], sasha: [], marcus: [],
      cooper: [], priya: [], raj: [], dana: [], tk: [],
    },
    metrics: {
      totalTicketsCreated: 0,
      totalCommentsAdded: 0,
      totalPagesCreated: 0,
      ticketsByStatus: {},
    },
    confluencePageIds: {},
    jiraIssueIds: {},
    sprintIds: {},
  };
}

const passed: string[] = [];
const failed: string[] = [];

function pass(name: string, detail?: string) {
  const msg = detail ? `${name}: ${detail}` : name;
  console.log(`  PASS  ${msg}`);
  passed.push(name);
}

function fail(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  FAIL  ${name}: ${msg}`);
  failed.push(name);
}

// ─── Cleanup tracking ────────────────────────────────────────────────

const createdIssueKeys: string[] = [];
const createdPageIds: string[] = [];
const createdSprintIds: string[] = [];

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading atlassian-config.json...");
  const config = await loadAtlassianConfig();
  console.log(`  Host: ${config.host}`);

  const writer = new AtlassianWriter(config);
  const state = emptyState();

  console.log("\nInitializing writer (discovering issue types)...");
  await writer.init(state);

  const persona = "marcus" as const;
  const now = new Date().toISOString();
  const tag = `[TEST-${Date.now()}]`;

  console.log(`\nTest tag: ${tag}`);
  console.log("━".repeat(60));

  // ── 1. Create Epic ───────────────────────────────────────────
  console.log("\n1. Create Jira Epic");
  let epicKey = "";
  try {
    const epic: JiraIssue = {
      key: "",
      project: "DR",
      type: "Epic",
      priority: "High",
      status: "To Do",
      summary: `${tag} Test Epic — Zombie Alert System`,
      description: makeAdf("Epic for testing the Atlassian writer integration."),
      reporter: "marcus",
      assignee: "marcus",
      labels: ["test", "integration"],
      components: [],
      created: now,
      updated: now,
      resolved: null,
      sprint: null,
      epicKey: null,
      parentKey: null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };
    const result = await writer.writeJiraIssue(epic, state, persona);
    epicKey = result.key!;
    createdIssueKeys.push(epicKey);
    pass("Create Epic", `key=${epicKey}, id=${result.id}`);
  } catch (err) {
    fail("Create Epic", err);
  }

  // ── 2. Create Story under Epic ──────────────────────────────
  console.log("\n2. Create Jira Story (child of Epic)");
  let storyKey = "";
  try {
    const story: JiraIssue = {
      key: "",
      project: "DR",
      type: "Story",
      priority: "Medium",
      status: "To Do",
      summary: `${tag} Test Story — Push notification endpoint`,
      description: makeRichAdf(),
      reporter: "marcus",
      assignee: "cooper",
      labels: ["test"],
      components: [],
      created: now,
      updated: now,
      resolved: null,
      sprint: null,
      epicKey: epicKey || null,
      parentKey: null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };
    const result = await writer.writeJiraIssue(story, state, persona);
    storyKey = result.key!;
    createdIssueKeys.push(storyKey);
    pass("Create Story", `key=${storyKey}, parent=${epicKey}`);
  } catch (err) {
    fail("Create Story", err);
  }

  // ── 3. Create Sub-task under Story ──────────────────────────
  console.log("\n3. Create Jira Sub-task (child of Story)");
  let subtaskKey = "";
  try {
    const subtask: JiraIssue = {
      key: "",
      project: "DR",
      type: "Sub-task",
      priority: "Low",
      status: "To Do",
      summary: `${tag} Test Sub-task — Write unit tests`,
      description: makeAdf("Write tests for the push notification endpoint."),
      reporter: "marcus",
      assignee: "priya",
      labels: ["test"],
      components: [],
      created: now,
      updated: now,
      resolved: null,
      sprint: null,
      epicKey: null,
      parentKey: storyKey || null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };
    const result = await writer.writeJiraIssue(subtask, state, persona);
    subtaskKey = result.key!;
    createdIssueKeys.push(subtaskKey);
    pass("Create Sub-task", `key=${subtaskKey}, parent=${storyKey}`);
  } catch (err) {
    fail("Create Sub-task", err);
  }

  // ── 4. Create Bug ───────────────────────────────────────────
  console.log("\n4. Create Jira Bug");
  let bugKey = "";
  try {
    const bug: JiraIssue = {
      key: "",
      project: "DR",
      type: "Bug",
      priority: "Highest",
      status: "To Do",
      summary: `${tag} Test Bug — Map pins disappear after zombie horde event`,
      description: makeAdf("When a horde event triggers, all safe-house pins vanish from the map layer."),
      reporter: "tk",
      assignee: "marcus",
      labels: ["test", "bug"],
      components: [],
      created: now,
      updated: now,
      resolved: null,
      sprint: null,
      epicKey: epicKey || null,
      parentKey: null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: null,
      slaBreached: null,
    };
    const result = await writer.writeJiraIssue(bug, state, persona);
    bugKey = result.key!;
    createdIssueKeys.push(bugKey);
    pass("Create Bug", `key=${bugKey}`);
  } catch (err) {
    fail("Create Bug", err);
  }

  // ── 5. Add comment to Story ─────────────────────────────────
  console.log("\n5. Add comment to Story");
  let commentId = "";
  if (storyKey) {
    try {
      const comment: JiraComment = {
        id: "",
        author: "cooper",
        body: makeAdf("Started looking at this — going to use WebSockets for real-time push. Will have a draft PR up tonight."),
        created: now,
        reactions: [],
      };
      const result = await writer.appendComment(storyKey, comment, state, "cooper");
      commentId = result.id || "";
      pass("Add comment", `commentId=${result.id} on ${storyKey}`);
    } catch (err) {
      fail("Add comment", err);
    }
  } else {
    fail("Add comment", "Skipped — no story key");
  }

  // ── 6. Transition Story to "In Progress" ────────────────────
  console.log("\n6. Transition Story status");
  if (storyKey) {
    try {
      await writer.updateJiraIssueStatus(storyKey, "In Progress", "marcus", now, state, persona);
      pass("Transition status", `${storyKey} → In Progress`);
    } catch (err) {
      fail("Transition status", err);
    }
  } else {
    fail("Transition status", "Skipped — no story key");
  }

  // ── 7. Read Story back ──────────────────────────────────────
  console.log("\n7. Read Jira issue");
  if (storyKey) {
    try {
      const issue = await writer.readJiraIssue(storyKey, state);
      if (!issue) throw new Error("readJiraIssue returned null");
      const checks = [
        issue.key === storyKey ? null : `key mismatch: ${issue.key}`,
        issue.type === "Story" ? null : `type mismatch: ${issue.type}`,
        issue.summary.includes(tag) ? null : `summary missing tag`,
        issue.status === "In Progress" ? null : `status=${issue.status}, expected "In Progress"`,
      ].filter(Boolean);
      if (checks.length > 0) {
        fail("Read issue", checks.join("; "));
      } else {
        pass("Read issue", `${storyKey}: type=${issue.type}, status=${issue.status}, comments=${issue.comments.length}`);
      }
    } catch (err) {
      fail("Read issue", err);
    }
  } else {
    fail("Read issue", "Skipped — no story key");
  }

  // ── 8. Create Confluence page ───────────────────────────────
  console.log("\n8. Create Confluence page");
  let pageTitle = "";
  try {
    pageTitle = `${tag} Test Page — Architecture Decision Record`;
    const page: ConfluencePage = {
      id: "",
      spaceKey: "ENG",
      title: pageTitle,
      author: "marcus",
      body: makeRichAdf(),
      parentTitle: null,
      labels: [],
      created: now,
      updated: now,
      comments: [],
      reactions: [],
      linkedJiraKeys: [],
    };
    const result = await writer.writeConfluencePage(page, persona);
    createdPageIds.push(result.id!);
    pass("Create page", `id=${result.id}, title="${pageTitle}"`);
  } catch (err) {
    fail("Create page", err);
  }

  // ── 9. Create child page ────────────────────────────────────
  console.log("\n9. Create Confluence child page");
  let childTitle = "";
  if (pageTitle) {
    try {
      childTitle = `${tag} Test Child — API Design Notes`;
      const child: ConfluencePage = {
        id: "",
        spaceKey: "ENG",
        title: childTitle,
        author: "priya",
        body: makeAdf("Notes on the REST API design for the zombie alert endpoint."),
        parentTitle: pageTitle,
        labels: [],
        created: now,
        updated: now,
        comments: [],
        reactions: [],
        linkedJiraKeys: [],
      };
      const result = await writer.writeConfluencePage(child, "priya");
      createdPageIds.push(result.id!);
      pass("Create child page", `id=${result.id}, parent="${pageTitle}"`);
    } catch (err) {
      fail("Create child page", err);
    }
  } else {
    fail("Create child page", "Skipped — no parent page");
  }

  // ── 10. Add Confluence page comment ─────────────────────────
  console.log("\n10. Add Confluence page comment");
  if (pageTitle) {
    try {
      const comment: ConfluenceComment = {
        id: "",
        author: "raj",
        body: makeAdf("Nice write-up. Should we add a section on rate limiting for the horde-event webhook?"),
        created: now,
      };
      const result = await writer.appendConfluenceComment("ENG", pageTitle, comment, "raj");
      pass("Add page comment", `commentId=${result.id} on "${pageTitle}"`);
    } catch (err) {
      fail("Add page comment", err);
    }
  } else {
    fail("Add page comment", "Skipped — no page");
  }

  // ── 11. Read Confluence page back ───────────────────────────
  console.log("\n11. Read Confluence page");
  if (pageTitle) {
    try {
      const page = await writer.readConfluencePage("ENG", pageTitle);
      if (!page) throw new Error("readConfluencePage returned null");
      const checks = [
        page.title === pageTitle ? null : `title mismatch: "${page.title}"`,
        page.spaceKey === "ENG" ? null : `spaceKey mismatch: ${page.spaceKey}`,
      ].filter(Boolean);
      if (checks.length > 0) {
        fail("Read page", checks.join("; "));
      } else {
        pass("Read page", `id=${page.id}, title="${page.title}"`);
      }
    } catch (err) {
      fail("Read page", err);
    }
  } else {
    fail("Read page", "Skipped — no page");
  }

  // ── 12. Create SUP (JSM) ticket ────────────────────────────
  console.log("\n12. Create JSM support ticket");
  try {
    const supTicket: JiraIssue = {
      key: "",
      project: "SUP",
      type: "Task",
      priority: "High",
      status: "To Do",
      summary: `${tag} Test SUP — User reports zombie spawning inside safe zone`,
      description: makeAdf("A user reported that zombies are appearing inside the designated safe zone on the map."),
      reporter: "tk",
      assignee: "tk",
      labels: ["test", "support"],
      components: [],
      created: now,
      updated: now,
      resolved: null,
      sprint: null,
      epicKey: null,
      parentKey: null,
      linkedIssues: [],
      comments: [],
      statusHistory: [],
      storyPoints: null,
      customerEmail: "survivor@deadroute.test",
      slaBreached: false,
    };
    const result = await writer.writeJiraIssue(supTicket, state, "tk");
    createdIssueKeys.push(result.key!);
    pass("Create SUP ticket", `key=${result.key}`);
  } catch (err) {
    fail("Create SUP ticket", err);
  }

  // ── 13. Start a sprint ───────────────────────────────────────
  console.log("\n13. Start sprint");
  const sprintName = `TST-${Date.now() % 100000}`;
  try {
    // Put sprint info into state so startSprint can use dates/goal
    state.currentSprint = {
      name: sprintName,
      goal: "Test sprint goal — verify Agile API integration",
      state: "active",
      startDate: now,
      endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await writer.startSprint(sprintName, state, persona);
    // Sync internal maps to state so we can read back the sprint ID
    writer.syncToState(state);
    const sprintId = state.sprintIds?.[sprintName];
    if (sprintId) createdSprintIds.push(sprintId);
    pass("Start sprint", `"${sprintName}" (id=${sprintId})`);
  } catch (err) {
    fail("Start sprint", err);
  }

  // ── 14. Move issues to sprint ───────────────────────────────
  console.log("\n14. Move issues to sprint");
  const sprintIssues = [storyKey, bugKey].filter(Boolean);
  if (sprintIssues.length > 0 && state.sprintIds?.[sprintName]) {
    try {
      await writer.moveToSprint(sprintIssues, sprintName, state, persona);
      pass("Move to sprint", `${sprintIssues.join(", ")} → "${sprintName}"`);
    } catch (err) {
      fail("Move to sprint", err);
    }
  } else {
    fail("Move to sprint", "Skipped — no issues or no sprint");
  }

  // ── 15. Move issues to backlog ──────────────────────────────
  console.log("\n15. Move issues to backlog");
  if (bugKey) {
    try {
      await writer.moveToBacklog([bugKey], state, persona);
      pass("Move to backlog", `${bugKey} → backlog`);
    } catch (err) {
      fail("Move to backlog", err);
    }
  } else {
    fail("Move to backlog", "Skipped — no bug key");
  }

  // ── 16. Close sprint ────────────────────────────────────────
  console.log("\n16. Close sprint");
  if (state.sprintIds?.[sprintName]) {
    try {
      await writer.closeSprint(sprintName, state, persona);
      pass("Close sprint", `"${sprintName}"`);
    } catch (err) {
      fail("Close sprint", err);
    }
  } else {
    fail("Close sprint", "Skipped — no sprint");
  }

  // ── 17. React to Jira comment ────────────────────────────────
  console.log("\n17. React to Jira comment");
  if (storyKey && commentId) {
    try {
      await writer.addReactionToComment(storyKey, commentId, ":thumbsup:", "marcus", state, persona);
      pass("React to comment", `thumbsup on comment ${commentId} (${storyKey})`);
    } catch (err) {
      fail("React to comment", err);
    }
  } else {
    fail("React to comment", `Skipped — storyKey=${storyKey || "(none)"}, commentId=${commentId || "(none)"}`);
  }

  // ── 18. React to Confluence page ────────────────────────────
  console.log("\n18. React to Confluence page");
  if (pageTitle) {
    try {
      await writer.addReactionToPage("ENG", pageTitle, "❤️", "cooper", "cooper");
      pass("React to page", `heart on "${pageTitle}"`);
    } catch (err) {
      fail("React to page", err);
    }
  } else {
    fail("React to page", "Skipped — no page");
  }

  // ── 19. Edit Jira issue description ──────────────────────────
  console.log("\n19. Edit Jira issue description");
  if (storyKey) {
    try {
      const newDesc = makeAdf("UPDATED: Push notification endpoint — now using Server-Sent Events instead of WebSockets for better mobile battery life.");
      const newSummary = `${tag} Test Story — SSE notification endpoint (EDITED)`;
      await writer.updateIssueDescription(storyKey, newDesc, newSummary, now, state, persona);
      // Verify the edit by reading it back
      const updated = await writer.readJiraIssue(storyKey, state);
      if (!updated) throw new Error("readJiraIssue returned null after edit");
      const checks = [
        updated.summary.includes("EDITED") ? null : `summary not updated: "${updated.summary}"`,
      ].filter(Boolean);
      if (checks.length > 0) {
        fail("Edit issue description", checks.join("; "));
      } else {
        pass("Edit issue description", `${storyKey}: summary="${updated.summary}"`);
      }
    } catch (err) {
      fail("Edit issue description", err);
    }
  } else {
    fail("Edit issue description", "Skipped — no story key");
  }

  // ── 20. Edit Confluence page body ─────────────────────────────
  console.log("\n20. Edit Confluence page body");
  if (pageTitle) {
    try {
      const newBody = makeAdf("UPDATED: This ADR has been revised. We are switching from REST to GraphQL for the zombie alert API.");
      await writer.updateConfluencePageBody("ENG", pageTitle, newBody, now, persona);
      // Verify the edit by reading it back
      const updated = await writer.readConfluencePage("ENG", pageTitle);
      if (!updated) throw new Error("readConfluencePage returned null after edit");
      pass("Edit page body", `"${pageTitle}" updated successfully (id=${updated.id})`);
    } catch (err) {
      fail("Edit page body", err);
    }
  } else {
    fail("Edit page body", "Skipped — no page");
  }

  // ── 21. Add comment with @mention ───────────────────────────
  console.log("\n21. Add comment with @mention");
  if (storyKey) {
    try {
      const cooperAccountId = config.users.cooper?.accountId;
      if (!cooperAccountId) throw new Error("No accountId for cooper in config");
      const mentionBody = makeMentionAdf(
        "Hey",
        cooperAccountId,
        `@${config.users.cooper.displayName}`,
      );
      const mentionComment: JiraComment = {
        id: "",
        author: "marcus",
        body: mentionBody,
        created: now,
        reactions: [],
      };
      const result = await writer.appendComment(storyKey, mentionComment, state, persona);
      pass("Add comment with mention", `commentId=${result.id} on ${storyKey}, mentioned cooper (${cooperAccountId})`);
    } catch (err) {
      fail("Add comment with mention", err);
    }
  } else {
    fail("Add comment with mention", "Skipped — no story key");
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log("\n" + "━".repeat(60));
  console.log(`\nResults: ${passed.length} passed, ${failed.length} failed out of ${passed.length + failed.length} tests\n`);

  if (failed.length > 0) {
    console.log("Failed tests:");
    for (const f of failed) {
      console.log(`  - ${f}`);
    }
    console.log();
  }

  // ── Cleanup ─────────────────────────────────────────────────
  console.log("Cleaning up test artifacts...");

  // Delete sprints
  for (const sprintId of createdSprintIds) {
    try {
      await atlassianDelete(config, `/rest/agile/1.0/sprint/${sprintId}`);
      console.log(`  Deleted sprint ${sprintId}`);
    } catch (err) {
      console.error(`  Failed to delete sprint ${sprintId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Delete Confluence pages (children first)
  for (const pageId of createdPageIds.reverse()) {
    try {
      await atlassianDelete(config, `/wiki/api/v2/pages/${pageId}`);
      console.log(`  Deleted page ${pageId}`);
    } catch (err) {
      console.error(`  Failed to delete page ${pageId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Delete Jira issues (sub-tasks first, then stories, then epics)
  for (const key of createdIssueKeys.reverse()) {
    try {
      await atlassianDelete(config, `/rest/api/3/issue/${key}`);
      console.log(`  Deleted issue ${key}`);
    } catch (err) {
      console.error(`  Failed to delete issue ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nDone.");
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});