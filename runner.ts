/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  type InitialContext,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "PI_SUBAGENT_TEMP_PARENT_SESSION";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const PERSISTENT_SESSION_EXIT_TIMEOUT_MS = 30_000;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
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

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function writeSessionSnapshotToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `parent-${safeName}.jsonl`);
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

export function rewriteSessionHeaderCwd(
  sessionJsonl: string,
  cwd: string,
): string | null {
  const newlineIndex = sessionJsonl.indexOf("\n");
  const firstLine = newlineIndex === -1 ? sessionJsonl : sessionJsonl.slice(0, newlineIndex);
  if (!firstLine.trim()) return null;

  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null;
  }

  if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session") {
    return null;
  }

  const updatedHeader = { ...header, cwd };
  const rest = newlineIndex === -1 ? "" : sessionJsonl.slice(newlineIndex + 1);
  return `${JSON.stringify(updatedHeader)}\n${rest}`;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  prompt: string,
  initialContext: InitialContext,
  parentSessionPath: string | null,
  session: SubagentSessionDetails | undefined,
  persistentSessionDir: string | undefined,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  if (session && persistentSessionDir && !inheritedCliArgs.sessionDir) {
    args.push("--session-dir", persistentSessionDir);
  }

  if (session) {
    if (session.created && initialContext === "parent") {
      if (parentSessionPath) args.push("--fork", parentSessionPath);
    }
    args.push("--session-id", session.id);
    if (session.created) args.push("--name", session.name);
  } else if (initialContext === "parent") {
    if (parentSessionPath) args.push("--session", parentSessionPath);
  } else {
    args.push("--no-session");
  }

  const model = agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    } else if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the call doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Original call index in the tool invocation. */
  callIndex: number;
  /** Name of the agent to run. */
  agentName: string;
  /** Prompt sent verbatim to the subagent. */
  prompt: string;
  /** Effective working directory for this process. */
  callCwd?: string;
  /** Initial context for newly-created child conversations. */
  initialContext: InitialContext;
  /** Serialized parent session snapshot, used when initialContext is "parent". */
  parentSessionSnapshotJsonl?: string;
  /** Optional named persistent subagent session. */
  session?: SubagentSessionDetails;
  /** Optional persistent session directory inherited from the parent runtime. */
  persistentSessionDir?: string;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    callIndex,
    agentName,
    prompt,
    callCwd,
    initialContext,
    parentSessionSnapshotJsonl,
    session,
    persistentSessionDir,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      callIndex,
      agent: agentName,
      agentSource: "unknown",
      prompt,
      initialContext,
      session,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.`,
    };
  }

  const needsParentSnapshot = initialContext === "parent" && (!session || session.created);
  if (needsParentSnapshot && (!parentSessionSnapshotJsonl || !parentSessionSnapshotJsonl.trim())) {
    const message =
      "Cannot run with initialContext=\"parent\": missing parent session snapshot context.";
    return {
      callIndex,
      agent: agentName,
      agentSource: agent.source,
      prompt,
      initialContext,
      session,
      exitCode: 1,
      messages: [],
      stderr: message,
      usage: emptyUsage(),
      model: agent.model,
      stopReason: "error",
      errorMessage: message,
    };
  }

  const result: SingleResult = {
    callIndex,
    agent: agentName,
    agentSource: agent.source,
    prompt,
    initialContext,
    session,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: agent.model,
  };

  if (signal?.aborted) {
    return normalizeCompletedResult(result, true);
  }

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

  // Write system prompt to temp file if needed.
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  // Write parent session snapshot if this call needs one.
  let parentSessionTmpDir: string | null = null;
  let parentSessionTmpPath: string | null = null;
  if (needsParentSnapshot && parentSessionSnapshotJsonl) {
    const snapshotCwd = path.resolve(callCwd ?? cwd);
    const snapshotJsonl =
      rewriteSessionHeaderCwd(parentSessionSnapshotJsonl, snapshotCwd) ??
      parentSessionSnapshotJsonl;
    const tmp = writeSessionSnapshotToTempFile(agent.name, snapshotJsonl);
    parentSessionTmpDir = tmp.dir;
    parentSessionTmpPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      prompt,
      initialContext,
      parentSessionTmpPath,
      session,
      persistentSessionDir,
    );
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
      const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
      const propagatedStack = [...parentAgentStack, agentName];
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: callCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [SUBAGENT_DEPTH_ENV]: String(nextDepth),
          [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
          [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
          [SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
          [SUBAGENT_TEMP_PARENT_SESSION_ENV]: !session && initialContext === "parent" ? "1" : "0",
          [PI_OFFLINE_ENV]: "1",
        },
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;
      let persistentSessionExitTimer: NodeJS.Timeout | undefined;
      let forcedExitCode: number | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const clearPersistentSessionExitTimer = () => {
        if (persistentSessionExitTimer) {
          clearTimeout(persistentSessionExitTimer);
          persistentSessionExitTimer = undefined;
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
        clearSemanticCompletionTimer();
        clearPersistentSessionExitTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(forcedExitCode ?? code);
      };

      const flushLine = (line: string) => {
        if (processPiJsonLine(line, result)) emitUpdate();
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!result.sawAgentEnd || didClose || settled) return;
        if (session) {
          // Named sessions persist child history. Let Pi exit naturally so its
          // session file is fully flushed before the parent reports completion.
          if (!persistentSessionExitTimer) {
            persistentSessionExitTimer = setTimeout(() => {
              if (didClose || settled || !result.sawAgentEnd) return;
              result.processError = true;
              result.stopReason = "error";
              result.errorMessage = `Named subagent session did not exit within ${PERSISTENT_SESSION_EXIT_TIMEOUT_MS}ms after completing; terminated to avoid hanging.`;
              if (!result.stderr.includes(result.errorMessage)) {
                result.stderr += `${result.stderr ? "\n" : ""}${result.errorMessage}`;
              }
              forcedExitCode = 1;
              terminateChild();
            }, PERSISTENT_SESSION_EXIT_TIMEOUT_MS);
            persistentSessionExitTimer.unref();
          }
          return;
        }
        clearSemanticCompletionTimer();
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

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      // Abort handling.
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(promptTmpDir);
    cleanupTempDir(parentSessionTmpDir);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
