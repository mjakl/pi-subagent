# Subagent Model UI Design

**Date:** 2026-05-08
**Repository:** `~/Projects/pi-subagent`
**Scope:** Recommended
**Goal:** Improve the extension UI so the main session shows which full model id each subagent is using while it is running and after it completes.

---

## Problem Statement

Today the extension already captures some model information, but the UI does not present it consistently across the delegation lifecycle.

Observed gaps:

1. `renderCall()` only sees raw tool args, so it cannot show the resolved model for named agents at invocation time.
2. `SingleResult.model` is too implicit for UI needs because it does not distinguish configured, runtime-reported, and unresolved states.
3. Parallel placeholder results drop initial model knowledge, so running parallel views cannot reliably show model information from the start.
4. `SubagentDetails` is result-centric and does not carry pre-resolved task display metadata for the renderer.
5. There are no tests that lock in the expected model-display UX.

The result is a fragmented experience: some final states may show a model, but the main session does not reliably tell the user which model a subagent is using while that subagent is running.

---

## User-Approved Requirements

- Show the subagent model in the **main session UI**.
- Show it **continuously while the subagent is running**, not only at the end.
- Show it in the **call/start state and the result state**.
- Display the **full configured model id** when known, for example `openai/gpt-5.3-codex`.
- If no model is known yet, display **`(resolving model…)`**.
- Support **named agents**, **inline agent definitions**, and **parallel runs**.

---

## Scope

### In Scope

- Add a first-class model display state for delegated tasks/results
- Make single-mode UI show model information in call, running, and final states
- Make parallel-mode UI show per-task model information in running and final states
- Seed model display from named-agent and inline-agent configuration
- Upgrade the displayed model when Pi reports a runtime model in JSON-mode events
- Add regression tests for model display behavior

### Out of Scope

- Estimating the model from the parent session when the child has not reported one
- Provider/model analytics or comparison UI
- Cost dashboards or model badges beyond plain text display
- Broad UI redesign unrelated to model visibility
- Dynamic multi-model history display; latest authoritative display value is enough

---

## Recommended Approach

Use a **resolved display metadata pipeline**.

1. Resolve each task to an initial model display state before launching the child process.
2. Carry that state through `SubagentDetails` so renderers can display it immediately.
3. Seed each `SingleResult` with the same initial state.
4. Upgrade to a runtime-reported model if Pi emits `message.model` later.
5. Render model text consistently in single and parallel views.

This approach is preferred over a render-only patch because the main architectural gap is not missing raw data; it is missing display-oriented task metadata at invocation and running time.

---

## Alternatives Considered

### 1. Render-only patch

Add model text only where `SingleResult.model` already exists.

**Pros**
- Smallest change
- Helps some final-result paths quickly

**Cons**
- Does not solve call-row rendering for named agents
- Leaves parallel placeholder behavior incomplete
- Keeps model resolution implicit and scattered

### 2. Runtime-event-only display

Display a model only after Pi emits `message.model`.

**Pros**
- Most faithful to runtime truth

**Cons**
- Poor running UX when no model event arrives early
- Cannot satisfy the requirement to show the model from the beginning when configured
- Does not help initial call rendering

### 3. Recommended hybrid

Start with configured model if known, otherwise show `resolving`, then upgrade to runtime model when reported.

**Pros**
- Best UX for running tasks
- Supports named, inline, and parallel flows
- Preserves future flexibility if runtime-reported models differ from configured ones

**Cons**
- Requires small coordinated changes across types, execution, and rendering

---

## Solution Design

### 1. Explicit model display state

Add an explicit UI-facing model state instead of treating `model?: string` as the full contract.

Conceptually each task/result should expose:

- `modelText?: string` — the full model id to display
- `modelStatus` — one of:
  - `configured`
  - `runtime`
  - `resolving`

Rules:

- If an agent config includes `model`, initialize with that full id and `configured` status.
- If no model is known yet, initialize with `resolving` status.
- If Pi later reports `message.model`, replace the display value and mark it `runtime`.

This removes renderer ambiguity and gives one consistent way to format model output.

### 2. Resolved task metadata in `SubagentDetails`

Extend `SubagentDetails` with per-task display metadata so renderers do not have to reconstruct state from raw tool params or partially-populated results.

Each task entry should include enough information to render the UI from the moment the tool starts:

- agent name
- agent source when known
- task text or preview
- model display state

For single mode, there is one entry. For parallel mode, there is one entry per task.

This is the key change that closes the current `renderCall()` gap.

### 3. Seed display state during task resolution

When `index.ts` resolves requested tasks:

- named agents use `AgentConfig.model`
- inline agents use `agentDefinition.model`
- tasks without a known model start as `resolving`

That resolved state should be used in three places:

1. initial details for `renderCall()`
2. placeholder running details for parallel execution
3. initial `SingleResult` creation for each launched child

### 4. Preserve and refine state during execution

`runner.ts` should initialize each `SingleResult` with the same model display state prepared earlier.

`runner-events.js` should continue parsing assistant message metadata and upgrade the display state when `message.model` appears.

If runtime metadata never arrives, the initial configured or resolving state remains valid for display.

### 5. Rendering behavior

#### Call/start state

Single mode should show:
- agent name
- delegation mode
- task preview
- model line with full id or `(resolving model…)`

Parallel mode should show, for each previewed task:
- agent name
- short task preview
- model line or inline model suffix using the same display rule

#### Running state

Single collapsed and expanded results should always show the current model display value.

Parallel collapsed and expanded results should show per-task model display values independently, including mixed states such as configured, runtime, and resolving.

#### Final state

Final result blocks should continue to show the model display value.

If a runtime model was observed, it replaces the configured one for display. If no model ever becomes known, the UI continues to show `(resolving model…)`.

---

## Error Handling and Edge Cases

### Configured model differs from runtime-reported model

Display the configured model first, then replace it with the runtime-reported model when available. The runtime-reported value is the authoritative final display.

### No configured model and no runtime model

Show `(resolving model…)` throughout execution and at completion. Do not guess from the parent session.

### Early process failure

If the child fails before emitting assistant events:
- show the configured model if one was known
- otherwise keep `(resolving model…)`

This preserves useful intent information even on failure paths.

### Parallel mixed states

Each task should render independently. No aggregate model summary is required.

### Malformed or missing model metadata

Treat this as display degradation only. Never fail delegation because model display metadata is absent or incomplete.

---

## File Impact Summary

### `types.ts`

Add explicit model display types and extend `SubagentDetails` with task-level display metadata.

### `index.ts`

Resolve initial model display state for named and inline tasks before execution, populate initial details, and preserve model state in parallel placeholders.

### `runner.ts`

Initialize `SingleResult` with explicit model display state rather than relying on a loosely-defined optional string only.

### `runner-events.js`

Upgrade model display state from `configured` or `resolving` to `runtime` when assistant message metadata includes a model.

### `render.ts`

Render model information consistently in call, running, and final states for both single and parallel views.

### `test/*`

Add tests for:
- named agents with configured models
- inline agents with configured models
- unresolved model display text
- runtime model override behavior
- parallel placeholder rendering/state propagation

---

## Testing Strategy

Follow a small TDD sequence.

### Slice 1: model display types and initialization
- Add tests for initial configured vs resolving state
- Update type definitions and task/result initialization

### Slice 2: renderer behavior
- Add tests for single and parallel rendering paths
- Update call and result renderers to display model state consistently

### Slice 3: runtime override
- Add tests proving runtime `message.model` replaces the initial configured or resolving display value
- Update event parsing/state refinement as needed

### Final verification
- `npm test`
- `npm pack --dry-run`
- manual smoke check with `pi -e .`

---

## Risks and Mitigations

### Risk: renderer becomes coupled to resolution logic
**Mitigation:** keep renderers simple and feed them prepared display metadata via `SubagentDetails`.

### Risk: duplicate state between details and results drifts out of sync
**Mitigation:** derive both from the same initial resolution step and let running updates replace the corresponding result entry authoritatively.

### Risk: runtime model updates are inconsistent across Pi events
**Mitigation:** treat runtime model updates as opportunistic refinement; if absent, continue displaying the initial state.

---

## Success Criteria

This work is successful when all of the following are true:

1. The main session shows each subagent’s model from the moment the tool starts
2. Named agents and inline agents display the full configured model id when one is defined
3. Tasks without a known model display `(resolving model…)`
4. Single and parallel running states both show model information
5. Final result views continue to show model information consistently
6. Runtime-reported model ids replace initial display values when Pi emits them
7. The new behavior is covered by regression tests
