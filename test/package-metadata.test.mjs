import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
