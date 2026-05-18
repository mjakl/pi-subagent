/**
 * Pi Subagent Extension (Phase 1)
 *
 * Delegates tasks to specialized subagents running in isolated `pi` processes.
 *
 * Phase 1 design:
 * - Single sub-agent only (no parallel execution)
 * - Fork mode only (full context inheritance)
 * - Sub-agents inherit the exact same system prompt as the main agent
 * - Task delivered as user message with [sub-agent-task] tag
 * - Results returned as tool results
 *
 * This preserves KV cache stability: the main agent's KV cache prefix
 * remains valid because the system prompt is never modified.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { getResultSummaryText } from "./runner-events.js";
import { runAgent } from "./runner.js";
import {
	type SingleResult,
	emptyUsage,
	isResultError,
	isResultSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const DEFAULT_TIMEOUT_MS = 120_000; // 120 seconds
const DEFAULT_MAX_TURNS = 50;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	agent: Type.String({
		description: "Agent name. Must match exactly.",
	}),
	task: Type.String({
		description:
			"Task description. The sub-agent receives the full session context.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum execution time in seconds. Default: 120.",
			default: 120,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description:
				"Maximum number of assistant turns (LLM calls) the sub-agent can make. Default: 50.",
			default: 50,
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Whether to prompt the user before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process.",
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

function parseNonNegativeInt(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
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

function parseBoolean(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return null;
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

function formatAgentNames(agents: AgentConfig[]): string {
	return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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

// ---------------------------------------------------------------------------
// Session snapshot helper
// ---------------------------------------------------------------------------

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
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

	let discoveredAgents: AgentConfig[] = [];

	// Auto-discover agents on session start
	pi.on("session_start", async (_event, ctx) => {
		if (!canDelegate) return;

		const discovery = discoverAgents(ctx.cwd, "both");
		discoveredAgents = discovery.agents;

		if (discoveredAgents.length > 0 && ctx.hasUI) {
			const list = discoveredAgents
				.map((a) => `  - ${a.name} (${a.source})`)
				.join("\n");
			ctx.ui.notify(
				`Found ${discoveredAgents.length} subagent(s):\n${list}`,
				"info",
			);
		}
	});

	// REMOVED: before_agent_start handler that appended "## Available Subagents"
	// to the system prompt. This modified the system prompt dynamically, breaking
	// KV cache stability. Agent discovery info is now communicated via the tool
	// description instead.

	// Register the subagent tool
	if (canDelegate) {
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate work to a specialized subagent running in an isolated pi process.",
				"",
				"The subagent inherits your full session context (conversation history + system prompt).",
				"",
				"Optional parameters:",
				"  timeout: Max execution time in seconds (default: 120)",
				"  maxTurns: Max LLM turns/calls (default: 50)",
				"",
				"Example: { agent: \"writer\", task: \"Rewrite README.md\", timeout: 180 }",
			].join("\n"),
			parameters: SubagentParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const discovery = discoverAgents(ctx.cwd, "both");
				const { agents } = discovery;

				// Build session snapshot for fork mode (full context inheritance)
				let forkSessionSnapshotJsonl: string | undefined;
				forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(
					ctx.sessionManager,
				);
				if (!forkSessionSnapshotJsonl) {
					return {
						content: [
							{
								type: "text",
								text: "Cannot spawn sub-agent: failed to snapshot current session context.",
							},
						],
						details: { projectAgentsDir: discovery.projectAgentsDir, results: [] },
						isError: true,
					};
				}

				// Security: guard project-local agents before running
				const requested = new Set<string>([params.agent]);

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
							details: { projectAgentsDir: discovery.projectAgentsDir, results: [] },
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
								details: { projectAgentsDir: discovery.projectAgentsDir, results: [] },
							};
						}
					} else {
						const names = requestedProjectAgents.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						return {
							content: [
								{
									type: "text",
									text: `Blocked: project-local agent confirmation is required in non-UI mode.
Agents: ${names}
Source: ${dir}

Re-run with confirmProjectAgents: false only if this repository is trusted.`,
								},
							],
							details: { projectAgentsDir: discovery.projectAgentsDir, results: [] },
							isError: true,
						};
					}
				}

				// Execute single sub-agent
				const timeoutMs = (params.timeout ?? 120) * 1000;
				const maxTurns = params.maxTurns ?? 50;

				const result = await runAgent({
					cwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task,
					taskCwd: params.cwd,
					forkSessionSnapshotJsonl,
					parentDepth: currentDepth,
					parentAgentStack: ancestorAgentStack,
					maxDepth,
					preventCycles,
					signal,
					onUpdate,
					makeDetails: (results) => ({
						projectAgentsDir: discovery.projectAgentsDir,
						results,
					}),
					timeout: timeoutMs,
					maxTurns,
				});

				if (isResultError(result)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Sub-agent failed: ${getResultSummaryText(result)}`,
							},
						],
						details: { projectAgentsDir: discovery.projectAgentsDir, results: [result] },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: getResultSummaryText(result),
						},
					],
					details: { projectAgentsDir: discovery.projectAgentsDir, results: [result] },
				};
			},

			renderCall: (args, theme) => renderCall(args, theme),
			renderResult: (result, { expanded }, theme) =>
				renderResult(result, expanded, theme),
		});
	}
}
