# Repro: final non-zero tool exit hides subagent output

This regression showed up when the last tool call in a subagent failed with a non-zero exit code, for example:

```bash
rg definitely-does-not-exist .
```

Before the fix, `pi-subagent` only parsed `message_end` and a non-existent `tool_result_end` event.
Pi's JSON mode actually emits the final failure context on `turn_end` / `agent_end`, so the extension could miss the final assistant error/output and collapse the result to `(no output)`.

## Automated repro

Run:

```bash
npm test
```

Relevant files:

- `test/fixtures/agent-end-error-only.jsonl` — captured JSON event sequence reproducing the bug
- `test/runner-events.test.mjs` — regression tests for parsing and result summarization
