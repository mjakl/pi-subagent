/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getFinalAssistantText } from "./runner-events.js";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn" | "fork";

/** Default context mode for delegated runs. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "spawn";

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	mode: "single" | "parallel";
	delegationMode: DelegationMode;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	if (hasSemanticCompletion(r)) return true;
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isResultSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = hasSemanticCompletion(result);

	if (wasAborted) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Subagent was aborted.") {
				result.errorMessage = undefined;
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}
