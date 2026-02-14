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

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent identifier used in tool calls |
| `description` | Yes | What the agent does (shown to the main agent) |
| `model` | No | LLM model override |
| `tools` | No | Comma-separated list of tools to enable |

The Markdown body below the frontmatter becomes the agent's system prompt.

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
