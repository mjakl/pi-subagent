# Project guidance

`@mjakl/pi-subagent` is a Pi extension with entry point `index.ts`.

## Setup and validation

Use Node.js and npm. Install dependencies with `npm install`.

For code changes, run the automated checks appropriate to the changed behavior:

- `npm test` — Node.js test suite in `test/`.
- `npm run check` — TypeScript checking without emitting files.

For documentation-only changes, verify referenced commands and paths and inspect
the diff for accuracy; runtime checks are not required unless behavior is affected.

Use `pi -e .` for a targeted manual check of the local extension when needed, not
as a replacement for automated checks.

When changing package contents or publishing configuration, inspect both dry runs:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Navigation

- `index.ts` — extension entry point and tool registration.
- `agents.ts` — agent discovery and parsing.
- `contract.ts` — parent-facing tool contract text and prompt rendering.
- `runner.ts` — subagent process execution; `runner-cli.js` and `runner-events.js`
  handle CLI inheritance and RPC events.
- `session-lock.ts`, `session-paths.ts` — named-session locking and storage paths.
- `delegation-metadata.ts` — persisted cross-process delegation metadata.
- `output.ts` — result summaries, truncation, and full-output saving.
- `render.ts` — TUI rendering for tool calls and results.
- `types.ts` — shared types and result helpers.
- `test/` — automated tests.

Before changing the tool API or runtime/session behavior, read the relevant
[README technical reference](README.md#technical-reference) and corresponding
implementation and tests.

## Commits and releases

Use focused commits with imperative, sentence-case messages and no `feat:`,
`fix:`, or `chore:` prefix.

Only version or publish the package for an explicitly authorized release, not
as part of an ordinary code or documentation task. For an authorized release,
bump the version with `npm version patch`, `npm version minor`, or
`npm version major` as appropriate, then publish with `npm publish --access public`.
