import test from "node:test";
import assert from "node:assert/strict";
import {
  CALL_FIELDS,
  formatAvailableSubagentsPrompt,
  formatSubagentToolDescription,
  formatSubagentUsageExample,
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

test("schema and generated prompt use the shared call field contract", () => {
  const prompt = makePrompt();
  const toolDescription = formatSubagentToolDescription();

  for (const field of CALL_FIELDS) {
    assert.equal(getCallFieldSchemaDescription(field.name), field.schemaDescription);
    assert.match(prompt, new RegExp(`\\\`${field.name}\\\``));
    assert.match(toolDescription, new RegExp(`\\\`${field.name}\\\``));
  }
});

test("generic usage example includes only the required call fields", () => {
  const example = formatSubagentUsageExample();

  assert.match(example, /"agent": "agent-name"/);
  assert.match(example, /"prompt": "Prompt sent verbatim to the subagent"/);
  assert.doesNotMatch(example, /"model"\s*:/);
  assert.doesNotMatch(example, /"initialContext"\s*:/);
  assert.doesNotMatch(example, /"session"\s*:/);
});

test("thinking contract documents levels, precedence, and no current-parent inheritance", () => {
  for (const text of [makePrompt(), formatSubagentToolDescription()]) {
    assert.match(text, /`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/);
    assert.match(text, /Precedence: call, agent frontmatter, startup/);
    assert.match(text, /startup `--thinking` fallback/);
    assert.match(text, /Applies to continued sessions too/);
    assert.match(text, /does not inherit the parent's current thinking level/);
  }
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
  assert.match(prompt, /Project agents come from this repository/);
  assert.match(prompt, /Max depth: current depth 1, max depth 3/);
  assert.match(prompt, /Current delegation stack: review/);
});
