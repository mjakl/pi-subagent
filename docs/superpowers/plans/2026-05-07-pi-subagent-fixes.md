# Pi Subagent Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the packaging/runtime mismatch, tool error-contract gaps, and multipart final-output truncation without changing the public `subagent` interface.

**Architecture:** Keep the extension’s current structure intact and make narrow corrections in `index.ts`, `runner-events.js`, and `package.json`. Protect each correction with a targeted regression test so the original defects become hard to reintroduce.

**Tech Stack:** Node.js, TypeScript-loaded extension modules, Node built-in test runner (`node --test`), pi extension packaging/runtime

---

## File map

### Existing files to modify
- `index.ts` — tool registration, validation, and error result shaping
- `runner-events.js` — Pi JSON event parsing and final assistant text extraction
- `package.json` — packaged-extension peer dependency metadata
- `test/runner-events.test.mjs` — regression coverage for final output extraction

### New test files to create
- `test/package-metadata.test.mjs` — regression test for `typebox` import/peer dependency alignment
- `test/index.test.mjs` — regression tests for `subagent` tool error signaling on invalid inputs

### Existing files to review after code changes
- `README.md` — confirm no documentation update is needed because public usage stays unchanged

---

## Chunk 1: Packaging/runtime compatibility

### Task 1: Add a regression test for pi-compatible TypeBox packaging

**Files:**
- Create: `test/package-metadata.test.mjs`
- Modify: none
- Test: `test/package-metadata.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a source/metadata regression test that reads `index.ts` and `package.json` and asserts:
- `index.ts` imports `Type` from `"typebox"`
- `index.ts` does not import from `"@sinclair/typebox"`
- `package.json.peerDependencies` contains `typebox`
- `package.json.peerDependencies` does not contain `@sinclair/typebox`

Example skeleton:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("extension uses pi-compatible typebox import and peer dependency", () => {
  const indexSource = fs.readFileSync("index.ts", "utf8");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.match(indexSource, /from\s+"typebox"/);
  assert.doesNotMatch(indexSource, /from\s+"@sinclair\/typebox"/);
  assert.ok(pkg.peerDependencies.typebox);
  assert.equal(pkg.peerDependencies["@sinclair/typebox"], undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- --test test/package-metadata.test.mjs
```

Expected: FAIL because the repo currently uses `@sinclair/typebox`

- [ ] **Step 3: Write the minimal implementation**

Update:
- `index.ts` import to `import { Type } from "typebox";`
- `package.json` peer dependency entry from `@sinclair/typebox` to `typebox`
- `package.json.peerDependenciesMeta` to match the renamed key

Do not change any unrelated package metadata.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run:

```bash
npm test -- --test test/package-metadata.test.mjs
```

Expected: PASS

- [ ] **Step 5: Run publish-shape validation**

Run:

```bash
npm pack --dry-run
```

Expected: PASS with the same publish surface as before

- [ ] **Step 6: Commit**

```bash
git add test/package-metadata.test.mjs index.ts package.json
git commit -m "Fix TypeBox package metadata"
```

---

## Chunk 2: Tool error-contract correctness

### Task 2: Add tests for invalid `subagent` invocations returning `isError: true`

**Files:**
- Create: `test/index.test.mjs`
- Modify: `index.ts`
- Test: `test/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a testable harness for `index.ts` similar in spirit to `test/agents.test.mjs`:
- create a temporary copy of `index.ts`
- replace extension-specific imports with local stubs
- provide a fake `ExtensionAPI` object that captures `registerTool()` calls
- load the module and obtain the registered `subagent` tool

Write at least these failing cases:
1. invalid invocation shape returns `isError: true`
   - example: `{ agent: "writer" }`
2. too many parallel tasks returns `isError: true`
   - example: `{ tasks: new Array(9).fill({ agent: "writer", task: "x" }) }`

Suggested assertion shape:

```javascript
assert.equal(result.isError, true);
assert.match(result.content[0].text, /Invalid parameters|Too many parallel tasks/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- --test test/index.test.mjs
```

Expected: FAIL because at least one invalid path currently omits `isError: true`

- [ ] **Step 3: Write the minimal implementation**

In `index.ts`, update only the malformed-input / limit-violation result paths so they return `isError: true`.

Target the branches that currently emit failure text without marking the tool result as an error, including:
- invalid invocation shape
- fallback invalid-parameter return
- too many parallel tasks

Keep user-facing messages unchanged unless the test requires an exact wording correction.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run:

```bash
npm test -- --test test/index.test.mjs
```

Expected: PASS

- [ ] **Step 5: Run related tests to confirm no helper regressions**

Run:

```bash
npm test -- --test test/runner.test.mjs test/runner-events.test.mjs
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/index.test.mjs index.ts
git commit -m "Mark invalid subagent calls as errors"
```

---

## Chunk 3: Multipart final-output preservation

### Task 3: Add regression coverage for multipart final assistant messages

**Files:**
- Modify: `test/runner-events.test.mjs`
- Modify: `runner-events.js`
- Review: `types.ts`
- Test: `test/runner-events.test.mjs`, `test/runner.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a new test in `test/runner-events.test.mjs` that constructs a final assistant message like:

```javascript
{
  role: "assistant",
  content: [
    { type: "text", text: "Part 1. " },
    { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    { type: "text", text: "Part 2." },
  ],
  timestamp: 1,
}
```

Assert that `getFinalAssistantText(...)` returns:

```javascript
"Part 1. Part 2."
```

Also add a regression assertion that `getResultSummaryText(...)` returns the same combined text when this is the final assistant message.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- --test test/runner-events.test.mjs
```

Expected: FAIL because current logic returns only the first text part

- [ ] **Step 3: Write the minimal implementation**

Update `runner-events.js` so `getFinalAssistantText(messages)`:
- finds the last assistant message
- concatenates all text parts from that message in order
- ignores non-text parts
- returns the joined string
- preserves current fallback behavior when no text exists

Review `types.ts` afterward to confirm helpers that rely on `getFinalAssistantText()` still behave correctly without additional changes.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run:

```bash
npm test -- --test test/runner-events.test.mjs test/runner.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/runner-events.test.mjs runner-events.js types.ts
git commit -m "Preserve multipart final assistant output"
```

---

## Chunk 4: Final validation and documentation check

### Task 4: Verify the full fix set end-to-end

**Files:**
- Review: `README.md`
- Review: `package.json`
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

- [ ] **Step 3: Run a manual pi load smoke check**

Run:

```bash
pi -e . --help
```

Expected: command exits successfully and the extension does not fail during load

- [ ] **Step 4: Review docs impact**

Inspect `README.md` and confirm no update is required because:
- installation command remains the same
- tool interface remains the same
- mode semantics remain the same

If no change is needed, leave `README.md` untouched.

- [ ] **Step 5: Commit any final doc/test touch-ups if needed**

```bash
git add README.md package.json test/*.mjs
if ! git diff --cached --quiet; then git commit -m "Finalize subagent fix validation"; fi
```

---

## Definition of done

- [ ] `index.ts` imports `Type` from `typebox`
- [ ] `package.json` uses `typebox` in peer dependency metadata
- [ ] invalid `subagent` requests consistently return `isError: true`
- [ ] final assistant summaries preserve all text parts from the final assistant message
- [ ] `npm test` passes
- [ ] `npm pack --dry-run` passes
- [ ] `pi -e . --help` passes
