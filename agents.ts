/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function parseAgentFile(filePath: string, source: "user" | "project"): AgentConfig | null {
	let content: string;
	try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	let tools: string[] | undefined;
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (frontmatter.tools !== undefined) {
		console.warn(
			`[pi-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
		);
	}

	return {
		name,
		description,
		tools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const agent = parseAgentFile(path.join(dir, entry.name), source);
		if (agent) agents.push(agent);
	}
	return agents;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * When scope is "both", project agents override user agents with the same name.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Deduplicate by name; project agents win in "both" mode.
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
