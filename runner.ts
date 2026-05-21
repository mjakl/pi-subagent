/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` subprocesses with full context inheritance.
 * Sub-agents inherit the exact same system prompt as the main agent
 * (no --append-system-prompt). Task is delivered as a user message.
 *
 * Simplified model:
 * - No named agents or config files
 * - Sub-agents inherit parent's model/tools/thinking
 * - Sub-agents cannot spawn further sub-agents (enforced in runner-events.js)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine, getInjectedFlag, setInjectedFlag } from "./runner-events.js";
import {
  type SingleResult,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const PI_OFFLINE_ENV = "PI_OFFLINE";

type OnUpdateCallback = (partial: AgentToolResult) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writeForkSessionToTempFile(
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const filePath = path.join(tmpDir, `session.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  task: string,
  forkSessionPath: string | null,
  taskCwd: string | undefined,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  // Fork mode: use the parent's session snapshot (full conversation history)
  if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  // Always inherit the parent's tools by default.
  // Sub-agents must have the same tool set as the parent to preserve KV cache.
  if (inheritedCliArgs.fallbackTools !== undefined) {
    args.push("--tools", inheritedCliArgs.fallbackTools);
  }

  // NO --append-system-prompt! The sub-agent inherits the main agent's
  // system prompt (Pi default + APPEND_SYSTEM.md) automatically.

  // Task message with sub-agent marker
  const taskMessage = `[sub-agent-task] Complete this task:\n${task}`;
  args.push(taskMessage);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Working directory. */
  cwd: string;
  /** Freeform name for the sub-agent. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Serialized parent session snapshot (full conversation in JSONL). */
  forkSessionSnapshotJsonl?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => { results: SingleResult[] };
  /** Maximum execution time in milliseconds. Default: 120000 (120s). */
  timeout?: number;
  /** Maximum number of assistant turns (LLM calls). Default: 50. */
  maxTurns?: number;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agentName,
    task,
    taskCwd,
    forkSessionSnapshotJsonl,
    signal,
    onUpdate,
    makeDetails,
    timeout = 120_000,
    maxTurns = 50,
  } = opts;

  if (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim()) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      stderr: "Cannot run sub-agent: missing parent session snapshot context.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "Cannot run sub-agent: missing parent session snapshot context.",
    };
  }

  const result: SingleResult = {
    agent: agentName,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    maxTurns: maxTurns,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  // Write forked session snapshot to temp file
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  if (forkSessionSnapshotJsonl) {
    const tmp = writeForkSessionToTempFile(forkSessionSnapshotJsonl);
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs(task, forkSessionTmpPath, taskCwd);
    let wasAborted = false;
    let timedOut = false;
    let exceededMaxTurns = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [PI_OFFLINE_ENV]: "1",
        },
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      // Keep stdin open — we may need to inject messages on timeout/maxTurns

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      // Helper: inject a user message into the child process via stdin
      const injectMessageIntoStdin = (message: string) => {
        if (didClose || settled || !proc.stdin) return;
        try {
          proc.stdin.write(message + "\n");
        } catch {
          /* pipe may be broken */
        }
      };

      // Helper: check if the child process is still alive and actively working
      const isChildAlive = (): boolean => {
        if (didClose || settled) return false;
        // If we've seen agent_end, the child has semantically finished
        if (result.sawAgentEnd) return false;
        // If the process has exited but we haven't processed the close event yet
        return true;
      };

      // Helper: handle max turns — terminate child and finish
      let maxTurnsTerminationScheduled = false;
      const handleMaxTurns = () => {
        if (maxTurnsTerminationScheduled || didClose || settled) return;
        maxTurnsTerminationScheduled = true;
        exceededMaxTurns = true;
        terminateChild();
        setTimeout(() => {
          if (!settled) finish(1);
        }, SIGKILL_TIMEOUT_MS + 500);
      };

      const flushLine = (line: string) => {
        if (exceededMaxTurns) return;
        if (processPiJsonLine(line, result, { stdin: proc.stdin, injectMessage: injectMessageIntoStdin, onMaxTurns: handleMaxTurns })) emitUpdate();
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!result.sawAgentEnd || didClose || settled) return;
        clearTimers();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !result.sawAgentEnd) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      // Timeout handling
      timeoutTimer = setTimeout(() => {
        if (didClose || settled) return;
        timedOut = true;
        result.timeout = true;
        result.exitCode = 124;
        result.stopReason = "timeout";
        result.errorMessage = `Sub-agent timed out after ${timeout / 1000}s`;
        result.stderr = `Sub-agent timed out after ${timeout / 1000}s`;

        // Try to inject a summary message before terminating
        if (isChildAlive() && !getInjectedFlag(result, "__timeoutInjected")) {
          setInjectedFlag(result, "__timeoutInjected", true);
          try {
            const summaryMsg = `You have reached your time limit. Please summarize what you did, where you stopped at, next steps, and anything relevant for the main agent.`;
            injectMessageIntoStdin(summaryMsg);
          } catch {
            /* ignore injection errors */
          }
        }

        terminateChild();
        setTimeout(() => {
          if (!settled) finish(124);
        }, SIGKILL_TIMEOUT_MS + 500);
      }, timeout);

      proc.on("close", (code) => {
        didClose = true;
        clearTimers();
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        clearTimers();
        finish(1);
      });

      // Abort handling
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          clearTimers();
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(forkSessionTmpDir);
  }
}
