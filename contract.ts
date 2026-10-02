/**
 * Parent-facing subagent tool contract.
 *
 * This module owns the wording taught to the parent agent through the tool
 * schema, tool description, and injected system prompt. Keep API semantics here
 * so those surfaces do not drift independently.
 */

import type { AgentConfig } from "./agents.js";

export interface DelegationGuardSummary {
  currentDepth: number;
  maxDepth: number;
  preventCycles: boolean;
  ancestorAgentStack: string[];
}

interface CallFieldContract {
  name: "agent" | "prompt" | "model" | "thinking" | "cwd" | "initialContext" | "session" | "inactivityTimeout" | "timeout";
  required: boolean;
  schemaDescription: string;
  promptDescription: string;
}

export const CALLS_SCHEMA_DESCRIPTION =
  "One or more subagent calls. A single call and multiple parallel calls use the same shape.";

export const CALL_FIELDS: CallFieldContract[] = [
  {
    name: "agent",
    required: true,
    schemaDescription: "Name of an available agent (must match exactly)",
    promptDescription: "exact available agent name",
  },
  {
    name: "prompt",
    required: true,
    schemaDescription: "Prompt sent verbatim to the subagent for this call",
    promptDescription: "non-empty prompt sent verbatim to the subagent",
  },
  {
    name: "model",
    required: false,
    schemaDescription: "Model to use for this call. Overrides the agent file's default model; otherwise the parent session's current model is inherited.",
    promptDescription: "model to use for this call. Overrides the agent file's default model. If omitted, the agent's default model is used when configured; otherwise Pi uses the parent session's current effective model",
  },
  {
    name: "thinking",
    required: false,
    schemaDescription: "Thinking level: off, minimal, low, medium, high, xhigh, max. Precedence: call, agent frontmatter, startup --thinking, child default/session setting.",
    promptDescription: "thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Precedence: call, agent frontmatter, startup `--thinking` fallback, child default/session setting. Applies to continued sessions too; does not inherit the parent's current thinking level",
  },
  {
    name: "cwd",
    required: false,
    schemaDescription: "Working directory for this subagent process",
    promptDescription: "working directory for this subagent process",
  },
  {
    name: "initialContext",
    required: false,
    schemaDescription:
      "Initial context for a newly-created child conversation: 'empty' (default) or 'parent'. Parent cloning is expensive and carries the parent's authority; prefer empty and pass relevant context deliberately. Existing named sessions ignore this field.",
    promptDescription:
      '`"empty"` (default) starts without parent history; `"parent"` exceptionally clones the current parent session snapshot, which is expensive and carries the parent conversation\'s authority. Prefer empty and pass relevant context deliberately. Existing named sessions ignore this field',
  },
  {
    name: "session",
    required: false,
    schemaDescription:
      "Optional logical handle for a persistent subagent session. Scoped by parent session, effective cwd, and agent name.",
    promptDescription:
      "durable conversation handle. If present, the call continues or creates a persistent child Pi session. The handle is scoped by parent session, effective cwd, and agent name. The same handle used with different agents resolves to different sessions. Requires a persisted parent Pi session",
  },
  {
    name: "inactivityTimeout",
    required: false,
    schemaDescription:
      "Optional positive integer inactivity timeout in seconds. Overrides the agent default. Resets only when the child emits RPC stdout activity; omitted uses the agent default, or no inactivity timeout.",
    promptDescription:
      "positive integer inactivity timeout in seconds. Overrides the agent default; otherwise the agent default applies, or there is no inactivity timeout. It resets only on child RPC stdout activity",
  },
  {
    name: "timeout",
    required: false,
    schemaDescription:
      "Optional exceptional positive integer absolute wall-clock deadline in seconds. Independent of inactivityTimeout. Omit for ordinary stuck-run protection.",
    promptDescription:
      "exceptional positive integer absolute wall-clock deadline in seconds, independent of `inactivityTimeout`. Omit it for ordinary stuck-run protection",
  },
];

export function getCallFieldSchemaDescription(name: CallFieldContract["name"]): string {
  const field = CALL_FIELDS.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Unknown subagent call field: ${name}`);
  return field.schemaDescription;
}

function formatCallFieldList(): string {
  return CALL_FIELDS
    .map((field) => {
      const requirement = field.required ? "required" : "optional";
      return `- \`${field.name}\` — ${requirement}: ${field.promptDescription}.`;
    })
    .join("\n");
}

function formatDelegationRules(): string {
  return [
    "- Do not use the same resolved session in more than one concurrent call. Same handle + same agent + same cwd conflicts; same handle + different agent is allowed. If a stale session lock is reported, remove the lock directory only after confirming no subagent is still running.",
    "- Use `session` for multi-turn specialist work; omit it for one-off delegation, when the parent is running with `--no-session`, or from temporary parent-seeded subagent sessions.",
    "- Agent-specific session preference and hint lines are advisory only. The tool creates or continues a persistent session only when a call includes `session`.",
    "- Prefer `initialContext: \"empty\"` and pass relevant task context deliberately. Parent cloning is exceptional because it is expensive and carries the parent conversation's authority.",
  ].join("\n");
}

export function formatSubagentUsageExample(): string {
  return `Use exactly one top-level \`calls\` array:\n\`\`\`json\n{\n  "calls": [\n    {\n      "agent": "agent-name",\n      "prompt": "Prompt sent verbatim to the subagent"\n    }\n  ]\n}\n\`\`\``;
}

export function formatSubagentUsageErrorExample(): string {
  return `Use the current API shape:\n{\n  "calls": [\n    { "agent": "agent-name", "prompt": "Prompt sent verbatim to the subagent" }\n  ]\n}`;
}

function formatSessionPreference(preference: AgentConfig["sessionPreference"]): string {
  switch (preference) {
    case "persistent":
      return "Prefer topic-specific named persistent sessions when context should carry across related calls.";
    case "ephemeral":
      return "Prefer ephemeral calls unless the caller explicitly needs continuation.";
    case "either":
      return "Choose ephemeral or persistent sessions based on the task.";
    default:
      return "";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatAgentForPrompt(agent: AgentConfig): string {
  const lines = [`- **${agent.name}** (${agent.source}): ${agent.description}`];
  if (agent.inactivityTimeout) {
    lines.push(`  Inactivity timeout default: ${agent.inactivityTimeout}s (child RPC stdout inactivity).`);
  }
  if (agent.sessionPreference) {
    lines.push(
      `  Session preference: ${agent.sessionPreference} — ${formatSessionPreference(agent.sessionPreference)}`,
    );
  }
  if (agent.sessionHint) {
    lines.push(`  Session hint: ${oneLine(agent.sessionHint)}`);
  }
  return lines.join("\n");
}

export function formatAvailableSubagentsPrompt(
  agents: AgentConfig[],
  guards: DelegationGuardSummary,
): string {
  const agentList = agents.map((agent) => formatAgentForPrompt(agent)).join("\n");
  const stack = guards.ancestorAgentStack.length > 0
    ? guards.ancestorAgentStack.join(" -> ")
    : "(root)";

  return `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Agent source labels are informational. Project agents come from this repository and can override user agents with the same name.

### How to call the subagent tool

${formatSubagentUsageExample()}

Each call runs in an isolated \`pi\` process. Multiple calls may run concurrently.

Fields:
${formatCallFieldList()}

Rules:
${formatDelegationRules()}

### Runtime delegation guards

- Max depth: current depth ${guards.currentDepth}, max depth ${guards.maxDepth}
- Cycle prevention: ${guards.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${stack}
`;
}

export function formatSubagentToolDescription(): string {
  return [
    "Delegate work to specialized subagents running in isolated pi processes.",
    "",
    "Use exactly one top-level `calls` array for both one and many invocations.",
    "Each call requires `agent` and `prompt`; `prompt` is sent verbatim.",
    "",
    "Fields:",
    formatCallFieldList(),
    "",
    "Rules:",
    formatDelegationRules(),
    "",
    "Multiple calls may run concurrently.",
    "Model-facing output is capped at Pi's standard 50KB/2000-line limits; full truncated output is saved to a temporary file for the active session.",
    "",
    'Example: { calls: [{ agent: "review", prompt: "Review this diff", model: "anthropic/claude-sonnet-4", session: "api-review", initialContext: "empty" }] }',
  ].join("\n");
}
