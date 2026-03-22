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
      'from "@mariozechner/pi-coding-agent"',
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
