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
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgentsWithStarter } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "./session-paths.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { acquireSessionLocks, releaseSessionLocks, type SessionLockTarget } from "./session-lock.js";
import {
  type InitialContext,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  DEFAULT_INITIAL_CONTEXT,
  emptyUsage,
  isResultError,
  isResultSuccess,
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

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const CallItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  prompt: Type.String({
    description: "Prompt sent verbatim to the subagent for this call",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this subagent process" }),
  ),
  initialContext: Type.Optional(
    Type.Union([Type.Literal("empty"), Type.Literal("parent")], {
      description:
        "Initial context for a newly-created child conversation: 'empty' (default) or 'parent'. Existing named sessions ignore this field.",
      default: DEFAULT_INITIAL_CONTEXT,
    }),
  ),
  session: Type.Optional(
    Type.String({
      description:
        "Optional logical handle for a persistent subagent session. Scoped by parent session, effective cwd, and agent name.",
    }),
  ),
});

const SubagentParams = Type.Object({
  calls: Type.Array(CallItem, {
    description:
      "One or more subagent calls. A single call and multiple parallel calls use the same shape.",
  }),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description:
        "Whether to prompt the user before running project-local agents. Default: true.",
      default: true,
    }),
  ),
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
  effectiveCwd: string;
  initialContext: InitialContext;
  sessionHandle?: string;
  session?: SubagentSessionDetails;
}

interface NormalizedCallsResult {
  calls?: NormalizedCall[];
  error?: string;
}

interface ExtensionExecutionContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: SessionSnapshotSource & {
    getSessionId: () => string;
    getSessionDir: () => string;
    getSessionFile: () => string | undefined;
  };
  ui: { confirm: (title: string, body: string) => Promise<boolean> };
}

function parseInitialContext(raw: unknown): InitialContext | null {
  if (raw === undefined) return DEFAULT_INITIAL_CONTEXT;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (normalized === "empty" || normalized === "parent") return normalized;
  return null;
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

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
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

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
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
  return (results: SingleResult[]): SubagentDetails => ({
    projectAgentsDir,
    results,
  });
}

function formatUsageExample(): string {
  return `Use the current API shape:\n{\n  "calls": [\n    { "agent": "agent-name", "prompt": "Prompt sent verbatim to the subagent" }\n  ]\n}`;
}

function normalizeCalls(rawCalls: unknown, defaultCwd: string): NormalizedCallsResult {
  if (!Array.isArray(rawCalls)) {
    return { error: `Invalid subagent parameters: missing calls array.\n${formatUsageExample()}` };
  }
  if (rawCalls.length === 0) {
    return { error: `Invalid subagent parameters: calls must contain at least one call.\n${formatUsageExample()}` };
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

    const initialContext = parseInitialContext(call.initialContext);
    if (!initialContext) {
      return { error: `calls[${index}].initialContext must be "empty" or "parent".` };
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
      } catch {
        return { error: `calls[${index}].cwd does not exist or is not accessible: ${effectiveCwd}` };
      }
    } else {
      effectiveCwd = path.resolve(defaultCwd);
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
      effectiveCwd,
      initialContext,
      sessionHandle,
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

async function resolveSessionCreationState(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): Promise<void> {
  const sessionIdsByListKey = new Map<string, Set<string>>();

  for (const call of calls) {
    if (!call.session) continue;
    const key = `${sessionDir ?? ""}\0${call.effectiveCwd}`;
    let ids = sessionIdsByListKey.get(key);
    if (!ids) {
      const sessions = await SessionManager.list(call.effectiveCwd, sessionDir);
      ids = new Set(sessions.map((session) => session.id));
      sessionIdsByListKey.set(key, ids);
    }

    const exists = ids.has(call.session.id);
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

function sessionBaseDir(call: NormalizedCall, sessionDir: string | undefined): string {
  return sessionDir ?? ensureDefaultSessionDir(call.effectiveCwd);
}

function getSessionLockTargets(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): SessionLockTarget[] {
  return calls
    .filter((call) => call.session)
    .map((call) => ({
      sessionId: call.session!.id,
      lockRoot: path.join(sessionBaseDir(call, sessionDir), ".pi-subagent-locks"),
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

/** Get project-local agents referenced by the current request. */
function getRequestedProjectAgents(
  agents: AgentConfig[],
  requestedNames: Set<string>,
): AgentConfig[] {
  return Array.from(requestedNames)
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project");
}

/**
 * Prompt the user to confirm project-local agents if needed.
 * Returns false if the user declines.
 */
async function confirmProjectAgentsIfNeeded(
  projectAgents: AgentConfig[],
  projectAgentsDir: string | null,
  ctx: { ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
  if (projectAgents.length === 0) return true;

  const names = projectAgents.map((a) => a.name).join(", ");
  const dir = projectAgentsDir ?? "(unknown)";
  return ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
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
  };
}

function formatResultLabel(result: SingleResult, fallbackIndex: number): string {
  const index = result.callIndex ?? fallbackIndex;
  const sessionText = result.session ? ` session=${oneLine(result.session.handle)}` : "";
  return `${index}: ${result.agent}${sessionText}`;
}

function formatCallsSummary(results: SingleResult[]): string {
  const successCount = results.filter((r) => isResultSuccess(r)).length;
  const summaries = results.map((r, index) => {
    const status = isResultError(r) ? "failed" : "completed";
    return `[${formatResultLabel(r, index)}] ${status}:\n${getResultSummaryText(r)}`;
  });
  return `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
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

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const activeSessionIds = new Set<string>();

  let discoveredAgents: AgentConfig[] = [];

  // Auto-discover agents on session start.
  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
    const discovery = starterDiscovery.discovery;
    discoveredAgents = discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "explorer" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(
          `No subagents found. ${starterDiscovery.error}`,
          "info",
        );
      } else if (discoveredAgents.length > 0) {
        const list = discoveredAgents
          .map((a) => `  - ${a.name} (${a.source})`)
          .join("\n");
        ctx.ui.notify(
          `Found ${discoveredAgents.length} subagent(s):\n${list}`,
          "info",
        );
      }
    }
  });

  // Inject available agents into the system prompt.
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents
      .map((a) => `- **${a.name}**: ${a.description}`)
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Use \`calls\` for both one and many subagent invocations:

\`\`\`json
{
  "calls": [
    {
      "agent": "agent-name",
      "prompt": "Prompt sent verbatim to the subagent",
      "initialContext": "empty",
      "session": "optional-logical-handle"
    }
  ]
}
\`\`\`

Each call runs in an isolated \`pi\` process. Multiple calls may run concurrently.

Fields:
- \`agent\` — required, exact available agent name.
- \`prompt\` — required, non-empty, sent verbatim as the subagent user prompt.
- \`initialContext\` — optional: \`"empty"\` (default) starts without parent history; \`"parent"\` seeds a newly-created child conversation from the current parent session snapshot. Existing named sessions ignore this field.
- \`session\` — optional durable conversation handle. If present, the call continues or creates a persistent child Pi session. The handle is scoped by parent session, effective cwd, and agent name. The same handle used with different agents resolves to different sessions. Requires a persisted parent Pi session.
- \`cwd\` — optional working directory for that subagent process.

Rules:
- Do not use the same resolved session in more than one concurrent call. Same handle + same agent + same cwd conflicts; same handle + different agent is allowed. If a stale session lock is reported, remove the lock directory only after confirming no subagent is still running.
- Use \`session\` for multi-turn specialist work; omit it for one-off delegation, when the parent is running with \`--no-session\`, or from temporary parent-seeded subagent sessions.

### Runtime delegation guards

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Cycle prevention: ${preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)"}
`,
    };
  });

  // Register the subagent tool.
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate work to specialized subagents running in isolated pi processes.",
        "",
        "Use exactly one top-level `calls` array for both one and many invocations.",
        "Each call requires `agent` and `prompt`; `prompt` is sent verbatim.",
        "",
        "Per-call options:",
        "  initialContext: \"empty\" (default) or \"parent\".",
        "    - \"empty\": start a newly-created child conversation without parent history.",
        "    - \"parent\": seed a newly-created child conversation from the current parent session snapshot.",
        "    - Existing named sessions ignore initialContext.",
        "  session: optional durable logical handle for continuing/creating a persistent child Pi session.",
        "    Handles are scoped by parent session, effective cwd, and agent name.",
        "    The same handle with different agents resolves to different sessions.",
        "    Requires a persisted parent Pi session; omit it when the parent uses --no-session or this process is a temporary parent-seeded subagent session.",
        "  cwd: optional working directory for that subagent process.",
        "",
        "Multiple calls may run concurrently. A persistent session may be used by only one running call at a time; stale lock errors require manual cleanup after confirming no subagent is still running.",
        "",
        'Example: { calls: [{ agent: "review", prompt: "Review this diff", session: "api-review", initialContext: "parent" }] }',
      ].join("\n"),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        const normalized = normalizeCalls(params.calls, ctx.cwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent parameters." }],
            details: makeDetails([]),
            isError: true,
          };
        }
        const calls = normalized.calls;

        attachSessionIdentities(calls, ctx.sessionManager.getSessionId());

        const duplicateSessionError = getDuplicateSessionError(calls);
        if (duplicateSessionError) {
          return {
            content: [{ type: "text", text: duplicateSessionError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const parentSessionError = getNamedSessionParentError(
          calls,
          ctx as ExtensionExecutionContext,
        );
        if (parentSessionError) {
          return {
            content: [{ type: "text", text: parentSessionError }],
            details: makeDetails([]),
            isError: true,
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
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        const requestedProjectAgents = getRequestedProjectAgents(
          agents,
          requested,
        );
        const shouldConfirmProjectAgents = params.confirmProjectAgents ?? true;
        if (requestedProjectAgents.length > 0 && shouldConfirmProjectAgents) {
          if (ctx.hasUI) {
            const approved = await confirmProjectAgentsIfNeeded(
              requestedProjectAgents,
              discovery.projectAgentsDir,
              ctx,
            );
            if (!approved) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Canceled: project-local agents not approved.",
                  },
                ],
                details: makeDetails([]),
              };
            }
          } else {
            const names = requestedProjectAgents.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRe-run with confirmProjectAgents: false only if this repository is trusted.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext);

        const activeSessionError = getActiveSessionError(calls, activeSessionIds);
        if (activeSessionError) {
          return {
            content: [{ type: "text", text: activeSessionError }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const lockResult = acquireSessionLocks(
          getSessionLockTargets(calls, persistentSessionDir),
        );
        if (lockResult.error) {
          return {
            content: [{ type: "text", text: lockResult.error }],
            details: makeDetails([]),
            isError: true,
          };
        }

        const reservedSessionIds = calls
          .map((call) => call.session?.id)
          .filter((id): id is string => Boolean(id));
        for (const id of reservedSessionIds) activeSessionIds.add(id);

        try {
          try {
            await resolveSessionCreationState(calls, persistentSessionDir);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to inspect existing subagent sessions: ${message}`,
                },
              ],
              details: makeDetails([]),
              isError: true,
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
                details: makeDetails([]),
                isError: true,
              };
            }
            parentSessionSnapshotJsonl = snapshot;
          }

          return await executeCalls(
            calls,
            parentSessionSnapshotJsonl,
            persistentSessionDir,
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
    parentSessionSnapshotJsonl: string | undefined,
    persistentSessionDir: string | undefined,
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
      onUpdate({
        content: [
          {
            type: "text",
            text: `Subagents: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails([...allResults]),
      });
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
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            callIndex: call.index,
            agentName: call.agent,
            prompt: call.prompt,
            callCwd: call.effectiveCwd,
            initialContext: call.initialContext,
            parentSessionSnapshotJsonl,
            session: call.session,
            persistentSessionDir,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                allResults[workerIndex] = partial.details.results[0];
                emitProgress();
              }
            },
            makeDetails,
          });
          allResults[workerIndex] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const hasErrors = results.some((r) => isResultError(r));
    return {
      content: [
        {
          type: "text" as const,
          text: formatCallsSummary(results),
        },
      ],
      details: makeDetails(results),
      isError: hasErrors || undefined,
    };
  }
}
