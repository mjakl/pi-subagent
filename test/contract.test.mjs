import test from "node:test";
import assert from "node:assert/strict";
import {
  CALL_FIELDS,
  formatAvailableSubagentsPrompt,
  formatSubagentToolDescription,
  getCallFieldSchemaDescription,
} from "../contract.ts";

const agents = [
  {
    name: "review",
    description: "Review code changes",
    source: "user",
    filePath: "/tmp/review.md",
    systemPrompt: "You review code.",
    inactivityTimeout: 45,
    sessionPreference: "ephemeral",
  },
  {
    name: "repo-helper",
    description: "Repository helper",
    source: "project",
    filePath: "/repo/.pi/agents/repo-helper.md",
    systemPrompt: "You help in this repo.",
    sessionHint: "Use only for repository-local questions.",
  },
];

function makePrompt() {
  return formatAvailableSubagentsPrompt(agents, {
    currentDepth: 1,
    maxDepth: 3,
    preventCycles: true,
    ancestorAgentStack: ["review"],
  });
}

test("schema and tool description use the shared call field contract", () => {
  const toolDescription = formatSubagentToolDescription();

  for (const field of CALL_FIELDS) {
    assert.equal(getCallFieldSchemaDescription(field.name), field.schemaDescription);
    assert.ok(toolDescription.includes(`- \`${field.name}\``));
    assert.ok(toolDescription.includes(field.promptDescription));
  }
});

test("available subagent prompt omits the static tool manual", () => {
  const prompt = makePrompt();

  assert.doesNotMatch(prompt, /How to call|Fields:|Rules:|```/);
  for (const field of CALL_FIELDS) {
    assert.ok(!prompt.includes(`- \`${field.name}\``));
  }
  assert.doesNotMatch(prompt, /Do not use the same resolved session|Use exactly one top-level/);
});

test("tool description retains the usage and session rules", () => {
  const description = formatSubagentToolDescription();

  assert.match(description, /Use exactly one top-level `calls` array for both one and many invocations/);
  assert.match(description, /Each call requires `agent` and `prompt`; `prompt` is sent verbatim/);
  assert.match(description, /Multiple calls may run concurrently/);
  assert.match(description, /Do not use the same resolved session in more than one concurrent call/);
  assert.match(description, /remove the lock directory only after confirming no subagent is still running/);
  assert.match(description, /when the parent is running with `--no-session`/);
  assert.match(description, /from temporary parent-seeded subagent sessions/);
  assert.match(description, /preference and hint lines are advisory only/);
  assert.match(description, /only when a call includes `session`/);
  assert.match(description, /Example: \{ calls: \[/);
});

test("thinking contract documents levels, precedence, and no current-parent inheritance", () => {
  const text = formatSubagentToolDescription();
  assert.match(text, /`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/);
  assert.match(text, /Precedence: call, agent frontmatter, startup/);
  assert.match(text, /startup `--thinking` fallback/);
  assert.match(text, /Applies to continued sessions too/);
  assert.match(text, /does not inherit the parent's current thinking level/);
  assert.match(getCallFieldSchemaDescription("thinking"), /off, minimal, low, medium, high, xhigh, max/);
});

test("generated contract has no project-agent confirmation option", () => {
  const combined = `${makePrompt()}\n${formatSubagentToolDescription()}`;

  assert.doesNotMatch(combined, /confirmProjectAgents/);
  assert.doesNotMatch(combined, /project-local agent confirmation/i);
});

test("delegation contract distinguishes liveness controls and discourages parent cloning", () => {
  const combined = `${makePrompt()}\n${formatSubagentToolDescription()}`;

  assert.match(combined, /Inactivity timeout default: 45s/);
  assert.match(combined, /ordinary stuck-run protection/);
  assert.match(combined, /absolute wall-clock deadline/);
  assert.match(combined, /expensive and carries the parent conversation's authority/);
  assert.match(formatSubagentToolDescription(), /initialContext: "empty"/);
  assert.doesNotMatch(formatSubagentToolDescription(), /initialContext: "parent"/);
});

test("available subagent prompt labels agent source and guard state", () => {
  const prompt = makePrompt();

  assert.match(prompt, /\*\*review\*\* \(user\): Review code changes/);
  assert.match(prompt, /\*\*repo-helper\*\* \(project\): Repository helper/);
  assert.match(prompt, /available via the `subagent` tool/);
  assert.match(prompt, /Inactivity timeout default: 45s \(child RPC stdout inactivity\)/);
  assert.match(prompt, /Session preference: ephemeral — Prefer ephemeral calls unless the caller explicitly needs continuation/);
  assert.match(prompt, /Session hint: Use only for repository-local questions/);
  assert.match(prompt, /Agent source labels are informational/);
  assert.match(prompt, /Project agents come from this repository and can override user agents with the same name/);
  assert.match(prompt, /Parent-local workers override ordinary agents only in their owner's catalog/);
  assert.match(prompt, /not available to root sessions or other agents/);
  assert.match(prompt, /Max depth: current depth 1, max depth 3/);
  assert.match(prompt, /Cycle prevention: enabled/);
  assert.match(prompt, /Current delegation stack: review/);
});
