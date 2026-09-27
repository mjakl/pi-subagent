import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getDefaultSessionDirPath, resolveChildSessionDir } from "../session-paths.ts";

test("default session directory matches Pi's cwd encoding without creating storage", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-path-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
  try {
    const cwd = path.join(tmpDir, "repo", "src:feature");
    const directory = getDefaultSessionDirPath(cwd);
    assert.equal(fs.existsSync(directory), false);
    const session = SessionManager.create(cwd);
    assert.equal(directory, session.getSessionDir());
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("storage resolution uses the target cwd for relative runtime paths and never changes process cwd", () => {
  const cwd = process.cwd();
  const target = path.join(os.tmpdir(), "subagent-target");
  assert.equal(resolveChildSessionDir(target, undefined, "runtime-relative"), path.join(target, "runtime-relative"));
  assert.equal(resolveChildSessionDir(target, path.join(cwd, "cli-relative"), "runtime-relative"), path.join(cwd, "cli-relative"));
  assert.equal(process.cwd(), cwd);
});
