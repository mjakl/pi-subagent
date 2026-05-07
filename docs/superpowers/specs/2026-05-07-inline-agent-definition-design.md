# Inline Agent Definition Support Design

**Date:** 2026-05-07
**Repository:** `~/PersonalProjects/pi-subagent/.worktrees/review-findings-impl`
**Goal:** Allow the `subagent` tool to run ephemeral inline agent definitions supplied directly in tool input, so callers can resolve prompts externally (for example from superpowers skills) and delegate without requiring a pre-existing agent file on disk.

---

## Problem Statement

Today, `pi-subagent` can only execute agents discovered from markdown files in:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md`

This prevents workflows where the caller already has an agent prompt or skill-derived prompt template in memory and wants to run it immediately.

A concrete example is combining `pi-subagent` with superpowers skills such as `requesting-code-review`, where the caller can read `requesting-code-review/code-reviewer.md`, fill placeholders, and then delegate to a reviewer subagent. The current extension cannot execute that inline definition unless the user first writes a real agent file.

---

## Scope

### In Scope

- Add support for **ephemeral inline structured agent definitions** in the `subagent` tool input
- Preserve existing named-agent behavior
- Allow inline agent definitions in both single and parallel modes
- Make `systemPrompt` optional for inline agents
- Reuse the existing runtime execution path as much as possible
- Ensure inline agents do **not** require persistence to disk

### Out of Scope

- Persisting inline definitions as markdown files
- Resolving skill names or skill paths inside the extension
- Changing spawn/fork behavior
- Changing the existing named-agent discovery mechanism
- Broad refactors unrelated to this feature

---

## Recommended API

### Single Mode

Exactly one of `agent` or `agentDefinition` must be provided together with `task`.

Existing:

```json
{ "agent": "writer", "task": "Rewrite README.md" }
```

New:

```json
{
  "agentDefinition": {
    "name": "code-reviewer",
    "description": "Reviews code changes for production readiness",
    "tools": ["read", "bash"],
    "systemPrompt": "Review code changes carefully."
  },
  "task": "Review commits A..B"
}
```

### Parallel Mode

Each task item may provide either `agent` or `agentDefinition`.

Existing `cwd` behavior remains unchanged:
- single mode continues to support top-level `cwd`
- parallel mode continues to support per-task `cwd`
- `cwd` is orthogonal to whether the task uses `agent` or `agentDefinition`

```json
{
  "tasks": [
    {
      "agentDefinition": {
        "name": "code-reviewer",
        "description": "Reviews code changes",
        "tools": ["read", "bash"]
      },
      "task": "Review commit range A..B"
    },
    {
      "agent": "writer",
      "task": "Draft release notes"
    }
  ]
}
```

### Inline Agent Definition Shape

```json
{
  "name": "code-reviewer",
  "description": "Reviews code changes for production readiness",
  "model": "optional",
  "thinking": "optional",
  "tools": ["read", "bash"],
  "systemPrompt": "optional"
}
```

### Field Semantics

- `name` — required, non-empty string
- `description` — required, non-empty string
- `model` — optional
- `thinking` — optional
- `tools` — optional
- `systemPrompt` — optional

If `systemPrompt` is omitted, the child run uses only Pi’s default system prompt plus the delegated task and any selected runtime overrides.

If `systemPrompt` is provided, it is appended the same way file-based agent prompt bodies are currently appended.

---

## Workflow Model

The extension does **not** resolve skills or prompt templates itself.

Instead, the intended workflow is:

1. The caller reads a skill or prompt resource
2. The caller fills placeholders or composes a final prompt
3. The caller builds a structured `agentDefinition` object
4. The caller invokes `subagent` with that inline definition

This keeps `pi-subagent` focused on delegation, not resource discovery.

---

## Internal Architecture

### Core Principle

Do not create real temporary agent files for inline definitions.

Instead:

1. Validate the inline object from tool params
2. Normalize it into the same internal runtime shape used by discovered agents
3. Pass that normalized config through the existing execution path

### Agent Model Changes

Current `AgentConfig.source` supports:
- `"user"`
- `"project"`

Proposed:
- `"user"`
- `"project"`
- `"inline"`

This preserves provenance cleanly and avoids special-case string hacks.

### Normalization Helper

Add a helper in `agents.ts` for inline definitions, for example:

- `normalizeInlineAgentDefinition(...)`

Responsibilities:
- validate required fields
- trim and normalize strings
- normalize tools to the same internal representation as discovered agents
- assign synthetic metadata such as:
  - `source: "inline"`
  - `filePath: "(inline agent definition)"`
  - `systemPrompt: ""` when omitted

### Execution Path

`index.ts` should:
- keep existing discovery logic for named agents
- accept inline definitions as an alternative invocation path
- normalize inline definitions into runtime agent configs
- include those inline configs only for the current tool call

`runner.ts` should continue to treat the normalized config exactly like any other agent config.

---

## Behavioral Rules

### Discovery Listing

Inline agents are **not** globally discoverable and must not be injected into the parent prompt’s “Available Subagents” list.

Reason: they are call-local, not reusable discovered resources.

### Project-Agent Confirmation

Inline agents should **not** trigger project-agent confirmation.

Reason: they are not repo-controlled project files.

### Cycle Prevention

Cycle prevention still applies by agent `name`.

An inline agent named `code-reviewer` participates in the delegation stack the same way as a file-based `code-reviewer` agent.

### Name Collisions and Resolution

Inline agent definitions are resolved directly from the provided object for that specific tool call. They do **not** participate in discovery precedence and are not overridden by discovered agents with the same name.

This means:
- a same-name discovered agent does not replace an inline `agentDefinition`
- a named-agent lookup (`agent: "code-reviewer"`) still resolves through normal discovery rules
- cycle checks still operate on the resolved runtime agent name, regardless of whether it came from discovery or an inline definition

### Rendering / Provenance

If source is shown in details or rendering, inline agents should be marked as `inline`.

For consistency with existing result metadata, the implementation should allow result provenance such as `agentSource: "inline"`.

---

## Validation Rules

### Single Mode

Require:
- `task`
- exactly one of:
  - `agent`
  - `agentDefinition`

Reject:
- both provided
- neither provided

### Parallel Mode

Require:
- `tasks`
- no top-level `agent` or `agentDefinition` alongside `tasks`

For each task item:
- `task` required
- exactly one of:
  - `agent`
  - `agentDefinition`
- existing per-task `cwd` remains valid for both named and inline agents

### Inline Definition Validation

Require:
- `name`: non-empty string
- `description`: non-empty string

Optional:
- `systemPrompt`: omitted or string
- `model`: omitted or string
- `thinking`: omitted or string
- `tools`: omitted or array of strings

For the inline API, `tools` should accept only a string array. File-based agents may continue to support their existing more permissive parsing rules, but inline definitions should use the stricter structured form.

### Error Handling

Return explicit tool errors (`isError: true`) for:
- malformed invocation shapes
- invalid inline definitions
- unknown named agents
- invalid mode values
- malformed task entries in parallel mode

Example error messages:
- `Invalid parameters. Provide exactly one of "agent" or "agentDefinition" in single mode.`
- `Invalid task[1]. Provide exactly one of "agent" or "agentDefinition".`
- `Invalid agentDefinition.name: expected non-empty string.`

---

## Testing Strategy

Follow TDD in focused slices.

### Slice 1: Inline normalization

Add tests for:
- minimal valid inline definition
- omitted `systemPrompt`
- trimmed values
- missing `name`
- missing `description`

### Slice 2: Single-mode validation

Add tests for:
- `{ agentDefinition, task }` accepted
- `{ agent, agentDefinition, task }` rejected
- `{ task }` rejected
- inline definition without `systemPrompt` accepted

### Slice 3: Parallel-mode validation

Add tests for:
- inline task item accepted
- mixed named + inline task items accepted
- malformed task item rejected

### Slice 4: Execution-path behavior

Add tests proving:
- inline agent definitions can run without discovery
- project-agent confirmation does not trigger for inline agents
- delegation stack / cycle behavior still keys off agent name

### Verification

At minimum:
- `npm test`
- `npm pack --dry-run`
- `pi -e . --help`

---

## Risks and Mitigations

### Risk: API ambiguity

**Mitigation:** enforce exact-one-of validation for `agent` vs `agentDefinition` at both single and per-task levels.

### Risk: scope creep into skill resolution

**Mitigation:** keep resource resolution outside the extension; callers supply finished inline definitions.

### Risk: duplicate validation logic

**Mitigation:** centralize inline-definition normalization in `agents.ts`.

### Risk: behavioral drift in existing workflows

**Mitigation:** preserve all named-agent flows unchanged and add only additive validation/normalization paths.

---

## Success Criteria

This feature is successful when:

1. The `subagent` tool accepts ephemeral structured inline agent definitions
2. Existing named-agent usage continues to work unchanged
3. `systemPrompt` is optional for inline agents
4. Inline agents do not require writing files to disk
5. Inline agents can be used in both single and parallel modes
6. Validation errors are explicit and machine-readable
7. Tests cover normalization, validation, and execution-path behavior
