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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { type SingleResult, type SubagentDetails, emptyUsage, getFinalOutput, isResultError } from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PARALLEL_HEARTBEAT_MS = 1000;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of an available agent (must match exactly)" }),
	task: Type.String({ description: "Self-contained task description with all necessary context. The subagent cannot see your conversation." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this agent's process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for single mode. Must match an available agent name exactly." })),
	task: Type.Optional(Type.String({ description: "Task description for single mode. Must be self-contained — the subagent has no access to your conversation history." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "For parallel mode: array of {agent, task} objects. Each task runs in an isolated process concurrently. Do NOT set agent/task when using this." })),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Whether to prompt the user before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode only)" })),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetailsFactory(projectAgentsDir: string | null) {
	return (mode: "single" | "parallel") =>
		(results: SingleResult[]): SubagentDetails => ({ mode, projectAgentsDir, results });
}

function formatAgentNames(agents: AgentConfig[]): string {
	return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

/** Get project-local agents referenced by the current request. */
function getRequestedProjectAgents(agents: AgentConfig[], requestedNames: Set<string>): AgentConfig[] {
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
				`\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process** with no access to your conversation. Task descriptions must be **self-contained** with all necessary context (file paths, requirements, constraints).

**Single mode** — delegate one task:
\`\`\`json
{ "agent": "agent-name", "task": "Detailed, self-contained task description..." }
\`\`\`

**Parallel mode** — run multiple tasks concurrently (do NOT also set agent/task):
\`\`\`json
{ "tasks": [{ "agent": "agent-name", "task": "..." }, { "agent": "other-agent", "task": "..." }] }
\`\`\`

Use single mode for one task, parallel mode when tasks are independent and can run simultaneously.
`,
		};
	});

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a specialized subagent running in its own isolated pi process.",
			"",
			"IMPORTANT: Use exactly ONE of these two modes:",
			"  Single mode:   set `agent` and `task` (both required together).",
			"  Parallel mode: set `tasks` array (do NOT also set `agent`/`task`).",
			"",
			"Each subagent runs with a fresh context — it cannot see your conversation.",
			"Write task descriptions that are fully self-contained with all needed context.",
			"",
			"Example single:   { agent: \"writer\", task: \"Rewrite README.md to be concise\" }",
			"Example parallel: { tasks: [{ agent: \"writer\", task: \"...\" }, { agent: \"tester\", task: \"...\" }] }",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd, "both");
			const { agents } = discovery;
			const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

			// Validate: exactly one mode must be specified
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${formatAgentNames(agents)}` }],
					details: makeDetails("single")([]),
				};
			}

			// Security: guard project-local agents before running
			const requested = new Set<string>();
			if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
			if (params.agent) requested.add(params.agent);

			const requestedProjectAgents = getRequestedProjectAgents(agents, requested);
			const shouldConfirmProjectAgents = params.confirmProjectAgents ?? true;
			if (requestedProjectAgents.length > 0 && shouldConfirmProjectAgents) {
				if (ctx.hasUI) {
					const approved = await confirmProjectAgentsIfNeeded(requestedProjectAgents, discovery.projectAgentsDir, ctx);
					if (!approved) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasTasks ? "parallel" : "single")([]),
						};
					}
				} else {
					const names = requestedProjectAgents.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					return {
						content: [{
							type: "text",
							text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRe-run with confirmProjectAgents: false only if this repository is trusted.`,
						}],
						details: makeDetails(hasTasks ? "parallel" : "single")([]),
						isError: true,
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

		let heartbeat: NodeJS.Timeout | undefined;
		if (onUpdate) {
			emitProgress();
			heartbeat = setInterval(() => {
				if (allResults.some((r) => r.exitCode === -1)) emitProgress();
			}, PARALLEL_HEARTBEAT_MS);
		}

		let results: SingleResult[];
		try {
			results = await mapConcurrent(tasks, MAX_CONCURRENCY, async (t, index) => {
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
		} finally {
			if (heartbeat) clearInterval(heartbeat);
		}

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const summaries = results.map((r) => {
			const output = getFinalOutput(r.messages);
			return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${output || "(no output)"}`;
		});

		return {
			content: [{ type: "text" as const, text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
			details: makeDetails("parallel")(results),
		};
	}
}
