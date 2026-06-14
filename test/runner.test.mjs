import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function createTestableRunnerModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runner-"));
  const modulePath = path.join(tmpDir, "runner.testable.ts");
  const source = fs
    .readFileSync(path.join(process.cwd(), "runner.ts"), "utf-8")
    .replace('from "./runner-cli.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-cli.js")).href)}`)
    .replace('from "./runner-events.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`)
    .replace('from "./types.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`);
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeResult(overrides = {}) {
  return {
    agent: "oracle",
    agentSource: "user",
    prompt: "repro",
    initialContext: "empty",
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
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves process-level errors despite semantic completion", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult does not mask process-level errors on abort", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult preserves semantic completion when the process is aborted after agent_end", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("rewriteSessionHeaderCwd updates only the session header cwd", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { rewriteSessionHeaderCwd } = await import(moduleUrl);
    const input = [
      JSON.stringify({ type: "session", id: "parent", cwd: "/old", version: 3 }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } }),
      "",
    ].join("\n");

    const output = rewriteSessionHeaderCwd(input, "/new");
    assert.ok(output);
    const lines = output.trimEnd().split("\n");
    assert.deepEqual(JSON.parse(lines[0]), {
      type: "session",
      id: "parent",
      cwd: "/new",
      version: 3,
    });
    assert.equal(JSON.parse(lines[1]).message.content, "hi");
  } finally {
    cleanup();
  }
});

test("runAgent returns immediately when the signal is already aborted", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { runAgent } = await import(moduleUrl);
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent({
      cwd: process.cwd(),
      agents: [
        {
          name: "review",
          description: "reviewer",
          source: "user",
          systemPrompt: "",
        },
      ],
      callIndex: 0,
      agentName: "review",
      prompt: "hello",
      initialContext: "empty",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      signal: controller.signal,
      makeDetails: (results) => ({ projectAgentsDir: null, results }),
    });

    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.errorMessage, "Subagent was aborted.");
  } finally {
    cleanup();
  }
});

test("buildPiArgs plans ephemeral and persistent session flags", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { buildPiArgs } = await import(moduleUrl);
    const agent = {
      name: "review",
      description: "reviewer",
      source: "user",
      systemPrompt: "",
    };
    const session = {
      handle: "api-review",
      id: "subagent.abc123",
      name: "subagent: review · api-review",
      cwd: "/repo",
      created: true,
      initialContextApplied: "parent",
    };

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined),
      ["--mode", "json", "-p", "--no-session", "hello"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", undefined, undefined),
      ["--mode", "json", "-p", "--session", "/tmp/parent.jsonl", "hello"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", session, undefined),
      [
        "--mode",
        "json",
        "-p",
        "--fork",
        "/tmp/parent.jsonl",
        "--session-id",
        "subagent.abc123",
        "--name",
        "subagent: review · api-review",
        "hello",
      ],
    );

    assert.deepEqual(
      buildPiArgs(
        agent,
        null,
        "hello",
        "parent",
        "/tmp/parent.jsonl",
        { ...session, created: false, initialContextApplied: null },
        undefined,
      ),
      ["--mode", "json", "-p", "--session-id", "subagent.abc123", "hello"],
    );
  } finally {
    cleanup();
  }
});
