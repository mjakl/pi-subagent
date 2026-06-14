import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "../session-paths.ts";

function expectedSessionDir(cwd, agentDir) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedAgentDir = path.resolve(agentDir);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(resolvedAgentDir, "sessions", safePath);
}

test("default session directory path matches Pi's cwd encoding", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-path-"));
  try {
    const agentDir = path.join(tmpDir, "agent");
    const cwd = path.join(tmpDir, "repo", "src:feature");

    assert.equal(
      getDefaultSessionDirPath(cwd, agentDir),
      expectedSessionDir(cwd, agentDir),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDefaultSessionDir creates the computed directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-path-"));
  try {
    const agentDir = path.join(tmpDir, "agent");
    const cwd = path.join(tmpDir, "repo");
    const sessionDir = ensureDefaultSessionDir(cwd, agentDir);

    assert.equal(sessionDir, expectedSessionDir(cwd, agentDir));
    assert.equal(fs.statSync(sessionDir).isDirectory(), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
