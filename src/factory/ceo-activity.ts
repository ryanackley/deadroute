/**
 * CEO activity hunter — finds everything the human CEO wrote across
 * Confluence and Jira since the last sprint, for the PM to synthesize.
 *
 * The digest is a starting point, not the whole story: the PM agent also
 * has search tools and is mandated to hunt further on its own.
 */

import type { AtlassianClient } from "../bootstrap/atlassian-client.js";
import type { CEOActivityDigest, CEOActivityItem } from "../types/factory.js";
import { extractTextFromAdf } from "../utils/adf.js";

export async function buildCEOActivityDigest(
  client: AtlassianClient,
  ceoAccountId: string,
  since: string | null,
): Promise<CEOActivityDigest> {
  const items: CEOActivityItem[] = [];
  const sinceDate = since ? since.slice(0, 10) : null;

  // ── Confluence pages the CEO created or contributed to ──
  try {
    const cql =
      `type = page AND contributor = "${ceoAccountId}"` +
      (sinceDate ? ` AND lastmodified >= "${sinceDate}"` : "") +
      ` ORDER BY lastmodified DESC`;
    const { results } = await client.searchConfluence(cql, 20);
    for (const r of results) {
      if (!r.content?.id) continue;
      let text = r.excerpt || "";
      try {
        const page = await client.getPage(r.content.id);
        const adfValue = page.body?.atlas_doc_format?.value;
        if (adfValue) text = extractTextFromAdf(JSON.parse(adfValue));
      } catch {
        // keep excerpt fallback
      }
      items.push({
        source: "confluence_page",
        ref: r.content.id,
        title: r.content.title,
        text: text.slice(0, 6000),
        updatedAt: r.lastModified || "",
      });
    }
  } catch (err) {
    console.warn(`  CEO Confluence page search failed: ${err}`);
  }

  // ── Confluence comments by the CEO ──
  try {
    const cql =
      `type = comment AND creator = "${ceoAccountId}"` +
      (sinceDate ? ` AND created >= "${sinceDate}"` : "") +
      ` ORDER BY created DESC`;
    const { results } = await client.searchConfluence(cql, 20);
    for (const r of results) {
      items.push({
        source: "confluence_comment",
        ref: r.content?.id || "",
        title: r.content?.title || r.title || "comment",
        text: (r.excerpt || "").replace(/@@@\w+@@@/g, "").slice(0, 2000),
        updatedAt: r.lastModified || "",
      });
    }
  } catch (err) {
    console.warn(`  CEO Confluence comment search failed: ${err}`);
  }

  // ── Jira issues the CEO reported ──
  try {
    const jql =
      `reporter = "${ceoAccountId}"` +
      (sinceDate ? ` AND updated >= "${sinceDate}"` : "") +
      ` ORDER BY updated DESC`;
    const { issues } = await client.searchIssues(jql, { maxResults: 25 });
    for (const issue of issues) {
      const f = issue.fields as Record<string, any>;
      const desc = f.description ? extractTextFromAdf(f.description) : "";
      items.push({
        source: "jira_issue",
        ref: issue.key,
        title: f.summary || "",
        text: desc.slice(0, 4000),
        updatedAt: f.updated || "",
      });
    }
  } catch (err) {
    console.warn(`  CEO Jira issue search failed: ${err}`);
  }

  // ── Jira comments by the CEO (on recently-updated issues) ──
  try {
    const jql =
      `project = DR` + (sinceDate ? ` AND updated >= "${sinceDate}"` : ` AND updated >= -30d`) +
      ` ORDER BY updated DESC`;
    const { issues } = await client.searchIssues(jql, { maxResults: 30, fields: ["summary"] });
    for (const issue of issues) {
      try {
        const { comments } = await client.getIssueComments(issue.key, 20);
        for (const c of comments) {
          if (c.author.accountId !== ceoAccountId) continue;
          if (since && c.created < since) continue;
          const f = issue.fields as Record<string, any>;
          items.push({
            source: "jira_comment",
            ref: issue.key,
            title: f.summary || issue.key,
            text: extractTextFromAdf(c.body).slice(0, 2000),
            updatedAt: c.created,
          });
        }
      } catch {
        // skip issues whose comments can't be read
      }
    }
  } catch (err) {
    console.warn(`  CEO Jira comment search failed: ${err}`);
  }

  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { since, items };
}

export function formatCEODigest(digest: CEOActivityDigest): string {
  if (digest.items.length === 0) {
    return (
      "No CEO-authored content found" +
      (digest.since ? ` since ${digest.since}` : "") +
      ". Use your search tools to hunt more broadly (older pages, different spaces) — requirements may predate the search window."
    );
  }

  const sections = digest.items.map((item) => {
    const label = {
      confluence_page: "CONFLUENCE PAGE",
      confluence_comment: "CONFLUENCE COMMENT on",
      jira_issue: "JIRA ISSUE",
      jira_comment: "JIRA COMMENT on",
    }[item.source];
    return `### ${label} "${item.title}" (${item.ref})${item.updatedAt ? ` — ${item.updatedAt}` : ""}\n${item.text}`;
  });

  return (
    `CEO-authored content${digest.since ? ` since ${digest.since}` : ""} (newest first):\n\n` +
    sections.join("\n\n")
  );
}
