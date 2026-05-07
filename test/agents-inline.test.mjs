import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function createTestableAgentsModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-inline-agents-"));
  const stubPath = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const modulePath = path.join(tmpDir, "agents.testable.ts");
  const sourcePath = path.join(process.cwd(), "agents.ts");

  fs.writeFileSync(
    stubPath,
    `export function parseFrontmatter(content) {
      return { frontmatter: {}, body: content };
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

function runNormalize(moduleUrl, definition) {
  const script = `
    import { normalizeInlineAgentDefinition } from ${JSON.stringify(moduleUrl)};
    const result = normalizeInlineAgentDefinition(${JSON.stringify(definition)});
    process.stdout.write(JSON.stringify(result));
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf-8",
    }),
  );
}

function runNormalizeFailure(moduleUrl, definition) {
  const script = `
    import { normalizeInlineAgentDefinition } from ${JSON.stringify(moduleUrl)};
    try {
      normalizeInlineAgentDefinition(${JSON.stringify(definition)});
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    }
  `;

  return JSON.parse(
    execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf-8",
    }),
  );
}

test("normalizes a minimal inline definition", () => {
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  try {
    const agent = runNormalize(moduleUrl, {
      name: " reviewer ",
      description: " Reviews code ",
    });

    assert.equal(agent.name, "reviewer");
    assert.equal(agent.description, "Reviews code");
    assert.equal(agent.source, "inline");
    assert.equal(agent.filePath, "(inline agent definition)");
    assert.equal(agent.systemPrompt, "");
  } finally {
    cleanup();
  }
});

test("normalizes optional fields for inline definitions", () => {
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  try {
    const agent = runNormalize(moduleUrl, {
      name: " reviewer ",
      description: " Reviews code ",
      model: " test/model ",
      thinking: " high ",
      tools: [" read ", "bash", ""],
      systemPrompt: " Be thorough. ",
    });

    assert.equal(agent.model, "test/model");
    assert.equal(agent.thinking, "high");
    assert.deepEqual(agent.tools, ["read", "bash"]);
    assert.equal(agent.systemPrompt, "Be thorough.");
  } finally {
    cleanup();
  }
});

test("rejects missing required inline definition fields", () => {
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  try {
    const missingName = runNormalizeFailure(moduleUrl, {
      name: "   ",
      description: "Reviews code",
    });
    const missingDescription = runNormalizeFailure(moduleUrl, {
      name: "reviewer",
      description: "   ",
    });

    assert.equal(missingName.ok, false);
    assert.match(missingName.message, /name/i);
    assert.equal(missingDescription.ok, false);
    assert.match(missingDescription.message, /description/i);
  } finally {
    cleanup();
  }
});

test("rejects non-array tools for inline definitions", () => {
  const { moduleUrl, cleanup } = createTestableAgentsModule();

  try {
    const invalid = runNormalizeFailure(moduleUrl, {
      name: "reviewer",
      description: "Reviews code",
      tools: "read,bash",
    });

    assert.equal(invalid.ok, false);
    assert.match(invalid.message, /tools/i);
  } finally {
    cleanup();
  }
});
