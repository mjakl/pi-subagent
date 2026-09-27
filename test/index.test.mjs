import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const {
  default: registerSubagentExtension,
  getProjectTrustOverrideFromArgv,
  resolveCallCwd,
  normalizeCalls,
} = await jiti.import("../index.ts");

function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const flags = new Map();

  const pi = {
    registerFlag(name, definition) {
      flags.set(name, definition);
    },
    getFlag() {
      return undefined;
    },
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };

  registerSubagentExtension(pi);
  return { handlers, tools, flags };
}

function writeAgent(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nYou are ${name}.\n`,
  );
}

function createContext(cwd, trusted) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: { notify() {} },
    sessionManager: {
      getHeader: () => ({ type: "session", version: 3, id: "parent", cwd }),
      getBranch: () => [],
      getSessionId: () => "parent-session",
      getSessionDir: () => path.join(cwd, ".sessions"),
      getSessionFile: () => undefined,
    },
  };
}

test("canonicalizes symlinked per-call working directories", {
  skip: process.platform === "win32",
}, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cwd-"));
  const physical = path.join(tmpDir, "physical");
  const alias = path.join(tmpDir, "alias");
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, "dir");
  try {
    assert.equal(resolveCallCwd(tmpDir, "alias"), fs.realpathSync(physical));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("subagent schema uses a Google-compatible initialContext enum", () => {
  const harness = createPiHarness();
  const schema = harness.tools.get("subagent").parameters;
  assert.equal(schema.properties.calls.minItems, 1);
  assert.equal(schema.properties.calls.maxItems, 8);
  assert.equal(schema.properties.calls.items.properties.agent.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.prompt.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.session.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.session.maxLength, 120);

  const initialContext = schema.properties.calls.items.properties.initialContext;

  assert.equal(initialContext.type, "string");
  assert.deepEqual(initialContext.enum, ["empty", "parent"]);
  assert.equal(initialContext.default, "empty");
  assert.equal(initialContext.anyOf, undefined);
  assert.equal(initialContext.oneOf, undefined);

  const inactivityTimeout = schema.properties.calls.items.properties.inactivityTimeout;
  assert.equal(inactivityTimeout.type, "integer");
  assert.equal(inactivityTimeout.minimum, 1);
  assert.equal(inactivityTimeout.maximum > 1, true);

  const timeout = schema.properties.calls.items.properties.timeout;
  assert.equal(timeout.type, "integer");
  assert.equal(timeout.minimum, 1);
  assert.equal(timeout.maximum > 1, true);
});

test("thinking schema and normalization accept exactly the supported per-call levels", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const schema = createPiHarness().tools.get("subagent").parameters.properties.calls.items;
  const thinking = schema.properties.thinking;
  assert.equal(thinking.type, "string");
  assert.deepEqual(thinking.enum, levels);
  assert.equal(thinking.anyOf, undefined);
  assert.equal(thinking.oneOf, undefined);
  assert.equal(thinking.default, undefined);
  assert.equal(schema.required.includes("thinking"), false);

  const calls = levels.map((thinking) => ({ agent: "review", prompt: "Review", thinking }));
  calls.push({ agent: "review", prompt: "Review" });
  const result = normalizeCalls(calls, process.cwd());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.map((call) => call.thinking), [...levels, undefined]);
});

test("thinking normalization rejects invalid values before executing a batch", () => {
  for (const thinking of ["", "HIGH", " high ", "invalid", null, false, 0, [], {}]) {
    const result = normalizeCalls([
      { agent: "review", prompt: "Valid", thinking: "off" },
      { agent: "review", prompt: "Invalid", thinking },
    ], process.cwd());
    assert.match(result.error, /calls\[1\]\.thinking must be one of: off, minimal, low, medium, high, xhigh, max/);
    assert.equal(result.calls, undefined);
  }
});

test("recognizes only parsed project approval flags", () => {
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--approve"]), true);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--no-approve"]), false);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--model", "--approve"]), null);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--", "--approve"]), null);
});

test("registers both cycle-prevention CLI flag forms", () => {
  const harness = createPiHarness();
  assert.equal(harness.flags.get("subagent-prevent-cycles").type, "boolean");
  assert.equal(harness.flags.get("no-subagent-prevent-cycles").type, "boolean");
});

test("implicit Pi trust does not enable project-only agents", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, true);
    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*explore\*\* \(user\)/);
    assert.doesNotMatch(promptPatch.systemPrompt, /project-only/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("saved project trust enables project-only agents", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");
  new ProjectTrustStore(configDir).set(projectDir, true);

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, true);
    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*project-only\*\* \(project\)/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extension lifecycle excludes untrusted project agents consistently", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false);

    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*explore\*\* \(user\)/);
    assert.doesNotMatch(promptPatch.systemPrompt, /project-only/);

    const invalidTimeout = await harness.tools.get("subagent").execute(
      "invalid-timeout",
      { calls: [{ agent: "project-only", prompt: "hello", timeout: 0 }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidTimeout.details.failed, true);
    assert.match(invalidTimeout.content[0].text, /timeout must be an integer/);

    const invalidInactivityTimeout = await harness.tools.get("subagent").execute(
      "invalid-inactivity-timeout",
      { calls: [{ agent: "project-only", prompt: "hello", inactivityTimeout: 1.5 }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidInactivityTimeout.details.failed, true);
    assert.match(invalidInactivityTimeout.content[0].text, /inactivityTimeout must be an integer/);

    const result = await harness.tools.get("subagent").execute(
      "call-1",
      { calls: [{ agent: "project-only", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.kind, "pi-subagent");
    assert.equal(result.details.failed, true);
    assert.equal(result.details.projectAgentsDir, null);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].agentSource, "unknown");
    assert.match(result.content[0].text, /Unknown agent: "project-only"/);

    const errorPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "subagent",
        content: result.content,
        details: result.details,
        isError: false,
      },
      ctx,
    );
    assert.deepEqual(errorPatch, { isError: true });

    const successPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "subagent",
        content: [{ type: "text", text: "ok" }],
        details: { kind: "pi-subagent", projectAgentsDir: null, results: [] },
        isError: false,
      },
      ctx,
    );
    assert.equal(successPatch, undefined);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("named-session setup failures and pre-cancelled calls release the resolved storage lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-setup-lock-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const target = path.join(dir, "target");
  fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: "storage" }));
  writeAgent(path.join(process.env.PI_CODING_AGENT_DIR, "agents"), "worker");
  try {
    const harness = createPiHarness();
    const tool = harness.tools.get("subagent");
    const ctx = createContext(dir, false);
    const manager = SessionManager.create(dir);
    ctx.sessionManager = manager;
    const lockRoot = path.join(target, "storage", ".pi-subagent-locks");
    const call = { agent: "worker", prompt: "No provider calls", session: "setup", cwd: target, initialContext: "parent" };
    const getHeader = manager.getHeader.bind(manager);
    manager.getHeader = () => undefined;
    const failed = await tool.execute("snapshot-failure", { calls: [call] }, undefined, undefined, ctx);
    assert.match(failed.content[0].text, /failed to snapshot/);
    assert.deepEqual(fs.readdirSync(lockRoot), []);
    manager.getHeader = getHeader;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tool.execute("cancelled", { calls: [call] }, controller.signal, undefined, ctx);
    assert.equal(cancelled.details.failed, true);
    assert.equal(cancelled.details.results[0].stopReason, "aborted");
    assert.deepEqual(fs.readdirSync(lockRoot), []);

    // A custom SDK/runtime directory keeps precedence over inherited env and target settings.
    const runtimeDirectory = path.join(dir, "runtime-storage");
    ctx.sessionManager = SessionManager.create(dir, runtimeDirectory);
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, "env-storage");
    const unknown = await tool.execute("unknown", { calls: [{ ...call, agent: "missing", initialContext: "empty" }] }, undefined, undefined, ctx);
    assert.match(unknown.content[0].text, /Unknown agent/);
    assert.deepEqual(fs.readdirSync(path.join(runtimeDirectory, ".pi-subagent-locks")), []);
    assert.equal(fs.existsSync(process.env.PI_CODING_AGENT_SESSION_DIR), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
