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
        }],
        projectAgentsDir: null,
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
      return result?.errorMessage || result?.stderr || "(no output)";
    }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "runner.js"),
    `export async function runAgent() {
      throw new Error("runAgent should not be called in invalid-parameter tests");
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
