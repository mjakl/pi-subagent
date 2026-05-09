# Subagent Model UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each delegated subagent’s full model id in the main session UI from tool invocation through running and final result states, falling back to `(resolving model…)` when the model is not yet known.

**Architecture:** Add an explicit model-display state to subagent task/result metadata, seed that state when tasks are resolved in `index.ts`, preserve it through `runner.ts`, refine it from Pi JSON-mode runtime metadata in `runner-events.js`, and render it consistently in `render.ts` for single and parallel views.

**Tech Stack:** TypeScript, Node.js built-in test runner, Pi extension tool rendering API, JSON-mode event parsing

---

## File structure

- **Modify:** `types.ts`
  - Add `ModelDisplayState`, task-display metadata, and helper functions for configured/runtime/resolving display behavior.
- **Modify:** `runner-events.js`
  - Upgrade result model display state when assistant messages include `message.model`.
- **Modify:** `runner.ts`
  - Seed `SingleResult` instances with the initial model display state and preserve it through running updates.
- **Modify:** `index.ts`
  - Resolve initial model display state for named and inline tasks, attach task-display metadata to `SubagentDetails`, and pass resolved task display info into `renderCall()`.
- **Modify:** `render.ts`
  - Render model lines in tool-call previews and running/final result blocks for single and parallel modes.
- **Modify:** `test/runner.test.mjs`
  - Add unit tests for model-display helpers.
- **Modify:** `test/runner-events.test.mjs`
  - Add regression tests proving runtime model metadata overrides configured/resolving state.
- **Modify:** `test/index.test.mjs`
  - Add regression tests for resolved task metadata and tool-call preview plumbing from `index.ts`.
- **Create:** `test/render.test.mjs`
  - Add focused rendering tests for running/final single and parallel states.

---

### Task 1: Add explicit model-display state and runtime override support

**Files:**
- Modify: `types.ts`
- Modify: `runner-events.js`
- Modify: `test/runner.test.mjs`
- Modify: `test/runner-events.test.mjs`

- [ ] **Step 1: Write failing helper and runtime-override tests**

Add these imports and tests.

`test/runner.test.mjs`
```js
import {
  createModelDisplayState,
  getModelDisplayText,
  isResultError,
  isResultSuccess,
  normalizeCompletedResult,
} from "../types.ts";

test("createModelDisplayState returns configured and resolving display states", () => {
  assert.deepEqual(createModelDisplayState("openai/gpt-5.3-codex"), {
    text: "openai/gpt-5.3-codex",
    status: "configured",
  });
  assert.deepEqual(createModelDisplayState(), { status: "resolving" });
  assert.equal(
    getModelDisplayText(createModelDisplayState()),
    "(resolving model…)"
  );
});
```

`test/runner-events.test.mjs`
```js
test("runtime model metadata replaces configured display state", () => {
  const result = makeResult({
    model: "openai/gpt-5.3-codex",
    modelDisplay: {
      text: "openai/gpt-5.3-codex",
      status: "configured",
    },
  });

  processPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "anthropic/claude-3.7-sonnet",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    },
    result,
  );

  assert.equal(result.model, "anthropic/claude-3.7-sonnet");
  assert.deepEqual(result.modelDisplay, {
    text: "anthropic/claude-3.7-sonnet",
    status: "runtime",
  });
});
```

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run:
```bash
node --test test/runner.test.mjs test/runner-events.test.mjs
```

Expected:
- FAIL in `test/runner.test.mjs` because `createModelDisplayState` and `getModelDisplayText` do not exist yet
- FAIL in `test/runner-events.test.mjs` because `modelDisplay` is not updated to runtime state yet

- [ ] **Step 3: Implement the model-display types and runtime override**

Add the new types and helpers in `types.ts`.

```ts
export type ModelDisplayStatus = "configured" | "runtime" | "resolving";

export interface ModelDisplayState {
  text?: string;
  status: ModelDisplayStatus;
}

export interface TaskDisplayState {
  agent: string;
  agentSource: SingleResult["agentSource"];
  task: string;
  modelDisplay: ModelDisplayState;
}

export function createModelDisplayState(model?: string): ModelDisplayState {
  const trimmed = typeof model === "string" ? model.trim() : "";
  return trimmed ? { text: trimmed, status: "configured" } : { status: "resolving" };
}

export function getModelDisplayText(modelDisplay?: ModelDisplayState): string {
  if (modelDisplay?.text) return modelDisplay.text;
  return "(resolving model…)";
}
```

Update the `SingleResult` and `SubagentDetails` interfaces in the same file.

```ts
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "inline" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  modelDisplay: ModelDisplayState;
  stopReason?: string;
  errorMessage?: string;
  sawAgentEnd?: boolean;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  delegationMode: DelegationMode;
  projectAgentsDir: string | null;
  tasks: TaskDisplayState[];
  results: SingleResult[];
}
```

Update `runner-events.js` so runtime metadata is authoritative.

```js
function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (message.model) {
    result.model = message.model;
    result.modelDisplay = {
      text: message.model,
      status: "runtime",
    };
  }
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}
```

Also update the test helpers’ synthetic result objects to include the new field.

`test/runner.test.mjs` and `test/runner-events.test.mjs`
```js
    modelDisplay: { status: "resolving" },
```

- [ ] **Step 4: Run the targeted tests and confirm they pass**

Run:
```bash
node --test test/runner.test.mjs test/runner-events.test.mjs
```

Expected:
- PASS for all tests in both files

- [ ] **Step 5: Commit the core model-display state changes**

Run:
```bash
git add types.ts runner-events.js test/runner.test.mjs test/runner-events.test.mjs
git commit -m "Add model display state helpers"
```

Expected:
- A commit is created with only the core model-display state and runtime-override test changes

---

### Task 2: Propagate resolved model metadata through tool execution and result details

**Files:**
- Modify: `index.ts`
- Modify: `runner.ts`
- Modify: `test/index.test.mjs`

- [ ] **Step 1: Add failing index-level tests for task metadata and call-preview plumbing**

Update the stubs in `createTestableIndexModule()` so discovered agents expose a configured model and the render stub echoes resolved task metadata.

`test/index.test.mjs`
```js
fs.writeFileSync(
  path.join(tmpDir, "agents.js"),
  `export function discoverAgents() {
    return {
      agents: [{
        name: "writer",
        description: "Writer agent",
        model: "openai/gpt-5.3-codex",
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
    return {
      name,
      description,
      model: typeof definition?.model === "string" ? definition.model.trim() || undefined : undefined,
      thinking: typeof definition?.thinking === "string" ? definition.thinking.trim() || undefined : undefined,
      tools: Array.isArray(definition?.tools) ? definition.tools.map((tool) => tool.trim()).filter(Boolean) : undefined,
      systemPrompt: typeof definition?.systemPrompt === "string" ? definition.systemPrompt.trim() : "",
      source: "inline",
      filePath: "(inline agent definition)",
    };
  }\n`,
);

fs.writeFileSync(
  path.join(tmpDir, "render.js"),
  `export function renderCall(_args, _theme, taskDisplays = []) {
    return { text: taskDisplays.map((task) => `${task.agent}|${task.modelDisplay.status}|${task.modelDisplay.text ?? "(resolving model…)"}`).join("\\n") };
  }
  export function renderResult() { return []; }\n`,
);
```

Add a helper that exercises the registered tool’s `renderCall()` wrapper.

```js
function renderRegisteredToolCall(moduleUrl, args) {
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

    const theme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };

    const rendered = tool.renderCall(${JSON.stringify(args)}, theme);
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
```

Add these failing tests.

```js
test("single-mode details keep configured model metadata for named agents", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      agent: "writer",
      task: "Draft release notes",
    });

    assert.deepEqual(result.details.tasks, [{
      agent: "writer",
      agentSource: "user",
      task: "Draft release notes",
      modelDisplay: {
        text: "openai/gpt-5.3-codex",
        status: "configured",
      },
    }]);
  } finally {
    cleanup();
  }
});

test("parallel details keep resolving metadata for model-less inline agents", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const result = runSubagentTool(moduleUrl, {
      tasks: [{
        agentDefinition: {
          name: "reviewer",
          description: "Reviews code",
        },
        task: "Review this diff",
      }],
    });

    assert.equal(result.details.tasks[0].modelDisplay.status, "resolving");
    assert.equal(result.details.tasks[0].modelDisplay.text, undefined);
  } finally {
    cleanup();
  }
});

test("registered tool renderCall receives resolved model metadata", () => {
  const { moduleUrl, cleanup } = createTestableIndexModule();

  try {
    const preview = renderRegisteredToolCall(moduleUrl, {
      agent: "writer",
      task: "Draft release notes",
    });

    assert.match(preview, /writer\|configured\|openai\/gpt-5.3-codex/);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the index tests and confirm they fail**

Run:
```bash
node --test test/index.test.mjs
```

Expected:
- FAIL because `details.tasks` is missing
- FAIL because the registered tool `renderCall()` wrapper does not pass resolved task metadata yet

- [ ] **Step 3: Implement resolved task-display metadata in `index.ts` and `runner.ts`**

Add model-display metadata to `ResolvedTask` and create helpers in `index.ts`.

```ts
interface ResolvedTask {
  agentName: string;
  task: string;
  cwd?: string;
  agentConfig?: AgentConfig;
  named: boolean;
  agentSource: SingleResult["agentSource"];
  modelDisplay: ModelDisplayState;
}

function buildTaskDisplayState(
  agentName: string,
  task: string,
  agentConfig: AgentConfig | undefined,
): TaskDisplayState {
  return {
    agent: agentName,
    agentSource: agentConfig?.source ?? "unknown",
    task,
    modelDisplay: createModelDisplayState(agentConfig?.model),
  };
}

function buildRenderCallTasks(
  args: Record<string, any>,
  agents: AgentConfig[],
): TaskDisplayState[] {
  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    return args.tasks.map((taskItem) => {
      const inlineAgent = taskItem.agentDefinition
        ? normalizeInlineAgentDefinition(taskItem.agentDefinition)
        : undefined;
      const namedAgent = inlineAgent
        ? undefined
        : agents.find((agent) => agent.name === taskItem.agent);
      const agentConfig = inlineAgent ?? namedAgent;
      return buildTaskDisplayState(
        taskItem.agent ?? inlineAgent?.name ?? "...",
        taskItem.task ?? "",
        agentConfig,
      );
    });
  }

  const inlineAgent = args.agentDefinition
    ? normalizeInlineAgentDefinition(args.agentDefinition)
    : undefined;
  const namedAgent = inlineAgent ? undefined : agents.find((agent) => agent.name === args.agent);
  const agentConfig = inlineAgent ?? namedAgent;
  if (!args.task) return [];
  return [buildTaskDisplayState(args.agent ?? inlineAgent?.name ?? "...", args.task, agentConfig)];
}
```

Update `makeDetailsFactory()` so `SubagentDetails` always carries the resolved task-display list.

```ts
function makeDetailsFactory(
  projectAgentsDir: string | null,
  delegationMode: DelegationMode,
  tasks: TaskDisplayState[],
) {
  return (mode: "single" | "parallel") =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      delegationMode,
      projectAgentsDir,
      tasks,
      results,
    });
}
```

Wire the resolved task-display metadata into task resolution and into the registered tool renderer.

```ts
const resolvedSingleTask =
  params.task && (params.agent || inlineSingleAgent)
    ? buildTaskDisplayState(
        params.agent ?? inlineSingleAgent!.name,
        params.task,
        inlineSingleAgent ?? agents.find((agent) => agent.name === params.agent),
      )
    : null;

renderCall: (args, theme) =>
  renderCall(args, theme, buildRenderCallTasks(args, discoveredAgents)),
```

Seed `runner.ts` with the initial display state.

```ts
export interface RunAgentOptions {
  cwd: string;
  agents: AgentConfig[];
  agentName: string;
  agentConfig?: AgentConfig;
  task: string;
  taskCwd?: string;
  delegationMode: DelegationMode;
  forkSessionSnapshotJsonl?: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  initialModelDisplay: ModelDisplayState;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

const result: SingleResult = {
  agent: agentName,
  agentSource: agent.source,
  task,
  exitCode: -1,
  messages: [],
  stderr: "",
  usage: emptyUsage(),
  model: agent.model,
  modelDisplay: initialModelDisplay,
};
```

Update `executeParallel()` placeholders so they preserve agent source and model state before completion.

```ts
const allResults: SingleResult[] = tasks.map((t) => ({
  agent: t.agentName,
  agentSource: t.agentSource,
  task: t.task,
  exitCode: -1,
  messages: [],
  stderr: "",
  usage: emptyUsage(),
  model: t.modelDisplay.text,
  modelDisplay: t.modelDisplay,
}));
```

- [ ] **Step 4: Run the index tests and confirm they pass**

Run:
```bash
node --test test/index.test.mjs
```

Expected:
- PASS for the existing invocation-shape tests
- PASS for the new `details.tasks` and registered `renderCall()` metadata tests

- [ ] **Step 5: Commit the execution-path metadata plumbing**

Run:
```bash
git add index.ts runner.ts test/index.test.mjs
git commit -m "Propagate subagent model display metadata"
```

Expected:
- A commit is created with only the execution-path model metadata changes and tests

---

### Task 3: Render model labels in call, running, and final states and verify end-to-end behavior

**Files:**
- Modify: `render.ts`
- Create: `test/render.test.mjs`

- [ ] **Step 1: Add failing rendering tests for single and parallel model labels**

Create `test/render.test.mjs` with a focused render harness.

```js
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

  fs.writeFileSync(path.join(tmpDir, "pi-coding-agent-stub.mjs"), "export function getMarkdownTheme() { return {}; }\n");
  fs.writeFileSync(
    path.join(tmpDir, "pi-tui-stub.mjs"),
    `export class Container { constructor() { this.children = []; } addChild(child) { this.children.push(child); } }
     export class Markdown { constructor(text) { this.text = text; } }
     export class Spacer { constructor(size) { this.size = size; } }
     export class Text { constructor(text) { this.text = text; } }\n`,
  );
  fs.writeFileSync(path.join(tmpDir, "runner-events.js"), "export function getResultSummaryText() { return \"(no output)\"; }\n");
  fs.writeFileSync(
    path.join(tmpDir, "types.js"),
    `export const DEFAULT_DELEGATION_MODE = "spawn";
     export function aggregateUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }; }
     export function createModelDisplayState(model) { return model ? { text: model, status: "configured" } : { status: "resolving" }; }
     export function getModelDisplayText(modelDisplay) { return modelDisplay?.text || "(resolving model…)"; }
     export function getDisplayItems() { return []; }
     export function getFinalOutput() { return ""; }
     export function isResultError(result) { return result.exitCode > 0; }
     export function isResultSuccess(result) { return result.exitCode === 0; }\n`,
  );

  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace('from "@mariozechner/pi-coding-agent"', 'from "./pi-coding-agent-stub.mjs"')
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
    const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
    const rendered = renderCall(${JSON.stringify(args)}, theme, ${JSON.stringify(taskDisplays)});
    process.stdout.write(JSON.stringify(rendered.text));
  `;

  return JSON.parse(execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" }));
}

function renderResultPreview(moduleUrl, result) {
  const script = `
    import { renderResult } from ${JSON.stringify(moduleUrl)};
    const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
    const rendered = renderResult(${JSON.stringify(result)}, false, theme);
    process.stdout.write(JSON.stringify(rendered.text));
  `;

  return JSON.parse(execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" }));
}

test("renderCall shows configured model labels", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const text = renderCallPreview(
      moduleUrl,
      { agent: "writer", task: "Draft release notes" },
      [{
        agent: "writer",
        agentSource: "user",
        task: "Draft release notes",
        modelDisplay: { text: "openai/gpt-5.3-codex", status: "configured" },
      }],
    );

    assert.match(text, /Model: openai\/gpt-5.3-codex/);
  } finally {
    cleanup();
  }
});

test("renderResult shows resolving labels for running tasks", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const text = renderResultPreview(moduleUrl, {
      content: [{ type: "text", text: "(running...)" }],
      details: {
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        tasks: [{
          agent: "reviewer",
          agentSource: "inline",
          task: "Review this diff",
          modelDisplay: { status: "resolving" },
        }],
        results: [{
          agent: "reviewer",
          agentSource: "inline",
          task: "Review this diff",
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          modelDisplay: { status: "resolving" },
        }],
      },
    });

    assert.match(text, /Model: \(resolving model…\)/);
  } finally {
    cleanup();
  }
});

test("parallel renderResult shows per-task model labels", () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const text = renderResultPreview(moduleUrl, {
      content: [{ type: "text", text: "Parallel: 1\/2 done" }],
      details: {
        mode: "parallel",
        delegationMode: "spawn",
        projectAgentsDir: null,
        tasks: [],
        results: [{
          agent: "writer",
          agentSource: "user",
          task: "Draft release notes",
          exitCode: 0,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          modelDisplay: { text: "openai/gpt-5.3-codex", status: "configured" },
        }, {
          agent: "reviewer",
          agentSource: "inline",
          task: "Review this diff",
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          modelDisplay: { status: "resolving" },
        }],
      },
    });

    assert.match(text, /writer/);
    assert.match(text, /openai\/gpt-5.3-codex/);
    assert.match(text, /reviewer/);
    assert.match(text, /\(resolving model…\)/);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the rendering tests and confirm they fail**

Run:
```bash
node --test test/render.test.mjs
```

Expected:
- FAIL because `render.ts` does not yet accept task-display metadata for call previews
- FAIL because the collapsed result views do not yet print a `Model:` line

- [ ] **Step 3: Implement model labels in `render.ts`**

Import the new helpers from `types.ts` and update the call/result renderers.

```ts
import {
  type DelegationMode,
  type DisplayItem,
  type SingleResult,
  type SubagentDetails,
  type TaskDisplayState,
  type UsageStats,
  DEFAULT_DELEGATION_MODE,
  aggregateUsage,
  createModelDisplayState,
  getDisplayItems,
  getFinalOutput,
  getModelDisplayText,
  isResultError,
  isResultSuccess,
} from "./types.js";
```

Add a helper for formatting the UI label.

```ts
function formatModelLine(modelDisplay: SingleResult["modelDisplay"]): string {
  return `Model: ${getModelDisplayText(modelDisplay)}`;
}
```

Update `renderCall()` to accept pre-resolved task displays and print the model label.

```ts
export function renderCall(
  args: Record<string, any>,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  taskDisplays: TaskDisplayState[] = [],
): Text {
  const delegationMode = normalizeDelegationMode(args.mode);
  const modeBadge = theme.fg("muted", ` [${delegationMode}]`);

  if (taskDisplays.length > 1 || (args.tasks && args.tasks.length > 0)) {
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `parallel (${taskDisplays.length} tasks)`) +
      modeBadge;
    for (const task of taskDisplays.slice(0, 3)) {
      text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${truncate(task.task, 40)}`)}`;
      text += `\n    ${theme.fg("muted", formatModelLine(task.modelDisplay))}`;
    }
    if (taskDisplays.length > 3) text += `\n  ${theme.fg("muted", `... +${taskDisplays.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }

  const taskDisplay = taskDisplays[0];
  const agentName = taskDisplay?.agent || args.agent || args.agentDefinition?.name || "...";
  const preview = taskDisplay?.task ? truncate(taskDisplay.task, 60) : args.task ? truncate(args.task, 60) : "...";
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName) +
    modeBadge;
  text += `\n  ${theme.fg("dim", preview)}`;
  text += `\n  ${theme.fg("muted", formatModelLine(taskDisplay?.modelDisplay ?? createModelDisplayState()))}`;
  return new Text(text, 0, 0);
}
```

Update collapsed result renderers to show the model label for both single and parallel views.

```ts
const usageStr = formatUsage(r.usage, r.model);
text += `\n${theme.fg("muted", formatModelLine(r.modelDisplay))}`;
if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
```

And in the parallel renderer loop:

```ts
text += `\n${theme.fg("muted", formatModelLine(r.modelDisplay))}`;
```

Also add the same `Model:` line in the expanded single and parallel views immediately before usage.

- [ ] **Step 4: Run focused and full verification**

Run:
```bash
node --test test/render.test.mjs
npm test
npm pack --dry-run
```

Expected:
- PASS for `test/render.test.mjs`
- PASS for the full test suite
- `npm pack --dry-run` lists the package contents without errors

Then run the manual smoke check:
```bash
pi -e .
```

Expected manual verification:
- Start Pi with the local extension
- Trigger a `subagent` call for a named agent with a configured `model`
- Observe `Model: openai/gpt-5.3-codex` in the call block and running/final result block
- Trigger an inline agent without a `model`
- Observe `Model: (resolving model…)` in the same places

- [ ] **Step 5: Commit the renderer and verification changes**

Run:
```bash
git add render.ts test/render.test.mjs
git commit -m "Show subagent models in tool rendering"
```

Expected:
- A commit is created with the renderer changes and focused render tests

---

## Spec coverage check

- **Show model in main session UI:** handled in Task 3 render-call and render-result changes.
- **Show model continuously while running:** handled in Task 2 placeholder/result seeding and Task 3 running-state tests.
- **Show model in call/start and result states:** handled in Task 2 registered tool `renderCall()` plumbing and Task 3 rendering updates.
- **Show full configured model id when known:** handled in Task 1 helper creation and Task 2 task-resolution plumbing.
- **Show `(resolving model…)` when not known:** handled in Task 1 helper creation and Task 3 rendering tests.
- **Support named agents, inline agent definitions, and parallel runs:** covered by Task 2 index tests and Task 3 parallel render tests.
- **Prefer runtime-reported model when available:** handled in Task 1 runtime override test and `runner-events.js` update.

## Placeholder scan

No `TBD`, `TODO`, deferred validation notes, or unnamed helper steps remain. Each code-changing step includes concrete code snippets, exact files, and commands.

## Type consistency check

The plan uses the same names throughout:
- `ModelDisplayState`
- `TaskDisplayState`
- `createModelDisplayState()`
- `getModelDisplayText()`
- `modelDisplay`
- `tasks` on `SubagentDetails`

These names are used consistently across types, execution plumbing, and rendering.
