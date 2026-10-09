import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
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
      launchCwd = cwd, storage = sessionDir, envOverrides = {}, resumeFile,
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
        ...(resumeFile ? ["--session", resumeFile] : ["--session-id", rootId]), ...(storage === null ? [] : ["--session-dir", storage]),
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

test("real Pi enforces denial before batch setup and inherits it through resumed children and descendants", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.agentDir, "agents", "helper.md"), "---\nname: helper\ndescription: Allowed helper\n---\nUse the deterministic test provider.\n");
  const initial = fixture.start({ envOverrides: { PI_SUBAGENT_DENY_AGENTS: "[]" } });
  const parent = await initial.command("get_state");
  const [worker, leaf] = results(await initial.prompt({ tag: "unrestricted", calls: [
    childCall("initial-worker", { session: "worker-session" }),
    childCall("initial-leaf", { agent: "leaf", session: "leaf-session" }),
  ] }));
  assert.equal(fixture.observation("initial-leaf").denyAgents, "[]");
  const leafFile = fixture.observation("initial-leaf").file;
  const leafBefore = fs.readFileSync(leafFile, "utf8");
  await initial.close();

  const deny = '["leaf"]';
  const rpc = fixture.start({ resumeFile: parent.sessionFile, envOverrides: {
    PI_SUBAGENT_DENY_AGENTS: deny, PI_SUBAGENT_MAX_DEPTH: "4", PI_SUBAGENT_PREVENT_CYCLES: "false",
  } });
  assert.equal((await rpc.command("get_state")).sessionId, parent.sessionId);
  const toolResult = (event) => event.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
  for (const [tag, calls] of [
    ["mixed-denied", [childCall("must-not-start", { agent: "helper", session: "fresh" }), childCall("denied", { agent: "leaf" })]],
    ["denied-continuation", [childCall("must-not-resume", { agent: "leaf", session: "leaf-session", initialContext: "parent" })]],
  ]) {
    const processesBefore = jsonl(fixture.log).filter(record => record.kind === "process").length;
    const sessionsBefore = fs.readdirSync(fixture.sessionDir).sort();
    const locksBefore = fs.readdirSync(path.join(fixture.sessionDir, ".pi-subagent-locks")).sort();
    const rejected = toolResult(await rpc.prompt({ tag, calls }));
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.failed, true);
    assert.deepEqual(rejected.details.results, []);
    assert.match(JSON.stringify(rejected), /Blocked by PI_SUBAGENT_DENY_AGENTS/);
    assert.equal(jsonl(fixture.log).filter(record => record.kind === "process").length, processesBefore, "entire batch starts no children");
    assert.deepEqual(fs.readdirSync(fixture.sessionDir).sort(), sessionsBefore, "no new sessions or lock roots");
    assert.deepEqual(fs.readdirSync(path.join(fixture.sessionDir, ".pi-subagent-locks")).sort(), locksBefore, "no lock artifacts");
    assert.equal(fs.readFileSync(leafFile, "utf8"), leafBefore, "denied continuation leaves persisted history unchanged");
  }

  for (const tag of ["allowed-first", "allowed-continue"]) {
    const helperPlan = { tag: `${tag}-helper`, calls: [childCall(`${tag}-denied`, { agent: "leaf", session: "leaf-session" })] };
    const workerPlan = { tag: `${tag}-worker`, calls: [childCall("unused", { agent: "helper", session: "helper-session", prompt: JSON.stringify(helperPlan) })] };
    const [continued] = results(await rpc.prompt({ tag, calls: [childCall("unused", {
      session: "worker-session", prompt: JSON.stringify(workerPlan),
    })] }));
    assert.equal(continued.session.id, worker.session.id);
    assert.equal(continued.session.created, false, "allowed worker continuation stays usable");
    const workerObservation = fixture.observation(`${tag}-worker`);
    const helperObservation = fixture.observation(`${tag}-helper`);
    assert.equal(workerObservation.denyAgents, deny);
    assert.equal(helperObservation.denyAgents, deny, "deeper child inherits policy");
    assert.equal(helperObservation.depth, "2");
    assert.equal(helperObservation.tools.includes("subagent"), true, "denial does not disable allowed delegation");
    const helperResult = results({ messages: jsonl(workerObservation.file).filter(entry => entry.type === "message").map(entry => entry.message) })[0];
    assert.equal(helperResult.session.created, tag === "allowed-first", "allowed helper starts fresh, then continues");
    const nestedRejection = toolResult({ messages: jsonl(helperObservation.file).filter(entry => entry.type === "message").map(entry => entry.message) });
    assert.equal(nestedRejection.isError, true);
    assert.match(JSON.stringify(nestedRejection), /Blocked by PI_SUBAGENT_DENY_AGENTS/);
    assert.equal(jsonl(fixture.log).some(record => record.tag === `${tag}-denied`), false, "denied descendant never runs");
  }
  assert.equal(fs.readFileSync(leafFile, "utf8"), leafBefore);
  assert.ok(leaf.session.id);
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

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
  // Pi 1.1 can flush real system/user entries before requesting its first response.
  assert.equal(beforeFirst.diskEntries.some(entry => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "assistant")), false, "metadata does not fabricate a message to force persistence");
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
  assert.equal(observation.diskEntries.some(entry => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "assistant")), false, "helper does not fabricate a message to force persistence");
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

function writeLocalOwner(directory, name, marker) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---
name: ${name}
description: Owner ${marker}
subagents:
  analyst:
    description: Private analyst ${marker}
    systemPrompt: Private analyst instructions ${marker}.
    thinking: medium
    sessionPreference: persistent
  secret:
    description: Private secret ${marker}
    systemPrompt: Private secret instructions ${marker}.
---
Owner instructions ${marker}.
`);
}

function nestedTool(result) {
  const tool = result.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
  assert.ok(tool, "child executed the real production tool");
  return tool;
}

function observedTool(fixture, tag) {
  const observation = jsonl(fixture.log).findLast(record => record.kind === "request" && record.tag === tag && record.lastRole === "toolResult");
  assert.ok(observation, `provider observed completed tool for ${tag}`);
  return nestedTool({ messages: observation.entries.filter(entry => entry.type === "message").map(entry => entry.message) });
}

const localCall = (agent, tag, options = {}, plan = {}) => ({
  agent, prompt: JSON.stringify({ tag, ...plan }), timeout: 25, inactivityTimeout: 20, ...options,
});

test("real owner launches pin private resolution across cwd, continuations, and descendant clearing", { timeout: 120_000 }, async t => {
  const fixture = setup(t);
  const userAgents = path.join(fixture.agentDir, "agents");
  const projectAgents = path.join(fixture.cwd, ".pi", "agents");
  writeLocalOwner(userAgents, "worker", "user");
  writeLocalOwner(projectAgents, "worker", "selected-project");
  fs.writeFileSync(path.join(userAgents, "analyst.md"), "---\nname: analyst\ndescription: Ordinary global analyst\n---\nGlobal analyst instructions.\n");
  const target = path.join(fixture.dir, "target");
  writeLocalOwner(path.join(target, ".pi", "agents"), "worker", "wrong-target");
  const trust = new ProjectTrustStore(fixture.agentDir);
  trust.set(fixture.cwd, true);
  trust.set(target, false);
  const rpc = fixture.start({ envOverrides: { PI_SUBAGENT_MAX_DEPTH: "4" } });
  const rootSecret = await rpc.prompt({ tag: "root-private", calls: [localCall("secret", "unreachable-root")] });
  assert.match(JSON.stringify(nestedTool({ messages: rootSecret.messages })), /Unknown agent.*secret/);
  assert.doesNotMatch(fixture.observation("root-private").systemPrompt, /\*\*secret\*\*/);

  const [owner] = results(await rpc.prompt({ tag: "owner-root", calls: [localCall("worker", "owner-first", { cwd: target, session: "owner" }, { calls: [
    localCall("analyst", "private-a", { session: "a", initialContext: "parent" }, { calls: [localCall("secret", "unreachable-analyst")] }),
    localCall("analyst", "private-b", { session: "b" }, { calls: [localCall("analyst", "global-grandchild")] }),
    localCall("secret", "private-secret", { initialContext: "parent" }),
    localCall("leaf", "unrelated-child", { session: "leaf" }, { calls: [localCall("secret", "unreachable-leaf")] }),
  ] })] }));
  const observation = fixture.observation("owner-first");
  assert.match(observation.systemPrompt, /Owner instructions selected-project/);
  assert.match(observation.systemPrompt, /\*\*analyst\*\* \(local to worker\): Private analyst selected-project/);
  assert.doesNotMatch(observation.systemPrompt, /wrong-target|Ordinary global analyst/);
  assert.equal(JSON.parse(observation.ownerContext).filePath, fs.realpathSync(path.join(projectAgents, "worker.md")));
  const nested = observedTool(fixture, "owner-first");
  assert.notEqual(nested.details.failed, true);
  const [a, b, secret, leaf] = nested.details.results;
  assert.notEqual(a.session.id, b.session.id, "independent parallel local sessions");
  assert.equal(a.session.initialContextApplied, "parent", "named locals support real parent snapshot creation");
  assert.equal(fixture.observation("private-secret").temporaryParent, "1", "ephemeral locals support real parent snapshots");
  for (const tag of ["private-a", "private-b", "private-secret"]) {
    const local = fixture.observation(tag);
    assert.equal(local.ownerContext, null, "inline workers cannot inherit their owner's catalog");
    assert.match(local.systemPrompt, /Private (analyst|secret) instructions selected-project/);
    assert.doesNotMatch(local.systemPrompt, /\*\*secret\*\*/);
    assert.match(JSON.parse(local.stack).at(-1), /pi-subagent\/local\/v1/);
  }
  assert.match(JSON.stringify(observedTool(fixture, "private-a")), /Unknown agent.*secret/);
  assert.match(JSON.stringify(observedTool(fixture, "unrelated-child")), /Unknown agent.*secret/);
  assert.equal(fixture.observation("unrelated-child").ownerContext, null);
  assert.equal(observedTool(fixture, "private-b").details.results[0].exitCode, 0, "a same-named global is not a local cycle");
  assert.match(fixture.observation("global-grandchild").systemPrompt, /Global analyst instructions/);
  assert.equal(JSON.parse(fixture.observation("global-grandchild").stack).at(-1), "analyst");
  assert.equal(secret.exitCode, 0);

  const [resumed] = results(await rpc.prompt({ tag: "resume-root", calls: [localCall("worker", "owner-resumed", { cwd: target, session: "owner", initialContext: "parent" }, { calls: [
    localCall("analyst", "private-resumed", { session: "a", initialContext: "parent" }),
    localCall("leaf", "leaf-resumed", { session: "leaf" }, { calls: [localCall("secret", "still-unreachable")] }),
  ] })] }));
  assert.equal(resumed.session.id, owner.session.id);
  assert.equal(resumed.session.created, false);
  const resumedChildren = observedTool(fixture, "owner-resumed").details.results;
  assert.equal(resumedChildren[0].session.id, a.session.id);
  assert.equal(resumedChildren[0].session.created, false);
  assert.equal(fixture.observation("private-resumed").ownerContext, null);
  assert.equal(fixture.observation("leaf-resumed").ownerContext, null);
  assert.match(JSON.stringify(observedTool(fixture, "leaf-resumed")), /Unknown agent.*secret/);

  const [duplicate] = results(await rpc.prompt({ tag: "duplicate-root", calls: [localCall("worker", "duplicate-owner", { cwd: target, session: "owner" }, { calls: [
    localCall("analyst", "must-not-start-one", { session: "same" }),
    localCall("analyst", "must-not-start-two", { session: "same" }),
  ] })] }));
  assert.match(JSON.stringify(observedTool(fixture, "duplicate-owner")), /same persistent session/);
  const rootGlobal = results(await rpc.prompt({ tag: "global-root", calls: [localCall("analyst", "ordinary-global")] }));
  assert.equal(rootGlobal[0].exitCode, 0);
  assert.match(fixture.observation("ordinary-global").systemPrompt, /Global analyst instructions/);
  assert.equal(fixture.observation("ordinary-global").ownerContext, null);
});

test("real local identities isolate equal owner names and preserve denial, cycles, and depth", { timeout: 120_000 }, async t => {
  const fixture = setup(t);
  const agents = path.join(fixture.agentDir, "agents");
  writeLocalOwner(agents, "worker", "first");
  writeLocalOwner(agents, "lead", "second");
  const rpc = fixture.start({ envOverrides: { PI_SUBAGENT_MAX_DEPTH: "4" } });
  const own = (name, tag, workerTag) => localCall(name, tag, { session: name }, { calls: [localCall("analyst", workerTag, { session: "shared" })] });
  const owners = results(await rpc.prompt({ tag: "two-owners", calls: [own("worker", "first-owner", "first-local"), own("lead", "second-owner", "second-local")] }));
  const locals = ["first-owner", "second-owner"].map(tag => observedTool(fixture, tag).details.results[0]);
  assert.notEqual(locals[0].session.id, locals[1].session.id);
  const identities = ["first-local", "second-local"].map(tag => JSON.parse(fixture.observation(tag).stack).at(-1));
  assert.notEqual(identities[0], identities[1]);
  assert.notEqual(identities[0], "analyst");

  results(await rpc.prompt({ tag: "replacement-root", calls: [localCall("worker", "replacement-first", { session: "worker" }, { calls: [
    localCall("lead", "replacement-second", { session: "lead" }, { calls: [localCall("analyst", "replacement-local", { session: "shared" })] }),
  ] })] }));
  assert.equal(JSON.parse(fixture.observation("replacement-second").ownerContext).name, "lead", "a global descendant replaces, rather than inherits, the private owner");
  assert.match(fixture.observation("replacement-second").systemPrompt, /Private analyst second/);
  assert.doesNotMatch(fixture.observation("replacement-second").systemPrompt, /Private analyst first/);
  assert.match(fixture.observation("replacement-local").systemPrompt, /Private analyst instructions second/);
  assert.equal(fixture.observation("replacement-local").ownerContext, null);

  const ownerContext = fixture.observation("first-owner").ownerContext;
  // Equal delegator ID, cwd, and handle prove that owner identity participates in the session key.
  const sameIdFirst = fixture.start({ rootId: "same-parent", envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: ownerContext } });
  const sameIdSecond = fixture.start({ rootId: "same-parent", storage: path.join(fixture.dir, "other-sessions"), envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: fixture.observation("second-owner").ownerContext } });
  const [[one], [two]] = await Promise.all([
    sameIdFirst.prompt({ tag: "same-id-first", calls: [localCall("analyst", "isolated-first", { session: "shared" })] }).then(results),
    sameIdSecond.prompt({ tag: "same-id-second", calls: [localCall("analyst", "isolated-second", { session: "shared" })] }).then(results),
  ]);
  assert.notEqual(one.session.id, two.session.id);

  const localFile = fixture.observation("isolated-first").file;
  const beforeDenial = fs.readFileSync(localFile, "utf8");
  await sameIdFirst.close();
  const denied = fixture.start({ rootId: "same-parent", envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: ownerContext, PI_SUBAGENT_DENY_AGENTS: '["analyst"]' } });
  const denyResult = await denied.prompt({ tag: "deny-private", calls: [localCall("analyst", "denied-local", { session: "shared" }), localCall("leaf", "denied-batch-peer")] });
  assert.match(JSON.stringify(nestedTool({ messages: denyResult.messages })), /Blocked by PI_SUBAGENT_DENY_AGENTS/);
  assert.equal(fs.readFileSync(localFile, "utf8"), beforeDenial, "denial prevents continuing the existing local session");
  assert.doesNotMatch(fixture.observation("deny-private").systemPrompt, /\*\*analyst\*\*/);

  const cyclic = fixture.start({ rootId: "cyclic-root", envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: ownerContext, PI_SUBAGENT_STACK: JSON.stringify([identities[0]]) } });
  const cycle = await cyclic.prompt({ tag: "local-cycle", calls: [localCall("analyst", "cyclic-local")] });
  assert.match(JSON.stringify(nestedTool({ messages: cycle.messages })), /delegation cycle detected/);

  const shallow = fixture.start({ rootId: "shallow-root", envOverrides: { PI_SUBAGENT_MAX_DEPTH: "2" } });
  results(await shallow.prompt({ tag: "depth-root", calls: [own("worker", "depth-owner", "depth-local")] }));
  assert.equal(fixture.observation("depth-local").tools.includes("subagent"), false);
  assert.doesNotMatch(fixture.observation("depth-local").systemPrompt, /## Available Subagents/);

  for (const [tag, context] of [["malformed", "{}"], ["changed", ownerContext]]) {
    if (tag === "changed") fs.appendFileSync(path.join(agents, "worker.md"), "Changed since launch.\n");
    const invalid = fixture.start({ rootId: `invalid-${tag}-root`, envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: context } });
    const event = await invalid.prompt({ tag: `invalid-${tag}`, calls: [localCall("analyst", `unreachable-${tag}`, { session: "shared" })] });
    const tool = nestedTool({ messages: event.messages });
    assert.equal(tool.details.failed, true);
    assert.deepEqual(tool.details.results, []);
    assert.match(JSON.stringify(tool), /Invalid PI_SUBAGENT_OWNER_CONTEXT/);
    assert.doesNotMatch(fixture.observation(`invalid-${tag}`).systemPrompt, /\*\*analyst\*\*/);
  }
});

test("parallel parent processes conflict only on the same owner-qualified local session", { timeout: 60_000 }, async t => {
  const fixture = setup(t);
  writeLocalOwner(path.join(fixture.agentDir, "agents"), "worker", "lock-owner");
  const setupClient = fixture.start();
  results(await setupClient.prompt({ tag: "local-lock-setup", calls: [localCall("worker", "local-lock-owner")] }));
  const ownerContext = fixture.observation("local-lock-owner").ownerContext;
  const secondCwd = path.join(fixture.dir, "second");
  const target = path.join(fixture.dir, "target");
  fs.mkdirSync(secondCwd);
  fs.mkdirSync(path.join(target, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: "local-storage" }));
  const first = fixture.start({ rootId: "local-lock-parent", storage: null, envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: ownerContext } });
  const second = fixture.start({ rootId: "local-lock-parent", launchCwd: secondCwd, storage: null, envOverrides: { PI_SUBAGENT_OWNER_CONTEXT: ownerContext } });
  const from = first.events.length;
  await first.command("prompt", { message: JSON.stringify({ tag: "local-lock-first", calls: [localCall("analyst", "slow-local", { cwd: target, session: "shared" }, { delayMs: 30_000 })] }) });
  const settled = first.wait(event => event.type === "agent_settled", from);
  settled.catch(() => {});
  const deadline = Date.now() + 15_000;
  while (!jsonl(fixture.log).some(record => record.kind === "request" && record.tag === "slow-local")) {
    assert.ok(Date.now() < deadline, "local child reaches the provider while holding its lock");
    await delay(25);
  }
  const before = jsonl(fixture.log).filter(record => record.kind === "process").length;
  const conflict = await second.prompt({ tag: "local-lock-second", calls: [localCall("analyst", "must-not-run-local", { cwd: target, session: "shared" })] });
  assert.match(JSON.stringify(nestedTool({ messages: conflict.messages })), /already running/);
  assert.equal(jsonl(fixture.log).filter(record => record.kind === "process").length, before);
  results(await second.prompt({ tag: "local-independent", calls: [localCall("analyst", "independent-local", { cwd: target, session: "independent" })] }));
  await first.command("abort");
  await settled;
  assert.deepEqual(fs.readdirSync(path.join(target, "local-storage", ".pi-subagent-locks")), []);
});
