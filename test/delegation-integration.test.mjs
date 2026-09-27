import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveChildSessionDir } from "../session-paths.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const cliEntry = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const customType = "pi-subagent:delegation";
const provider = path.join(root, "test/fixtures/delegation-provider.ts");
const helper = path.join(root, "delegation-metadata.ts");

function jsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function origins(entries) {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function ownOrigins(entries) {
  return origins(entries).filter((entry) => entry.data.childSessionId === entries[0].id);
}

function assertOrigin(entries, parentSessionId, agent, handle) {
  assert.equal(entries[0].type, "session");
  assert.equal(entries.filter((entry) => entry.type === "session").length, 1);
  const own = ownOrigins(entries);
  assert.equal(own.length, 1, `one origin owned by header ${entries[0].id}`);
  assert.deepEqual(own[0].data, {
    version: 1, childSessionId: entries[0].id, parentSessionId, agent, handle,
  });
  const ids = new Set(entries.slice(1).map((entry) => entry.id));
  assert.equal(ids.size, entries.length - 1, "entry IDs remain unique");
  for (const entry of entries.slice(1)) {
    assert.ok(entry.parentId === null || ids.has(entry.parentId), `valid parent link for ${entry.id}`);
  }
  return own[0];
}

function childCall(tag, options = {}) {
  return { agent: "worker", prompt: JSON.stringify({ tag }), timeout: 25, inactivityTimeout: 20, ...options };
}

function results(event) {
  const tool = event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "subagent");
  assert.ok(tool, "real Pi executed the production subagent tool");
  assert.equal(tool.isError, false, JSON.stringify(tool));
  assert.notEqual(tool.details.failed, true, JSON.stringify(tool));
  for (const result of tool.details.results) {
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
  }
  return tool.details.results;
}

class Rpc {
  constructor(cwd, env, args, cli = false) {
    this.events = [];
    this.waiters = new Set();
    this.stderr = "";
    this.proc = spawn(process.execPath, [...(cli ? [cliEntry, "--mode", "rpc"] : [rpcEntry]), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise((resolve) => this.proc.once("close", (code, signal) => {
      this.exit = { code, signal };
      for (const waiter of this.waiters) waiter();
      resolve(this.exit);
    }));
    this.proc.on("error", (error) => { this.error = error; });
    this.proc.stdin.on("error", (error) => { this.error = error; });
    this.proc.stderr.setEncoding("utf8").on("data", (chunk) => { this.stderr += chunk; });
    let buffer = "";
    this.proc.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); }
        catch { this.error = new Error(`Non-JSON RPC output: ${line}`); }
      }
      for (const waiter of this.waiters) waiter();
    });
  }

  wait(predicate, from = 0, timeout = 40_000) {
    return new Promise((resolve, reject) => {
      const finish = (error, event) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve(event);
      };
      const check = () => {
        const event = this.events.slice(from).find(predicate);
        if (event) return finish(null, event);
        if (this.error || this.exit) finish(new Error(`RPC exited/failed: ${this.error ?? JSON.stringify(this.exit)}\n${this.stderr}`));
      };
      const timer = setTimeout(() => finish(new Error(`RPC deadline exceeded\n${this.stderr}\n${JSON.stringify(this.events.slice(-3))}`)), timeout);
      this.waiters.add(check);
      check();
    });
  }

  async command(type, data = {}, timeout = 40_000) {
    const id = `${type}-${this.events.length}`;
    const from = this.events.length;
    this.proc.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const response = await this.wait((event) => event.type === "response" && event.id === id, from, timeout);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }

  async prompt(plan) {
    const from = this.events.length;
    await this.command("prompt", { message: JSON.stringify(plan) });
    const end = await this.wait((event) => event.type === "agent_end", from);
    await this.wait((event) => event.type === "agent_settled", from);
    assert.deepEqual(this.events.slice(from).filter((event) => event.type === "extension_error"), []);
    const errors = end.messages.filter((message) => message.role === "assistant" && message.stopReason === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors));
    return end;
  }

  async close() {
    if (!this.exit) {
      try { await this.command("abort", {}, 5000); } catch { /* Fall through to process cleanup. */ }
      this.proc.stdin.end();
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
      await this.closed;
      clearTimeout(timer);
    }
  }
}

function setup(t, { workerThinking } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-integration-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  const sessionDir = path.join(dir, "sessions");
  const tmp = path.join(dir, "tmp");
  const log = path.join(dir, "observations.jsonl");
  for (const subdir of [cwd, agentDir, sessionDir, tmp, path.join(dir, "home"), path.join(agentDir, "agents")]) {
    fs.mkdirSync(subdir, { recursive: true });
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  for (const agent of ["worker", "leaf"]) {
    const thinking = agent === "worker" && workerThinking ? `thinking: ${workerThinking}\n` : "";
    fs.writeFileSync(path.join(agentDir, "agents", `${agent}.md`), `---\nname: ${agent}\ndescription: Integration fixture\n${thinking}---\nUse the deterministic test provider.\n`);
  }
  // Allowlist rather than inherit API keys, auth locations, NODE_OPTIONS, or the harness's delegation guards.
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: path.join(dir, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_SUBAGENT_MAX_DEPTH: "2",
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    DELEGATION_TEST_LOG: log,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const clients = [];
  t.after(async () => {
    try {
      for (const client of clients) await client.close();
      // Runner children use separate process groups. Clean up any still running after a failed assertion/deadline.
      const records = jsonl(log);
      const exited = new Set(records.filter((record) => record.kind === "exit").map((record) => record.pid));
      const remaining = records.filter((record) => record.kind === "process" && !exited.has(record.pid));
      for (const { pid } of remaining) {
        try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    dir, cwd, agentDir, sessionDir, tmp, log,
    start({ rootOnly = false, rootId = "delegation-test-root", launchPayload, thinking, model = "deterministic", cli = false,
      launchCwd = cwd, storage = sessionDir, envOverrides = {},
    } = {}) {
      const launchEnv = { ...env, ...envOverrides };
      if (launchPayload) launchEnv.PI_SUBAGENT_DELEGATION = JSON.stringify(launchPayload);
      const client = new Rpc(launchCwd, launchEnv, [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools",
        "--extension", provider,
        "--extension", rootOnly ? path.join(root, "test/fixtures/delegation-root-only.ts") : path.join(root, "index.ts"),
        // Deliberately omit the helper in the root-only case: runner.ts must supply it.
        ...(rootOnly ? [] : ["--extension", helper]),
        "--provider", "delegation-test", "--model", model,
        ...(thinking ? ["--thinking", thinking] : []),
        "--session-id", rootId, ...(storage === null ? [] : ["--session-dir", storage]),
      ], cli);
      clients.push(client);
      return client;
    },
    observation(tag) {
      const matches = jsonl(log).filter((record) => record.kind === "request" && record.tag === tag && record.lastRole === "user");
      assert.equal(matches.length, 1, `one real provider request for ${tag}`);
      return matches[0];
    },
  };
}

test("real Pi persists only new named origins, bound to the child header and immediate parent", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const ancestor = {
    version: 1, childSessionId: "copied-ancestor", parentSessionId: "older-ancestor", agent: "ancestor", handle: "copied",
  };
  const rpc = fixture.start({ launchPayload: ancestor });
  const parent = await rpc.command("get_state");
  assert.equal(parent.model.provider, "delegation-test");
  assert.equal(fs.existsSync(parent.sessionFile), false, "Pi has not flushed an assistant-free root");
  assert.deepEqual(origins((await rpc.command("get_entries")).entries), [], "helper rejects payloads for a different header identity");
  await rpc.command("prompt", { message: `/delegation-test-seed ${JSON.stringify(ancestor)}` });
  // Matches the temporary parent's header exactly, so identity checks alone cannot hide a leaked payload.
  const inherited = {
    version: 1, childSessionId: parent.sessionId, parentSessionId: "outer-parent", agent: "outer-agent", handle: "outer-handle",
  };
  await rpc.command("prompt", { message: `/delegation-test-payload ${JSON.stringify(inherited)}` });

  const [first] = results(await rpc.prompt({ tag: "first", calls: [childCall("first-child", { agent: " worker ", session: " work " })] }));
  assert.equal(first.session.created, true);
  const beforeFirst = fixture.observation("first-child");
  assert.equal(first.session.id, beforeFirst.header.id);
  assert.equal(beforeFirst.diskEntries.length, 0, "appendEntry remains buffered until a real assistant response");
  assert.deepEqual(beforeFirst.entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role), ["system", "user"]);
  assert.equal(beforeFirst.entries.some((entry) => entry.type === "custom_message"), false, "no placeholder custom messages");
  assert.equal(origins(beforeFirst.entries).length, 1, "child appended metadata before its first model response");
  assert.equal(JSON.stringify(beforeFirst.contextMessages).includes(customType), false, "metadata is not model context");
  const firstEntries = jsonl(beforeFirst.file);
  const firstOrigin = assertOrigin(firstEntries, parent.sessionId, "worker", "work");
  assert.equal(firstEntries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);

  const [continued] = results(await rpc.prompt({ tag: "continue", calls: [childCall("continued-child", { session: "work", initialContext: "parent" })] }));
  assert.equal(continued.session.created, false);
  assert.equal(continued.session.id, first.session.id);
  assert.equal(continued.session.initialContextApplied, null);
  const beforeContinue = fixture.observation("continued-child");
  assert.equal(beforeContinue.launchPayload, null, "continuation clears the inherited payload");
  assert.deepEqual(jsonl(beforeFirst.file).slice(0, firstEntries.length), firstEntries, "continuation preserves existing history verbatim");
  assert.deepEqual(assertOrigin(jsonl(beforeFirst.file), parent.sessionId, "worker", "work"), firstOrigin);

  const nestedPrompt = JSON.stringify({ tag: "seeded-child", calls: [childCall("nested-child", { agent: "leaf", session: "nested", initialContext: "parent" })] });
  const [seeded] = results(await rpc.prompt({ tag: "seeded", calls: [childCall("unused", { session: "seeded", initialContext: "parent", prompt: nestedPrompt })] }));
  assert.equal(seeded.session.created, true);
  const beforeSeeded = fixture.observation("seeded-child");
  const seededEntries = jsonl(beforeSeeded.file);
  assertOrigin(seededEntries, parent.sessionId, "worker", "seeded");
  assert.equal(origins(seededEntries).length, 2, "copied ancestor does not suppress this child's origin");
  assert.deepEqual(origins(seededEntries)[0].data, ancestor);
  assert.notEqual(beforeSeeded.header.id, parent.sessionId, "Pi fork uses a new header identity");
  assert.ok(beforeSeeded.header.parentSession.startsWith(fixture.tmp), "fork source is the temporary parent snapshot");
  assert.equal(fs.existsSync(beforeSeeded.header.parentSession), false, "runner removed the fork snapshot");

  const [nested] = results({ messages: seededEntries.filter((entry) => entry.type === "message").map((entry) => entry.message) });
  const beforeNested = fixture.observation("nested-child");
  const nestedEntries = jsonl(beforeNested.file);
  assert.equal(nested.session.id, beforeNested.header.id);
  assertOrigin(nestedEntries, seeded.session.id, "leaf", "nested");
  assert.equal(origins(nestedEntries).length, 3, "both copied ancestors remain foreign to the nested header");
  assert.equal(beforeNested.depth, "2");
  assert.equal(beforeNested.tools.includes("subagent"), false, "depth guard disables delegation, not metadata");
  assert.notEqual(ownOrigins(nestedEntries)[0].data.parentSessionId, parent.sessionId, "nested parent is not the root");

  const persistedBeforeEphemeral = fs.readdirSync(fixture.sessionDir).filter((name) => name.endsWith(".jsonl")).sort();
  const ephemeral = results(await rpc.prompt({ tag: "ephemeral", calls: [
    childCall("ephemeral-empty"), childCall("ephemeral-parent", { initialContext: "parent" }),
  ] }));
  assert.ok(ephemeral.every((result) => result.session === undefined));
  for (const tag of ["ephemeral-empty", "ephemeral-parent"]) {
    const observation = fixture.observation(tag);
    assert.equal(observation.launchPayload, null, `${tag} clears inherited launch metadata`);
    assert.equal(origins(observation.entries).some((entry) => entry.data.childSessionId === observation.header.id), false);
    if (tag === "ephemeral-empty") {
      assert.equal(observation.file, null);
      assert.equal(origins(observation.entries).length, 0);
    } else {
      assert.equal(observation.header.id, parent.sessionId, "ephemeral snapshot retains the delegator's ID");
      assert.equal(observation.temporaryParent, "1");
      assert.deepEqual(origins(observation.entries).map((entry) => entry.data), [ancestor]);
      assert.equal(fs.existsSync(observation.file), false, "temporary session removed after the child exits");
    }
  }
  assert.deepEqual(fs.readdirSync(fixture.sessionDir).filter((name) => name.endsWith(".jsonl")).sort(), persistedBeforeEphemeral);

  // Reconstruct an owned pre-feature transcript by removing only the new origin and repairing its tree link.
  const legacyEntries = jsonl(beforeFirst.file).filter((entry) => entry.id !== firstOrigin.id)
    .map((entry) => entry.parentId === firstOrigin.id ? { ...entry, parentId: firstOrigin.parentId } : entry);
  fs.writeFileSync(beforeFirst.file, legacyEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await rpc.command("prompt", { message: `/delegation-test-payload ${JSON.stringify(firstOrigin.data)}` });
  const [legacy] = results(await rpc.prompt({ tag: "legacy", calls: [childCall("legacy-child", { session: "work" })] }));
  assert.equal(legacy.session.created, false);
  assert.equal(legacy.session.id, first.session.id);
  assert.equal(fixture.observation("legacy-child").launchPayload, null, "even a matching inherited payload cannot backfill a continuation");
  assert.deepEqual(origins(jsonl(beforeFirst.file)), [], "legacy sessions stay unmarked");
  assert.deepEqual(jsonl(beforeFirst.file).slice(0, legacyEntries.length), legacyEntries);
  assert.equal(ownOrigins(jsonl(parent.sessionFile)).length, 0, "no backfill into the root either");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
  assert.deepEqual(fs.readdirSync(fixture.tmp).filter((name) => name.startsWith("pi-subagent-")), [], "runner temporary resources cleaned up");
});

test("real Pi preserves thinking precedence and delegation metadata across named continuations", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t, { workerThinking: "high" });
  const rpc = fixture.start({ model: "reasoning", thinking: "low" });
  const parent = await rpc.command("get_state");
  assert.equal(parent.thinkingLevel, "low");
  await rpc.command("set_thinking_level", { level: "medium" });

  const [first] = results(await rpc.prompt({ tag: "thinking-first", calls: [
    childCall("thinking-off", { session: "thinking", thinking: "off" }),
  ] }));
  const initial = fixture.observation("thinking-off");
  assert.equal(initial.thinking, "off", "call overrides agent high and startup low");
  const origin = assertOrigin(jsonl(initial.file), parent.sessionId, "worker", "thinking");

  const [continued] = results(await rpc.prompt({ tag: "thinking-continue", calls: [
    childCall("thinking-agent", { session: "thinking" }),
  ] }));
  assert.equal(continued.session.id, first.session.id);
  assert.equal(continued.session.created, false);
  assert.equal(fixture.observation("thinking-agent").thinking, "high", "agent overrides restored off and startup low");

  results(await rpc.prompt({ tag: "thinking-call-again", calls: [
    childCall("thinking-low", { session: "thinking", thinking: "low" }),
    childCall("thinking-fallback", { agent: "leaf", session: "fallback" }),
  ] }));
  assert.equal(fixture.observation("thinking-low").thinking, "low", "call overrides continued agent high");
  assert.equal(fixture.observation("thinking-fallback").thinking, "low", "startup low, not live parent medium");
  assert.deepEqual(assertOrigin(jsonl(initial.file), parent.sessionId, "worker", "thinking"), origin);

  results(await rpc.prompt({ tag: "thinking-fallback-continue", calls: [
    childCall("thinking-fallback-off", { agent: "leaf", session: "fallback", thinking: "off" }),
  ] }));
  assert.equal(fixture.observation("thinking-fallback-off").thinking, "off");
  results(await rpc.prompt({ tag: "thinking-fallback-restored", calls: [
    childCall("thinking-fallback-low", { agent: "leaf", session: "fallback" }),
  ] }));
  assert.equal(fixture.observation("thinking-fallback-low").thinking, "low", "startup fallback overrides restored off");

  const before = jsonl(fixture.log).filter((entry) => entry.kind === "process").length;
  const invalid = await rpc.prompt({ tag: "thinking-invalid", calls: [
    childCall("must-not-run", { session: "invalid-batch", thinking: "off" }),
    childCall("invalid", { thinking: "HIGH" }),
  ] });
  const rejected = invalid.messages.findLast((message) => message.role === "toolResult" && message.toolName === "subagent");
  assert.ok(rejected);
  assert.match(JSON.stringify(rejected), /thinking/);
  assert.equal(jsonl(fixture.log).filter((entry) => entry.kind === "process").length, before, "invalid batch starts no children");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi CLI accepts max and leaves model-dependent clamping to Pi", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ cli: true, thinking: "max" });
  assert.equal((await rpc.command("get_state")).thinkingLevel, "off", "non-reasoning model clamps max to off");
  const [child] = results(await rpc.prompt({ tag: "max-cli", calls: [
    childCall("max-child", { session: "max", thinking: "max" }),
  ] }));
  const observation = fixture.observation("max-child");
  assert.equal(observation.argv[observation.argv.indexOf("--thinking") + 1], "max");
  assert.equal(observation.thinking, "off");
  assert.equal(child.session.created, true);
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi explicitly loads the metadata helper when child extension discovery is disabled", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ rootOnly: true });
  const parent = await rpc.command("get_state");
  const [child] = results(await rpc.prompt({ tag: "helper", calls: [childCall("helper-child", { session: "helper-only" })] }));
  const observation = fixture.observation("helper-child");
  assert.equal(observation.depth, "1", "below the configured maximum, not a depth-guard case");
  assert.equal(observation.tools.includes("subagent"), false, "main extension is absent in the child");
  assert.equal(child.session.id, observation.header.id);
  assertOrigin(jsonl(observation.file), parent.sessionId, "worker", "helper-only");
  assert.equal(observation.diskEntries.length, 0, "helper does not force a placeholder flush");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("child storage composition matches real Pi startup precedence and relative paths", { timeout: 120_000 }, async (t) => {
  for (const scenario of [
    { name: "CLI before runtime/env/settings", cli: "cli", runtime: "runtime", env: "env", project: "project", global: "global", expected: "cli" },
    { name: "runtime before env/settings", runtime: "runtime", env: "env", project: "project", expected: "runtime" },
    { name: "relative runtime", runtime: "./runtime", expected: "runtime" },
    { name: "absolute env before settings", env: "absolute", project: "project", expected: "absolute" },
    { name: "relative env before settings", env: "env", project: "project", expected: "env" },
    { name: "tilde env", env: "~/sessions", expected: "~/sessions" },
    { name: "project before global", project: "project", global: "global", expected: "project" },
    { name: "absolute project", project: "absolute", expected: "absolute" },
    { name: "tilde project", project: "~/sessions", expected: "~/sessions" },
    { name: "global relative", global: "global", expected: "global" },
    { name: "empty env falls through", env: "", global: "global", expected: "global" },
    { name: "default" },
    { name: "relative config root settings", agent: "relative-agent", global: "global", expected: "global" },
    { name: "relative config root default", agent: "relative-agent" },
    { name: "tilde config root default", agent: "~/custom-pi" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = setup(t);
      const home = path.join(fixture.dir, "home");
      const agent = scenario.agent ?? fixture.agentDir;
      const agentDir = agent.startsWith("~/") ? path.join(home, agent.slice(2)) : path.resolve(fixture.cwd, agent);
      fs.mkdirSync(agentDir, { recursive: true });
      const value = (s) => s === "absolute" ? path.join(fixture.dir, "absolute") : s;
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: value(scenario.global) }));
      fs.mkdirSync(path.join(fixture.cwd, ".pi"));
      fs.writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: value(scenario.project) }));
      const cli = scenario.cli && path.resolve(fixture.dir, scenario.cli);
      const runtime = value(scenario.runtime);
      const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: value(scenario.env) };
      const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
      let resolved;
      try {
        for (const [key, val] of Object.entries(env)) {
          if (val === undefined) delete process.env[key];
          else process.env[key] = val;
        }
        resolved = resolveChildSessionDir(fixture.cwd, cli, runtime);
      } finally {
        for (const [key, val] of Object.entries(previous)) {
          if (val === undefined) delete process.env[key];
          else process.env[key] = val;
        }
      }
      const rpc = fixture.start({ storage: cli ?? runtime ?? null, envOverrides: env });
      const state = await rpc.command("get_state");
      assert.equal(resolved, path.resolve(fixture.cwd, path.dirname(state.sessionFile)));
      if (scenario.expected) {
        const expected = scenario.expected.startsWith("~/") ? path.join(home, scenario.expected.slice(2))
          : cli ?? path.resolve(fixture.cwd, value(scenario.expected));
        assert.equal(resolved, expected);
      } else {
        assert.ok(resolved.startsWith(path.join(agentDir, "sessions") + path.sep));
      }
      await rpc.close();
      assert.equal(rpc.exit.code, 0, rpc.stderr);
    });
  }
});

test("named calls preserve existing target histories and header-only sessions in configured storage", { timeout: 90_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ storage: null });
  const parent = await rpc.command("get_state");
  const target = path.join(fixture.dir, "target");
  const other = path.join(fixture.dir, "other");
  for (const cwd of [target, other]) {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: "child-sessions" }));
  }
  const directory = path.join(target, "child-sessions");
  const files = new Map();
  for (const handle of ["history", "header-only"]) {
    const digest = createHash("sha256").update(JSON.stringify([
      "pi-subagent/v1", parent.sessionId, fs.realpathSync(target), "worker", handle,
    ])).digest("hex").slice(0, 16);
    const session = SessionManager.create(target, directory, { id: `subagent.${digest}` });
    if (handle === "history") {
      session.appendMessage({ role: "user", content: "Keep my history", timestamp: 1 });
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Previous answer" }],
        timestamp: 2, provider: "delegation-test", api: "delegation-test-api", model: "deterministic", stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      session.appendSessionInfo("User-chosen name");
    } else {
      fs.writeFileSync(session.getSessionFile(), JSON.stringify(session.getHeader()) + "\n");
    }
    files.set(handle, { file: session.getSessionFile(), content: fs.readFileSync(session.getSessionFile(), "utf8") });
  }
  const calls = ["history", "header-only", "new"].map(handle =>
    childCall(`storage-${handle}`, { cwd: target, session: handle, initialContext: "parent" }));
  calls.push(childCall("storage-other", { cwd: other, session: "new" }));
  const children = results(await rpc.prompt({ tag: "storage-parent", calls }));
  for (const child of children) {
    const handle = child.session.handle;
    const isOther = child.session.cwd === other;
    const observation = fixture.observation(isOther ? "storage-other" : `storage-${handle}`);
    const expectedDirectory = path.join(child.session.cwd, "child-sessions");
    assert.equal(path.dirname(observation.file), expectedDirectory);
    assert.equal(observation.argv.filter(arg => arg === "--session-dir").length, 1);
    assert.equal(observation.argv[observation.argv.indexOf("--session-dir") + 1], expectedDirectory);
    assert.deepEqual(fs.readdirSync(path.join(expectedDirectory, ".pi-subagent-locks")), [], "completion releases corrected lock");
    const previous = files.get(handle);
    if (previous) {
      assert.equal(child.session.created, false);
      assert.equal(child.session.initialContextApplied, null);
      assert.equal(observation.file, previous.file);
      assert.equal(observation.argv.includes("--fork"), false);
      assert.equal(observation.argv.includes("--name"), false);
      assert.ok(fs.readFileSync(previous.file, "utf8").startsWith(previous.content), "existing bytes remain unchanged");
      assert.deepEqual(ownOrigins(jsonl(previous.file)), [], "continuations do not gain creation metadata");
      if (handle === "history") {
        assert.equal(SessionManager.open(previous.file, directory).getSessionName(), "User-chosen name");
        assert.ok(observation.contextMessages.some(m => m.role === "user" && m.content === "Keep my history"));
      }
    } else {
      assert.equal(child.session.created, true);
      assert.equal(observation.argv.includes("--fork"), !isOther);
      assertOrigin(jsonl(observation.file), parent.sessionId, "worker", handle);
    }
  }
  const original = files.get("history").file;
  const originalContent = fs.readFileSync(original, "utf8");
  fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: "changed-storage" }));
  const [changed] = results(await rpc.prompt({ tag: "changed-storage", calls: [childCall("changed-child", { cwd: target, session: "history" })] }));
  assert.equal(changed.session.id, children[0].session.id, "configuration does not change session identity");
  assert.equal(changed.session.created, true, "no search for the old file in another directory");
  assert.equal(path.dirname(fixture.observation("changed-child").file), path.join(target, "changed-storage"));
  assert.equal(fs.readFileSync(original, "utf8"), originalContent, "no copying, migration, or repair of the original");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("relative parent CLI storage is rebased before delegating to another cwd", { timeout: 45_000 }, async (t) => {
  const fixture = setup(t);
  const target = path.join(fixture.dir, "target");
  fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: "wrong-settings-storage" }));
  const rpc = fixture.start({
    storage: "./parent-sessions",
    envOverrides: { PI_CODING_AGENT_SESSION_DIR: "wrong-env-storage" },
  });
  results(await rpc.prompt({ tag: "relative-cli", calls: [childCall("relative-cli-child", { cwd: target, session: "cli" })] }));
  const observation = fixture.observation("relative-cli-child");
  const directory = path.join(fixture.cwd, "parent-sessions");
  assert.equal(path.dirname(observation.file), directory);
  assert.equal(observation.argv[observation.argv.indexOf("--session-dir") + 1], directory);
  assert.deepEqual(fs.readdirSync(path.join(directory, ".pi-subagent-locks")), []);
  assert.equal(fs.existsSync(path.join(target, "parent-sessions")), false);
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("current parents share the corrected lock and release it after cancellation and deadlines", { timeout: 90_000 }, async (t) => {
  const fixture = setup(t);
  const secondCwd = path.join(fixture.dir, "second-parent");
  const target = path.join(fixture.dir, "target");
  fs.mkdirSync(secondCwd);
  fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: "storage" }));
  // Equal parent IDs with separate parent storage avoid concurrent writes to a parent transcript.
  const first = fixture.start({ storage: null });
  const second = fixture.start({ storage: null, launchCwd: secondCwd });
  await Promise.all([first.command("get_state"), second.command("get_state")]);
  const slowCall = (tag, options = {}) => childCall(tag, {
    cwd: target, session: "shared", prompt: JSON.stringify({ tag, delayMs: 60_000 }), ...options,
  });
  const from = first.events.length;
  await first.command("prompt", { message: JSON.stringify({ tag: "lock-owner", calls: [slowCall("locked-child")] }) });
  const pending = first.wait(event => event.type === "agent_settled", from);
  pending.catch(() => {});
  const deadline = Date.now() + 15_000;
  while (!jsonl(fixture.log).some(record => record.kind === "request" && record.tag === "locked-child")) {
    assert.ok(Date.now() < deadline, "child reaches the deterministic provider");
    await delay(25);
  }
  const observation = fixture.observation("locked-child");
  const lockRoot = path.join(target, "storage", ".pi-subagent-locks");
  const lockPath = path.join(lockRoot, `${observation.sessionId}.lock`);
  assert.equal(fs.existsSync(path.join(lockPath, "owner.json")), true);
  const before = jsonl(fixture.log).filter(record => record.kind === "process").length;
  const conflict = await second.prompt({ tag: "lock-contender", calls: [childCall("cannot-run", { cwd: target, session: "shared" })] });
  const toolResult = (event) => event.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
  assert.match(JSON.stringify(toolResult(conflict)), /already running/);
  assert.equal(jsonl(fixture.log).filter(record => record.kind === "process").length, before);
  const duplicate = await second.prompt({ tag: "duplicate", calls: [
    childCall("dup-one", { cwd: target, session: "duplicate" }),
    childCall("dup-two", { cwd: target, session: "duplicate" }),
  ] });
  assert.match(JSON.stringify(toolResult(duplicate)), /same persistent session/);
  assert.equal(jsonl(fixture.log).filter(record => record.kind === "process").length, before);
  results(await second.prompt({ tag: "unrelated", calls: [childCall("unrelated-child", { cwd: target, session: "unrelated" })] }));
  assert.equal(fs.existsSync(lockPath), true, "unrelated session runs without releasing the owner's lock");
  await first.command("abort");
  await pending;
  assert.deepEqual(fs.readdirSync(lockRoot), [], "cancellation waits for child exit before release");

  for (const [name, timers, error] of [
    ["wall", { timeout: 1 }, /configured 1s run timeout/],
    ["idle", { inactivityTimeout: 1 }, /inactivity timeout/],
  ]) {
    const timedOut = await second.prompt({ tag: `${name}-timeout`, calls: [slowCall(`${name}-child`, { session: name, ...timers })] });
    assert.match(JSON.stringify(toolResult(timedOut)), error);
    assert.equal(toolResult(timedOut).isError, true);
    assert.deepEqual(fs.readdirSync(lockRoot), [], `${name} timeout releases the lock`);
  }

  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ updatedAt: "2000-01-01T00:00:00.000Z" }));
  const stale = await second.prompt({ tag: "stale-lock", calls: [childCall("stale-cannot-run", { cwd: target, session: "shared" })] });
  assert.match(JSON.stringify(toolResult(stale)), /appears stale/);
  assert.ok(JSON.stringify(toolResult(stale)).includes(lockPath));
  assert.equal(fs.existsSync(lockPath), true, "stale locks are not removed automatically");
  await first.close();
  await second.close();
  assert.equal(first.exit.code, 0, first.stderr);
  assert.equal(second.exit.code, 0, second.stderr);
});
