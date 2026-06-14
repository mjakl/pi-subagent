import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireSessionLock,
  acquireSessionLocks,
  lockTokenMatches,
  releaseSessionLocks,
  SESSION_LOCK_STALE_MS,
} from "../session-lock.ts";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lock-"));
}

function target(lockRoot, sessionId = "subagent.test") {
  return {
    sessionId,
    lockRoot,
    agent: "review",
    handle: "api-review",
    cwd: "/repo",
  };
}

test("session lock acquisition rejects an existing active lock", () => {
  const tmpDir = makeTempDir();
  try {
    const first = acquireSessionLock(target(tmpDir));
    assert.ok(first.lock);

    const second = acquireSessionLock(target(tmpDir));
    assert.match(second.error ?? "", /already running/);

    releaseSessionLocks([first.lock]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session lock acquisition reports stale locks without deleting them", () => {
  const tmpDir = makeTempDir();
  try {
    const lockPath = path.join(tmpDir, "subagent.test.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ updatedAt: new Date(Date.now() - SESSION_LOCK_STALE_MS - 1000).toISOString() }),
    );

    const result = acquireSessionLock(target(tmpDir));
    assert.match(result.error ?? "", /appears stale/);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session lock release does not remove a lock with a different owner token", () => {
  const tmpDir = makeTempDir();
  try {
    const result = acquireSessionLock(target(tmpDir));
    assert.ok(result.lock);
    const lock = result.lock;

    const ownerPath = path.join(lock.path, "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));
    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "different-token" }));

    assert.equal(lockTokenMatches(lock), false);
    releaseSessionLocks([lock]);
    assert.equal(fs.existsSync(lock.path), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("batch lock acquisition returns mkdir errors and releases earlier locks", () => {
  const tmpDir = makeTempDir();
  try {
    const firstRoot = path.join(tmpDir, "locks");
    const blockingFile = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blockingFile, "x");

    const result = acquireSessionLocks([
      target(firstRoot, "subagent.first"),
      target(path.join(blockingFile, "locks"), "subagent.second"),
    ]);

    assert.match(result.error ?? "", /Failed to lock persistent subagent session subagent.second/);
    assert.equal(result.locks.length, 0);
    assert.equal(fs.existsSync(path.join(firstRoot, "subagent.first.lock")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
