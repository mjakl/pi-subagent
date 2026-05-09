import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function createTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-"));
  const modulePath = path.join(tmpDir, "render.testable.ts");
  const sourcePath = path.join(process.cwd(), "render.ts");

  fs.writeFileSync(
    path.join(tmpDir, "pi-coding-agent-stub.mjs"),
    "export function getMarkdownTheme() { return {}; }\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "pi-tui-stub.mjs"),
    `export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    }
    export class Markdown { constructor(text) { this.text = text; } }
    export class Spacer { constructor(size) { this.size = size; } }
    export class Text { constructor(text) { this.text = text; } }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "runner-events.js"),
    "export function getResultSummaryText(result) { return result?.errorMessage || result?.stderr || \"(no output)\"; }\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "types.js"),
    `export const DEFAULT_DELEGATION_MODE = "spawn";
    export function aggregateUsage(results) {
      return results.reduce((acc, r) => ({
        input: acc.input + (r.usage?.input || 0),
        output: acc.output + (r.usage?.output || 0),
        cacheRead: acc.cacheRead + (r.usage?.cacheRead || 0),
        cacheWrite: acc.cacheWrite + (r.usage?.cacheWrite || 0),
        cost: acc.cost + (r.usage?.cost || 0),
        contextTokens: acc.contextTokens + (r.usage?.contextTokens || 0),
        turns: acc.turns + (r.usage?.turns || 0),
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    }
    export function createModelDisplayState(model) {
      const trimmed = typeof model === "string" ? model.trim() : "";
      return trimmed ? { text: trimmed, status: "configured" } : { status: "resolving" };
    }
    export function getDisplayItems(messages) {
      const items = [];
      for (const msg of messages || []) {
        if (msg.role !== "assistant") continue;
        for (const part of msg.content || []) {
          if (part.type === "text") items.push({ type: "text", text: part.text });
          if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments || {} });
        }
      }
      return items;
    }
    export function getFinalOutput(messages) {
      for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.role !== "assistant") continue;
        for (let j = (msg.content || []).length - 1; j >= 0; j -= 1) {
          const part = msg.content[j];
          if (part.type === "text" && typeof part.text === "string") return part.text;
        }
      }
      return "";
    }
    export function getModelDisplayText(modelDisplay) {
      if (modelDisplay?.text) return modelDisplay.text;
      return "(resolving model…)";
    }
    export function isResultError(result) {
      return result.exitCode !== -1 && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
    }
    export function isResultSuccess(result) {
      return result.exitCode !== -1 && !isResultError(result);
    }\n`,
  );

  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace(
      'from "@mariozechner/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    )
    .replace('from "@mariozechner/pi-tui"', 'from "./pi-tui-stub.mjs"');

  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function renderCallPreview(moduleUrl, args, taskDisplays = []) {
  const script = `
    import { renderCall } from ${JSON.stringify(moduleUrl)};

    const theme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };

    const rendered = renderCall(${JSON.stringify(args)}, theme, ${JSON.stringify(taskDisplays)});
    process.stdout.write(JSON.stringify(rendered.text));
  `;

  return JSON.parse(
    execFileSync(
      "node",
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    ),
  );
}

function renderResultPreview(moduleUrl, result, expanded = false) {
  const script = `
    import { renderResult } from ${JSON.stringify(moduleUrl)};

    function toText(node) {
      if (!node) return "";
      const lines = [];
      if (typeof node.text === "string") lines.push(node.text);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          const childText = toText(child);
          if (childText) lines.push(childText);
        }
      }
      return lines.join("\\n");
    }

    const theme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };

    const rendered = renderResult(${JSON.stringify(result)}, ${JSON.stringify(expanded)}, theme);
    process.stdout.write(JSON.stringify(toText(rendered)));
  `;

  return JSON.parse(
    execFileSync(
      "node",
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    ),
  );
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

test("renderCall shows configured model labels", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();

  try {
    const text = renderCallPreview(
      moduleUrl,
      {
        agent: "writer",
        task: "Draft release notes",
      },
      [
        {
          agent: "writer",
          agentSource: "user",
          task: "Draft release notes",
          modelDisplay: { status: "configured", text: "openai/gpt-5.3-codex" },
        },
      ],
    );

    assert.match(text, /Model: openai\/gpt-5.3-codex/);
  } finally {
    cleanup();
  }
});

test("single renderResult keeps model in footer for running tasks without usage", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();

  try {
    const text = renderResultPreview(moduleUrl, {
      content: [{ type: "text", text: "running" }],
      details: {
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results: [
          {
            agent: "writer",
            agentSource: "user",
            task: "Draft release notes",
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: zeroUsage,
            modelDisplay: { status: "resolving" },
          },
        ],
      },
    });

    assert.doesNotMatch(text, /Model:/);
    assert.match(text, /\(resolving model…\)/);
  } finally {
    cleanup();
  }
});

test("single expanded renderResult appends model to usage footer", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();

  try {
    const text = renderResultPreview(
      moduleUrl,
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          delegationMode: "spawn",
          projectAgentsDir: null,
          results: [
            {
              agent: "writer",
              agentSource: "user",
              task: "Draft release notes",
              exitCode: 0,
              messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
              stderr: "",
              usage: {
                ...zeroUsage,
                contextTokens: 5200,
              },
              model: "openai/gpt-5.3-codex",
              modelDisplay: { status: "configured", text: "openai/gpt-5.3-codex" },
            },
          ],
        },
      },
      true,
    );

    assert.doesNotMatch(text, /Model:/);
    assert.match(text, /ctx:5\.2k.*openai\/gpt-5\.3-codex/);
  } finally {
    cleanup();
  }
});

test("parallel renderResult shows models in footer without model labels", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();

  try {
    const text = renderResultPreview(moduleUrl, {
      content: [{ type: "text", text: "running" }],
      details: {
        mode: "parallel",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results: [
          {
            agent: "writer",
            agentSource: "user",
            task: "Draft release notes",
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: zeroUsage,
            modelDisplay: { status: "configured", text: "openai/gpt-5.3-codex" },
          },
          {
            agent: "reviewer",
            agentSource: "inline",
            task: "Review release notes",
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: zeroUsage,
            modelDisplay: { status: "resolving" },
          },
        ],
      },
    });

    assert.doesNotMatch(text, /Model:/);
    assert.match(text, /openai\/gpt-5.3-codex/);
    assert.match(text, /\(resolving model…\)/);
  } finally {
    cleanup();
  }
});

test("renderCall uses sanitized taskDisplays for malformed parallel args", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();

  try {
    const text = renderCallPreview(
      moduleUrl,
      {
        tasks: [null, { agent: 42, task: { bad: true } }, "broken"],
      },
      [
        {
          agent: "writer",
          agentSource: "user",
          task: "Draft release notes",
          modelDisplay: { status: "configured", text: "openai/gpt-5.3-codex" },
        },
      ],
    );

    assert.match(text, /writer/);
    assert.match(text, /Model: openai\/gpt-5.3-codex/);
  } finally {
    cleanup();
  }
});
