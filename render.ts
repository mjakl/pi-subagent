/**
 * TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getProcessErrorText, getResultSummaryText } from "./runner-events.js";
import {
	type DisplayItem,
	type InitialContext,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	isResultError,
	isResultSuccess,
} from "./types.js";

const COLLAPSED_LINE_COUNT = 8;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function oneLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function getResultPrompt(result: SingleResult & { task?: unknown }): string {
	if (typeof result.prompt === "string") return result.prompt;
	if (typeof result.task === "string") return result.task;
	return "";
}

type ThemeFg = (color: string, text: string) => string;

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(cmd, 60));
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${truncate(JSON.stringify(args), 50)}`);
	}
}

function formatInitialContext(context?: InitialContext): string {
	return context === "parent" ? "parent" : "empty";
}

function formatResultLabel(r: SingleResult, fallbackIndex: number): string {
	const index = r.callIndex ?? fallbackIndex;
	const sessionText = r.session ? ` session=${oneLine(r.session.handle)}` : "";
	return `${index}: ${r.agent}${sessionText}`;
}

function formatInitialContextStatus(r: SingleResult): string {
	if (!r.session) return formatInitialContext(r.initialContext);
	if (r.session.initialContextApplied) {
		return `${formatInitialContext(r.session.initialContextApplied)} applied`;
	}
	return `${formatInitialContext(r.initialContext)} requested, ignored (continued session)`;
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countDisplayLines(items: DisplayItem[]): number {
	let count = 0;
	for (const item of items) {
		count += item.type === "text" ? splitOutputLines(item.text).length : 1;
	}
	return count;
}

function renderDisplayItems(
	items: DisplayItem[],
	expanded: boolean,
	theme: { fg: ThemeFg },
	limit?: number,
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "text") {
			for (const line of splitOutputLines(item.text)) {
				lines.push(theme.fg("toolOutput", line));
			}
		} else {
			lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}

	const shouldTail = !expanded && typeof limit === "number";
	const toShow = shouldTail ? lines.slice(-limit) : lines;
	const skipped = shouldTail && lines.length > limit ? lines.length - limit : 0;

	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier lines\n`);
	text += toShow.join("\n");
	return text.trimEnd();
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(args: Record<string, any>, theme: { fg: ThemeFg; bold: (s: string) => string }): Text {
	const calls = Array.isArray(args.calls) ? args.calls : [];
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `${calls.length || "?"} call${calls.length === 1 ? "" : "s"}`);

	for (const call of calls.slice(0, 3)) {
		const agent = typeof call.agent === "string" ? call.agent : "...";
		const session = typeof call.session === "string" && call.session.trim()
			? theme.fg("muted", ` session=${oneLine(call.session)}`)
			: "";
		const context = call.initialContext === "parent"
			? theme.fg("warning", " parent")
			: "";
		const preview = typeof call.prompt === "string" ? truncate(oneLine(call.prompt), 45) : "...";
		text += `\n  ${theme.fg("accent", agent)}${session}${context}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (calls.length > 3) text += `\n  ${theme.fg("muted", `... +${calls.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — shown after the tool completes
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	return expanded
		? renderCallsExpanded(details, theme)
		: renderCallsCollapsed(details, theme);
}

function renderCallsExpanded(
	details: SubagentDetails,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => isResultSuccess(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const icon = running > 0
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");

	const status = running > 0
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} succeeded`;

	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`,
			0,
			0,
		),
	);

	for (const [index, r] of details.results.entries()) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);
		const processErrorText = getProcessErrorText(r);
		const label = formatResultLabel(r, index);

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)} ${rIcon}`, 0, 0));
		container.addChild(new Text(theme.fg("muted", "Source: ") + theme.fg("dim", r.agentSource), 0, 0));
		container.addChild(new Text(theme.fg("muted", "Initial context: ") + theme.fg("dim", formatInitialContextStatus(r)), 0, 0));
		if (r.session) {
			const sessionStatus = r.session.created ? "created" : "continued";
			container.addChild(new Text(theme.fg("muted", "Session: ") + theme.fg("dim", `${r.session.handle} (${sessionStatus}, id ${r.session.id})`), 0, 0));
			container.addChild(new Text(theme.fg("muted", "Session cwd: ") + theme.fg("dim", shortenPath(r.session.cwd)), 0, 0));
		}
		container.addChild(new Text(theme.fg("muted", "Prompt: ") + theme.fg("dim", oneLine(getResultPrompt(r))), 0, 0));

		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		} else if (r.exitCode === -1) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "(running...)"), 0, 0));
		} else if (isResultError(r)) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", getResultSummaryText(r)), 0, 0));
		}

		if (processErrorText && finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("error", processErrorText), 0, 0));
		}

		const taskUsage = formatUsage(r.usage, r.model);
		if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
	}

	const totalUsage = formatUsage(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	return container;
}

function renderCallsCollapsed(
	details: SubagentDetails,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => isResultSuccess(r)).length;
	const failCount = details.results.filter((r) => isResultError(r)).length;
	const icon = running > 0
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = running > 0
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} succeeded`;

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`;

	for (const [index, r] of details.results.entries()) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const processErrorText = getProcessErrorText(r);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", formatResultLabel(r, index))} ${rIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg(r.exitCode === -1 ? "muted" : isResultError(r) ? "error" : "muted", r.exitCode === -1 ? "(running...)" : getResultSummaryText(r))}`;
		} else {
			text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_LINE_COUNT)}`;
			if (processErrorText) text += `\n${theme.fg("error", processErrorText)}`;
			if (countDisplayLines(displayItems) > COLLAPSED_LINE_COUNT) {
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
		}
	}

	if (running === 0) {
		const totalUsage = formatUsage(aggregateUsage(details.results));
		if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	}

	return new Text(text, 0, 0);
}
