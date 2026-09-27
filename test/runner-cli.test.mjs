import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getInheritedProjectTrustArgs,
  parseInheritedCliArgs,
  selectInheritedPiArgv,
} from "../runner-cli.js";

test("inherits arguments only from Pi entrypoints", () => {
  const hostArgv = [
    "/usr/bin/node",
    "next",
    "start",
    "-H",
    "0.0.0.0",
    "--approve",
    "--subagent-max-depth",
    "0",
    "--no-subagent-prevent-cycles",
  ];
  const piArgv = [
    "/usr/bin/node",
    "pi",
    "--model",
    "openrouter/test-model",
    "--custom-flag",
    "value",
  ];

  const selectedHostArgv = selectInheritedPiArgv(hostArgv, {});
  assert.deepEqual(selectedHostArgv, hostArgv.slice(0, 2));
  assert.deepEqual(parseInheritedCliArgs(selectedHostArgv).alwaysProxy, []);

  const selectedPiArgv = selectInheritedPiArgv(piArgv, {
    PI_CODING_AGENT: "true",
  });
  assert.equal(selectedPiArgv, piArgv);
  const inherited = parseInheritedCliArgs(selectedPiArgv);
  assert.equal(inherited.fallbackModel, "openrouter/test-model");
  assert.deepEqual(inherited.alwaysProxy, ["--custom-flag", "value"]);
});

test("forwards safe parent CLI flags and captures fallback model settings", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--provider",
    "openrouter",
    "--api-key=secret",
    "--theme",
    "dark",
    "--skill",
    "research",
    "--model",
    "anthropic/claude-3-7-sonnet",
    "--thinking=high",
    "--tools",
    "read,bash",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    "/tmp/prompt.md",
    "--subagent-max-depth",
    "2",
    "--subagent-prevent-cycles",
    "true",
    "--custom-flag",
    "value",
    "positional prompt text",
  ]);

  assert.deepEqual(parsed.extensionArgs, []);
  assert.deepEqual(parsed.alwaysProxy, [
    "--api-key",
    "secret",
    "--theme",
    "dark",
    "--skill",
    "research",
    "--custom-flag",
    "value",
  ]);
  assert.equal(parsed.fallbackProvider, "openrouter");
  assert.equal(parsed.fallbackModel, "anthropic/claude-3-7-sonnet");
  assert.equal(parsed.fallbackThinking, "high");
  assert.equal(parsed.fallbackTools, "read,bash");
  assert.equal(parsed.fallbackNoTools, false);
});

test("resolves relative extension paths against the parent cwd", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cli-"));
  const extensionDir = path.join(tmpDir, "local-extension");
  fs.mkdirSync(extensionDir);

  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      "-e",
      "./local-extension",
      "--extension=git:github.com/example/other-extension",
      "--no-extensions",
    ]);

    assert.deepEqual(parsed.extensionArgs, [
      "-e",
      extensionDir,
      "--extension",
      "git:github.com/example/other-extension",
      "--no-extensions",
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolves inherited relative resource paths against the parent cwd", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cli-"));
  const skillPath = path.join(tmpDir, "skills", "research", "SKILL.md");
  const promptPath = path.join(tmpDir, "prompts", "review.md");
  const themePath = path.join(tmpDir, "themes", "custom.json");
  const sessionDir = path.join(tmpDir, ".sessions", "nested");

  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(skillPath, "# skill\n");
  fs.writeFileSync(promptPath, "# prompt\n");
  fs.writeFileSync(themePath, "{}\n");

  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      "--skill",
      "./skills/research/SKILL.md",
      "--prompt-template",
      "prompts/review.md",
      "--theme",
      "dark",
      "--theme",
      "my-org/dark",
      "--theme",
      "./themes/custom.json",
      "--session-dir",
      "./.sessions/nested",
      "--system-prompt",
      "You are helpful",
    ]);

    assert.deepEqual(parsed.alwaysProxy, [
      "--skill",
      skillPath,
      "--prompt-template",
      promptPath,
      "--theme",
      "dark",
      "--theme",
      "my-org/dark",
      "--theme",
      themePath,
      "--system-prompt",
      "You are helpful",
    ]);
    assert.equal(parsed.sessionDir, sessionDir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("does not consume positional prompts after built-in boolean flags", () => {
  const forwardedBooleans = [
    "--no-context-files",
    "-nc",
    "--no-builtin-tools",
    "-nbt",
  ];

  for (const flag of forwardedBooleans) {
    const parsed = parseInheritedCliArgs(["/usr/bin/node", "pi", flag, "parent prompt"]);
    assert.deepEqual(parsed.alwaysProxy, [flag]);
    assert.doesNotMatch(JSON.stringify(parsed), /parent prompt/);
  }

  for (const flag of ["--no-tools", "-nt"]) {
    const parsed = parseInheritedCliArgs(["/usr/bin/node", "pi", flag, "parent prompt"]);
    assert.equal(parsed.fallbackNoTools, true);
    assert.doesNotMatch(JSON.stringify(parsed), /parent prompt/);
  }

  for (const [flag, expected] of [["--approve", true], ["-a", true], ["--no-approve", false], ["-na", false]]) {
    const parsed = parseInheritedCliArgs(["/usr/bin/node", "pi", flag, "parent prompt"]);
    assert.equal(parsed.projectTrustOverride, expected);
    assert.doesNotMatch(JSON.stringify(parsed), /parent prompt/);
  }
});

test("forwards exclude-tools values without consuming the parent prompt", () => {
  for (const flag of ["--exclude-tools", "-xt"]) {
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      flag,
      "write",
      "parent prompt",
    ]);
    assert.deepEqual(parsed.alwaysProxy, [flag, "write"]);
    assert.doesNotMatch(JSON.stringify(parsed), /parent prompt/);
  }
});

test("limits temporary project approval to the same child working directory", () => {
  assert.deepEqual(getInheritedProjectTrustArgs(true, true), ["--approve"]);
  assert.deepEqual(getInheritedProjectTrustArgs(true, false), []);
  assert.deepEqual(getInheritedProjectTrustArgs(false, true), ["--no-approve"]);
  assert.deepEqual(getInheritedProjectTrustArgs(false, false), ["--no-approve"]);
  assert.deepEqual(getInheritedProjectTrustArgs(undefined, true), []);
});

test("inherits no-tools when the parent disabled tools", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--no-tools",
  ]);

  assert.equal(parsed.fallbackTools, undefined);
  assert.equal(parsed.fallbackNoTools, true);
});

test("does not inherit parent session identity flags", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--session-id",
    "parent-session",
    "--fork",
    "/tmp/parent.jsonl",
    "--name",
    "Parent Session",
    "--provider",
    "openrouter",
  ]);

  assert.deepEqual(parsed.alwaysProxy, []);
  assert.equal(parsed.fallbackProvider, "openrouter");
});

test("captures the last inherited provider from separate and inline flags", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--provider",
    "anthropic",
    "--provider=openrouter",
  ]);

  assert.equal(parsed.fallbackProvider, "openrouter");
  assert.deepEqual(parsed.alwaysProxy, []);
});

test("consumes dash-prefixed values for known value flags", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cli-"));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      "--session-dir",
      "-sessions",
      "--api-key",
      "-secret",
      "--model",
      "-fallback-model",
      "--custom-flag",
      "-not-a-value",
    ]);

    assert.deepEqual(parsed.alwaysProxy, [
      "--api-key",
      "-secret",
      "--custom-flag",
      "-not-a-value",
    ]);
    assert.equal(parsed.sessionDir, path.join(tmpDir, "-sessions"));
    assert.equal(parsed.fallbackModel, "-fallback-model");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
