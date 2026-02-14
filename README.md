# Pi Subagent

**Delegate tasks to specialized subagents with isolated context windows.**

## Why Pi Subagent

**Specialization** — Use tailored agents for specific tasks like refactoring, documentation, or research.

**Isolated Context** — Each subagent runs in its own process with its own context, preventing the main agent's context from becoming cluttered.

**Parallel Execution** — Run multiple agents at once.

## Install

### Option 1: Install via Pi

```bash
pi install git:github.com/mjakl/pi-subagent
```

### Option 2: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/mjakl/pi-subagent.git
cd pi-subagent
npm install
```

## Configuration

### Subagent Definitions

Subagents are defined as Markdown files with YAML frontmatter.

**User Agents:** `~/.pi/agent/agents/*.md`
**Project Agents:** `.pi/agents/*.md` (requires `agentScope: "both"`)

Example agent (`~/.pi/agent/agents/writer.md`):

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
tools: read, write
---
You are an expert technical writer. Your task is to improve the clarity and conciseness of the provided text.
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Agent identifier used in tool calls (must match exactly) |
| `description` | Yes | — | What the agent does (shown to the main agent) |
| `model` | No | Uses the default pi model | Overrides the model for this agent (e.g. `anthropic/claude-3-5-sonnet`) |
| `tools` | No | `read,bash,edit,write` | Comma-separated list of **built-in** tools to enable for this agent. If omitted, defaults apply. |

Notes:
- `tools` only controls built-in tools. Extension tools remain available unless extensions are disabled.
- The Markdown body below the frontmatter becomes the agent's system prompt and is **appended** to Pi's default system prompt (it does **not** replace it).

## Usage

### Single Task

```typescript
subagent({
  agent: "writer",
  task: "Rewrite the README.md to be more professional."
})
```

### Parallel Tasks

```typescript
subagent({
  tasks: [
    { agent: "tester", task: "Write unit tests for index.ts" },
    { agent: "writer", task: "Document the API in index.ts" }
  ]
})
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | string | Name of the agent (single mode) |
| `task` | string | Task description (single mode) |
| `tasks` | array | List of `{agent, task, cwd?}` for parallel execution |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | Where to look for agents. Default: `"user"` |
| `confirmProjectAgents` | boolean | Prompt before running project-local agents. Default: `true` |
| `cwd` | string | Working directory override (single mode) |

## How Communication Works

### The Isolation Model

Each subagent runs as a **completely isolated process**:
- ❌ Cannot see the main agent's conversation history
- ❌ Cannot see other subagents' work
- ❌ Cannot access shared memory or state
- ✅ Receives only: its system prompt (from the .md file) + your task string
- ✅ Has its own fresh context window

### What Gets Sent to Subagents

When you call `subagent({ agent: "writer", task: "Document the API" })`, the subagent receives:

```
[System Prompt from ~/.pi/agent/agents/writer.md]

User: Task: Document the API
```

Nothing else. No file contents, no conversation history, no prior context. **You must include all necessary context in the task string itself** (file paths, requirements, code snippets).

### What Comes Back to the Main Agent

| Data | Main Agent Sees | TUI Shows |
|------|-----------------|-----------|
| Final text output | ✅ Yes — full, unbounded | ✅ Yes |
| Tool calls made by subagent | ❌ No | ✅ Yes (expanded view) |
| Token usage / cost | ❌ No | ✅ Yes |
| Reasoning/thinking steps | ❌ No | ❌ No |
| Error messages | ✅ Yes (on failure) | ✅ Yes |

**Key point:** The main agent receives **only the final assistant text** from each subagent. Not the tool calls, not the reasoning, not the intermediate steps. This prevents context pollution while still giving you the results.

### Parallel Mode Behavior

When running multiple agents in parallel:
- All subagents start simultaneously (up to 4 concurrent)
- Each runs in complete isolation
- Main agent receives a combined result after all finish:

```
Parallel: 3/3 succeeded

[writer] completed: Full output text here...
[tester] completed: Full output text here...
[reviewer] completed: Full output text here...
```

## Features

- **Auto-Discovery** — Agents are found at startup and their descriptions are injected into the main agent's system prompt.
- **Streaming Updates** — Watch subagent progress in real-time as tool calls and outputs stream in.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats, tool call previews, and markdown output.
- **Security Confirmation** — Project-local agents require explicit user approval before execution.

## Project Structure

```
index.ts    — Extension entry point: lifecycle hooks, tool registration, mode orchestration
agents.ts   — Agent discovery: reads and parses .md files from user/project directories
runner.ts   — Process runner: spawns `pi` subprocesses and streams JSON events
render.ts   — TUI rendering: renderCall and renderResult for the subagent tool
types.ts    — Shared types and pure helper functions
```

## License

MIT
