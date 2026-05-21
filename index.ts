/**
 * Pi Subagent Extension (Simplified)
 *
 * Delegates tasks to sub-agents running in isolated `pi` processes.
 *
 * Simplified design:
 * - Sub-agents identified by a freeform name (no config files)
 * - Sub-agents inherit the exact same system prompt and session context as the main agent
 * - Sub-agents cannot spawn further sub-agents (enforced at runner level)
 * - No named agents, no tool sets, no model overrides
 *
 * This preserves KV cache stability: the main agent's KV cache prefix
 * remains valid because the system prompt is never modified (auto-injected constant text only).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderCall, renderResult } from "./render.js";
import { getFinalAssistantText, getResultSummaryText } from "./runner-events.js";
import { runAgent } from "./runner.js";
import {
	type SingleResult,
	emptyUsage,
	isResultError,
	isResultSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Constant sub-agent instructions injected into the system prompt.
 *
 * This text is deterministic — it never changes regardless of session,
 * project, or model. KV cache stable.
 */
const SUBAGENT_INSTRUCTIONS = `
## Sub-Agent Tools/Extension

Since we are running all our LLMs locally, we have to use a modified version of sub-agents. This means that you may switch between main agent and sub agent mode at any point during the session. 

You will know sub-agent mode is active when you see a user message that follows this format:

\`\`\`
**[BEGIN SUB AGENT MODE]**: <prompt and task will go here>
\`\`\`

Once you see that then you will be operating in sub-agent mode, where you have an assigned task and should work to complete it. You will not be able to spawn any sub agents while operating in sub agent mode.
Your primary goal is to accomplish the task and report back to the main agent.

Another way to tell if you are in sub-agent mode is to look at the most recent tool call. You will see the sub-agent tool call followed by an empty tool result "No result provided". You ARE the tool result actively running in sub-agent mode.
This means your final response will be the tool_result.

### When to Use a Sub-Agent

Use sub-agents when you need to:
- Do heavy research across many files without polluting your context
- Run long-running tasks that would consume your context window
- Offload specialized work while you continue other tasks
- Preserve context efficiency by keeping only summaries in your context

A sub-agent will have FULL context for all tool calls/results and message history up until the point you spawn it, meaning it will know exactly what you know. Keep this in mind while defining a full task statement.

### Calling the Subagent Tool

\`\`\`
subagent({
  name: "researcher",     // Freeform name (human-like, for your reference)
  task: "Research the latest about quantum computing",
  timeout: 180,           // Optional: max seconds (default: 600)
  maxTurns: 80,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
\`\`\`


### Best Practices

1. Give sub-agents clear, specific task descriptions
2. Set appropriate timeouts for long-running tasks
3. Let sub-agents write results to files — you can read them back
4. Use sub-agents to consolidate knowledge into summaries before bringing it back into your context
`;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	name: Type.String({
		description: "A human-like name for the sub-agent (e.g., 'researcher', 'analyst', or even something like 'Albert', 'Isaac', 'Ben' for non-focused tasks). Freeform, no config lookup.",
	}),
	task: Type.String({
		description:
			"Task description. The sub-agent receives the full session context.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum execution time in seconds. Default: 600.",
			default: 600,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description:
				"Maximum number of assistant turns (LLM calls) the sub-agent can make. Default: 50.",
			default: 50,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process. Will default to your CWD.",
		}),
	),
});

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
	// Auto-inject constant sub-agent instructions into system prompt.
	// This is deterministic — same text every session — so KV cache is stable.
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + SUBAGENT_INSTRUCTIONS,
		};
	});

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a sub-agent running in an isolated pi process.",
			"",
			"The sub-agent inherits your full session context (conversation history + system prompt).",
			"",
			"Optional parameters:",
			"  timeout: Max execution time in seconds (default: 120)",
			"  maxTurns: Max LLM turns/calls (default: 50)",
			"",
			"Example: { name: \"researcher\", task: \"Research the latest about quantum computing\", timeout: 180 }",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
					details: { results: [] },
					isError: true,
				};
			}

			// Execute sub-agent
			const timeoutMs = (params.timeout ?? 120) * 1000;
			const maxTurns = params.maxTurns ?? 50;

			const result = await runAgent({
				cwd: ctx.cwd,
				agentName: params.name,
				task: params.task,
				taskCwd: params.cwd,
				forkSessionSnapshotJsonl,
				signal,
				onUpdate,
				makeDetails: (results) => ({ results }),
				timeout: timeoutMs,
				maxTurns,
			});

			console.error(`[DEBUG execute] isResultError check: exitCode=${result.exitCode} stopReason=${result.stopReason} sawAgentEnd=${result.sawAgentEnd} messages.length=${result.messages.length} stderr=${result.stderr.substring(0,100)} hasFinalText=${getFinalAssistantText(result.messages).substring(0,80)}`);
			if (isResultError(result)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Sub-agent failed: ${getResultSummaryText(result)}`,
						},
					],
					details: { results: [result] },
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
				details: { results: [result] },
			};
		},

		renderCall: (args, theme) => renderCall(args, theme),
		renderResult: (result, { expanded }, theme) =>
			renderResult(result, expanded, theme),
	});
}
