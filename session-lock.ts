import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SESSION_LOCK_HEARTBEAT_MS = 30_000;
export const SESSION_LOCK_STALE_MS = 2 * 60 * 1000;

export interface SessionLockTarget {
  sessionId: string;
  lockRoot: string;
  agent?: string;
  handle?: string;
  cwd?: string;
}

export interface SessionLock {
  sessionId: string;
  path: string;
  token: string;
  heartbeat: NodeJS.Timeout;
}

interface LockOwner {
  token?: unknown;
  pid?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  sessionId?: unknown;
  agent?: unknown;
  handle?: unknown;
  cwd?: unknown;
}

function ownerPath(lockPath: string): string {
  return path.join(lockPath, "owner.json");
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

function lockTimestamp(lockPath: string): number | null {
  const owner = readLockOwner(lockPath);
  if (owner) {
    const rawTimestamp =
      typeof owner.updatedAt === "string" ? owner.updatedAt : owner.createdAt;
    const timestamp = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }

  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return "unknown";
  return new Date(timestamp).toISOString();
}

function lockedError(sessionId: string, lockPath: string): string {
  const timestamp = lockTimestamp(lockPath);
  const stale = timestamp === null || Date.now() - timestamp > SESSION_LOCK_STALE_MS;
  if (stale) {
    return `Persistent subagent session ${sessionId} is locked at ${lockPath}. The lock appears stale (last update: ${formatTimestamp(timestamp)}). If no subagent is running for this session, remove this lock directory and retry.`;
  }
  return `Persistent subagent session ${sessionId} is already running. Retry after that call finishes.`;
}

function writeLockOwner(
  lockPath: string,
  target: SessionLockTarget,
  token: string,
  createdAt: string,
): void {
  fs.writeFileSync(
    ownerPath(lockPath),
    JSON.stringify(
      {
        token,
        pid: process.pid,
        createdAt,
        updatedAt: new Date().toISOString(),
        sessionId: target.sessionId,
        agent: target.agent,
        handle: target.handle,
        cwd: target.cwd,
      },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );
}

export function lockTokenMatches(lock: Pick<SessionLock, "path" | "token">): boolean {
  return readLockOwner(lock.path)?.token === lock.token;
}

function startLockHeartbeat(
  lockPath: string,
  target: SessionLockTarget,
  token: string,
  createdAt: string,
): NodeJS.Timeout {
  let heartbeat: NodeJS.Timeout;
  heartbeat = setInterval(() => {
    if (!lockTokenMatches({ path: lockPath, token })) return;
    try {
      writeLockOwner(lockPath, target, token, createdAt);
    } catch {
      /* best effort: stale diagnostics remain available from the previous owner timestamp */
    }
  }, SESSION_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return heartbeat;
}

export function acquireSessionLock(
  target: SessionLockTarget,
): { lock?: SessionLock; error?: string } {
  const lockPath = path.join(target.lockRoot, `${target.sessionId}.lock`);
  try {
    fs.mkdirSync(target.lockRoot, { recursive: true });
  } catch (error) {
    return {
      error: `Failed to lock persistent subagent session ${target.sessionId}: ${String(error)}`,
    };
  }

  const token = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { error: lockedError(target.sessionId, lockPath) };
    }
    return {
      error: `Failed to lock persistent subagent session ${target.sessionId}: ${String(error)}`,
    };
  }

  try {
    writeLockOwner(lockPath, target, token, createdAt);
  } catch (error) {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return {
      error: `Failed to lock persistent subagent session ${target.sessionId}: ${String(error)}`,
    };
  }

  const heartbeat = startLockHeartbeat(lockPath, target, token, createdAt);
  return { lock: { sessionId: target.sessionId, path: lockPath, token, heartbeat } };
}

export function releaseSessionLocks(locks: SessionLock[]): void {
  for (const lock of locks) {
    clearInterval(lock.heartbeat);
    if (lockTokenMatches(lock)) {
      fs.rmSync(lock.path, { recursive: true, force: true });
    }
  }
}

export function acquireSessionLocks(
  targets: SessionLockTarget[],
): { locks: SessionLock[]; error?: string } {
  const locks: SessionLock[] = [];
  for (const target of targets) {
    let result: { lock?: SessionLock; error?: string };
    try {
      result = acquireSessionLock(target);
    } catch (error) {
      releaseSessionLocks(locks);
      return {
        locks: [],
        error: `Failed to lock persistent subagent session ${target.sessionId}: ${String(error)}`,
      };
    }
    if (result.error) {
      releaseSessionLocks(locks);
      return { locks: [], error: result.error };
    }
    if (result.lock) locks.push(result.lock);
  }
  return { locks };
}
