/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process with its own context window.
 *
 * Supports two modes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { type SingleResult, type SubagentDetails, emptyUsage, getFinalOutput, isResultError } from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetailsFactory(agentScope: AgentScope, projectAgentsDir: string | null) {
	return (mode: "single" | "parallel") =>
		(results: SingleResult[]): SubagentDetails => ({ mode, agentScope, projectAgentsDir, results });
}

function formatAgentNames(agents: AgentConfig[]): string {
	return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

/**
 * Prompt the user to confirm project-local agents if needed.
 * Returns false if the user declines.
 */
async function confirmProjectAgentsIfNeeded(
	agents: AgentConfig[],
	requestedNames: Set<string>,
	projectAgentsDir: string | null,
	ctx: { hasUI: boolean; ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
	const projectAgents = Array.from(requestedNames)
		.map((name) => agents.find((a) => a.name === name))
		.filter((a): a is AgentConfig => a?.source === "project");

	if (projectAgents.length === 0) return true;

	const names = projectAgents.map((a) => a.name).join(", ");
	const dir = projectAgentsDir ?? "(unknown)";
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let discoveredAgents: AgentConfig[] = [];

	// Auto-discover agents on session start
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverAgents(ctx.cwd, "both");
		discoveredAgents = discovery.agents;

		if (discoveredAgents.length > 0 && ctx.hasUI) {
			const list = discoveredAgents.map((a) => `  - ${a.name} (${a.source})`).join("\n");
			ctx.ui.notify(`Found ${discoveredAgents.length} subagent(s):\n${list}`, "info");
		}
	});

	// Inject available agents into the system prompt
	pi.on("before_agent_start", async (event) => {
		if (discoveredAgents.length === 0) return;

		const agentList = discoveredAgents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Available Subagents\n\nThe following subagents are available for delegation via the \`subagent\` tool:\n\n${agentList}\n\nUse the subagent tool to delegate tasks to these specialized agents when appropriate.\n`,
		};
	});

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const { agents } = discovery;
			const makeDetails = makeDetailsFactory(agentScope, discovery.projectAgentsDir);

			// Validate: exactly one mode must be specified
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${formatAgentNames(agents)}` }],
					details: makeDetails("single")([]),
				};
			}

			// Security: confirm project-local agents before running
			if ((agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
				const requested = new Set<string>();
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);

				const approved = await confirmProjectAgentsIfNeeded(agents, requested, discovery.projectAgentsDir, ctx);
				if (!approved) {
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: makeDetails(hasTasks ? "parallel" : "single")([]),
					};
				}
			}

			// ── Parallel mode ──
			if (params.tasks && params.tasks.length > 0) {
				return executeParallel(params.tasks, agents, ctx.cwd, signal, onUpdate, makeDetails);
			}

			// ── Single mode ──
			if (params.agent && params.task) {
				return executeSingle(params.agent, params.task, params.cwd, agents, ctx.cwd, signal, onUpdate, makeDetails);
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall: (args, theme) => renderCall(args, theme),
		renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),
	});

	// -----------------------------------------------------------------------
	// Mode implementations
	// -----------------------------------------------------------------------

	async function executeSingle(
		agentName: string,
		task: string,
		cwd: string | undefined,
		agents: AgentConfig[],
		defaultCwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: any) => void) | undefined,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
	) {
		const result = await runAgent({
			cwd: defaultCwd,
			agents,
			agentName,
			task,
			taskCwd: cwd,
			signal,
			onUpdate,
			makeDetails: makeDetails("single"),
		});

		if (isResultError(result)) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		return {
			content: [{ type: "text" as const, text: getFinalOutput(result.messages) || "(no output)" }],
			details: makeDetails("single")([result]),
		};
	}

	async function executeParallel(
		tasks: Array<{ agent: string; task: string; cwd?: string }>,
		agents: AgentConfig[],
		defaultCwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: any) => void) | undefined,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
	) {
		if (tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [{ type: "text" as const, text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: makeDetails("parallel")([]),
			};
		}

		// Initialize placeholder results for streaming
		const allResults: SingleResult[] = tasks.map((t) => ({
			agent: t.agent,
			agentSource: "unknown" as const,
			task: t.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		}));

		const emitProgress = () => {
			if (!onUpdate) return;
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails("parallel")([...allResults]),
			});
		};

		const results = await mapConcurrent(tasks, MAX_CONCURRENCY, async (t, index) => {
			const result = await runAgent({
				cwd: defaultCwd,
				agents,
				agentName: t.agent,
				task: t.task,
				taskCwd: t.cwd,
				signal,
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitProgress();
					}
				},
				makeDetails: makeDetails("parallel"),
			});
			allResults[index] = result;
			emitProgress();
			return result;
		});

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const summaries = results.map((r) => {
			const output = getFinalOutput(r.messages);
			const preview = output.length > 100 ? `${output.slice(0, 100)}...` : output;
			return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
		});

		return {
			content: [{ type: "text" as const, text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
			details: makeDetails("parallel")(results),
		};
	}
}
