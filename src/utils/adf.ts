/**
 * ADF (Atlassian Document Format) utilities.
 *
 * - Simplified Zod schema for LLM tool parameters (practical subset)
 * - Text extraction from ADF for RAG, display, and pattern matching
 * - Convenience helpers
 */

import { z } from "zod";

// ─── TypeScript Interfaces ──────────────────────────────────────────

export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

// ─── Simplified Zod Schema (for tool parameters) ────────────────────

// Text marks — inline formatting applied to text nodes
const markSchema = z.object({
  type: z.enum(["strong", "em", "code", "strike", "underline", "link", "subsup", "textColor"]),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

// Text node — leaf node containing actual text content
const textNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  marks: z.array(markSchema).optional(),
});

// Mention node — @mention of a user
const mentionNodeSchema = z.object({
  type: z.literal("mention"),
  attrs: z.object({
    id: z.string(),
    text: z.string().optional(),
    accessLevel: z.string().optional(),
  }),
});

// Emoji node
const emojiNodeSchema = z.object({
  type: z.literal("emoji"),
  attrs: z.object({
    shortName: z.string(),
    text: z.string().optional(),
  }),
});

// Status node — colored status lozenge
const statusNodeSchema = z.object({
  type: z.literal("status"),
  attrs: z.object({
    text: z.string(),
    color: z.enum(["neutral", "purple", "blue", "red", "yellow", "green"]),
  }),
});

// Hard break
const hardBreakNodeSchema = z.object({
  type: z.literal("hardBreak"),
});

// Date node
const dateNodeSchema = z.object({
  type: z.literal("date"),
  attrs: z.object({
    timestamp: z.string(),
  }),
});

// Inline card (e.g., Jira issue link)
const inlineCardNodeSchema = z.object({
  type: z.literal("inlineCard"),
  attrs: z.object({
    url: z.string(),
  }),
});

// Union of all inline node types
const inlineNodeSchema = z.discriminatedUnion("type", [
  textNodeSchema,
  mentionNodeSchema,
  emojiNodeSchema,
  statusNodeSchema,
  hardBreakNodeSchema,
  dateNodeSchema,
  inlineCardNodeSchema,
]);

// ─── Block Nodes ────────────────────────────────────────────────────

// Paragraph
const paragraphNodeSchema = z.object({
  type: z.literal("paragraph"),
  content: z.array(inlineNodeSchema).optional(),
});

// Heading (levels 1-6)
const headingNodeSchema = z.object({
  type: z.literal("heading"),
  attrs: z.object({
    level: z.number().min(1).max(6),
  }),
  content: z.array(inlineNodeSchema).optional(),
});

// Code block
const codeBlockNodeSchema = z.object({
  type: z.literal("codeBlock"),
  attrs: z.object({
    language: z.string().optional(),
  }).optional(),
  content: z.array(z.object({
    type: z.literal("text"),
    text: z.string(),
  })).optional(),
});

// Blockquote
const blockquoteNodeSchema = z.object({
  type: z.literal("blockquote"),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

// Horizontal rule
const ruleNodeSchema = z.object({
  type: z.literal("rule"),
});

// Panel (info, note, warning, error, success)
const panelNodeSchema = z.object({
  type: z.literal("panel"),
  attrs: z.object({
    panelType: z.enum(["info", "note", "tip", "warning", "error", "success"]),
  }),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

// List item
const listItemNodeSchema = z.object({
  type: z.literal("listItem"),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

// Bullet list
const bulletListNodeSchema = z.object({
  type: z.literal("bulletList"),
  content: z.array(listItemNodeSchema).min(1),
});

// Ordered list
const orderedListNodeSchema = z.object({
  type: z.literal("orderedList"),
  attrs: z.object({
    order: z.number().optional(),
  }).optional(),
  content: z.array(listItemNodeSchema).min(1),
});

// Task item
const taskItemNodeSchema = z.object({
  type: z.literal("taskItem"),
  attrs: z.object({
    localId: z.string(),
    state: z.enum(["TODO", "DONE"]),
  }),
  content: z.array(inlineNodeSchema).optional(),
});

// Task list
const taskListNodeSchema = z.object({
  type: z.literal("taskList"),
  attrs: z.object({
    localId: z.string(),
  }),
  content: z.array(taskItemNodeSchema).min(1),
});

// Decision item
const decisionItemNodeSchema = z.object({
  type: z.literal("decisionItem"),
  attrs: z.object({
    localId: z.string(),
    state: z.string(),
  }),
  content: z.array(inlineNodeSchema).optional(),
});

// Decision list
const decisionListNodeSchema = z.object({
  type: z.literal("decisionList"),
  attrs: z.object({
    localId: z.string(),
  }),
  content: z.array(decisionItemNodeSchema).min(1),
});

// Table cell / header
const tableCellNodeSchema = z.object({
  type: z.literal("tableCell"),
  attrs: z.object({
    colspan: z.number().optional(),
    rowspan: z.number().optional(),
    colwidth: z.array(z.number()).optional(),
    background: z.string().optional(),
  }).optional(),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

const tableHeaderNodeSchema = z.object({
  type: z.literal("tableHeader"),
  attrs: z.object({
    colspan: z.number().optional(),
    rowspan: z.number().optional(),
    colwidth: z.array(z.number()).optional(),
    background: z.string().optional(),
  }).optional(),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

// Table row
const tableRowNodeSchema = z.object({
  type: z.literal("tableRow"),
  content: z.array(z.union([tableCellNodeSchema, tableHeaderNodeSchema])),
});

// Table
const tableNodeSchema = z.object({
  type: z.literal("table"),
  attrs: z.object({
    isNumberColumnEnabled: z.boolean().optional(),
    layout: z.enum(["default", "wide", "full-width"]).optional(),
  }).optional(),
  content: z.array(tableRowNodeSchema).min(1),
});

// Expand (collapsible section)
const expandNodeSchema = z.object({
  type: z.literal("expand"),
  attrs: z.object({
    title: z.string().optional(),
  }).optional(),
  content: z.array(z.lazy(() => blockNodeSchema)).min(1),
});

// Union of all block node types
const blockNodeSchema: z.ZodTypeAny = z.discriminatedUnion("type", [
  paragraphNodeSchema,
  headingNodeSchema,
  codeBlockNodeSchema,
  blockquoteNodeSchema,
  ruleNodeSchema,
  panelNodeSchema,
  bulletListNodeSchema,
  orderedListNodeSchema,
  taskListNodeSchema,
  decisionListNodeSchema,
  tableNodeSchema,
  expandNodeSchema,
]);

// ─── Root Document Schema ───────────────────────────────────────────

/**
 * Simplified ADF document schema for use as tool parameters.
 * Covers the practical subset of ADF that LLMs would produce.
 */
export const adfToolSchema = z.object({
  version: z.literal(1),
  type: z.literal("doc"),
  content: z.array(blockNodeSchema).min(1),
}).describe("Atlassian Document Format (ADF) document.");

// ─── Text Extraction ────────────────────────────────────────────────

/**
 * Recursively extract all plain text from an ADF document.
 *
 * Handles backward compatibility: if input is a string, returns it as-is.
 * If input is not a valid ADF structure, returns empty string.
 */
export function extractTextFromAdf(adf: unknown): string {
  // Backward compat — handle legacy string content
  if (typeof adf === "string") return adf;
  if (!adf || typeof adf !== "object") return "";

  const doc = adf as Record<string, unknown>;
  if (!Array.isArray(doc.content)) return "";

  const parts: string[] = [];
  extractFromNodes(doc.content as AdfNode[], parts);
  return parts.join("\n").trim();
}

function extractFromNodes(nodes: AdfNode[], parts: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        if (node.text) parts.push(node.text);
        break;
      case "hardBreak":
        parts.push("\n");
        break;
      case "mention":
        parts.push((node.attrs?.text as string) || `@${node.attrs?.id || "unknown"}`);
        break;
      case "emoji":
        parts.push((node.attrs?.text as string) || (node.attrs?.shortName as string) || "");
        break;
      case "status":
        parts.push(`[${node.attrs?.text || ""}]`);
        break;
      case "date":
        parts.push((node.attrs?.timestamp as string) || "");
        break;
      case "inlineCard":
        parts.push((node.attrs?.url as string) || "");
        break;
      case "paragraph":
      case "heading":
      case "blockquote":
      case "listItem":
      case "taskItem":
      case "decisionItem":
      case "tableCell":
      case "tableHeader":
      case "panel":
      case "expand":
        if (node.content) {
          extractFromNodes(node.content, parts);
        }
        parts.push("\n");
        break;
      case "bulletList":
      case "orderedList":
      case "taskList":
      case "decisionList":
      case "table":
      case "tableRow":
        if (node.content) {
          extractFromNodes(node.content, parts);
        }
        break;
      case "codeBlock":
        if (node.content) {
          for (const child of node.content) {
            if (child.text) parts.push(child.text);
          }
        }
        parts.push("\n");
        break;
      case "rule":
        parts.push("\n---\n");
        break;
      default:
        // Unknown node type — try to extract content recursively
        if (node.content) {
          extractFromNodes(node.content, parts);
        }
        break;
    }
  }
}

// ─── Convenience Helpers ────────────────────────────────────────────

/**
 * Wrap plain text in a minimal ADF document with a single paragraph.
 */
export function textToAdf(text: string): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}
