# Inline Agent Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the inline-agent implementation so same-name collisions cannot execute the wrong agent config, while preserving the public API and existing named-agent behavior.

**Architecture:** Replace shared name-only resolution for inline tasks with task-local runtime resolution. Keep discovered named agents on the existing discovery path, but ensure inline task items carry or reference their own resolved `AgentConfig` so same-name inline/named combinations and duplicate inline names are handled correctly. Add regression tests for the broken collision cases, then fix the smaller review items in rendering and schema/help text.

**Tech Stack:** Node.js, TypeScript-loaded pi extension modules, Node built-in test runner (`node --test`), pi extension runtime

---

## File map

### Existing files to modify
- `index.ts` — task validation, task shaping, and runtime dispatch for inline/named tasks
- `runner.ts` — allow task-local resolved agent execution without relying solely on shared name lookup
- `render.ts` — improve inline call preview naming
- `test/index.test.mjs` — add collision regression coverage and keep current inline-agent behavior tests green
- `README.md` — update any contract wording if validation/help text changes

### Existing files to review
- `agents.ts` — likely unchanged, unless a small helper is needed for task-local runtime identifiers
- `types.ts` — only if runtime task/result typing needs a narrow extension

---

## Chunk 1: Fix task-local resolution for inline agents

### Task 1: Add failing regression tests for same-name collisions

**Files:**
- Modify: `test/index.test.mjs`
- Modify: `index.ts`
- Modify: `runner.ts`
- Test: `test/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Extend `test/index.test.mjs` with at least these failing cases:

1. **Named + inline same-name in one parallel call**
   - one task uses `{ agent: "reviewer" }`
   - another task uses `{ agentDefinition: { name: "reviewer", ... } }`
   - assert the named task executes the discovered agent config
   - assert the inline task executes the inline config

2. **Two inline task items with the same public name**
   - both use `agentDefinition.name = "reviewer"`
   - give them different prompt/config markers in the stubbed execution path
   - assert each task gets its own intended config, or if the chosen implementation intentionally rejects duplicate inline names, assert the tool returns `isError: true` with a specific message

Recommended assertion strategy:
- capture both the selected runtime config and user-visible agent name in the stubbed runner
- make the stubbed output distinguish discovered vs inline config selection clearly

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- --test test/index.test.mjs
```

Expected: FAIL because current execution still resolves tasks by shared name lookup.

- [ ] **Step 3: Write the minimal implementation**

Choose the task-local resolution fix:
- update `index.ts` so each task carries its intended runtime agent identity/config, not just a public `name`
- update `runner.ts` so `runAgent()` can execute from a directly supplied `AgentConfig` (preferred), or from an opaque runtime identifier that uniquely maps to a single inline config
- keep named-agent execution on normal discovery lookup
- preserve the public output agent names shown to the caller

Implementation constraints:
- do not change the public `subagent` API
- do not regress single-mode inline support
- do not regress cycle checking or project-agent confirmation behavior

- [ ] **Step 4: Run the targeted test to verify it passes**

Run:

```bash
npm test -- --test test/index.test.mjs
```

Expected: PASS

- [ ] **Step 5: Run related execution regressions**

Run:

```bash
npm test -- --test test/runner.test.mjs test/runner-events.test.mjs
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/index.test.mjs index.ts runner.ts types.ts
git commit -m "Fix inline task agent resolution"
```

---

## Chunk 2: Close the review gaps in UI/help text

### Task 2: Fix inline call preview and stale schema/help wording

**Files:**
- Modify: `render.ts`
- Modify: `index.ts`
- Modify: `README.md`
- Test: `test/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a focused regression test for call-preview/schema behavior where practical:
- assert the tool description / schema text for parallel `tasks` mentions `agentDefinition`
- if `render.ts` is practical to test directly, add a test that inline calls display `agentDefinition.name` instead of `...` or `undefined`

If direct renderer testing is too heavy, write the minimum possible unit around `renderCall()` or document the renderer update and verify manually later.

- [ ] **Step 2: Run the test to verify it fails**

Run the smallest relevant command, for example:

```bash
npm test -- --test test/index.test.mjs
```

Expected: FAIL for the stale contract wording or missing inline render behavior.

- [ ] **Step 3: Write the minimal implementation**

In `render.ts`:
- make inline calls display `agentDefinition.name` when `agent` is absent

In `index.ts`:
- update any stale schema/description text so `tasks` documents `agentDefinition`
- ensure examples and validation wording remain accurate after the task-local resolution fix

In `README.md`:
- align wording only if the implementation changed behavior or clarification is needed for same-name task handling

- [ ] **Step 4: Run the targeted test to verify it passes**

Run:

```bash
npm test -- --test test/index.test.mjs
```

Expected: PASS

- [ ] **Step 5: Run focused manual verification if renderer test coverage is thin**

Run:

```bash
pi -e . --help
```

Then inspect the inline-agent examples / tool help text for accuracy.

- [ ] **Step 6: Commit**

```bash
git add render.ts index.ts README.md test/index.test.mjs
git commit -m "Polish inline agent UX"
```

---

## Chunk 3: Final verification

### Task 3: Re-run full verification on the review fixes

**Files:**
- Review: working tree state only
- Test: full repository validation

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 2: Run package validation**

Run:

```bash
npm pack --dry-run
```

Expected: PASS

- [ ] **Step 3: Run a manual extension load check**

Run:

```bash
pi -e . --help
```

Expected: exit 0

- [ ] **Step 4: Commit any final touch-ups if needed**

```bash
git add .
if ! git diff --cached --quiet; then git commit -m "Finalize inline agent review fixes"; fi
```

---

## Definition of done

- [ ] same-name named + inline tasks in one call resolve to the correct intended configs
- [ ] duplicate inline-name behavior is either correctly supported or explicitly rejected with a clear error
- [ ] single-mode inline behavior remains green
- [ ] cycle checking still applies to inline names
- [ ] project-agent confirmation still ignores inline-only tasks
- [ ] inline call previews show meaningful names
- [ ] parallel schema/help text documents `agentDefinition`
- [ ] `npm test` passes
- [ ] `npm pack --dry-run` passes
- [ ] `pi -e . --help` passes
