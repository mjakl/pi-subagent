import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-"));
  const codingAgentStub = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const tuiStub = path.join(tmpDir, "pi-tui-stub.mjs");
  const modulePath = path.join(tmpDir, "render.testable.ts");

  fs.writeFileSync(codingAgentStub, `export function getMarkdownTheme() { return {}; }\n`);
  fs.writeFileSync(
    tuiStub,
    `export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); return child; }
    }
    export class Text { constructor(text) { this.text = text; } }
    export class Markdown { constructor(text) { this.text = text; } }
    export class Spacer { constructor(size) { this.size = size; } }
`,
  );

  const source = fs
    .readFileSync(path.join(process.cwd(), "render.ts"), "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    )
    .replace('from "@earendil-works/pi-tui"', 'from "./pi-tui-stub.mjs"')
    .replace(
      'from "./runner-events.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`,
    )
    .replace(
      'from "./types.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`,
    );
  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function collectText(component) {
  if (!component) return [];
  const own = typeof component.text === "string" ? [component.text] : [];
  const children = Array.isArray(component.children)
    ? component.children.flatMap((child) => collectText(child))
    : [];
  return [...own, ...children];
}

test("expanded renderer tolerates legacy pre-prompt results with task", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderResult } = await import(moduleUrl);
    const component = renderResult(
      {
        content: [{ type: "text", text: "legacy" }],
        details: {
          projectAgentsDir: null,
          results: [
            {
              callIndex: 0,
              agent: "review",
              agentSource: "user",
              task: "old task field",
              initialContext: "empty",
              exitCode: 0,
              messages: [],
              stderr: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
            },
          ],
        },
      },
      true,
      theme,
    );

    assert.ok(collectText(component).some((text) => text.includes("Prompt: old task field")));
  } finally {
    cleanup();
  }
});
