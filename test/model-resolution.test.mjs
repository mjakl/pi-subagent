import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";

const { buildModelArgs } = await createJiti(import.meta.url).import("../runner.ts");
const models = [
  { provider: "anthropic", id: "claude-test", name: "Claude test" },
  { provider: "openai", id: "gpt-test", name: "GPT test" },
  { provider: "openrouter", id: "anthropic/claude-test", name: "Claude via router" },
  { provider: "openrouter", id: "meta-llama/llama-test", name: "Llama" },
  { provider: "openrouter", id: "openrouter/free", name: "Free" },
  { provider: "custom-one", id: "raw/shared", name: "Shared one" },
  { provider: "custom-two", id: "raw/shared", name: "Shared two" },
];
const modelRuntime = { getModels: () => models, hasConfiguredAuth: () => true };

function resolve(args) {
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  return resolveCliModel({ cliProvider: value("--provider"), cliModel: value("--model"), modelRuntime });
}

for (const [label, override, expected] of [
  ["cross-provider", "openai/gpt-test", "openai/gpt-test"],
  ["unique raw slash ID", "meta-llama/llama-test", "openrouter/meta-llama/llama-test"],
  ["provider-prefix collision", "anthropic/claude-test", "anthropic/claude-test"],
  ["qualified nested ID", "openrouter/anthropic/claude-test", "openrouter/anthropic/claude-test"],
  ["repeated provider prefix", "openrouter/openrouter/free", "openrouter/openrouter/free"],
  ["explicit disambiguation", "custom-two/raw/shared", "custom-two/raw/shared"],
  ["bare exact ID", "claude-test", "anthropic/claude-test"],
  ["bare pattern", "claude", "anthropic/claude-test"],
]) {
  for (const source of ["call", "agent"]) {
    test(`Pi resolves ${source} ${label} without changing model precedence`, () => {
      const args = buildModelArgs(
        source === "call" ? override : undefined,
        source === "agent" ? override : "wrong-agent-default",
        models[4], "anthropic", "wrong-startup-default",
      );
      if (override.includes("/")) assert.deepEqual(args, ["--model", override]);
      else assert.equal(args[1], "anthropic");
      const result = resolve(args);
      assert.equal(result.error, undefined);
      assert.equal(result.warning, undefined);
      assert.equal(`${result.model.provider}/${result.model.id}`, expected);
    });
  }
}

test("Pi rejects ambiguous raw slash IDs rather than routing through the inherited provider", () => {
  for (const [call, agent] of [["raw/shared", undefined], [undefined, "raw/shared"]]) {
    const result = resolve(buildModelArgs(call, agent, models[0], "anthropic", undefined));
    assert.equal(result.model, undefined);
    assert.match(result.error, /ambiguous/i);
    assert.match(result.error, /custom-one/);
    assert.match(result.error, /custom-two/);
  }
});

test("effective parent inheritance remains fully qualified, including slash IDs", () => {
  for (const parent of models) {
    const args = buildModelArgs(undefined, undefined, parent, "stale-provider", "stale-model");
    assert.deepEqual(args, ["--model", `${parent.provider}/${parent.id}`]);
    assert.equal(resolve(args).model, parent);
  }
});
