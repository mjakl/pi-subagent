import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function createTestableIndexModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const modulePath = path.join(tmpDir, "index.testable.ts");
  const sourcePath = path.join(process.cwd(), "index.ts");

  fs.writeFileSync(
    path.join(tmpDir, "pi-coding-agent-stub.mjs"),
    "export {}\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "typebox-stub.mjs"),
    `export const Type = {
      Object: (shape, options = {}) => ({ type: "object", shape, ...options }),
      String: (options = {}) => ({ type: "string", ...options }),
      Optional: (schema) => ({ ...schema, optional: true }),
      Array: (items, options = {}) => ({ type: "array", items, ...options }),
      Boolean: (options = {}) => ({ type: "boolean", ...options }),
    };\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "agents.js"),
    `export function discoverAgents() {
      return {
        agents: [{
          name: "writer",
          description: "Writer agent",
          source: "user",
          filePath: "/tmp/writer.md",
          systemPrompt: "You are writer.",
        }, {
          name: "reviewer",
          description: "Project reviewer agent",
          source: "project",
          filePath: "/tmp/project-reviewer.md",
          systemPrompt: "You are project reviewer.",
        }],
        projectAgentsDir: "/tmp/.pi/agents",
      };
    }

    export function normalizeInlineAgentDefinition(definition) {
      const name = typeof definition?.name === "string" ? definition.name.trim() : "";
      const description = typeof definition?.description === "string" ? definition.description.trim() : "";
      if (!name) throw new Error("Invalid agentDefinition.name: expected non-empty string.");
      if (!description) throw new Error("Invalid agentDefinition.description: expected non-empty string.");

      const tools = definition?.tools;
      if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))) {
        throw new Error("Invalid agentDefinition.tools: expected string array.");
      }

      return {
        name,
        description,
        model: typeof definition?.model === "string" ? definition.model.trim() || undefined : undefined,
        thinking: typeof definition?.thinking === "string" ? definition.thinking.trim() || undefined : undefined,
        tools: Array.isArray(tools) ? tools.map((tool) => tool.trim()).filter(Boolean) : undefined,
        systemPrompt: typeof definition?.systemPrompt === "string" ? definition.systemPrompt.trim() : "",
        source: "inline",
        filePath: "(inline agent definition)",
      };
    }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "render.js"),
    `export function renderCall() { return []; }
     export function renderResult() { return []; }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "runner-events.js"),
    `export function getResultSummaryText(result) {
      return result?.stderr || result?.errorMessage || "(no output)";
    }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "runner.js"),
    `export async function runAgent(opts) {
      const selectedAgent = opts.agentConfig || opts.agents.find((agent) => agent.name === opts.agentName);
      if (!selectedAgent) {
        return {
          agent: opts.agentName,
          agentSource: "unknown",
          task: opts.task,
          exitCode: 1,
          messages: [],
          stderr: "unknown agent",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          stopReason: "error",
          errorMessage: "unknown agent",
        };
      }

      return {
        agent: selectedAgent.name,
        agentSource: selectedAgent.source,
        task: opts.task,
        exitCode: 0,
        messages: [],
        stderr: "inline success " + selectedAgent.name + " " + selectedAgent.source + (selectedAgent.systemPrompt ? " " + selectedAgent.systemPrompt : "") + (opts.taskCwd ? " " + opts.taskCwd : ""),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      };
    }
    export async function mapConcurrent(items, _concurrency, fn) {
      return Promise.all(items.map(fn));
    }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "types.js"),
    `export const DEFAULT_DELEGATION_MODE = "spawn";
     export function emptyUsage() {
       return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
     }
     export function isResultError() { return false; }
     export function isResultSuccess() { return true; }\n`,
  );

  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace(
      'from "@mariozechner/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    )
    .replace('from "typebox"', 'from "./typebox-stub.mjs"');

  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function runSubagentTool(moduleUrl, params) {
  const script = `
    import extension from ${JSON.stringify(moduleUrl)};

    let tool;
    const pi = {
      registerFlag() {},
      on() {},
      registerTool(def) { tool = def; },
      getFlag() { return undefined; },
    };

    extension(pi);

    const result = await tool.execute(
      "tool-call-1",
      ${JSON.stringify(params)},
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        hasUI: false,
        sessionManager: {
          getHeader() { return { version: 1 }; },
          getBranch() { return []; },
        },
      },
    );

    process.stdout.write(JSON.stringify(result));
  `;

  return JSON.parse(
    execFileSync(
      "node",
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    ),
  );
}

test("invalid invocation shape returns isError true", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, { agent: "writer" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid parameters/);
  } finally {
    cleanup();
  }
});

test("too many parallel tasks returns isError true", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: Array.from({ length: 9 }, () => ({ agent: "writer", task: "x" })),
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Too many parallel tasks/);
  } finally {
    cleanup();
  }
});

test("single-mode inline agent definition is accepted", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agentDefinition: {
        name: "reviewer",
        description: "Reviews code",
      },
      task: "Review commits A..B",
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "inline success reviewer inline");
  } finally {
    cleanup();
  }
});

test("single-mode agent and agentDefinition together are rejected", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agent: "writer",
      agentDefinition: {
        name: "reviewer",
        description: "Reviews code",
      },
      task: "Review commits A..B",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /agentDefinition|Invalid parameters/);
  } finally {
    cleanup();
  }
});

test("single-mode inline agent definition without systemPrompt is accepted", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agentDefinition: {
        name: "reviewer",
        description: "Reviews code",
        tools: ["read", "bash"],
      },
      task: "Review commits A..B",
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "inline success reviewer inline");
  } finally {
    cleanup();
  }
});

test("single-mode invalid inline agent definition returns isError true", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agentDefinition: {
        name: "   ",
        description: "Reviews code",
      },
      task: "Review commits A..B",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /agentDefinition\.name|Invalid agentDefinition/);
  } finally {
    cleanup();
  }
});

test("parallel inline agent definition is accepted", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
          },
          task: "Review commits A..B",
        },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /inline success reviewer inline/);
  } finally {
    cleanup();
  }
});

test("parallel mixed named and inline agents are accepted", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agent: "writer",
          task: "Draft notes",
        },
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
          },
          task: "Review commits A..B",
        },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /inline success writer user/);
    assert.match(result.content[0].text, /inline success reviewer inline/);
  } finally {
    cleanup();
  }
});

test("parallel named and inline tasks with the same name keep their own configs", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      confirmProjectAgents: false,
      tasks: [
        {
          agent: "reviewer",
          task: "Review the named agent path",
        },
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
            systemPrompt: "INLINE_REVIEW_PROMPT",
          },
          task: "Review the inline agent path",
        },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.match(
      result.content[0].text,
      /\[reviewer\] completed: inline success reviewer project You are project reviewer\./,
    );
    assert.match(
      result.content[0].text,
      /\[reviewer\] completed: inline success reviewer inline INLINE_REVIEW_PROMPT/,
    );
  } finally {
    cleanup();
  }
});

test("parallel inline tasks with the same public name keep their own configs", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
            systemPrompt: "INLINE_REVIEW_PROMPT_A",
          },
          task: "Review alpha",
        },
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
            systemPrompt: "INLINE_REVIEW_PROMPT_B",
          },
          task: "Review beta",
        },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.match(
      result.content[0].text,
      /\[reviewer\] completed: inline success reviewer inline INLINE_REVIEW_PROMPT_A/,
    );
    assert.match(
      result.content[0].text,
      /\[reviewer\] completed: inline success reviewer inline INLINE_REVIEW_PROMPT_B/,
    );
  } finally {
    cleanup();
  }
});

test("parallel task item with both agent and agentDefinition is rejected", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agent: "writer",
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
          },
          task: "Review commits A..B",
        },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /task\[0\]|agentDefinition|Invalid parameters/);
  } finally {
    cleanup();
  }
});

test("parallel task item with neither agent nor agentDefinition is rejected", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          task: "Review commits A..B",
        },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /task\[0\]|Invalid parameters/);
  } finally {
    cleanup();
  }
});

test("parallel inline task item keeps per-task cwd", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
          },
          task: "Review commits A..B",
          cwd: "/tmp/review",
        },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /\/tmp\/review/);
  } finally {
    cleanup();
  }
});

test("inline single-mode agent is not blocked by project-agent confirmation when names collide", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agentDefinition: {
        name: "reviewer",
        description: "Reviews code",
      },
      task: "Review commits A..B",
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "inline success reviewer inline");
  } finally {
    cleanup();
  }
});

test("same-name discovered agents do not override inline definitions", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [
        {
          agentDefinition: {
            name: "reviewer",
            description: "Reviews code",
          },
          task: "Review commits A..B",
          confirmProjectAgents: false,
        },
      ],
      confirmProjectAgents: false,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /inline success reviewer inline/);
    assert.doesNotMatch(result.content[0].text, /inline success reviewer project/);
  } finally {
    cleanup();
  }
});

test("cycle prevention applies to inline agent names", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = JSON.parse(
      execFileSync(
        "node",
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `
            import extension from ${JSON.stringify(moduleUrl)};

            let tool;
            const pi = {
              registerFlag() {},
              on() {},
              registerTool(def) { tool = def; },
              getFlag() { return undefined; },
            };

            extension(pi);

            const result = await tool.execute(
              "tool-call-1",
              {
                agentDefinition: {
                  name: "reviewer",
                  description: "Reviews code",
                },
                task: "Review commits A..B",
              },
              undefined,
              undefined,
              {
                cwd: process.cwd(),
                hasUI: false,
                sessionManager: {
                  getHeader() { return { version: 1 }; },
                  getBranch() { return []; },
                },
              },
            );

            process.stdout.write(JSON.stringify(result));
          `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PI_SUBAGENT_STACK: JSON.stringify(["reviewer"]),
            PI_SUBAGENT_PREVENT_CYCLES: "1",
          },
        },
      ),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cycle detected|delegation cycle/);
  } finally {
    cleanup();
  }
});

test("top-level tasks remain exclusive with top-level agentDefinition", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agentDefinition: {
        name: "reviewer",
        description: "Reviews code",
      },
      tasks: [
        {
          agent: "writer",
          task: "Draft notes",
        },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one invocation shape|agentDefinition/);
  } finally {
    cleanup();
  }
});
