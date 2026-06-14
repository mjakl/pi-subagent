# Pi Subagent

**Delegate prompts to specialized Pi subagents, optionally continuing named subagent sessions.**

There are many subagent extensions for Pi; this one is mine.

## Why Pi Subagent

**Specialization** — Use tailored agents for review, research, testing, documentation, exploration, and other focused work.

**Flexible Context** — Start a child conversation empty, or seed a newly-created child conversation from the current parent session.

**Named Continuation** — Give a subagent call a logical `session` handle and continue that same specialist conversation later.

**Parallel Execution** — Run one or many subagent calls with the same `calls` API.

**Small Surface Area** — The extension keeps delegation explicit: choose an agent, send a prompt, optionally name the session.

## Install

### Option 1: Install from npm (recommended)

```bash
pi install npm:@mjakl/pi-subagent
```

### Option 2: Install via git

```bash
pi install git:github.com/mjakl/pi-subagent
```

### Option 3: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/mjakl/pi-subagent.git
cd pi-subagent
npm install
```

## Subagent Definitions

Subagents are defined as Markdown files with YAML frontmatter.

**User agents:** `~/.pi/agent/agents/*.md` by default, or `$PI_CODING_AGENT_DIR/agents/*.md` when `PI_CODING_AGENT_DIR` is set.

**Project agents:** `.pi/agents/*.md`.

Project agents win on name conflicts. They are repo-controlled configuration and are discovered, advertised to the main agent, and executed like user agents. Use project agents only in repositories you trust.

### Starter Agent

If no user or project subagents can be found, `pi-subagent` creates a starter user agent named `explorer` in the active user agents directory:

- `~/.pi/agent/agents/explorer.md` by default
- `$PI_CODING_AGENT_DIR/agents/explorer.md` when `PI_CODING_AGENT_DIR` is set

The starter is read-only (`read`, `grep`, `find`, `ls`) and is meant for focused codebase exploration. It includes an advisory preference for topic-specific persistent sessions so follow-up exploration can reuse context. Existing files are never overwritten.

### Small Example Agents

Small, focused definitions work best. The `description` helps the main agent choose a subagent; the Markdown body is the subagent's extra system prompt.

#### explore

A good default for fast codebase reconnaissance. It prefers named sessions because exploration often has follow-up questions.

```markdown
---
name: explore
description: Codebase exploration specialist for focused searches and evidence-backed summaries.
sessionPreference: persistent
sessionHint: Prefer a topic-specific named session for iterative exploration; use ephemeral calls for one-off searches.
---

You are a codebase exploration specialist. Find the relevant files, symbols, and tests for the request. Return concise findings with file paths and line references.
```

#### review

A useful complement to `explore`: stateless by default, judgment-oriented, and configured for deeper reasoning.

```markdown
---
name: review
description: Pragmatic code reviewer for correctness, regression risk, test coverage, and maintainability.
thinking: high
sessionPreference: ephemeral
sessionHint: Use ephemeral calls for independent reviews; use a named session only when continuing the same review thread.
---

You review code changes. Focus on substantive issues, cite files and lines, and distinguish confirmed problems from suggestions. Keep the report concise.
```

### Frontmatter Fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | Yes | — | Agent identifier used in tool calls. |
| `description` | Yes | — | What the agent does; shown to the main agent. |
| `model` | No | Parent/default Pi model | Overrides the model for this agent. Supports provider-prefixed values such as `anthropic/claude-3-5-sonnet`. |
| `thinking` | No | Parent/default Pi thinking level | Sets the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). |
| `tools` | No | `read,bash,edit,write` | Comma-separated list of built-in tools to enable for this agent. |
| `sessionPreference` | No | — | Advisory machine-readable hint for the main agent. One of `ephemeral`, `persistent`, or `either`. |
| `sessionHint` | No | — | Advisory free-form guidance shown to the main agent when choosing whether to pass `session`. |

Notes:

- `tools` controls built-in tools. Extension tools remain available unless extensions are disabled.
- `sessionPreference` and `sessionHint` only guide the main agent. They do not automatically create, require, or name persistent sessions.
- `sessionHint` can be used by itself for free-form guidance; the extension does not infer `sessionPreference` from it.
- The Markdown body becomes the agent's system prompt and is appended to Pi's default system prompt.
- Agent files are read when the tool runs; continued named sessions use the current definition of the agent name.

### Available Built-in Tools

Available tools by default: `read`, `bash`, `edit`, `write`.

Optional built-in tools:

- `grep` — Search file contents
- `find` — Find files by glob pattern
- `ls` — List directory contents

For a read-only agent, use `tools: read,find,ls,grep`.

## How Communication Works

Each subagent runs in a separate `pi` process:

- No shared memory/state with the parent process.
- No visibility into sibling subagents.
- Its own model/tool/runtime loop.
- Started with `PI_OFFLINE=1` to skip startup network operations and reduce latency.
- Inherits relevant parent CLI configuration such as extensions, provider/theme/skill flags, model/thinking/tool defaults, and custom session storage when applicable.

The main agent receives a concise text summary for each subagent call. Tool calls, usage, generated session IDs, and creation metadata are available to the TUI and tool result details; the text summary includes only the logical `session` handle in the call header when one was provided.

## Features

- **Auto-Discovery** — Agents are found at startup and listed in the main agent's system prompt.
- **Unified Calls API** — One schema for one or many subagent calls.
- **Named Persistent Sessions** — Continue specialist subagents across multiple turns.
- **Agent Session Guidance** — Agent definitions can advise when persistent or ephemeral calls fit best.
- **Per-Call Initial Context** — Each call chooses empty or parent-seeded creation.
- **Depth + Cycle Guards** — Prevent runaway recursive delegation.
- **Streaming Updates** — Watch progress in real time.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats, tool calls, markdown output, and session metadata.

## Tool API

**Note:** This is reference documentation for the Pi agent/tool interface. Users do not need to call `subagent`, write JSON, or interact with the tools in any way; the main Pi agent invokes the tool when it delegates work.

The tool is named `subagent` and accepts one top-level `calls` array. Use the same shape for one call and many calls.

```json
{
  "calls": [
    {
      "agent": "explorer",
      "prompt": "Find where authentication is implemented."
    }
  ]
}
```

Each call supports:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `agent` | Yes | — | Exact name of an available subagent. |
| `prompt` | Yes | — | Non-empty prompt sent verbatim to the subagent. |
| `cwd` | No | Parent cwd | Working directory for this subagent process. |
| `initialContext` | No | `"empty"` | `"empty"` starts a newly-created child conversation without parent history. `"parent"` seeds a newly-created child conversation from the current parent session snapshot. Existing named sessions ignore this field. |
| `session` | No | — | Logical handle for a persistent child Pi session. Use this for multi-turn specialist work. Requires a persisted parent Pi session. |

### Examples

#### One ephemeral call

```json
{
  "calls": [
    {
      "agent": "explorer",
      "prompt": "Find where authentication is implemented."
    }
  ]
}
```

#### Multiple parallel calls

```json
{
  "calls": [
    {
      "agent": "review",
      "prompt": "Review correctness risks in the current diff."
    },
    {
      "agent": "testing-audit",
      "prompt": "Find missing test coverage in the current diff."
    }
  ]
}
```

#### Named persistent session

Start a durable subagent conversation:

```json
{
  "calls": [
    {
      "agent": "review",
      "session": "api-review",
      "prompt": "Start a review plan for the API changes."
    }
  ]
}
```

Continue the same specialist conversation later:

```json
{
  "calls": [
    {
      "agent": "review",
      "session": "api-review",
      "prompt": "Now review the implementation against your earlier plan."
    }
  ]
}
```

#### Parent-seeded named session

```json
{
  "calls": [
    {
      "agent": "review",
      "session": "api-review",
      "initialContext": "parent",
      "prompt": "Use the current parent conversation as context and start a review plan."
    }
  ]
}
```

If the named session already exists, the subagent continues it and `initialContext` is ignored. If it does not exist, the new child session is seeded from the parent snapshot.

## Named Session Semantics

A `session` value is a logical handle, not a Pi display name and not a raw Pi session ID.

The extension derives an opaque Pi session ID from:

```text
pi-subagent/v1 + parentSessionId + effectiveCwd + agentName + sessionHandle
```

The generated Pi session ID looks like:

```text
subagent.<hash>
```

The human-readable Pi display name is:

```text
subagent: <agent> · <handle>
```

Important rules:

- Same `session` handle + same parent session + same effective cwd + same agent continues the same child session.
- A new top-level Pi parent session creates a new subagent session namespace, even in the same repository.
- Same `session` handle with different agents resolves to different child sessions.
- Same `session` handle with different effective cwd resolves to different child sessions.
- A persistent child session can be used by only one running call at a time. The extension uses a session lock in the Pi session directory to guard this across parent processes. If a process is killed, a later call may report a stale lock and ask you to remove the lock directory manually after confirming no subagent is still running.
- If two calls in the same tool invocation resolve to the same persistent session, the whole request is rejected before any child process starts.
- Named child sessions require a persisted parent Pi session. If the parent is running with `--no-session`, omit `session` for ephemeral delegation.
- Named child sessions are also unavailable from temporary parent-seeded subagent sessions. Use a named parent subagent session first if nested durable delegation is needed.
- To start a fresh durable conversation, choose a new `session` handle.

## Initial Context

`initialContext` controls only how a newly-created child conversation starts:

- `"empty"` — start without parent conversation history.
- `"parent"` — copy the current parent session branch into the new child conversation before sending the prompt.

Existing named sessions always continue their own history and ignore `initialContext`.

Calls without `session` are ephemeral:

- no `session`, `initialContext: "empty"` — fresh temporary child conversation
- no `session`, `initialContext: "parent"` — temporary child conversation seeded from the parent snapshot
- with `session` — persistent child Pi session

When multiple calls need `initialContext: "parent"`, they all receive the same parent snapshot captured at the start of the tool invocation.

## Result Format

The main agent receives a uniform wrapper for one or many calls:

```text
2/2 succeeded

[0: review session=api-review] completed:
...

[1: testing-audit] completed:
...
```

If any call fails, the tool result is marked as an error while still returning every call's output:

```text
1/2 succeeded

[0: review session=api-review] completed:
...

[1: testing-audit] failed:
Unknown agent: "testing-audit".
```

Full session metadata, including generated session ID, effective cwd, creation status, and applied initial context, is available in the tool result details and TUI expanded view.

## Delegation Guards

By default, this extension enforces two runtime guards:

1. **Depth guard** (`--subagent-max-depth`, default `3`)
   - Main agent starts at depth `0`.
   - Delegation is allowed while `currentDepth < maxDepth`.
   - With default depth `3`: depth `0`, `1`, and `2` can delegate; depth `3` cannot.
2. **Cycle guard** (`--subagent-prevent-cycles`, default `true`)
   - Blocks delegating to any agent name already present in the current delegation stack.
   - Prevents self-recursion and loops.

Configure depth with either:

- CLI flag: `--subagent-max-depth <n>`
- Environment variable: `PI_SUBAGENT_MAX_DEPTH=<n>`

Configure cycle prevention with either:

- CLI flag: `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles`
- Environment variable: `PI_SUBAGENT_PREVENT_CYCLES=true|false`

Internal env vars managed by the extension and propagated to child processes:

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_STACK` (JSON array of ancestor agent names)
- `PI_SUBAGENT_PREVENT_CYCLES`

Recommended integration note: if another extension needs to detect whether it is running inside a delegated subagent process, check `PI_SUBAGENT_DEPTH`. Treat `PI_SUBAGENT_DEPTH > 0` as "this pi process is a subagent".

## Attribution

Inspired by implementations from [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
