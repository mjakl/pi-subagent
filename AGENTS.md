# AGENTS.md

Simple guidance for coding agents working in this repository.

## Repository setup

- Requirements: Node.js + npm
- Install dependencies:

```bash
npm install
```

- Check what would be published:

```bash
npm pack --dry-run
npm publish --dry-run --access public
```

## Local validation

- This package is a Pi extension (entry point: `index.ts`).
- Quick manual check with local package:

```bash
pi -e .
```

## Code map

- `index.ts` — extension entry point and tool registration
- `agents.ts` — agent discovery/parsing
- `runner.ts` — subagent process execution
- `render.ts` — TUI rendering for tool calls/results
- `types.ts` — shared types/helpers
- `README.md` — user-facing docs

## Commit format (important)

Use the repository's existing style:

- Imperative mood
- Sentence case
- No prefix like `feat:` / `fix:` / `chore:`

Examples:

- `Add depth-limited subagent delegation`
- `Scope npm package name`
- `Add npm install option to README`

Keep commits focused (one logical change per commit).

## Release notes

- Package name: `@mjakl/pi-subagent`
- For doc/code changes on npm, publish a new version (`npm version patch|minor|major`), then publish.
