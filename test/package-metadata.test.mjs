import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

test("extension uses pi-compatible typebox import and peer dependency", () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, "index.ts"), "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  assert.match(indexSource, /from\s+"typebox"/);
  assert.doesNotMatch(indexSource, /from\s+"@sinclair\/typebox"/);
  assert.ok(pkg.peerDependencies.typebox);
  assert.equal(pkg.peerDependencies["@sinclair/typebox"], undefined);
  assert.equal(pkg.peerDependenciesMeta.typebox?.optional, true);
  assert.equal(pkg.peerDependenciesMeta["@sinclair/typebox"], undefined);
});

test("package declares Node 22+ when test script uses experimental strip-types", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  if (!pkg.scripts?.test?.includes("--experimental-strip-types")) return;

  assert.equal(typeof pkg.engines?.node, "string");
  assert.match(pkg.engines.node, />=\s*22(?:\.0\.0)?/);
});

test("package files include README demo GIF asset", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("docs/assets/subagent-demo.gif"));
});

test("npm pack dry-run includes README demo GIF asset in packed files", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const packResult = JSON.parse(output);
  assert.ok(Array.isArray(packResult));

  const packedEntry = packResult.find((entry) => entry?.name === pkg.name);
  assert.ok(packedEntry, `expected npm pack output for package ${pkg.name}`);
  assert.ok(Array.isArray(packedEntry.files));

  const packedPaths = packedEntry.files.map((file) => file.path);
  assert.ok(packedPaths.includes("docs/assets/subagent-demo.gif"));
});
