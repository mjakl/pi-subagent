import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});
