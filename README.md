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

## Usage

### subagent

Delegate a task to a specialized agent.

```typescript
// Single task
subagent({ 
  agent: "writer", 
  task: "Rewrite the README.md to be more professional." 
})

// Parallel tasks
subagent({
  tasks: [
    { agent: "tester", task: "Write unit tests for index.ts" },
    { agent: "writer", task: "Document the API in index.ts" }
  ]
})
```

**Parameters:**
- `agent` (string) - Name of the agent (single mode)
- `task` (string) - Task description (single mode)
- `tasks` (array) - List of `{agent, task}` for parallel execution
- `agentScope` ("user" | "project" | "both") - Where to look for agents. Default: "user".
- `cwd` (string, optional) - Working directory for the subagent.

## Features

- **Streaming Updates**: Watch the subagent's progress in real-time.
- **TUI Integration**: Rich rendering of tool calls and outputs from subagents.
- **Auto-Discovery**: Subagents are automatically found and their descriptions are added to your main agent's system prompt.

## Author

Inspired by implementations from [vaayne](https://github.com/vaayne/agent-kit) and [mariozechner](https://github.com/badlogic/pi-mono).

## License

MIT
