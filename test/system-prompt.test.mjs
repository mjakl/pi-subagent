import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliModule = new URL("../runner-cli.js", import.meta.url).href;
const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");

function run(cwd, script, input) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, input: JSON.stringify(input), encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: cwd, PI_OFFLINE: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  }));
}

test("inherited system prompts use parent files and preserve literal text through Pi's loader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-system-prompt-"));
  const parent = path.join(dir, "parent");
  const child = path.join(dir, "child");
  fs.mkdirSync(parent);
  fs.mkdirSync(child);
  const file = path.join(parent, "instructions.md");
  fs.writeFileSync(file, "Parent instructions");
  fs.writeFileSync(path.join(child, "instructions.md"), "Wrong child instructions");
  const files = ["instructions.md", "./instructions.md", file];
  if (process.platform !== "win32") {
    fs.symlinkSync(file, path.join(parent, "prompt-link"));
    files.push("./prompt-link");
  }
  const literals = [
    "Be precise. Keep punctuation!", "Review input/output carefully.",
    "  Keep leading and trailing spaces.  ", "Line one\nLine two / three.",
    "./missing.md", "dir/missing", "~/missing.md", "--literal-prompt", "",
  ];
  try {
    const inputs = [...files, ...literals].flatMap((value) => [
      ["--system-prompt", value], [`--system-prompt=${value}`],
    ]);
    const forwarded = run(parent, `
      import fs from "node:fs";
      import { parseInheritedCliArgs } from ${JSON.stringify(cliModule)};
      const inputs = JSON.parse(fs.readFileSync(0, "utf8"));
      console.log(JSON.stringify(inputs.map(args => parseInheritedCliArgs([
        "node", "pi", ...args, "--append-system-prompt", "do not inherit", "--api-key", "unchanged/key"
      ]))));
    `, inputs);
    for (let i = 0; i < inputs.length; i++) {
      const value = [...files, ...literals][Math.floor(i / 2)];
      const expected = files.includes(value) ? path.resolve(parent, value) : value;
      assert.deepEqual(forwarded[i].alwaysProxy, ["--system-prompt", expected, "--api-key", "unchanged/key"]);
    }
    // Forward paths, not a snapshot: Pi must read the current contents at child startup.
    fs.writeFileSync(file, "Updated parent instructions");
    const loaded = run(child, `
      import fs from "node:fs";
      import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(piModule)};
      const prompts = JSON.parse(fs.readFileSync(0, "utf8"));
      const result = [];
      for (const systemPrompt of prompts) {
        const loader = new DefaultResourceLoader({
          cwd: process.cwd(), agentDir: process.cwd(), settingsManager: SettingsManager.inMemory(),
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPrompt,
        });
        await loader.reload();
        result.push(loader.getSystemPrompt() ?? null);
      }
      console.log(JSON.stringify(result));
    `, forwarded.map((parsed) => parsed.alwaysProxy[1]));
    assert.deepEqual(loaded, [...files.map(() => "Updated parent instructions"), ...literals.map((s) => s || null)]
      .flatMap((value) => [value, value]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
