import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentIdentity, discoverAgents, discoverEffectiveAgentsWithStarter, resolveOwnerSubagents,
} from "../agents.ts";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-agents-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "config");
  const agents = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
  fs.mkdirSync(agents, { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, agents };
}

function owner(file, name = "owner", settings = "description: Local worker\n    systemPrompt: |\n      Private instructions.") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: Owner\nmodel: owner-model\nthinking: xhigh\nsubagents:\n  analyst:\n    ${settings}\n---\nOwner body.\n`);
}

function selected(dir, name = "owner", trusted = false) {
  return discoverAgents(dir, "both", trusted).agents.find(agent => agent.name === name);
}

test("parses inline settings without flattening or inheriting owner defaults", t => {
  const { dir, agents } = setup(t);
  owner(path.join(agents, "owner.md"), "owner", `description: Local worker
    systemPrompt: |
      Private instructions.
      Second line.
    tools: [read, grep]
    noTools: false
    model: worker-model
    thinking: medium
    inactivityTimeout: 42
    sessionPreference: persistent
    sessionHint: Keep bounded follow-ups.`);
  const parent = selected(dir);
  assert.equal(parent.systemPrompt, "Owner body.");
  assert.deepEqual(discoverAgents(dir, "both", false).agents.map(a => a.name), ["owner"]);
  const [local] = parent.subagents;
  assert.equal(local.name, "analyst");
  assert.equal(local.systemPrompt, "Private instructions.\nSecond line.\n");
  assert.deepEqual(local.tools, ["read", "grep"]);
  assert.equal(local.noTools, false);
  assert.equal(local.model, "worker-model");
  assert.equal(local.thinking, "medium");
  assert.equal(local.inactivityTimeout, 42);
  assert.equal(local.sessionPreference, "persistent");
  assert.equal(local.sessionHint, "Keep bounded follow-ups.");
  assert.equal(local.ownerContext, undefined);
  assert.equal(local.subagents, undefined);
  assert.deepEqual(resolveOwnerSubagents(JSON.stringify(parent.ownerContext)), parent.subagents);
  owner(path.join(agents, "minimal.md"), "minimal");
  const [minimal] = selected(dir, "minimal").subagents;
  assert.equal(minimal.model, undefined);
  assert.equal(minimal.thinking, undefined);
  assert.equal(minimal.tools, undefined);
});

test("effective catalog overlays locals only for the exact selected owner across cwd and precedence", t => {
  const { dir, agents } = setup(t);
  owner(path.join(agents, "owner.md"));
  owner(path.join(dir, ".pi", "agents", "owner.md"), "owner", "description: Project private\n    systemPrompt: Project instructions.");
  fs.writeFileSync(path.join(agents, "analyst.md"), "---\nname: analyst\ndescription: Global analyst\n---\nGlobal instructions.\n");
  const user = selected(dir);
  const project = selected(dir, "owner", true);
  assert.equal(project.source, "project");
  assert.equal(user.source, "user");
  assert.notEqual(agentIdentity(user.subagents[0]), agentIdentity(project.subagents[0]));
  assert.notEqual(agentIdentity(user.subagents[0]), "analyst");
  const other = path.join(dir, "other");
  fs.mkdirSync(other);
  for (const [parent, text] of [[user, "Private instructions."], [project, "Project instructions."]]) {
    const catalog = discoverEffectiveAgentsWithStarter(other, false, JSON.stringify(parent.ownerContext));
    assert.equal(catalog.discovery.agents.find(a => a.name === "analyst").systemPrompt.trim(), text);
  }
  assert.equal(discoverEffectiveAgentsWithStarter(other, false, undefined).discovery.agents.find(a => a.name === "analyst").systemPrompt, "Global instructions.");
  assert.equal(agentIdentity(user), "owner", "global identity stays compatible");
});

const invalidSettings = [
  "description: Local worker", "description: ''\n    systemPrompt: valid", "description: valid\n    systemPrompt: 3",
  "description: valid\n    systemPrompt: valid\n    subagents: {}", "description: valid\n    systemPrompt: valid\n    name: override",
  "description: valid\n    systemPrompt: valid\n    tools: [read, 5]", "description: valid\n    systemPrompt: valid\n    noTools: yes",
  "description: valid\n    systemPrompt: valid\n    model: 5", "description: valid\n    systemPrompt: valid\n    thinking: extreme",
  "description: valid\n    systemPrompt: valid\n    inactivityTimeout: 0", "description: valid\n    systemPrompt: valid\n    sessionPreference: always",
  "description: valid\n    systemPrompt: valid\n    sessionHint: []", "description: valid\n    systemPrompt: valid\n    unknown: value",
];

test("rejects invalid explicit local configuration rather than dropping bad fields", t => {
  const { dir, agents } = setup(t);
  const file = path.join(agents, "owner.md");
  const warnings = [];
  const previous = console.warn;
  console.warn = message => warnings.push(message);
  try {
    for (const settings of invalidSettings) {
      owner(file, "owner", settings);
      assert.equal(selected(dir), undefined, settings);
    }
    for (const value of ["null", "[]", "string"]) {
      fs.writeFileSync(file, `---\nname: owner\ndescription: owner\nsubagents: ${value}\n---\nBody\n`);
      assert.equal(selected(dir), undefined);
    }
    assert.equal(warnings.length, invalidSettings.length + 3);
    assert.ok(warnings.every(message => message.includes("subagents")));
  } finally {
    console.warn = previous;
  }
});

test("selected owner errors fail closed before discovery and never select a replacement", t => {
  const { dir, agents } = setup(t);
  const file = path.join(agents, "owner.md");
  owner(file);
  const context = selected(dir).ownerContext;
  for (const raw of ["", "null", "{}", "not json", JSON.stringify({ ...context, filePath: "relative.md" }), JSON.stringify({ ...context, name: "other" })]) {
    assert.throws(() => discoverEffectiveAgentsWithStarter(dir, false, raw), /Invalid PI_SUBAGENT_OWNER_CONTEXT/);
  }
  fs.appendFileSync(file, "Changed.\n");
  assert.throws(() => resolveOwnerSubagents(JSON.stringify(context)), /changed since launch/);
  const malformed = "---\nname: owner\ndescription: Owner\nsubagents: []\n---\nBody\n";
  fs.writeFileSync(file, malformed);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.throws(() => resolveOwnerSubagents(JSON.stringify({ ...context, digest: createHash("sha256").update(malformed).digest("hex") })), /selected owner is missing or invalid/);
  } finally {
    console.warn = originalWarn;
  }
  fs.rmSync(file);
  owner(path.join(agents, "replacement.md"));
  assert.throws(() => resolveOwnerSubagents(JSON.stringify(context)), /ENOENT/);
  assert.deepEqual(resolveOwnerSubagents(undefined), []);
});
