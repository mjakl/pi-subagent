import * as path from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

function normalizeSessionDir(directory: string): string {
  // Reuse Pi's path normalization for runtime/env values, not just disk settings.
  return SettingsManager.inMemory({ sessionDir: directory }).getSessionDir()!;
}

/**
 * Compute the default Pi session directory for a cwd.
 *
 * This mirrors Pi's SessionManager default path format without importing the
 * internal getDefaultSessionDir helper, which is not exported from the public
 * @earendil-works/pi-coding-agent package entry point.
 */
export function getDefaultSessionDirPath(cwd: string, agentDir = getAgentDir()): string {
  const resolvedCwd = path.resolve(normalizeSessionDir(cwd));
  const resolvedAgentDir = path.resolve(normalizeSessionDir(agentDir));
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(resolvedAgentDir, "sessions", safePath);
}

/** Resolve the directory the child would select, without changing the parent's cwd. */
export function resolveChildSessionDir(
  cwd: string,
  cliSessionDir?: string,
  runtimeSessionDir?: string,
): string {
  // Relative configuration roots, like relative session paths, belong to the child cwd.
  const agentDir = path.resolve(cwd, getAgentDir());
  const configured = cliSessionDir || runtimeSessionDir || process.env.PI_CODING_AGENT_SESSION_DIR ||
    SettingsManager.create(cwd, agentDir).getSessionDir();
  return configured
    ? path.resolve(cwd, normalizeSessionDir(configured))
    : getDefaultSessionDirPath(cwd, agentDir);
}
