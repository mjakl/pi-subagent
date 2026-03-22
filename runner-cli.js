/**
 * Helpers for inheriting selected parent CLI flags in child subagent processes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function looksLikeExplicitRelativePath(value) {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function resolvePathArg(value, options = {}) {
  const { allowPackageSource = false, alwaysResolveRelative = false } = options;
  if (!value) return value;
  if (allowPackageSource && (value.startsWith("npm:") || value.startsWith("git:"))) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;

  const resolved = path.resolve(process.cwd(), value);
  if (
    alwaysResolveRelative ||
    looksLikeExplicitRelativePath(value) ||
    path.extname(value) !== "" ||
    fs.existsSync(resolved)
  ) {
    return resolved;
  }
  return value;
}

/**
 * Parse process.argv into groups used for child pi invocations.
 *
 * - extensionArgs: forwarded with path resolution
 * - alwaysProxy: forwarded verbatim to every child
 * - fallbackModel/thinking/tools: used only when the agent file does not set them
 */
export function parseInheritedCliArgs(argv) {
  const extensionArgs = [];
  const alwaysProxy = [];
  let fallbackModel;
  let fallbackThinking;
  let fallbackTools;
  let fallbackNoTools = false;

  let i = 2; // skip executable + script name
  while (i < argv.length) {
    const raw = argv[i];
    if (!raw.startsWith("-")) {
      i++;
      continue;
    }

    const eqIdx = raw.indexOf("=");
    const flagName = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineValue = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;

    const nextToken = argv[i + 1];
    const nextIsValue = nextToken !== undefined && !nextToken.startsWith("-");

    const getValue = () => {
      if (inlineValue !== undefined) return [inlineValue, 1];
      if (nextIsValue) return [nextToken, 2];
      return [undefined, 1];
    };

    if (
      [
        "--mode",
        "--session",
        "--append-system-prompt",
        "--export",
        "--subagent-max-depth",
      ].includes(flagName)
    ) {
      const [, skip] = getValue();
      i += skip;
      continue;
    }

    if (["--subagent-prevent-cycles", "--list-models"].includes(flagName)) {
      const [, skip] = getValue();
      i += skip;
      continue;
    }

    if (
      [
        "--print",
        "-p",
        "--no-session",
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--offline",
        "--help",
        "-h",
        "--version",
        "-v",
        "--no-subagent-prevent-cycles",
      ].includes(flagName)
    ) {
      i++;
      continue;
    }

    if (flagName === "--no-extensions" || flagName === "-ne") {
      extensionArgs.push(flagName);
      i++;
      continue;
    }

    if (flagName === "--extension" || flagName === "-e") {
      const [value, skip] = getValue();
      if (value !== undefined) {
        extensionArgs.push(flagName, resolvePathArg(value, { allowPackageSource: true }));
      }
      i += skip;
      continue;
    }

    if (["--skill", "--prompt-template", "--theme"].includes(flagName)) {
      const [value, skip] = getValue();
      if (value !== undefined) alwaysProxy.push(flagName, resolvePathArg(value));
      i += skip;
      continue;
    }

    if (flagName === "--session-dir") {
      const [value, skip] = getValue();
      if (value !== undefined) {
        alwaysProxy.push(flagName, resolvePathArg(value, { alwaysResolveRelative: true }));
      }
      i += skip;
      continue;
    }

    if (
      [
        "--provider",
        "--api-key",
        "--system-prompt",
        "--models",
      ].includes(flagName)
    ) {
      const [value, skip] = getValue();
      if (value !== undefined) alwaysProxy.push(flagName, value);
      i += skip;
      continue;
    }

    if (
      [
        "--no-skills",
        "-ns",
        "--no-prompt-templates",
        "-np",
        "--no-themes",
        "--verbose",
      ].includes(flagName)
    ) {
      alwaysProxy.push(flagName);
      i++;
      continue;
    }

    if (flagName === "--model") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackModel = value;
      i += skip;
      continue;
    }

    if (flagName === "--thinking") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackThinking = value;
      i += skip;
      continue;
    }

    if (flagName === "--tools") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackTools = value;
      i += skip;
      continue;
    }

    if (flagName === "--no-tools") {
      fallbackNoTools = true;
      i++;
      continue;
    }

    if (inlineValue !== undefined) {
      alwaysProxy.push(flagName, inlineValue);
      i++;
      continue;
    }

    if (nextIsValue) {
      alwaysProxy.push(flagName, nextToken);
      i += 2;
      continue;
    }

    alwaysProxy.push(flagName);
    i++;
  }

  return {
    extensionArgs,
    alwaysProxy,
    fallbackModel,
    fallbackThinking,
    fallbackTools,
    fallbackNoTools,
  };
}
