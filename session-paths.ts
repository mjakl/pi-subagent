import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getAgentDir(): string {
  const configured = process.env[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (configured) return expandTilde(configured);
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Compute the default Pi session directory for a cwd.
 *
 * This mirrors Pi's SessionManager default path format without importing the
 * internal getDefaultSessionDir helper, which is not exported from the public
 * @earendil-works/pi-coding-agent package entry point.
 */
export function getDefaultSessionDirPath(cwd: string, agentDir = getAgentDir()): string {
  const resolvedCwd = path.resolve(expandTilde(cwd));
  const resolvedAgentDir = path.resolve(expandTilde(agentDir));
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(resolvedAgentDir, "sessions", safePath);
}

export function ensureDefaultSessionDir(cwd: string, agentDir?: string): string {
  const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}
