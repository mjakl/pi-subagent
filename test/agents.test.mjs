import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function writeAgent(dir, name, description = `${name} description`) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nYou are ${name}.\n`,
  );
}

function createTestableAgentsModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
  const stubPath = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const modulePath = path.join(tmpDir, "agents.testable.ts");
  const sourcePath = path.join(process.cwd(), "agents.ts");

  fs.writeFileSync(
    stubPath,
    `export function parseFrontmatter(content) {
      const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/);
      if (!match) return { frontmatter: {}, body: content };
      const frontmatter = {};
      for (const line of match[1].split(/\\r?\\n/)) {
        if (!line.trim()) continue;
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        frontmatter[key] = value;
      }
      return { frontmatter, body: match[2] ?? "" };
    }
`,
  );

  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    );
  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function runDiscoverAgents(moduleUrl, cwd, scope, env) {
  const script = `
    import { discoverAgents } from ${JSON.stringify(moduleUrl)};
    const result = discoverAgents(${JSON.stringify(cwd)}, ${JSON.stringify(scope)});
    process.stdout.write(JSON.stringify(result));
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    }),
  );
}

function runDiscoverAgentsWithStarter(moduleUrl, cwd, env) {
  const script = `
    import { discoverAgentsWithStarter } from ${JSON.stringify(moduleUrl)};
    const result = discoverAgentsWithStarter(${JSON.stringify(cwd)});
    process.stdout.write(JSON.stringify(result));
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    }),
  );
}

test("PI_CODING_AGENT_DIR overrides the default user agent directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  writeAgent(path.join(homeDir, ".pi", "agent", "agents"), "home-agent");
  writeAgent(path.join(configDir, "agents"), "override-agent");

  try {
    const discovery = runDiscoverAgents(moduleUrl, tmpDir, "user", {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    assert.equal(discovery.projectAgentsDir, null);
    assert.deepEqual(
      discovery.agents.map((agent) => ({ name: agent.name, source: agent.source })),
      [{ name: "override-agent", source: "user" }],
    );
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("project agents override the active user config directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const projectDir = path.join(tmpDir, "project");
  const nestedCwd = path.join(projectDir, "src", "feature");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  writeAgent(path.join(homeDir, ".pi", "agent", "agents"), "home-only");
  writeAgent(path.join(configDir, "agents"), "shared", "user shared");
  writeAgent(path.join(configDir, "agents"), "global-only");
  writeAgent(path.join(projectDir, ".pi", "agents"), "shared", "project shared");
  fs.mkdirSync(nestedCwd, { recursive: true });

  try {
    const discovery = runDiscoverAgents(moduleUrl, nestedCwd, "both", {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    assert.equal(discovery.projectAgentsDir, path.join(projectDir, ".pi", "agents"));

    const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]));
    assert.equal(byName.get("shared")?.source, "project");
    assert.equal(byName.get("global-only")?.source, "user");
    assert.equal(byName.has("home-only"), false);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parses optional session guidance from agent frontmatter", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const agentsDir = path.join(configDir, "agents");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "explore.md"),
    `---\nname: explore\ndescription: Explore code\nsessionPreference: persistent\nsessionHint: Prefer topic-specific named sessions for follow-up searches.\n---\n\nYou are explore.\n`,
  );
  fs.writeFileSync(
    path.join(agentsDir, "hint-only.md"),
    `---\nname: hint-only\ndescription: Hint only\nsessionHint: Use a named session only after the first broad pass.\n---\n\nYou are hint-only.\n`,
  );

  try {
    const discovery = runDiscoverAgents(moduleUrl, tmpDir, "user", {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]));
    assert.equal(byName.get("explore")?.sessionPreference, "persistent");
    assert.equal(
      byName.get("explore")?.sessionHint,
      "Prefer topic-specific named sessions for follow-up searches.",
    );
    assert.equal(byName.get("hint-only")?.sessionPreference, undefined);
    assert.equal(
      byName.get("hint-only")?.sessionHint,
      "Use a named session only after the first broad pass.",
    );
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("creates a starter explorer agent when no agents are found", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  try {
    const result = runDiscoverAgentsWithStarter(moduleUrl, tmpDir, {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    const expectedPath = path.join(configDir, "agents", "explorer.md");
    assert.equal(result.createdAgentPath, expectedPath);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.discovery.agents.map((agent) => ({ name: agent.name, source: agent.source, tools: agent.tools })),
      [{ name: "explorer", source: "user", tools: ["read", "grep", "find", "ls"] }],
    );

    const content = fs.readFileSync(expectedPath, "utf-8");
    assert.match(content, /name: explorer/);
    assert.match(content, /tools: read, grep, find, ls/);
    assert.match(content, /sessionPreference: persistent/);
    assert.match(content, /sessionHint: Prefer a topic-specific named session/);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("does not create a starter agent when a project agent exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const projectDir = path.join(tmpDir, "project");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const result = runDiscoverAgentsWithStarter(moduleUrl, projectDir, {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    assert.equal(result.createdAgentPath, null);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.discovery.agents.map((agent) => ({ name: agent.name, source: agent.source })),
      [{ name: "project-only", source: "project" }],
    );
    assert.equal(fs.existsSync(path.join(configDir, "agents")), false);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("starter creation does not overwrite an existing explorer file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-fixture-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(tmpDir, "override-config");
  const agentsDir = path.join(configDir, "agents");
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "explorer.md"), "not a valid agent\n");

  try {
    const result = runDiscoverAgentsWithStarter(moduleUrl, tmpDir, {
      HOME: homeDir,
      PI_CODING_AGENT_DIR: configDir,
    });

    const expectedPath = path.join(agentsDir, "explorer-starter.md");
    assert.equal(result.createdAgentPath, expectedPath);
    assert.equal(fs.readFileSync(path.join(agentsDir, "explorer.md"), "utf-8"), "not a valid agent\n");
    assert.deepEqual(
      result.discovery.agents.map((agent) => ({ name: agent.name, source: agent.source })),
      [{ name: "explorer", source: "user" }],
    );
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
