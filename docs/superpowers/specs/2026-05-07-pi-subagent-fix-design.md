# Pi Subagent Fix Design

**Date:** 2026-05-07
**Repository:** `~/PersonalProjects/pi-subagent`
**Scope:** Recommended
**Constraint:** Preserve the current public tool interface and README usage behavior

---

## Goal

Fix the packaging/runtime defect and the correctness issues identified in the extension review without changing the public `subagent` tool interface, spawn/fork semantics, or documented usage patterns.

## Confirmed Issues

1. **Packaging/runtime mismatch**
   - `index.ts` imports `@sinclair/typebox`
   - Pi extension/package docs expect `typebox`
   - `package.json` also declares `@sinclair/typebox` instead of `typebox`
   - This can make the extension fail to load in a clean pi environment even if tests and `npm pack --dry-run` pass

2. **Invalid tool calls are not always marked as errors**
   - Some malformed input paths return explanatory text without `isError: true`
   - This weakens the tool contract for LLM self-correction and machine-readable handling

3. **Final output extraction can truncate multipart assistant messages**
   - Current logic returns the first text part from the last assistant message
   - This can drop later text parts from the same final assistant response

4. **Validation coverage misses the highest-risk failure modes**
   - Existing tests cover helpers well
   - They do not currently protect against the packaging/load problem or the tool error-contract problem

---

## Non-Goals

The following are explicitly out of scope for this fix set:

- Changing the `subagent` tool schema
- Changing parameter names or mode names
- Changing spawn/fork semantics
- Broad refactoring unrelated to the identified issues
- Adding general lint/typecheck/tooling cleanup
- Release/version bump work

---

## Recommended Approach

Use a **targeted correctness + hardening** approach:

- fix the concrete defects only
- add narrow tests that would have caught them
- keep UX and public behavior stable except where current behavior is objectively incorrect

This provides a high confidence fix with minimal drift risk.

---

## Solution Design

### 1. Packaging/runtime compatibility

**Files likely affected**
- `index.ts`
- `package.json`
- possibly `README.md` only if package/dependency guidance needs correction

**Design**
- Replace runtime imports from `@sinclair/typebox` with `typebox`
- Align package metadata with pi’s documented package expectations
- Keep pi core packages as peer dependencies only
- Avoid introducing any new runtime dependencies

**Expected result**
- The extension continues to install and run the same way from the user’s perspective
- The package becomes compatible with pi’s packaged-extension expectations
- A clean load/import check no longer fails because of the TypeBox package name

### 2. Tool error-contract correctness

**Files likely affected**
- `index.ts`
- `test/` files covering tool execution behavior

**Design**
- Preserve the current validation messages and branching logic
- Ensure all parameter-validation and limit-violation outcomes that are semantically failures return `isError: true`
- Keep successful and canceled flows unchanged unless they are currently misclassified

**Expected result**
- The tool remains user-compatible
- Calling models receive explicit failure signals for malformed requests
- Machine-readable behavior becomes more reliable

### 3. Multipart final output extraction

**Files likely affected**
- `runner-events.js`
- `types.ts`
- `test/runner-events.test.mjs`
- possibly `test/runner.test.mjs`

**Design**
- Preserve the current rule that the parent agent receives only final assistant text
- Change final text extraction to join all text parts from the last assistant message, in order
- Ignore non-text parts
- Keep existing fallback behavior when no text exists

**Expected result**
- No public interface change
- More faithful final output passed back to the main agent
- No loss of text when the last assistant message is multipart

### 4. Targeted hardening

**Files likely affected**
- `test/index.test.mjs` or equivalent new tool-contract test file
- `test/runner-events.test.mjs`
- `test/package-metadata.test.mjs` or equivalent packaging regression test file

**Design**
- Add a regression test that asserts the extension source and package metadata use `typebox`, not `@sinclair/typebox`
- Add tests that verify malformed tool calls surface `isError: true`
- Add multipart final-output tests that prove all text parts are preserved
- Keep the current lightweight `node --test` strategy

**Expected result**
- The exact defects from the review become test-protected
- Future maintenance is less likely to reintroduce the same issues

---

## Testing Strategy

Implementation should follow TDD in three slices.

### Slice 1: Packaging/runtime
1. Add a failing regression test for TypeBox import/package metadata alignment
2. Update `index.ts` and `package.json`
3. Verify:
   - `npm test`
   - `npm pack --dry-run`
   - manual load smoke check such as `pi -e . --help`

### Slice 2: Tool error contract
1. Add failing tests for malformed tool invocations / limit violations
2. Update `index.ts` to consistently return `isError: true`
3. Verify existing text output remains stable

### Slice 3: Multipart final text
1. Add failing tests for multipart final assistant messages
2. Update `runner-events.js` (and any dependent helpers if needed)
3. Verify single-part behavior remains unchanged

### Final verification
- `npm test`
- `npm pack --dry-run`
- `pi -e . --help`

---

## Risks and Mitigations

### Risk: accidental public behavior drift
**Mitigation:** limit changes to import/package metadata, error flags, and text extraction only; do not alter parameter names or mode semantics.

### Risk: new tests become too coupled to pi internals
**Mitigation:** prefer focused regression tests around package metadata, helper behavior, and minimal tool-contract execution paths.

### Risk: multipart output joining changes display formatting unexpectedly
**Mitigation:** join text parts in natural order and preserve existing fallback behavior for non-text-only messages.

---

## File Impact Summary

### Modify
- `index.ts`
- `package.json`
- `runner-events.js`
- `types.ts` (only if helper expectations need adjustment)
- `README.md` (only if validation shows a packaging note needs to be corrected)

### Add or expand tests
- `test/runner-events.test.mjs`
- `test/index.test.mjs` or similar tool-contract test file
- `test/package-metadata.test.mjs` or similar packaging regression test file

---

## Success Criteria

This work is successful when all of the following are true:

1. The extension source and package metadata align with pi’s documented `typebox` packaging expectations
2. Invalid tool invocations and limit violations consistently return `isError: true`
3. Final assistant output preserves all text parts from the final assistant message
4. `npm test` passes
5. `npm pack --dry-run` passes
6. A manual pi load smoke check succeeds
