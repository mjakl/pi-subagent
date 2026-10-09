import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function createTestableRunnerModule(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runner-"));
  const modulePath = path.join(tmpDir, "runner.testable.ts");
  const codingAgentDir = path.join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
  );
  let source = fs
    .readFileSync(path.join(process.cwd(), "runner.ts"), "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      `from ${JSON.stringify(pathToFileURL(path.join(codingAgentDir, "index.js")).href)}`,
    )
    .replace('from "./runner-cli.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-cli.js")).href)}`)
    .replace('from "./runner-events.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`)
    .replace('from "./agents.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "agents.ts")).href)}`)
    .replace('from "./types.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`)
    .replace('from "./delegation-metadata.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "delegation-metadata.ts")).href)}`)
    .replace('new URL("./delegation-metadata.ts", import.meta.url)', `new URL(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "delegation-metadata.ts")).href)})`);
  if (options.rpcEntryPath !== undefined) {
    source = source.replace(
      "return { command: process.execPath, prefixArgs: [resolvePiRpcEntry()] };",
      `return { command: process.execPath, prefixArgs: [${JSON.stringify(options.rpcEntryPath)}, "--mode", "rpc"] };`,
    );
  }
  if (options.maxJsonLineBytes !== undefined) {
    source = source.replace(
      "const MAX_JSON_LINE_BYTES = 25 * 1024 * 1024;",
      `const MAX_JSON_LINE_BYTES = ${options.maxJsonLineBytes};`,
    );
  }
  if (options.forceWindows === true) {
    source = source.replace(
      'const isWindows = process.platform === "win32";',
      "const isWindows = true;",
    );
  }
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function createRunnerProcessHarness(name, runnerOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagent-${name}-`));
  const harnessPath = path.join(tmpDir, `${name}-harness.mjs`);
  const runnerModule = createTestableRunnerModule({
    ...runnerOptions,
    rpcEntryPath: harnessPath,
  });

  return {
    moduleUrl: runnerModule.moduleUrl,
    tmpDir,
    harnessPath,
    runJson: () => JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", harnessPath], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    ),
    cleanup: () => {
      runnerModule.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
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
    pendingToolError: "Command exited with code 1",
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

test("normalizeCompletedResult preserves provider failures after partial output", () => {
  for (const exitCode of [0, 1]) {
    const result = makeResult({
      exitCode,
      stopReason: "error",
      errorMessage: "Connection reset while streaming",
      stderr: "Connection reset while streaming",
      sawAgentEnd: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial answer" }],
          timestamp: 1,
        },
      ],
    });

    normalizeCompletedResult(result, false);

    assert.equal(isResultSuccess(result), false);
    assert.equal(isResultError(result), true);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Connection reset while streaming");
  }
});

test("normalizeCompletedResult keeps aborted provider output as a failure", () => {
  const result = makeResult({
    exitCode: 0,
    stopReason: "aborted",
    errorMessage: "Request aborted",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
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

test("normalizeCompletedResult preserves settled completion when teardown is aborted", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    sawAgentSettled: true,
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

test("normalizeCompletedResult preserves settled attributed tool errors on teardown abort", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    pendingToolError: "Command exited with code 1",
    sawAgentEnd: true,
    sawAgentSettled: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
});

test("normalizeCompletedResult rejects aborted intermediate agent_end output", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "stop",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Intermediate answer" }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(isResultError(result), true);
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

test("clean process exit without agent completion is a failure", () => {
  const result = makeResult({ exitCode: 0 });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /without completing an agent run/);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("classifies only unexpected signal exits as process failures", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { getUnexpectedSignalFailure } = await import(moduleUrl);

    const failure = getUnexpectedSignalFailure(null, "SIGTERM", false, undefined);
    assert.ok(failure);
    assert.equal(failure.exitCode > 0, true);
    assert.match(failure.message, /SIGTERM/);

    assert.equal(getUnexpectedSignalFailure(1, null, false, undefined), null);
    assert.equal(getUnexpectedSignalFailure(null, "SIGTERM", true, undefined), null);
    assert.equal(getUnexpectedSignalFailure(null, "SIGTERM", false, 1), null);
  } finally {
    cleanup();
  }
});

test("compares working directories by canonical path", {
  skip: process.platform === "win32",
}, async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-same-cwd-"));
  const physical = path.join(tmpDir, "physical");
  const alias = path.join(tmpDir, "alias");
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, "dir");

  try {
    const { isSameWorkingDirectory } = await import(moduleUrl);
    assert.equal(isSameWorkingDirectory(physical, alias), true);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("per-call inactivity timeout overrides the agent default", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { resolveInactivityTimeoutMs } = await import(moduleUrl);
    assert.equal(resolveInactivityTimeoutMs(undefined, undefined), undefined);
    assert.equal(resolveInactivityTimeoutMs(undefined, 12), 12_000);
    assert.equal(resolveInactivityTimeoutMs(3_000, 12), 3_000);
  } finally {
    cleanup();
  }
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

test("runAgent converts synchronous spawn failures into structured results", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { runAgent } = await import(moduleUrl);
    const result = await runAgent({
      cwd: process.cwd(),
      agents: [
        {
          name: "invalid-model",
          description: "invalid model",
          source: "user",
          systemPrompt: "",
          model: "bad\0model",
        },
      ],
      callIndex: 0,
      agentName: "invalid-model",
      prompt: "hello",
      initialContext: "empty",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /null bytes|invalid/i);
  } finally {
    cleanup();
  }
});

test("runAgent propagates per-call thinking and inherits the exact parent model", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("parent-model");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const final = {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(process.argv) }],
        model: "child-resolved-model",
        stopReason: "stop",
        timestamp: 1,
      };
      process.stdout.write(JSON.stringify({ type: "message_end", message: final }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [final] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "review", description: "review", source: "user", systemPrompt: "", thinking: "high" }],
        callIndex: 0,
        agentName: "review",
        prompt: "hello",
        callThinking: "off",
        parentModel: { provider: "openrouter", id: "openrouter/free" },
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.model, "child-resolved-model");
    const childArgv = JSON.parse(result.messages[0].content[0].text);
    const modelIndex = childArgv.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(childArgv[modelIndex + 1], "openrouter/openrouter/free");
    assert.equal(childArgv.includes("--provider"), false);
    assert.equal(childArgv[childArgv.indexOf("--thinking") + 1], "off");
    assert.equal(childArgv.filter((arg) => arg === "--thinking").length, 1);
  } finally {
    cleanup();
  }
});

test("runAgent waits for agent_settled across multiple low-level runs", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("settled");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const intermediate = { role: "assistant", content: [{ type: "text", text: "intermediate" }], stopReason: "stop", timestamp: 1 };
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [intermediate] }) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 400));
      const final = { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop", timestamp: 2 };
      process.stdout.write(JSON.stringify({ type: "message_end", message: final }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [final] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "retry", description: "retry", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "retry",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 0);
    assert.equal(result.sawAgentSettled, true);
    assert.deepEqual(
      result.messages.map((message) => message.content[0].text),
      ["intermediate", "final"],
    );
  } finally {
    cleanup();
  }
});

test("runAgent delivers CLI-like prompts verbatim through stdin", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("stdin");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const prompt = await new Promise((resolve) => {
        process.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString().trim()).message));
      });
      const message = {
        role: "assistant",
        content: [{ type: "text", text: prompt }],
        stopReason: "stop",
        timestamp: 1,
      };
      const writeEvent = async (event) => {
        const bytes = Buffer.from(JSON.stringify(event) + "\\n");
        const emojiOffset = bytes.indexOf(Buffer.from("😀"));
        if (emojiOffset === -1) {
          process.stdout.write(bytes);
          return;
        }
        process.stdout.write(bytes.subarray(0, emojiOffset + 1));
        await new Promise((resolve) => setImmediate(resolve));
        process.stdout.write(bytes.subarray(emojiOffset + 1));
      };
      await writeEvent({ type: "message_end", message });
      await writeEvent({ type: "agent_end", messages: [message] });
      await writeEvent({ type: "agent_settled" });
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const prompt of ["--approve", "--help", "@/tmp/secret", "-leading", "  padded prompt  \\n", "emoji 😀 boundary"]) {
        results.push(await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "echo", description: "echo", source: "user", systemPrompt: "" }],
          callIndex: 0,
          agentName: "echo",
          prompt,
          initialContext: "empty",
          parentDepth: 0,
          parentAgentStack: [],
          maxDepth: 3,
          preventCycles: true,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        }));
      }
      process.stdout.write(JSON.stringify(results));
    }`,
  );

  try {
    const results = runJson();

    assert.deepEqual(
      results.map((result) => result.messages.at(-1).content[0].text),
      ["--approve", "--help", "@/tmp/secret", "-leading", "  padded prompt  \n", "emoji 😀 boundary"],
    );
    assert.equal(results.every((result) => result.exitCode === 0), true);
  } finally {
    cleanup();
  }
});

test("runAgent appends finite runtime guidance across child session paths", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("runtime-prompt");
  const guidance = "Your runtime shuts down after your final response. Finish required commands and inspect their results before returning. Use explicit or blocking waits where available; do not rely on notifications after your final response. Stop temporary services you started for your own work before returning. For a test server: start it, wait for readiness (not exit), run tests, wait for test completion and inspect results, stop the server, then respond.";
  const cases = [
    { initialContext: "empty", systemPrompt: "" },
    { initialContext: "parent", systemPrompt: "  Keep agent instructions verbatim.\n" },
    { initialContext: "empty", created: true },
    { initialContext: "parent", created: true },
    { initialContext: "parent", created: false },
    { initialContext: "empty", parentDepth: 1 },
  ];

  fs.writeFileSync(harnessPath, `
    import fs from "node:fs";
    if (process.argv.includes("--mode")) {
      const index = process.argv.indexOf("--append-system-prompt");
      const text = JSON.stringify({
        append: index < 0 ? null : fs.readFileSync(process.argv[index + 1], "utf8"),
        replacesBase: process.argv.includes("--system-prompt"),
      });
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 };
      process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const [i, item] of ${JSON.stringify(cases)}.entries()) {
        results.push(await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "worker", description: "worker", source: "user", systemPrompt: item.systemPrompt ?? "Agent-specific instructions." }],
          callIndex: i,
          agentName: "worker",
          prompt: "Do the task.",
          initialContext: item.initialContext,
          parentSessionSnapshotJsonl: JSON.stringify({ type: "session", cwd: process.cwd() }) + "\\n",
          session: item.created === undefined ? undefined : {
            handle: "work", id: "subagent.test", name: "work", cwd: process.cwd(),
            created: item.created, initialContextApplied: item.created ? item.initialContext : null,
          },
          parentDepth: item.parentDepth ?? 0,
          parentAgentStack: item.parentDepth ? ["parent"] : [],
          maxDepth: 3,
          preventCycles: true,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        }));
      }
      process.stdout.write(JSON.stringify(results));
    }
  `);

  try {
    const results = runJson();
    for (const [i, result] of results.entries()) {
      assert.equal(result.exitCode, 0);
      const prompt = JSON.parse(result.messages.at(-1).content[0].text);
      const agentPrompt = cases[i].systemPrompt ?? "Agent-specific instructions.";
      assert.deepEqual(prompt, {
        append: [agentPrompt, "## Subagent runtime\n\n" + guidance].filter(Boolean).join("\n\n"),
        replacesBase: false,
      });
    }
  } finally {
    cleanup();
  }
});

test("runAgent auto-cancels inherited RPC extension dialogs", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("dialog");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        buffer += chunk;
        const lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "prompt") {
            process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "dialog-1", method: "confirm" }) + "\\n");
          }
          if (event.type === "extension_ui_response") {
            const message = { role: "assistant", content: [{ type: "text", text: String(event.cancelled) }], stopReason: "stop", timestamp: 1 };
            process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
            process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
            process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
            process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          }
        }
      }
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "dialog", description: "dialog", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "dialog",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.at(-1).content[0].text, "true");
  } finally {
    cleanup();
  }
});

test("runAgent settles prompts handled without an agent run", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("handled");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        buffer += chunk;
        const lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const command = JSON.parse(line);
          if (command.type === "prompt") {
            process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");
          }
          if (command.type === "get_state") {
            process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { isStreaming: false } }) + "\\n");
          }
        }
      }
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "handled", description: "handled", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "handled",
        prompt: "/handled-command",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 0);
    assert.equal(result.handledWithoutAgent, true);
    assert.equal(result.sawAgentSettled, true);
  } finally {
    cleanup();
  }
});

test("runAgent does not treat an accepted streaming prompt as handled", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("accepted");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      let buffer = "";
      let finishTimer;
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        buffer += chunk;
        const lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const command = JSON.parse(line);
          if (command.type === "prompt") {
            process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true }) + "\\n");
            finishTimer = setTimeout(() => {
              const message = { role: "assistant", content: [{ type: "text", text: "completed" }], stopReason: "stop", timestamp: 1 };
              process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
              process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
              process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
              process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
            }, 500);
          }
          if (command.type === "get_state") {
            process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { isStreaming: true } }) + "\\n");
          }
        }
      }
      clearTimeout(finishTimer);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "accepted", description: "accepted", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "accepted",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 0);
    assert.equal(result.handledWithoutAgent, undefined);
    assert.equal(result.messages.at(-1).content[0].text, "completed");
  } finally {
    cleanup();
  }
});

test("runAgent propagates the effective deny policy in every launch mode, not the ambient value", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("deny-env");
  fs.writeFileSync(harnessPath, `
    if (process.argv.includes("--mode")) {
      const message = { role: "assistant", content: [{ type: "text", text: process.env.PI_SUBAGENT_DENY_AGENTS }], stopReason: "stop", timestamp: 1 };
      for (const event of [{ type: "message_end", message }, { type: "agent_end", messages: [message] }, { type: "agent_settled" }]) {
        process.stdout.write(JSON.stringify(event) + "\\n");
      }
    } else {
      process.env.PI_SUBAGENT_DENY_AGENTS = "[]";
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const mode of ["ephemeral", "parent-seeded", "fresh", "continued"]) {
        const session = mode === "fresh" || mode === "continued" ? {
          id: "subagent.deny-env", handle: "helper", name: "helper", cwd: process.cwd(),
          created: mode === "fresh", initialContextApplied: mode === "fresh" ? "empty" : null,
        } : undefined;
        results.push(await runAgent({
          cwd: process.cwd(), agents: [{ name: "helper", description: "allowed", source: "user", systemPrompt: "" }],
          callIndex: 0, agentName: "helper", prompt: "hello", parentSessionId: "parent",
          initialContext: mode === "parent-seeded" ? "parent" : "empty",
          parentSessionSnapshotJsonl: JSON.stringify({ type: "session", version: 3, id: "parent", cwd: process.cwd() }) + "\\n",
          session, parentDepth: 1, parentAgentStack: ["worker"], maxDepth: 4, preventCycles: false,
          deniedAgentNames: ["blocked", "another"],
          makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
        }));
      }
      process.stdout.write(JSON.stringify(results));
    }
  `);
  try {
    const results = runJson();
    assert.equal(results.length, 4);
    for (const result of results) {
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.messages.at(-1).content[0].text, '["blocked","another"]');
    }
  } finally {
    cleanup();
  }
});

test("runAgent terminates a silent child after its inactivity timeout", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("inactivity");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "silent", description: "silent", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "silent",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        inactivityTimeoutMs: 300,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.match(result.errorMessage, /child RPC stdout activity.*inactivity timeout/);
  } finally {
    cleanup();
  }
});

test("runAgent handles Windows taskkill spawn failures without crashing", () => {
  const { moduleUrl, tmpDir, harnessPath, runJson, cleanup } = createRunnerProcessHarness(
    "taskkill-error",
    { forceWindows: true },
  );

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      setInterval(() => {}, 1000);
    } else {
      process.env.PATH = ${JSON.stringify(tmpDir)};
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "windows", description: "windows", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "windows",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        inactivityTimeoutMs: 100,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.match(result.errorMessage, /inactivity timeout/);
    assert.match(result.stderr, /Could not start Windows taskkill/);
  } finally {
    cleanup();
  }
});

test("runAgent stops inactivity timing after a named session settles", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("settled-inactivity");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "completed before session flush" }],
        stopReason: "stop",
        timestamp: 1,
      };
      process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      setTimeout(() => {}, 900);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "settled", description: "settled", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "settled",
        prompt: "hello",
        initialContext: "empty",
        session: {
          handle: "settled-session",
          id: "subagent.settled",
          name: "subagent: settled · settled-session",
          cwd: process.cwd(),
          created: false,
          initialContextApplied: null,
        },
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        inactivityTimeoutMs: 500,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.exitCode, 0);
    assert.equal(result.processError, undefined);
    assert.equal(result.sawAgentSettled, true);
    assert.equal(result.messages.at(-1).content[0].text, "completed before session flush");
  } finally {
    cleanup();
  }
});

test("runAgent preserves the watchdog reason when late failures arrive", {
  skip: process.platform === "win32",
}, () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness(
    "late-rpc",
    { maxJsonLineBytes: 1024 },
  );

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      process.on("SIGTERM", () => {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "partial output after timeout" }],
          stopReason: "error",
          errorMessage: "late provider error",
          timestamp: 1,
        };
        process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
        process.stdout.write("x".repeat(1025) + "\\n");
      });
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "late", description: "late", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "late",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        inactivityTimeoutMs: 500,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();
    assert.equal(result.processError, true);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /child RPC stdout activity.*inactivity timeout/);
    assert.doesNotMatch(result.errorMessage, /late provider error/);
    assert.equal(result.messages.at(-1).content[0].text, "partial output after timeout");
  } finally {
    cleanup();
  }
});

test("runAgent resets inactivity only for child stdout activity", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("activity");

  fs.writeFileSync(
    harnessPath,
    `const mode = process.env.PI_SUBAGENT_ACTIVITY_CASE;
    if (process.argv.includes("--mode")) {
      let count = 0;
      const stream = mode === "stdout" ? process.stdout : process.stderr;
      const timer = setInterval(() => {
        stream.write(".");
        count++;
        if (mode === "stdout" && count === 6) {
          clearInterval(timer);
          const message = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 1 };
          process.stdout.write("\\n" + JSON.stringify({ type: "message_end", message }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }
      }, 100);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const mode of ["stdout", "stderr"]) {
        process.env.PI_SUBAGENT_ACTIVITY_CASE = mode;
        results.push(await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "activity", description: "activity", source: "user", systemPrompt: "" }],
          callIndex: 0,
          agentName: "activity",
          prompt: "hello",
          initialContext: "empty",
          parentDepth: 0,
          parentAgentStack: [],
          maxDepth: 3,
          preventCycles: true,
          inactivityTimeoutMs: 300,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        }));
      }
      delete process.env.PI_SUBAGENT_ACTIVITY_CASE;
      process.stdout.write(JSON.stringify(results));
    }`,
  );

  try {
    const [stdoutResult, stderrResult] = runJson();
    assert.equal(stdoutResult.exitCode, 0);
    assert.equal(stdoutResult.messages.at(-1).content[0].text, "done");
    assert.equal(stderrResult.exitCode, 1);
    assert.match(stderrResult.errorMessage, /inactivity timeout/);
  } finally {
    cleanup();
  }
});

test("runAgent enforces an explicitly configured wall-clock timeout", () => {
  const { moduleUrl, harnessPath, runJson, cleanup } = createRunnerProcessHarness("timeout");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "hang", description: "hang", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "hang",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        timeoutMs: 100,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = runJson();

    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /configured 0\.1s run timeout/);
  } finally {
    cleanup();
  }
});

test(
  "runAgent inactivity timeout terminates Unix descendant processes",
  { skip: process.platform === "win32" },
  () => {
    const { moduleUrl, tmpDir, harnessPath, runJson, cleanup } =
      createRunnerProcessHarness("tree");
    const readyPath = path.join(tmpDir, "descendant-ready");
    const markerPath = path.join(tmpDir, "descendant-marker");

    fs.writeFileSync(
      harnessPath,
      `import fs from "node:fs";
      import { spawn } from "node:child_process";
      if (process.argv.includes("--mode")) {
        spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); process.on("SIGTERM", () => {}); setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, "alive"), 1200)`) }], { stdio: "ignore" });
        setInterval(() => {}, 1000);
      } else {
        const { runAgent } = await import(${JSON.stringify(moduleUrl)});
        const result = await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "tree", description: "tree", source: "user", systemPrompt: "" }],
          callIndex: 0,
          agentName: "tree",
          prompt: "hello",
          initialContext: "empty",
          parentDepth: 0,
          parentAgentStack: [],
          maxDepth: 3,
          preventCycles: true,
          inactivityTimeoutMs: 500,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        process.stdout.write(JSON.stringify({
          result,
          descendantStarted: fs.existsSync(${JSON.stringify(readyPath)}),
          markerExists: fs.existsSync(${JSON.stringify(markerPath)}),
        }));
      }`,
    );

    try {
      const output = runJson();
      assert.equal(output.result.processError, true);
      assert.equal(output.descendantStarted, true);
      assert.equal(output.markerExists, false);
    } finally {
      cleanup();
    }
  },
);

test("thinking precedence preserves CLI fallback and unset behavior across session modes", () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    for (const fallback of [undefined, "medium"]) {
      const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
        process.env.PI_CODING_AGENT = "true";
        process.argv = ["node", "pi", ...${JSON.stringify(fallback ? ["--thinking", fallback] : [])}];
        const { buildPiArgs } = await import(${JSON.stringify(moduleUrl)});
        const levels = [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"];
        const results = [];
        for (const created of [undefined, true, false]) {
          const session = created === undefined ? undefined : {
            id: "child", handle: "review", name: "review", cwd: process.cwd(), created,
            initialContextApplied: created ? "empty" : null,
          };
          for (const agentThinking of [undefined, "high"]) {
            const agent = { name: "review", thinking: agentThinking };
            for (const callThinking of levels) {
              const args = buildPiArgs(agent, null, "hello", "empty", null, session,
                undefined, undefined, undefined, true, callThinking);
              results.push({ args, expected: callThinking ?? agentThinking ?? ${JSON.stringify(fallback) ?? "undefined"} });
            }
          }
        }
        process.stdout.write(JSON.stringify(results));
      `], { encoding: "utf8", timeout: 10_000 });
      for (const { args, expected } of JSON.parse(output)) {
        assert.equal(args.filter((arg) => arg === "--thinking").length, expected === undefined ? 0 : 1);
        if (expected !== undefined) assert.equal(args[args.indexOf("--thinking") + 1], expected);
      }
    }
  } finally {
    cleanup();
  }
});

test("resolvePiSpawn uses the packaged RPC entry under Node", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { resolvePiSpawn } = await import(moduleUrl);
    const spawn = resolvePiSpawn();

    assert.equal(spawn.command, process.execPath);
    assert.deepEqual(spawn.prefixArgs, [
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
    ]);
    assert.notEqual(spawn.prefixArgs[0], process.argv[1]);
  } finally {
    cleanup();
  }
});

test("buildPiArgs plans ephemeral and persistent session flags", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { buildModelArgs, buildPiArgs } = await import(moduleUrl);
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
      ["--no-session"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", undefined, undefined),
      ["--session", "/tmp/parent.jsonl"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", session, undefined),
      [
        "--extension",
        path.join(process.cwd(), "delegation-metadata.ts"),
        "--fork",
        "/tmp/parent.jsonl",
        "--session-id",
        "subagent.abc123",
        "--name",
        "subagent: review · api-review",
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
      ["--extension", path.join(process.cwd(), "delegation-metadata.ts"), "--session-id", "subagent.abc123"],
    );

    assert.deepEqual(
      buildPiArgs(
        { ...agent, tools: ["read"], noTools: true },
        null,
        "hello",
        "empty",
        null,
        undefined,
        undefined,
      ),
      ["--no-session", "--no-tools"],
    );

    const parentModel = {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4",
    };

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined, undefined, parentModel),
      ["--no-session", "--model", "openrouter/anthropic/claude-sonnet-4"],
    );

    assert.deepEqual(
      buildPiArgs(
        agent,
        null,
        "hello",
        "empty",
        null,
        { ...session, created: false, initialContextApplied: null },
        undefined,
        undefined,
        parentModel,
      ),
      [
        "--extension",
        path.join(process.cwd(), "delegation-metadata.ts"),
        "--session-id",
        "subagent.abc123",
        "--model",
        "openrouter/anthropic/claude-sonnet-4",
      ],
    );

    assert.deepEqual(
      buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined, undefined, parentModel),
      ["--no-session", "--model", "agent-model"],
    );

    assert.deepEqual(
      buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined, "call-model", parentModel),
      ["--no-session", "--model", "call-model"],
    );

    assert.deepEqual(
      buildModelArgs(undefined, undefined, parentModel, "stale-provider", "stale-model"),
      ["--model", "openrouter/anthropic/claude-sonnet-4"],
    );
    assert.deepEqual(
      buildModelArgs("call-model", "agent-model", parentModel, "startup-provider", "startup-model"),
      ["--provider", "startup-provider", "--model", "call-model"],
    );
    assert.deepEqual(
      buildModelArgs(undefined, "agent-model", parentModel, "startup-provider", "startup-model"),
      ["--provider", "startup-provider", "--model", "agent-model"],
    );
    const providerPrefixedId = {
      provider: "openrouter",
      id: "openrouter/free",
    };
    const providerPrefixedArgs = buildModelArgs(
      undefined,
      undefined,
      providerPrefixedId,
      "stale-provider",
      "stale-model",
    );
    assert.deepEqual(
      providerPrefixedArgs,
      ["--model", "openrouter/openrouter/free"],
    );

    const exactModel = {
      provider: "openrouter",
      id: "openrouter/free",
      name: "OpenRouter Free",
    };
    const resolved = resolveCliModel({
      cliModel: providerPrefixedArgs[1],
      modelRuntime: {
        getModels: () => [
          exactModel,
          { provider: "openrouter", id: "other/free", name: "Other Free" },
        ],
        hasConfiguredAuth: () => true,
      },
    });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.model, exactModel);

    assert.deepEqual(
      buildModelArgs(undefined, undefined, undefined, "startup-provider", "startup-model"),
      ["--provider", "startup-provider", "--model", "startup-model"],
    );
    assert.deepEqual(
      buildModelArgs(undefined, undefined, undefined, undefined, undefined),
      [],
    );
  } finally {
    cleanup();
  }
});
