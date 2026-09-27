/**
 * Pi Subagent Extension
 *
 * Delegates prompts to specialized subagents, each running as an isolated `pi`
 * process. The tool accepts a single `calls` array for both one and many
 * subagent invocations.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  ProjectTrustStore,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type AgentConfig,
  MAX_TIMER_SECONDS,
  STARTER_AGENT_NAME,
  discoverAgentsWithStarter,
} from "./agents.js";
import {
  CALLS_SCHEMA_DESCRIPTION,
  formatAvailableSubagentsPrompt,
  formatSubagentToolDescription,
  formatSubagentUsageErrorExample,
  getCallFieldSchemaDescription,
} from "./contract.js";
import { formatCallsSummary, writeOutputArtifact } from "./output.js";
import { renderCall, renderResult } from "./render.js";
import { parseInheritedCliArgs, selectInheritedPiArgv } from "./runner-cli.js";
import { getDefaultSessionDirPath, resolveChildSessionDir } from "./session-paths.js";
import { mapConcurrent, runAgent, type ParentModel } from "./runner.js";
import { acquireSessionLocks, releaseSessionLocks, type SessionLockTarget } from "./session-lock.js";
import {
  type CallThinkingLevel,
  type InitialContext,
  CALL_THINKING_LEVELS,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  DEFAULT_INITIAL_CONTEXT,
  emptyUsage,
  isResultError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CALLS = 8;
const MAX_CONCURRENCY = 4;
const CALLS_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "PI_SUBAGENT_TEMP_PARENT_SESSION";
const SESSION_ID_NAMESPACE = "pi-subagent/v1";
const SESSION_ID_PREFIX = "subagent.";
const SESSION_HANDLE_MAX_LENGTH = 120;
const inheritedPiArgv = selectInheritedPiArgv(process.argv, process.env);
const inheritedSessionDir = parseInheritedCliArgs(inheritedPiArgv).sessionDir;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const CallItem = Type.Object({
  agent: Type.String({
    description: getCallFieldSchemaDescription("agent"),
    minLength: 1,
  }),
  prompt: Type.String({
    description: getCallFieldSchemaDescription("prompt"),
    minLength: 1,
  }),
  model: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("model"),
      minLength: 1,
    }),
  ),
  thinking: Type.Optional(
    StringEnum(CALL_THINKING_LEVELS, {
      description: getCallFieldSchemaDescription("thinking"),
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("cwd"),
      minLength: 1,
    }),
  ),
  initialContext: Type.Optional(
    StringEnum(["empty", "parent"] as const, {
      description: getCallFieldSchemaDescription("initialContext"),
      default: DEFAULT_INITIAL_CONTEXT,
    }),
  ),
  session: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("session"),
      minLength: 1,
      maxLength: SESSION_HANDLE_MAX_LENGTH,
    }),
  ),
  inactivityTimeout: Type.Optional(
    Type.Integer({
      description: getCallFieldSchemaDescription("inactivityTimeout"),
      minimum: 1,
      maximum: MAX_TIMER_SECONDS,
    }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      description: getCallFieldSchemaDescription("timeout"),
      minimum: 1,
      maximum: MAX_TIMER_SECONDS,
    }),
  ),
});

const SubagentParams = Type.Object({
  calls: Type.Array(CallItem, {
    description: CALLS_SCHEMA_DESCRIPTION,
    minItems: 1,
    maxItems: MAX_CALLS,
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

interface NormalizedCall {
  index: number;
  agent: string;
  prompt: string;
  model?: string;
  thinking?: CallThinkingLevel;
  effectiveCwd: string;
  initialContext: InitialContext;
  sessionHandle?: string;
  session?: SubagentSessionDetails;
  persistentSessionDir?: string;
  inactivityTimeoutMs?: number;
  timeoutMs?: number;
}

interface NormalizedCallsResult {
  calls?: NormalizedCall[];
  error?: string;
}

interface ExtensionExecutionContext {
  cwd: string;
  sessionManager: SessionSnapshotSource & {
    getSessionId: () => string;
    getSessionDir: () => string;
    getSessionFile: () => string | undefined;
  };
}

function parseInitialContext(raw: unknown): InitialContext | null {
  if (raw === undefined) return DEFAULT_INITIAL_CONTEXT;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (normalized === "empty" || normalized === "parent") return normalized;
  return null;
}

function parseOptionalTimeoutMs(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_TIMER_SECONDS
  ) return null;
  return raw * 1000;
}

function buildParentSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

export function getProjectTrustOverrideFromArgv(argv: string[]): boolean | null {
  return parseInheritedCliArgs(argv).projectTrustOverride ?? null;
}

function shouldIncludeProjectAgents(cwd: string, contextTrusted: boolean): boolean {
  if (!contextTrusted) return false;

  const trustOverride = getProjectTrustOverrideFromArgv(inheritedPiArgv);
  if (trustOverride !== null) return trustOverride;

  try {
    return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
  } catch (error) {
    console.warn(`[pi-subagent] Could not verify project trust; project agents are disabled: ${String(error)}`);
    return false;
  }
}

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(inheritedPiArgv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(inheritedPiArgv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(projectAgentsDir: string | null) {
  return (results: SingleResult[], failed = false): SubagentDetails => ({
    kind: "pi-subagent",
    projectAgentsDir,
    results,
    ...(failed ? { failed: true as const } : {}),
  });
}

export function resolveCallCwd(defaultCwd: string, rawCwd?: string): string {
  return fs.realpathSync(path.resolve(defaultCwd, rawCwd ?? "."));
}

export function normalizeCalls(rawCalls: unknown, defaultCwd: string): NormalizedCallsResult {
  if (!Array.isArray(rawCalls)) {
    return { error: `Invalid subagent parameters: missing calls array.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length === 0) {
    return { error: `Invalid subagent parameters: calls must contain at least one call.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length > MAX_CALLS) {
    return { error: `Too many subagent calls (${rawCalls.length}). Max is ${MAX_CALLS}.` };
  }

  const calls: NormalizedCall[] = [];
  for (let index = 0; index < rawCalls.length; index++) {
    const raw = rawCalls[index];
    if (!raw || typeof raw !== "object") {
      return { error: `calls[${index}] must be an object.` };
    }
    const call = raw as Record<string, unknown>;

    if (typeof call.agent !== "string" || call.agent.trim().length === 0) {
      return { error: `calls[${index}].agent must be a non-empty string.` };
    }
    const agent = call.agent.trim();

    if (typeof call.prompt !== "string" || call.prompt.trim().length === 0) {
      return { error: `calls[${index}].prompt must be a non-empty string.` };
    }
    const prompt = call.prompt;

    let model: string | undefined;
    if (call.model !== undefined) {
      if (typeof call.model !== "string") {
        return { error: `calls[${index}].model must be a string when provided.` };
      }
      model = call.model.trim();
      if (!model) {
        return { error: `calls[${index}].model must not be empty when provided.` };
      }
    }

    let thinking: CallThinkingLevel | undefined;
    if (call.thinking !== undefined) {
      if (typeof call.thinking !== "string" || !CALL_THINKING_LEVELS.includes(call.thinking as CallThinkingLevel)) {
        return { error: `calls[${index}].thinking must be one of: ${CALL_THINKING_LEVELS.join(", ")}.` };
      }
      thinking = call.thinking as CallThinkingLevel;
    }

    const initialContext = parseInitialContext(call.initialContext);
    if (!initialContext) {
      return { error: `calls[${index}].initialContext must be "empty" or "parent".` };
    }

    const inactivityTimeoutMs = parseOptionalTimeoutMs(call.inactivityTimeout);
    if (inactivityTimeoutMs === null) {
      return {
        error: `calls[${index}].inactivityTimeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
      };
    }

    const timeoutMs = parseOptionalTimeoutMs(call.timeout);
    if (timeoutMs === null) {
      return {
        error: `calls[${index}].timeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
      };
    }

    let effectiveCwd: string;
    if (call.cwd !== undefined) {
      if (typeof call.cwd !== "string" || call.cwd.trim().length === 0) {
        return { error: `calls[${index}].cwd must be a non-empty string when provided.` };
      }
      effectiveCwd = path.resolve(defaultCwd, call.cwd);
      try {
        if (!fs.statSync(effectiveCwd).isDirectory()) {
          return { error: `calls[${index}].cwd is not a directory: ${effectiveCwd}` };
        }
        effectiveCwd = resolveCallCwd(defaultCwd, call.cwd);
      } catch {
        return { error: `calls[${index}].cwd does not exist or is not accessible: ${effectiveCwd}` };
      }
    } else {
      try {
        effectiveCwd = resolveCallCwd(defaultCwd);
      } catch {
        return { error: `Parent cwd does not exist or is not accessible: ${path.resolve(defaultCwd)}` };
      }
    }

    let sessionHandle: string | undefined;
    if (call.session !== undefined) {
      if (typeof call.session !== "string") {
        return { error: `calls[${index}].session must be a string when provided.` };
      }
      sessionHandle = call.session.trim();
      if (!sessionHandle) {
        return { error: `calls[${index}].session must not be empty when provided.` };
      }
      if (sessionHandle.length > SESSION_HANDLE_MAX_LENGTH) {
        return {
          error: `calls[${index}].session must be at most ${SESSION_HANDLE_MAX_LENGTH} characters.`,
        };
      }
    }

    calls.push({
      index,
      agent,
      prompt,
      model,
      thinking,
      effectiveCwd,
      initialContext,
      sessionHandle,
      inactivityTimeoutMs,
      timeoutMs,
    });
  }

  return { calls };
}

function stableSessionSeed(values: unknown[]): string {
  return JSON.stringify(values);
}

function deriveSessionId(
  parentSessionId: string,
  effectiveCwd: string,
  agentName: string,
  sessionHandle: string,
): string {
  const digest = createHash("sha256")
    .update(stableSessionSeed([
      SESSION_ID_NAMESPACE,
      parentSessionId,
      effectiveCwd,
      agentName,
      sessionHandle,
    ]))
    .digest("hex")
    .slice(0, 16);
  return `${SESSION_ID_PREFIX}${digest}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSessionDisplayName(agentName: string, sessionHandle: string): string {
  return `subagent: ${agentName} · ${oneLine(sessionHandle)}`;
}

function attachSessionIdentities(calls: NormalizedCall[], parentSessionId: string): void {
  for (const call of calls) {
    if (!call.sessionHandle) continue;
    const id = deriveSessionId(
      parentSessionId,
      call.effectiveCwd,
      call.agent,
      call.sessionHandle,
    );
    call.session = {
      handle: call.sessionHandle,
      id,
      name: formatSessionDisplayName(call.agent, call.sessionHandle),
      cwd: call.effectiveCwd,
      created: false,
      initialContextApplied: null,
    };
  }
}

function getDuplicateSessionError(calls: NormalizedCall[]): string | null {
  const firstById = new Map<string, NormalizedCall>();
  for (const call of calls) {
    if (!call.session) continue;
    const first = firstById.get(call.session.id);
    if (first) {
      return `Invalid subagent calls: calls[${first.index}] and calls[${call.index}] resolve to the same persistent session (${call.session.id}).\nA persistent subagent session can only be used by one call at a time. Use different session handles or combine the prompts.`;
    }
    firstById.set(call.session.id, call);
  }
  return null;
}

function getActiveSessionError(
  calls: NormalizedCall[],
  activeSessionIds: Set<string>,
): string | null {
  for (const call of calls) {
    if (call.session && activeSessionIds.has(call.session.id)) {
      return `Invalid subagent calls: calls[${call.index}] uses persistent session ${call.session.id}, which is already running in another subagent call. Retry after that call finishes.`;
    }
  }
  return null;
}

function resolveSessionCreationState(calls: NormalizedCall[]): void {
  for (const call of calls) {
    if (!call.session) continue;
    const exists = SessionManager.findById(call.effectiveCwd, call.session.id, call.persistentSessionDir);
    call.session.created = !exists;
    call.session.initialContextApplied = exists ? null : call.initialContext;
  }
}

function needsParentSnapshot(calls: NormalizedCall[]): boolean {
  return calls.some(
    (call) => call.initialContext === "parent" && (!call.session || call.session.created),
  );
}

function getPersistentSessionDir(ctx: ExtensionExecutionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as {
    usesDefaultSessionDir?: () => boolean;
  };

  if (typeof manager.usesDefaultSessionDir === "function") {
    return manager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
  }

  try {
    const current = path.resolve(ctx.sessionManager.getSessionDir());
    const defaultDir = path.resolve(getDefaultSessionDirPath(ctx.cwd));
    return current === defaultDir ? undefined : ctx.sessionManager.getSessionDir();
  } catch {
    return undefined;
  }
}

function getNamedSessionParentError(
  calls: NormalizedCall[],
  ctx: ExtensionExecutionContext,
): string | null {
  if (!calls.some((call) => call.session)) return null;
  if (parseBoolean(process.env[SUBAGENT_TEMP_PARENT_SESSION_ENV]) === true) {
    return "Named subagent sessions are not available from temporary parent-seeded subagent sessions. Omit `session` or use a named parent subagent session first.";
  }
  if (ctx.sessionManager.getSessionFile()) return null;
  return "Named subagent sessions require a persisted parent Pi session. Omit `session` for ephemeral delegation, or run the parent without --no-session.";
}

function getSessionLockTargets(calls: NormalizedCall[]): SessionLockTarget[] {
  return calls
    .filter((call) => call.session)
    .map((call) => ({
      sessionId: call.session!.id,
      lockRoot: path.join(call.persistentSessionDir!, ".pi-subagent-locks"),
      agent: call.agent,
      handle: call.session!.handle,
      cwd: call.effectiveCwd,
    }));
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

function makePlaceholderResult(call: NormalizedCall): SingleResult {
  return {
    callIndex: call.index,
    agent: call.agent,
    agentSource: "unknown",
    prompt: call.prompt,
    initialContext: call.initialContext,
    session: call.session,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: call.model,
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });
  pi.registerFlag("no-subagent-prevent-cycles", {
    description: "Disable subagent delegation cycle prevention.",
    type: "boolean",
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const activeSessionIds = new Set<string>();
  const outputArtifactDirs = new Set<string>();

  const saveFullOutput = (content: string): string | null => {
    try {
      const artifact = writeOutputArtifact(content);
      outputArtifactDirs.add(artifact.dir);
      return artifact.filePath;
    } catch (error) {
      console.warn(`[pi-subagent] Could not save truncated output: ${String(error)}`);
      return null;
    }
  };

  pi.on("session_shutdown", () => {
    for (const dir of outputArtifactDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS temp directory remains the fallback lifecycle.
      }
    }
    outputArtifactDirs.clear();
  });

  let discoveredAgents: AgentConfig[] = [];

  // Auto-discover agents on session start.
  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(
      ctx.cwd,
      shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
    );
    const discovery = starterDiscovery.discovery;
    discoveredAgents = discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "${STARTER_AGENT_NAME}" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(
          `No subagents found. ${starterDiscovery.error}`,
          "info",
        );
      }
    }
  });

  // Inject available agents into the system prompt.
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    return {
      systemPrompt:
        event.systemPrompt +
        formatAvailableSubagentsPrompt(discoveredAgents, {
          currentDepth,
          maxDepth,
          preventCycles,
          ancestorAgentStack,
        }),
    };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent") return;
    const details = event.details as Partial<SubagentDetails> | undefined;
    if (details?.kind === "pi-subagent" && details.failed === true) {
      return { isError: true };
    }
  });

  // Register the subagent tool.
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: formatSubagentToolDescription(),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const parentModel: ParentModel | undefined = ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined;
        const starterDiscovery = discoverAgentsWithStarter(
          ctx.cwd,
          shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
        );
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        const normalized = normalizeCalls(params.calls, ctx.cwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent parameters." }],
            details: makeDetails([], true),
          };
        }
        const calls = normalized.calls;

        const parentSessionId = ctx.sessionManager.getSessionId();
        attachSessionIdentities(calls, parentSessionId);

        const duplicateSessionError = getDuplicateSessionError(calls);
        if (duplicateSessionError) {
          return {
            content: [{ type: "text", text: duplicateSessionError }],
            details: makeDetails([], true),
          };
        }

        const parentSessionError = getNamedSessionParentError(
          calls,
          ctx as ExtensionExecutionContext,
        );
        if (parentSessionError) {
          return {
            content: [{ type: "text", text: parentSessionError }],
            details: makeDetails([], true),
          };
        }

        const requested = new Set(calls.map((call) => call.agent));

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails([], true),
            };
          }
        }

        const runtimeSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext);
        for (const call of calls) {
          if (call.session) {
            call.persistentSessionDir = resolveChildSessionDir(
              call.effectiveCwd, inheritedSessionDir, runtimeSessionDir,
            );
          }
        }

        const activeSessionError = getActiveSessionError(calls, activeSessionIds);
        if (activeSessionError) {
          return {
            content: [{ type: "text", text: activeSessionError }],
            details: makeDetails([], true),
          };
        }

        const lockResult = acquireSessionLocks(
          getSessionLockTargets(calls),
        );
        if (lockResult.error) {
          return {
            content: [{ type: "text", text: lockResult.error }],
            details: makeDetails([], true),
          };
        }

        const reservedSessionIds = calls
          .map((call) => call.session?.id)
          .filter((id): id is string => Boolean(id));
        for (const id of reservedSessionIds) activeSessionIds.add(id);

        try {
          try {
            resolveSessionCreationState(calls);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to inspect existing subagent sessions: ${message}`,
                },
              ],
              details: makeDetails([], true),
            };
          }

          let parentSessionSnapshotJsonl: string | undefined;
          if (needsParentSnapshot(calls)) {
            const snapshot = buildParentSessionSnapshotJsonl(ctx.sessionManager);
            if (!snapshot) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Cannot run subagent calls: failed to snapshot current parent session context for calls requiring initialContext=\"parent\".",
                  },
                ],
                details: makeDetails([], true),
              };
            }
            parentSessionSnapshotJsonl = snapshot;
          }

          return await executeCalls(
            calls,
            parentSessionId,
            parentSessionSnapshotJsonl,
            parentModel,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        } finally {
          for (const id of reservedSessionIds) activeSessionIds.delete(id);
          releaseSessionLocks(lockResult.locks);
        }
      },

      renderCall: (args, theme) => renderCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
    });
  }

  // -----------------------------------------------------------------------
  // Call execution
  // -----------------------------------------------------------------------

  async function executeCalls(
    calls: NormalizedCall[],
    parentSessionId: string,
    parentSessionSnapshotJsonl: string | undefined,
    parentModel: ParentModel | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const allResults: SingleResult[] = calls.map(makePlaceholderResult);

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      try {
        onUpdate({
          content: [
            {
              type: "text",
              text: `Subagents: ${done}/${allResults.length} done, ${running} running...`,
            },
          ],
          details: makeDetails([...allResults]),
        });
      } catch (error) {
        console.warn(`[pi-subagent] Progress callback failed: ${String(error)}`);
      }
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, CALLS_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      results = await mapConcurrent(
        calls,
        MAX_CONCURRENCY,
        async (call, workerIndex) => {
          let result: SingleResult;
          try {
            result = await runAgent({
              cwd: defaultCwd,
              agents,
              callIndex: call.index,
              agentName: call.agent,
              prompt: call.prompt,
              callModel: call.model,
              callThinking: call.thinking,
              parentSessionId,
              parentModel,
              callCwd: call.effectiveCwd,
              initialContext: call.initialContext,
              parentSessionSnapshotJsonl,
              session: call.session,
              persistentSessionDir: call.persistentSessionDir,
              parentDepth: currentDepth,
              parentAgentStack: ancestorAgentStack,
              maxDepth,
              preventCycles,
              inactivityTimeoutMs: call.inactivityTimeoutMs,
              timeoutMs: call.timeoutMs,
              signal,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  allResults[workerIndex] = partial.details.results[0];
                  emitProgress();
                }
              },
              makeDetails,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = {
              ...makePlaceholderResult(call),
              exitCode: 1,
              stderr: message,
              stopReason: "error",
              errorMessage: message,
              processError: true,
            };
          }
          allResults[workerIndex] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const hasErrors = results.some((r) => isResultError(r));
    const summary = formatCallsSummary(results, saveFullOutput);
    return {
      content: [
        {
          type: "text" as const,
          text: summary.text,
        },
      ],
      details: makeDetails(results, hasErrors),
    };
  }
}
