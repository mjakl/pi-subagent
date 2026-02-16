/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import { type SingleResult, type SubagentDetails, emptyUsage, getFinalOutput } from "./types.js";

const SIGKILL_TIMEOUT_MS = 5000;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupTempFile(filePath: string | null, dir: string | null): void {
	if (filePath) try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	if (dir) try { fs.rmdirSync(dir); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// JSON-line stream processing
// ---------------------------------------------------------------------------

function processJsonLine(line: string, result: SingleResult): boolean {
	if (!line.trim()) return false;

	let event: any;
	try { event = JSON.parse(line); } catch { return false; }

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
		return true;
	}

	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Message);
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

function buildPiArgs(agent: AgentConfig, systemPromptPath: string | null, task: string): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	args.push(`Task: ${task}`);
	return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
	/** Fallback working directory when the task doesn't specify one. */
	cwd: string;
	/** All available agent configs. */
	agents: AgentConfig[];
	/** Name of the agent to run. */
	agentName: string;
	/** Task description. */
	task: string;
	/** Optional override working directory. */
	taskCwd?: string;
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
	const { cwd, agents, agentName, task, taskCwd, signal, onUpdate, makeDetails } = opts;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
		};
	}

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
			details: makeDetails([result]),
		});
	};

	// Write system prompt to temp file if needed
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
	}

	try {
		const piArgs = buildPiArgs(agent, tmpPath, task);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", piArgs, {
				cwd: taskCwd ?? cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const flushLine = (line: string) => {
				if (processJsonLine(line, result)) emitUpdate();
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) flushLine(line);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				result.stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) flushLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			// Abort handling
			if (signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, SIGKILL_TIMEOUT_MS);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	} finally {
		cleanupTempFile(tmpPath, tmpDir);
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
