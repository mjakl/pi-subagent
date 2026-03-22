import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInheritedCliArgs } from "../runner-cli.js";

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
    "--provider",
    "openrouter",
    "--api-key",
    "secret",
    "--theme",
    "dark",
    "--skill",
    "research",
    "--custom-flag",
    "value",
  ]);
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
      "--session-dir",
      sessionDir,
      "--system-prompt",
      "You are helpful",
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
