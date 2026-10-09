# Pi Subagent

**Delegate prompts to specialized Pi subagents, optionally continuing named subagent sessions.**

There are many subagent extensions for Pi; this one is mine.

## User Guide

### Why Pi Subagent

**Specialization** — Use tailored agents for review, research, testing, documentation, exploration, and other focused work.

**Flexible Context** — Let specialists start fresh, or give them the current conversation when that helps.

**Named Continuation** — Continue the same specialist conversation later for multi-step work.

**Parallel Execution** — Let the main agent ask multiple specialists at the same time.

**Small Surface Area** — Install the extension, define agents as Markdown, and let the main Pi agent handle delegation.

### Features

- **Auto-Discovery** — Agents are found at startup and listed in the main agent's system prompt.
- **Unified Delegation** — One extension handles one specialist call or many parallel calls.
- **Named Persistent Sessions** — Continue specialist subagents across multiple turns when useful.
- **Agent Session Guidance** — Agent definitions can advise when persistent or ephemeral calls fit best.
- **Parent-Local Workers** — Define private direct workers inline, visible only when their owner is launched.
- **Context Control** — Subagents start fresh by default; explicit parent snapshot cloning remains available for exceptional cases.
- **Inactivity Watchdog** — Stop silent child runs while allowing active RPC streams to continue.
- **Depth + Cycle Guards** — Prevent runaway recursive delegation.
- **Streaming Updates** — Watch progress in real time.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats, tool calls, markdown output, and session metadata.

### Install

Requires Pi 0.87.1 or newer.

#### Option 1: Install from npm (recommended)

```bash
pi install npm:@mjakl/pi-subagent
```

#### Option 2: Install via git

```bash
pi install git:github.com/mjakl/pi-subagent
```

#### Option 3: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/mjakl/pi-subagent.git
cd pi-subagent
npm install
```

### Upgrade existing installations

Version 3.1.0 corrects where named-session locks are stored. Before upgrading from an earlier version:

1. Finish or cancel affected delegations and wait for their child processes to exit.
2. While idle, restart or reload all affected parent Pi runtimes, including terminal, RPC, and SDK hosts, so they load the new extension before any new delegations.
3. Do not let old and new extension versions access the same persistent child session concurrently. Upgrading Pi to 0.87.1 alone does not replace extension code already loaded in a running process.

No session migration is needed. Existing session files, IDs, names, and history stay in place. The extension does not automatically delete stale locks; remove a reported stale lock only after confirming its child is no longer running.

### Using Pi Subagent

Once installed, use Pi normally. Ask the main agent for work that benefits from a specialist, such as "review this diff" or "find where authentication is implemented." The main agent decides when to delegate, runs the subagent, and folds the result back into your conversation.

You do not need to call `subagent`, write JSON, or interact with tools directly.

What to expect:

- Delegated work appears in the TUI with streaming progress and expandable details.
- Each subagent runs in its own isolated `pi` process.
- If you have no agents yet, `pi-subagent` creates a starter `explore` agent automatically.
- Customize agents only when you want different or additional specialists.

### Customizing Subagents

pi-subagent works out of the box — on first run it creates a starter `explore` agent for you. Customize it only if you want different or additional specialists.

Subagents are defined as Markdown files with YAML frontmatter.

**User agents:** `~/.pi/agent/agents/*.md` by default, or `$PI_CODING_AGENT_DIR/agents/*.md` when `PI_CODING_AGENT_DIR` is set. Discovery and starter creation use Pi's configuration-directory interpretation, including supported `~` expansion. Files mistakenly created under a project-local literal `~/` directory by older versions are left untouched and are not imported or migrated.

**Project agents:** `.pi/agents/*.md`.

Project agents win on name conflicts, but only after explicit project trust recorded in Pi's trust store or supplied with `--approve`. Implicit or session-only trust does not enable them. They are repo-controlled configuration and execute like user agents.

#### Starter Agent

If no user or project subagents can be found, `pi-subagent` creates a starter user agent named `explore` in the active user agents directory:

- `~/.pi/agent/agents/explore.md` by default
- `$PI_CODING_AGENT_DIR/agents/explore.md` when `PI_CODING_AGENT_DIR` is set

The starter is read-only (`read`, `grep`, `find`, `ls`) and is meant for focused codebase exploration. It includes an advisory preference for topic-specific persistent sessions so follow-up exploration can reuse context. Existing files are never overwritten.

#### Example Agents

Small, focused definitions work best. The `description` helps the main agent choose a subagent; the Markdown body is the subagent's extra system prompt.

##### oracle (packaged example)

The repository and npm package include [`agents/oracle.md`](agents/oracle.md) as a full-featured reference definition. It demonstrates:

- a provider-prefixed default `model` and elevated `thinking` level;
- an explicit tool allowlist;
- a 10-minute inactivity watchdog default;
- advisory `sessionPreference` and `sessionHint` guidance for choosing between independent and continued discussions.

The package does **not** install or activate this agent automatically. Agent definitions can select models and tools, so copy examples into your user or project agents directory only after reviewing them. Adjust or remove the example's `model` if it is not available in your Pi configuration.

From a repository checkout, install the example as a user agent with:

```bash
agents_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents"
mkdir -p "$agents_dir"
cp agents/oracle.md "$agents_dir/oracle.md"
```

##### explore

A good default for fast codebase reconnaissance. It prefers named sessions because exploration often has follow-up questions.

```markdown
---
name: explore
description: Codebase exploration specialist for focused searches and evidence-backed summaries.
tools: read,grep,find,ls
sessionPreference: persistent
sessionHint: Prefer a topic-specific named session for iterative codebase exploration, e.g. session="explore-auth". Use ephemeral calls for one-off or parallel independent searches.
---

You are a codebase exploration specialist. Find the relevant files, symbols, and tests for the request. Return concise findings with file paths and line references.
```

##### review

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

#### Frontmatter Fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | Yes | — | Agent identifier used in tool calls. |
| `description` | Yes | — | What the agent does; shown to the main agent. |
| `model` | No | Parent's current Pi model | Sets the default model for this agent. A per-call `model` overrides it. Supports provider-prefixed values such as `anthropic/claude-3-5-sonnet`. |
| `thinking` | No | Startup `--thinking` or child Pi default/session setting | Sets the agent's default thinking level. A per-call `thinking` overrides it. |
| `inactivityTimeout` | No | No inactivity timeout | Positive integer seconds, up to 2,147,483, that a child may produce no RPC stdout activity before its process tree is terminated. A per-call value overrides this default. |
| `tools` | No | Parent/default Pi tools | Comma-separated allowlist of tool names to enable for this agent. Omitted or empty values inherit the parent configuration. |
| `noTools` | No | `false` | Set to `true` to disable all built-in, extension, and custom tools for this agent. |
| `sessionPreference` | No | — | Advisory machine-readable hint for the main agent. One of `ephemeral`, `persistent`, or `either`. |
| `sessionHint` | No | — | Advisory free-form guidance shown to the main agent when choosing whether to pass `session`. |
| `subagents` | No | — | Map of direct parent-local workers. See below for the inline schema. |

Notes:

- Agent `model` is a default for that agent, not a lock. A `model` supplied in a subagent call wins.
- `tools` is passed to Pi's `--tools` allowlist and can include built-in or extension tool names. `noTools: true` takes precedence over `tools`.
- `inactivityTimeout` observes child RPC stdout bytes only. Child stderr and parent-generated progress updates do not keep a silent child alive.
- `sessionPreference` and `sessionHint` only guide the main agent. They do not automatically create, require, or name persistent sessions.
- `sessionHint` can be used by itself for free-form guidance; the extension does not infer `sessionPreference` from it.
- The Markdown body becomes the agent's system prompt and is appended to Pi's default system prompt.
- Agent files are read when the tool runs; continued named sessions use the current definition of the agent name.

#### Parent-local inline workers

An agent can own one direct tier of workers without installing separate agent files:

```markdown
---
name: reviewer
description: Review a concrete change.
thinking: medium
subagents:
  review-analyst:
    description: Investigate one bounded correctness question.
    tools: read,grep,find,ls
    thinking: medium
    sessionPreference: ephemeral
    systemPrompt: |
      Investigate the assigned question and return evidence.
      Do not implement fixes, delegate, or assess overall readiness.
---

Review the change. Delegate bounded investigations when useful, then assess the evidence yourself.
```

The Markdown body remains the owner's system prompt. Each map key is the worker's
call name; it must be non-blank without surrounding whitespace. Each value must be
a settings map with non-blank string `description` and `systemPrompt` fields.
Optional fields are `model`, `thinking`, `tools`, `noTools`, `inactivityTimeout`,
`sessionPreference`, and `sessionHint`, with the same defaults and precedence as
ordinary agents. Workers do **not** implicitly copy all owner settings. For example,
an omitted model uses the delegator's current model, while tools and startup thinking
follow the existing CLI fallback rules. Set explicit worker settings when needed.

Inline settings are validated rather than silently ignored: `model` and `sessionHint`
must be non-blank strings; `thinking` must be `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, or `max`; `noTools` must be boolean; `inactivityTimeout` must be an integer
between 1 and 2,147,483; and `sessionPreference` must be `ephemeral`, `persistent`, or
`either` (case-insensitive). `tools` accepts a comma-separated string or an array of
non-blank strings; empty lists inherit the normal tool configuration. Unknown fields,
including `name` and nested `subagents`, are rejected. An invalid inline definition
causes the containing agent file to be skipped with a diagnostic. Existing top-level
agents without `subagents` keep their previous parsing behavior.

Only the exact selected owner sees these workers in its effective catalog. Local
workers override same-named ordinary agents for that owner only. Root sessions and
unrelated agents cannot resolve a private worker by its short name; if an ordinary
global agent has that name, they still resolve the global one. An inline worker does
not inherit its owner's private catalog. Each descendant launch clears that context
or replaces it with the newly selected ordinary agent's own direct workers.

The runner transports an absolute locator for the selected owner, including its
name, user/project source, and content digest. It does not resolve the definition
relative to the temporary prompt file or the child's cwd. Thus an owner selected
from a trusted project remains the same owner even when launched in another cwd;
this does not approve that other project's configuration. Missing, changed, or
malformed launch context disables delegation rather than selecting a replacement.
Relaunch the owner to use an edited definition. Normal named owner continuations
load the current definition and transport a fresh locator.

Local workers support both ephemeral calls and named continuation under the existing
persisted-parent contract. Their session IDs, locks, and cycle identities include the
owner's canonical file path and name, so equal short names under different owners
remain separate. Moving or renaming an owner creates a different local session
identity; editing its settings does not. Ordinary global session identities are
unchanged. Depth, cycle, trust, and `PI_SUBAGENT_DENY_AGENTS` controls still apply;
the deny list matches the worker's short call name, including continuations and batches.

This is workflow-local visibility, **not confidentiality or an OS security boundary**.
A shell-capable process can read agent files or bypass the launcher. A read-only tool
allowlist reduces accidental edits and delegation; it is not a general access policy.

#### Available Built-in Tools

Available tools by default: `read`, `bash`, `edit`, `write`.

Optional built-in tools:

- `grep` — Search file contents
- `find` — Find files by glob pattern
- `ls` — List directory contents

For a read-only agent, use `tools: read,find,ls,grep`. For an agent with no tools at all, use `noTools: true`.

---

## Technical Reference

These sections document the `subagent` tool interface and runtime behavior. They are for advanced users, extension authors, and maintainers — you do not need them for everyday use.

### How Subagents Run

Each subagent runs in a separate `pi` process:

- No shared memory/state with the parent process.
- No visibility into sibling subagents.
- Its own model/tool/runtime loop.
- Uses Pi's headless RPC mode so prompts are transported verbatim and completion follows Pi's settlement events.
- Interactive UI requests from inherited extensions are cancelled because subagent processes have no interactive user; non-interactive extension hooks continue normally.
- Started with `PI_OFFLINE=1` to skip startup network operations and reduce latency.
- Inherits relevant parent configuration such as extensions, theme/skill flags, startup `--thinking` fallback (not live parent reasoning), tool defaults, and custom session storage when applicable. When neither the call nor agent file sets a model, the child receives the parent session's current effective provider/model at delegation time. Temporary `--approve` trust is inherited only when the child uses the same working directory; `--no-approve` is always preserved. A per-call `model` overrides the agent file's default model.

An inherited `--system-prompt` that names an existing readable file is resolved against the parent's startup cwd before forwarding. The child reads that file at startup, even when its cwd differs; literal prompt text is forwarded unchanged. File contents are not cached or snapshotted.

The main agent receives a concise text summary for each subagent call. Tool calls, usage, generated session IDs, and creation metadata are available to the TUI and tool result details; the text summary includes only the logical `session` handle in the call header when one was provided.

### Tool API

The tool is named `subagent` and accepts one top-level `calls` array. Use the same shape for one call and many calls.

```json
{
  "calls": [
    {
      "agent": "explore",
      "prompt": "Find where authentication is implemented."
    }
  ]
}
```

A tool invocation accepts between 1 and 8 calls. Each call supports:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `agent` | Yes | — | Exact name of an available subagent. |
| `prompt` | Yes | — | Non-empty prompt sent verbatim to the subagent. |
| `model` | No | Agent or current parent Pi model | Model to use for this call. Overrides the agent file's default model. |
| `thinking` | No | Agent, startup `--thinking`, or child Pi default/session setting | Thinking level for this call: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Overrides agent frontmatter. |
| `cwd` | No | Parent cwd | Working directory for this subagent process. |
| `initialContext` | No | `"empty"` | `"empty"` starts without parent history. `"parent"` exceptionally clones the current parent snapshot; this is expensive and carries the parent conversation's authority. Prefer empty and pass relevant context deliberately. Existing named sessions ignore this field. |
| `session` | No | — | Logical handle of at most 120 characters for a persistent child Pi session. Use this for multi-turn specialist work. Requires a persisted parent Pi session. |
| `inactivityTimeout` | No | Agent default or disabled | Positive integer seconds without child RPC stdout activity before termination (maximum 2,147,483). Overrides the agent frontmatter default. Stderr and parent progress updates do not reset it. |
| `timeout` | No | Unlimited | Exceptional positive integer absolute wall-clock deadline in seconds (maximum 2,147,483), independent of `inactivityTimeout`. Omit it for ordinary stuck-run protection. |

#### One ephemeral call

```json
{
  "calls": [
    {
      "agent": "explore",
      "prompt": "Find where authentication is implemented."
    }
  ]
}
```

#### Per-call model override

```json
{
  "calls": [
    {
      "agent": "review",
      "model": "anthropic/claude-sonnet-4",
      "prompt": "Review correctness risks in the current diff."
    }
  ]
}
```

If omitted, the agent file's `model` is used when configured; otherwise the child uses the parent session's current effective provider/model at delegation time. This applies to continued named sessions too, so a parent model change affects their next call.

Call and agent model overrides containing `/` are forwarded unchanged without the parent's startup `--provider` restriction. Pi decides whether the value is provider-qualified or a raw slash-containing model ID. Use full qualification to resolve ambiguity, for example `openrouter/anthropic/claude-sonnet-4` or `openrouter/openrouter/free`. Bare names and patterns retain the parent's startup provider fallback. Inherited effective-parent models are always fully qualified, even when their IDs contain slashes.

#### Per-call thinking override

```json
{
  "calls": [
    { "agent": "review", "prompt": "Review correctness risks.", "thinking": "high" },
    { "agent": "explore", "prompt": "Locate the entry point.", "thinking": "off" }
  ]
}
```

Precedence, including continued named sessions: call `thinking`, agent frontmatter, startup `--thinking`, then child Pi's default/session setting. The parent's live thinking level is not inherited. Pi may clamp the level to the child's model capabilities.

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

#### Exceptional parent-seeded named session

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

If the named session already exists, the subagent continues it and `initialContext` is ignored. If it does not exist, the new child session is seeded from the parent snapshot. Use this only when the full parent history and authority are genuinely required; normally use empty context and include the relevant facts in `prompt`.

### Named Session Semantics

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

#### Session storage

Each named call resolves one absolute storage directory for session lookup, locking, and child startup. The precedence is:

1. The parent's explicit CLI `--session-dir`, already resolved against its startup cwd.
2. A custom directory forwarded from the parent runtime's session manager.
3. Inherited `PI_CODING_AGENT_SESSION_DIR`.
4. The target project's `sessionDir` setting, then the global setting.
5. Pi's default session directory for the target cwd.

Except for the rebased CLI path, relative storage paths and relative configuration roots retain the child's cwd interpretation. Pi reads `sessionDir` before project trust is resolved; this does not grant trust to other project resources.

Existing sessions, including valid header-only interrupted sessions, ignore `initialContext` and are not forked or renamed. New sessions use the directory the child would normally select. Changing storage configuration does not search other directories, copy files, repair sessions, migrate history, or merge conversations. See the [upgrade steps](#upgrade-existing-installations) before switching extension versions.

### Delegation metadata

New named child sessions record their origin in the child's existing Pi session JSONL. This is a versioned cross-repo contract for consumers such as web-pi; consumers can ship independently of this producer. The entry is written by the child through Pi's `appendEntry` API, not by a parent editing the child's file. It does not enter model context.

The entry has `type: "custom"`, `customType: "pi-subagent:delegation"`, and this exact data schema:

```typescript
{
  version: 1;
  childSessionId: string;
  parentSessionId: string;
  agent: string;
  handle: string;
}
```

- `childSessionId` is the containing child session header's `id`.
- `parentSessionId` is the immediate actual delegator's session ID, captured before creating a temporary parent snapshot. Nested children point to their delegating child, not the top-level ancestor.
- `agent` and `handle` are the trimmed values used to derive the named session identity. Internal whitespace is preserved; the display name is not an identity source.

Representative entry (Pi supplies the entry ID, tree parent, and timestamp):

```json
{"type":"custom","id":"a1b2c3d4","parentId":null,"timestamp":"2026-09-21T12:00:00.000Z","customType":"pi-subagent:delegation","data":{"version":1,"childSessionId":"subagent.0123456789abcdef","parentSessionId":"parent-session-id","agent":"explore","handle":"auth-investigation"}}
```

Consumer rules:

- Read **all entries**, not just the active branch, to find session origin.
- Accept only supported, well-formed metadata whose `childSessionId` equals the containing session header's `id`. Forks and parent-seeded sessions may copy other sessions' entries; those entries do not assign ownership to the new session.
- Do not infer delegation from display names, `subagent.*` IDs, or the header's `parentSession` path. In parent-seeded calls that path points to a temporary snapshot, not the durable delegator.
- Metadata describes origin, not authorization, process status, or liveness. Consumers must enforce their own access and inspect-only UI rules.

Continuation preserves the original entry without rewriting it. Existing unmarked child sessions are not backfilled. Ephemeral calls receive no new origin entry and create no durable metadata; parent-seeded temporary sessions may contain copied history, which is removed with the snapshot as before.

A small packaged helper extension is loaded explicitly in named children, independently of extension discovery and delegation-depth limits. Its per-launch `PI_SUBAGENT_DELEGATION` environment payload is provided only for new named sessions and cleared for continuations and ephemeral calls. Reloads and session switches do not reapply it. This environment variable is internal transport, not the persisted consumer contract.

Pi controls flushing: a fresh empty session and its metadata may remain in memory until the first assistant message. The helper does not force a file or placeholder message. A failed launch that leaves an existing unmarked session is not backfilled on continuation. No sidecar, registry, status, run, or PID data is written.

### Initial Context

`initialContext` controls only how a newly-created child conversation starts:

- `"empty"` — start without parent conversation history. This is the default and recommended mode.
- `"parent"` — exceptionally copy the current parent session branch into the new child conversation before sending the prompt. Cloning can be expensive and carries the parent conversation's accumulated authority and instructions; pass relevant context deliberately in the prompt instead whenever practical.

Existing named sessions always continue their own history and ignore `initialContext`.

Calls without `session` are ephemeral:

- no `session`, `initialContext: "empty"` — fresh temporary child conversation
- no `session`, `initialContext: "parent"` — temporary child conversation seeded from the parent snapshot
- with `session` — persistent child Pi session

When multiple calls need `initialContext: "parent"`, they all receive the same parent snapshot captured at the start of the tool invocation.

### Liveness Timeouts

`inactivityTimeout` and `timeout` are independent:

- `inactivityTimeout` is the normal stuck-run guard. Its countdown starts with the child run and resets only when bytes arrive on the child's RPC stdout. Stderr output and parent synthetic progress updates do not reset it.
- `timeout` is an exceptional absolute wall-clock deadline. Activity never extends it. Omit it for ordinary stuck-run protection.
- Either expiry preserves captured partial output and reports a distinct error. On Unix, the child process group receives SIGTERM followed by SIGKILL when needed; on Windows, the existing `taskkill /T /F` process-tree termination path is used.

A per-call `inactivityTimeout` overrides the selected agent's frontmatter value. If neither is configured, there is no inactivity watchdog.

### Result Format

The main agent receives a uniform wrapper for one or many calls:

```text
2/2 succeeded

[1: review session=api-review] completed:
...

[2: testing-audit] completed:
...
```

If any call fails, the tool result is marked as an error while still returning every call's output:

```text
1/2 succeeded

[1: review session=api-review] completed:
...

[2: testing-audit] failed:
Unknown agent: "testing-audit".
```

Model-facing output is limited to 50KB or 2000 lines. When a captured result exceeds either limit, every call's status remains visible, captured details remain available in the expanded TUI, and the complete captured summary is written to a mode-`0600` temporary file for the lifetime of the parent Pi session.

Process capture is separately bounded to prevent a long-running child from consuming unbounded memory. The runner retains a rolling 5MB window of assistant messages. Earlier messages and oversized tool-only messages may be omitted; oversized final text is retained in truncated form with an explicit marker. The temporary summary artifact contains the complete captured summary, not an unbounded raw event transcript.

Full session metadata, including generated session ID, effective cwd, creation status, and applied initial context, is available in the tool result details and TUI expanded view.

### Denying Agent Names

Set `PI_SUBAGENT_DENY_AGENTS` to a JSON array of exact agent names when launching Pi:

```bash
PI_SUBAGENT_DENY_AGENTS='["coder-junior","coder-senior"]' pi
```

These names are illustrative; any agent name can be denied. Matching is case-sensitive, with no wildcard expansion or trimming of configured names. Values must be non-blank strings. Duplicate names are harmless. An unset variable or `[]` preserves unrestricted behavior.

Denied names are omitted from the model-visible available-agent catalog and rejected by the `subagent` tool even if the caller already knows the name. Denial applies after user/project definition precedence, so a project override with the same name remains denied. A batch containing a denied call is rejected before any child starts or session locks are acquired. This also applies to named-session continuation; allowed agents and their continuations remain usable.

The extension reads the policy when it loads. Invalid explicit values (including an empty string, malformed JSON, a non-array value, or entries that are not non-blank strings) report an error to stderr and, when available, the UI. No agent catalog is injected, and every `subagent` call fails without child or session setup. Pi itself can continue running. Correct the configuration and reload the extension, or relaunch Pi with a valid value.

Every extension-launched child receives the effective policy, including fresh and continued named sessions, parent-seeded calls, and deeper descendants. The policy is independent of the depth and cycle guards below; disabling cycle prevention does not disable denial. Native Pi launches and resumes must receive the variable from their launcher, for example by applying the same environment assignment to `pi --resume`. Session files do not store authorization: resuming under a different launch environment uses that environment's policy. There is no agent-frontmatter or CLI counterpart for this setting.

This is workflow control, **not an OS security sandbox**. A process with shell access can launch another process or alter its environment. The extension does not prevent that or impose irreversible authorization on saved sessions.

### Delegation Guards

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
