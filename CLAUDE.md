# DeadRoute — AI-Powered Atlassian Sample Data Generator

## What This Is

DeadRoute generates ~5,000 realistic Jira tickets and ~100-200 Confluence pages for a fictional zombie-apocalypse startup ("Waze for the zombie apocalypse"). It runs a day-by-day simulation across 250 working days where AI agents roleplay as 10 team members, producing in-character artifacts with narrative continuity.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in ANTHROPIC_API_KEY and OPENAI_API_KEY
npm run build           # TypeScript compilation
npm run generate        # Run the simulation
```

## Commands

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit (type check only)
npm run lint           # eslint src/
npm run generate       # Full 250-day simulation
npm run dev            # tsx src/index.ts (dev mode)
```

### CLI Options

```bash
npm run generate -- --days 10        # Simulate only 10 days
npm run generate -- --from-day 50    # Resume from day 50
npm run generate -- --dry-run        # Plan only, no AI generation
```

## Architecture

### Simulation Loop (engine.ts)

Each working day:
1. **Master Planner** (Claude Sonnet) receives rolling 5-day summary + sprint context + narrative beats → outputs a `DayPlan` with 5-15 activities
2. **Persona Agents** (Claude Haiku via Agent SDK MCP tools) execute each activity in-character using tools: `create_jira_ticket`, `add_comment`, `transition_ticket`, `create_confluence_page`, `summarize_day`
3. **Reaction Pass** — other personas react to new artifacts (round-robin conversations, max 3 rounds)
4. **State saved** — simulation is resumable from any day

### Key Components

| File | Purpose |
|------|---------|
| `src/simulation/engine.ts` | Main day-by-day loop |
| `src/agents/master-planner.ts` | Daily planning (raw Anthropic SDK, Sonnet) |
| `src/agents/persona-agent.ts` | In-character execution (Agent SDK + MCP tools, Haiku) |
| `src/rag/context-builder.ts` | Persona-specific context assembly with awareness maps |
| `src/simulation/state.ts` | Persistent state (tickets, metrics, activity history) |
| `src/simulation/reactions.ts` | Multi-round reaction conversations |
| `src/output/writer.ts` | Hierarchical JSON file output |
| `src/narrative/spine.ts` | Narrative beat loader (120 plot beats across 52 weeks) |
| `src/narrative/sprint-calendar.ts` | 26 two-week sprints with ceremonies |
| `src/personas/profiles.ts` | 10 persona profiles with writing styles and quirks |
| `src/simulation/token-tracker.ts` | Token counting and cost estimation |

### Agent Architecture

- **Master Planner**: Uses raw `@anthropic-ai/sdk` with JSON output parsing. Accepts a rolling multi-day summary (last 5 days) for narrative continuity.
- **Persona Agents**: Uses `@anthropic-ai/claude-agent-sdk` with `createSdkMcpServer()` and `tool()` for in-process MCP tools. The SDK manages the tool loop automatically. Tools require streaming input mode (async generator for prompt). Custom tools populate a `PersonaResult` via closure.

### Context System

Each persona gets a role-specific "view" of the world:
- **AWARENESS_MAP** in `context-builder.ts` defines which teammates each role sees
- CEO sees only epics/stories (high-level), devs see technical tickets, PM sees everything
- Close collaborators get 5 recent activities, distant ones get 3
- RAG (Vectra + OpenAI embeddings) provides semantic search for relevant past artifacts

## Type System

- **PersonaId**: `"chad" | "vanessa" | "tammy" | "sasha" | "marcus" | "cooper" | "priya" | "raj" | "dana" | "tk"`
- **Jira Projects**: `"DR"` (software dev), `"SUP"` (customer support/JSM)
- **Confluence Spaces**: `"PROD"` | `"ENG"` | `"OPS"` | `"MKT"`
- **Issue Types**: Epic, Story, Task, Bug, Sub-task
- **Issue Statuses**: To Do, In Progress, In Review, Done, Won't Do

## Output Structure

```
output/
├── jira/
│   ├── DR/           # Hierarchical: epic → story → sub-task
│   └── SUP/          # Flat structure for support tickets
├── confluence/
│   ├── PROD/         # Parent pages are directories
│   ├── ENG/
│   ├── OPS/
│   └── MKT/
├── state.json        # Simulation state (resumable)
├── token-report.json # Token usage + cost breakdown
└── vectra/           # RAG vector database
```

## Conventions

- All generated content is **in-character** — personas have distinct voices, quirks, writing styles
- ES modules throughout (`import`/`export`, `.js` extensions in imports)
- Strict TypeScript (ES2022 target, NodeNext modules)
- Types defined in `src/types/` before implementation
- State mutations go through `StateManager` (single source of truth)
- Ticket keys: `DR-123` or `SUP-456`; page IDs: `page-123`
- All I/O is async; concurrency controlled via `p-limit`
- No database — all persistence is JSON files on disk

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Agent SDK with in-process MCP tools (persona agents)
- `@anthropic-ai/sdk` — Raw Claude API (master planner)
- `@modelcontextprotocol/sdk` — MCP protocol types
- `vectra` — File-backed local vector database for RAG
- `openai` — Embeddings for Vectra (text-embedding-3-small)
- `zod` — Schema validation for MCP tool definitions
- `date-fns`, `chalk`, `commander`, `p-limit`, `dotenv`

## The 10 Personas

| ID | Name | Role | Key Trait |
|----|------|------|-----------|
| `chad` | Chad Blackwell | CEO/Founder | 2AM idea bursts, buzzword misuse, no acceptance criteria |
| `vanessa` | Vanessa Moreau | Head of Marketing | "USERS ARE SAYING...", knows NPS to 1 decimal |
| `tammy` | Tammy Clearwater | HR/Office Manager | Perfectly formatted tickets, apocalypse cornbread |
| `sasha` | Sasha Kim | Product Manager | Defers to "Phase 2", over-organizes, imposter syndrome |
| `marcus` | Marcus Chen | Dev Lead/CTO | Talks to server "Hershel", reviews every PR |
| `cooper` | Cooper Hayes | Frontend Dev | 22, sleeps at office, "stuff" commits, talented |
| `priya` | Priya Patel | Backend Dev | "Things I Learned" posts, de facto DBA |
| `raj` | Raj Okonkwo | Full-Stack Dev | Pushes "proper" practices, tension with Cooper |
| `dana` | Dana Reeves | Mobile Dev/Designer | Quiet, communicates via annotated screenshots |
| `tk` | TK Vasquez | Support Engineer | Former mechanic, "marking critical because DEATH" |

## Narrative Spine

`data/narrative-spine.json` contains 120 plot beats across 52 weeks driving the dramatic arc. Each beat specifies involved personas and expected artifact types. The master planner incorporates beats for the current week into its daily plans.

## Sprint Structure

26 two-week sprints. Ceremonies: Planning (day 1), Review + Retro (day 11). Sprint velocity is realistic (60-80% completion, carryover, stale tickets, reopened bugs).
