/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools/session guidance, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md by default, or
 *                     $PI_CODING_AGENT_DIR/agents/*.md when the env var is set
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 */

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";
export type SessionPreference = "ephemeral" | "persistent" | "either";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	noTools?: boolean;
	model?: string;
	thinking?: string;
	inactivityTimeout?: number;
	sessionPreference?: SessionPreference;
	sessionHint?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	/** Direct workers are never included in ordinary discovery. */
	subagents?: AgentConfig[];
	ownerContext?: OwnerContext;
	localOwner?: { name: string; filePath: string };
}

export const OWNER_CONTEXT_ENV = "PI_SUBAGENT_OWNER_CONTEXT";

interface OwnerContext {
	version: 1;
	filePath: string;
	name: string;
	source: "user" | "project";
	digest: string;
}

/** Keep global identities unchanged; local identities include the selected owner. */
export function agentIdentity(agent: AgentConfig): string {
	return agent.localOwner
		? JSON.stringify(["pi-subagent/local/v1", agent.localOwner.filePath, agent.localOwner.name, agent.name])
		: agent.name;
}

function contentDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface StarterAgentDiscoveryResult {
	discovery: AgentDiscoveryResult;
	createdAgentPath: string | null;
	error?: string;
}

export const STARTER_AGENT_NAME = "explore";
export const STARTER_AGENT_FILE_NAME = "explore.md";

export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

export function parseDeniedAgentNames(raw: string | undefined): {
	names: Set<string>;
	error?: string;
} {
	if (raw === undefined) return { names: new Set() };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every(
			(name) => typeof name === "string" && name.trim().length > 0,
		)) {
			return { names: new Set(parsed) };
		}
	} catch {
		// Explicit malformed configuration must not fall back to unrestricted delegation.
	}
	return {
		names: new Set(),
		error: "Invalid PI_SUBAGENT_DENY_AGENTS: expected a JSON array of non-blank agent-name strings. Subagent delegation is disabled until the configuration is corrected and the extension is reloaded.",
	};
}

const STARTER_AGENT_MARKDOWN = `---
name: explore
description: Read-only codebase exploration specialist for focused searches, repository reconnaissance, and evidence-backed summaries. Use when you need fast context from files without edits.
tools: read, grep, find, ls
sessionPreference: persistent
sessionHint: Prefer a topic-specific named session for iterative codebase exploration, e.g. session="explore-auth". Use ephemeral calls for one-off or parallel independent searches.
---

You are a codebase exploration specialist. Your job is to quickly gather reliable,
targeted context from the local repository and return it in a form another agent
can use without repeating the same search.

## Operating mode

- Work read-only.
- Never create, edit, delete, or commit files.
- Do not make changes to the environment or repository state.
- Prefer fast discovery first, then selective reading.
- Keep scope tight to the task; do not broaden the investigation unless needed.

## Search strategy

1. Start broad: find likely files, symbols, call sites, configs, tests, and docs.
2. Narrow down: read only the most relevant files or sections.
3. Stop when you have enough evidence; avoid exhaustive exploration unless asked.

## Output rules

- Return file paths as absolute paths when possible.
- Include line ranges whenever you rely on file contents.
- Be factual and precise.
- Distinguish facts supported by inspected files from inferences.
- If something is not found, say what you checked.

Keep the response concise, structured, and optimized for agent handoff.
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function parseSessionPreference(raw: unknown, filePath: string): SessionPreference | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		console.warn(
			`[pi-subagent] Ignoring invalid sessionPreference field in "${filePath}". Expected "ephemeral", "persistent", or "either".`,
		);
		return undefined;
	}

	const normalized = raw.trim().toLowerCase();
	if (normalized === "ephemeral" || normalized === "persistent" || normalized === "either") {
		return normalized;
	}

	console.warn(
		`[pi-subagent] Ignoring invalid sessionPreference field in "${filePath}". Expected "ephemeral", "persistent", or "either".`,
	);
	return undefined;
}

function parseNoTools(raw: unknown, filePath: string): boolean | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	console.warn(
		`[pi-subagent] Ignoring invalid noTools field in "${filePath}". Expected true or false.`,
	);
	return undefined;
}

function parsePositiveInteger(raw: unknown, field: string, filePath: string): number | undefined {
	if (raw === undefined) return undefined;
	if (
		typeof raw === "number" &&
		Number.isSafeInteger(raw) &&
		raw > 0 &&
		raw <= MAX_TIMER_SECONDS
	) return raw;
	console.warn(
		`[pi-subagent] Ignoring invalid ${field} field in "${filePath}". Expected an integer between 1 and ${MAX_TIMER_SECONDS}.`,
	);
	return undefined;
}

function parseSessionHint(raw: unknown, filePath: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		console.warn(
			`[pi-subagent] Ignoring invalid sessionHint field in "${filePath}". Expected a string.`,
		);
		return undefined;
	}

	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/** Walk up from `cwd` looking for a project-local agents directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function parseAgentFile(filePath: string, source: "user" | "project", selectedContent?: string): AgentConfig | null {
	let content: string;
	try { content = selectedContent ?? fs.readFileSync(filePath, "utf-8"); } catch { return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`);
		return null;
	}

	try {
		return parseAgentConfig(parsed.frontmatter ?? {}, parsed.body ?? "", source, filePath, content);
	} catch (error) {
		console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${String(error)}`);
		return null;
	}
}

function parseAgentConfig(
	frontmatter: Record<string, unknown>,
	body: string,
	source: "user" | "project",
	filePath: string,
	content?: string,
): AgentConfig | null {
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

	const noTools = parseNoTools(frontmatter.noTools, filePath);
	if (noTools === true && tools && tools.length > 0) {
		console.warn(
			`[pi-subagent] Agent file "${filePath}" sets noTools: true and a non-empty tools list. noTools takes precedence.`,
		);
	}

	let subagents: AgentConfig[] | undefined;
	let ownerContext: OwnerContext | undefined;
	if (frontmatter.subagents !== undefined) {
		if (!isRecord(frontmatter.subagents)) throw new Error("subagents must be a map of local worker names to settings.");
		const ownerPath = fs.realpathSync(filePath);
		subagents = Object.entries(frontmatter.subagents).map(([localName, settings]) => {
			validateLocalSettings(localName, settings);
			const local = parseAgentConfig(
				{ ...settings, name: localName }, settings.systemPrompt as string, source, ownerPath,
			)!;
			local.localOwner = { name, filePath: ownerPath };
			return local;
		});
		ownerContext = { version: 1, filePath: ownerPath, name, source, digest: contentDigest(content!) };
	}

	return {
		name,
		description,
		tools,
		noTools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		inactivityTimeout: parsePositiveInteger(frontmatter.inactivityTimeout, "inactivityTimeout", filePath),
		sessionPreference: parseSessionPreference(frontmatter.sessionPreference, filePath),
		sessionHint: parseSessionHint(frontmatter.sessionHint, filePath),
		systemPrompt: body,
		source,
		filePath,
		...(subagents ? { subagents, ownerContext } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLocalSettings(name: string, value: unknown): asserts value is Record<string, unknown> {
	const invalid = (message: string): never => { throw new Error(`subagents.${name}: ${message}`); };
	if (!name.trim() || name !== name.trim()) invalid("name must be non-blank with no surrounding whitespace.");
	if (!isRecord(value)) invalid("settings must be a map.");
	const settings = value as Record<string, unknown>;
	const fields = new Set(["description", "systemPrompt", "tools", "noTools", "model", "thinking", "inactivityTimeout", "sessionPreference", "sessionHint"]);
	for (const field of Object.keys(settings)) {
		if (!fields.has(field)) invalid(`unsupported field "${field}" (nested subagents are not supported).`);
	}
	for (const field of ["description", "systemPrompt"]) {
		if (typeof settings[field] !== "string" || !(settings[field] as string).trim()) invalid(`${field} must be a non-blank string.`);
	}
	for (const field of ["model", "sessionHint"]) {
		if (settings[field] !== undefined && (typeof settings[field] !== "string" || !(settings[field] as string).trim())) invalid(`${field} must be a non-blank string.`);
	}
	if (settings.noTools !== undefined && typeof settings.noTools !== "boolean") invalid("noTools must be a boolean.");
	if (settings.tools !== undefined && typeof settings.tools !== "string" &&
		!(Array.isArray(settings.tools) && settings.tools.every((tool) => typeof tool === "string" && tool.trim()))) invalid("tools must be a comma-separated string or an array of non-blank strings.");
	if (settings.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(settings.thinking as string)) invalid("invalid thinking level.");
	if (settings.sessionPreference !== undefined &&
		(typeof settings.sessionPreference !== "string" || !["ephemeral", "persistent", "either"].includes(settings.sessionPreference.trim().toLowerCase()))) invalid("invalid sessionPreference.");
	if (settings.inactivityTimeout !== undefined &&
		(typeof settings.inactivityTimeout !== "number" || !Number.isSafeInteger(settings.inactivityTimeout) || settings.inactivityTimeout < 1 || settings.inactivityTimeout > MAX_TIMER_SECONDS)) invalid(`inactivityTimeout must be an integer between 1 and ${MAX_TIMER_SECONDS}.`);
}

/** Resolve only the exact launch-selected owner, never a same-named replacement. */
export function resolveOwnerSubagents(raw: string | undefined): AgentConfig[] {
	if (raw === undefined) return [];
	try {
		const context: unknown = JSON.parse(raw);
		if (!isRecord(context) || context.version !== 1 ||
			typeof context.filePath !== "string" || !path.isAbsolute(context.filePath) ||
			typeof context.name !== "string" || !context.name.trim() ||
			(context.source !== "user" && context.source !== "project") ||
			typeof context.digest !== "string" || !/^[a-f0-9]{64}$/.test(context.digest)) throw new Error("malformed launch locator.");
		const content = fs.readFileSync(context.filePath, "utf8");
		if (contentDigest(content) !== context.digest) throw new Error("selected owner file changed since launch.");
		const owner = parseAgentFile(context.filePath, context.source, content);
		if (!owner || owner.name !== context.name || !owner.subagents) throw new Error("selected owner is missing or invalid.");
		return owner.subagents;
	} catch (error) {
		throw new Error(`Invalid ${OWNER_CONTEXT_ENV}: ${String(error)} Delegation is disabled; relaunch the owner from its current definition.`);
	}
}

/** Shared effective catalog for prompt visibility and execution. */
export function discoverEffectiveAgentsWithStarter(
	cwd: string,
	includeProjectAgents: boolean,
	ownerContext: string | undefined,
): StarterAgentDiscoveryResult {
	const locals = resolveOwnerSubagents(ownerContext);
	const result = discoverAgentsWithStarter(cwd, includeProjectAgents);
	result.discovery.agents = mergeAgents(result.discovery.agents, locals);
	return result;
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const agent = parseAgentFile(path.join(dir, entry.name), source);
		if (agent) agents.push(agent);
	}
	return agents;
}

function mergeAgents(...groups: AgentConfig[][]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const group of groups) {
		for (const agent of group) agentMap.set(agent.name, agent);
	}
	return Array.from(agentMap.values());
}

function getStarterAgentFileName(attempt: number): string {
	if (attempt === 0) return STARTER_AGENT_FILE_NAME;
	if (attempt === 1) return "explore-starter.md";
	return `explore-starter-${attempt}.md`;
}

function isFileExistsError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "EEXIST"
	);
}

function writeStarterAgentFile(filePath: string): void {
	const fd = fs.openSync(filePath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, STARTER_AGENT_MARKDOWN, { encoding: "utf-8" });
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * Precedence is: user < project.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	includeProjectAgents: boolean,
): AgentDiscoveryResult {
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = includeProjectAgents ? findNearestProjectAgentsDir(cwd) : null;

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
	const projectAgents =
		!includeProjectAgents || scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	if (scope === "user") {
		return { agents: userAgents, projectAgentsDir };
	}
	if (scope === "project") {
		return { agents: projectAgents, projectAgentsDir };
	}
	return {
		agents: mergeAgents(userAgents, projectAgents),
		projectAgentsDir,
	};
}

/**
 * Discover user/project agents, creating a starter user agent when none exist.
 *
 * This intentionally has no marker file: if a user deletes every agent, the
 * starter will be recreated on the next discovery that needs runnable agents.
 * Existing files are never overwritten.
 */
export function discoverAgentsWithStarter(
	cwd: string,
	includeProjectAgents: boolean,
): StarterAgentDiscoveryResult {
	const initial = discoverAgents(cwd, "both", includeProjectAgents);
	if (initial.agents.length > 0) {
		return { discovery: initial, createdAgentPath: null };
	}

	const userAgentsDir = getUserAgentsDir();

	try {
		fs.mkdirSync(userAgentsDir, { recursive: true });

		for (let attempt = 0; attempt < 100; attempt++) {
			const latest = attempt === 0
				? initial
				: discoverAgents(cwd, "both", includeProjectAgents);
			if (latest.agents.length > 0) {
				return { discovery: latest, createdAgentPath: null };
			}

			const filePath = path.join(userAgentsDir, getStarterAgentFileName(attempt));
			try {
				writeStarterAgentFile(filePath);
				return {
					discovery: discoverAgents(cwd, "both", includeProjectAgents),
					createdAgentPath: filePath,
				};
			} catch (err) {
				if (isFileExistsError(err)) continue;
				throw err;
			}
		}

		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not find an unused starter agent filename in ${userAgentsDir}.`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not create starter agent in ${userAgentsDir}: ${message}`,
		};
	}
}
