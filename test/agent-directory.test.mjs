import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const agentsModule = new URL("../agents.ts", import.meta.url).href;
const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");

for (const kind of ["unset", "empty", "absolute", "relative", "tilde", "home", ...(process.platform === "win32" ? ["backslash-tilde"] : [])]) {
  test(`agent discovery and starter placement follow Pi's ${kind} config directory`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-agent-dir-"));
    const cwd = path.join(root, "project");
    const home = path.join(root, "home");
    fs.mkdirSync(cwd);
    fs.mkdirSync(home);
    const overrides = { empty: "", absolute: path.join(root, "custom"), relative: "custom", tilde: "~/custom", home: "~", "backslash-tilde": "~\\custom" };
    const expected = kind === "unset" || kind === "empty" ? path.join(home, ".pi", "agent")
      : kind === "absolute" ? overrides.absolute : kind === "relative" ? path.join(cwd, "custom")
      : kind === "home" ? home : path.join(home, "custom");
    const literal = path.join(cwd, "~", "custom", "agents", "erroneous.md");
    fs.mkdirSync(path.dirname(literal), { recursive: true });
    const erroneous = "---\nname: erroneous\ndescription: Must not be imported\n---\nOld misplaced agent.\n";
    fs.writeFileSync(literal, erroneous);
    try {
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        import fs from "node:fs";
        import path from "node:path";
        import { getAgentDir } from ${JSON.stringify(piModule)};
        import { getUserAgentsDir, discoverAgentsWithStarter } from ${JSON.stringify(agentsModule)};
        const directory = getUserAgentsDir();
        fs.mkdirSync(directory, { recursive: true });
        const collision = path.join(directory, "explore.md");
        fs.writeFileSync(collision, "Keep this invalid agent unchanged.");
        const first = discoverAgentsWithStarter(process.cwd(), false);
        const second = discoverAgentsWithStarter(process.cwd(), false);
        console.log(JSON.stringify({
          directory: path.resolve(directory), piDirectory: path.resolve(getAgentDir(), "agents"),
          created: path.resolve(first.createdAgentPath), names: first.discovery.agents.map(a => a.name),
          secondCreated: second.createdAgentPath, collision: fs.readFileSync(collision, "utf8")
        }));
      `], {
        cwd, encoding: "utf8", timeout: 15_000,
        env: {
          PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_OFFLINE: "1",
          ...(kind === "unset" ? {} : { PI_CODING_AGENT_DIR: overrides[kind] }),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      }));
      assert.equal(result.directory, path.join(expected, "agents"));
      assert.equal(result.directory, result.piDirectory);
      assert.equal(result.created, path.join(expected, "agents", "explore-starter.md"));
      assert.deepEqual(result.names, ["explore"]);
      assert.equal(result.secondCreated, null);
      assert.equal(result.collision, "Keep this invalid agent unchanged.");
      assert.equal(fs.readFileSync(literal, "utf8"), erroneous);
      assert.deepEqual(fs.readdirSync(path.dirname(literal)), ["erroneous.md"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
