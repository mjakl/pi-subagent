/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 */

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function getMessageSignature(message) {
  return stableStringify(message);
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);

  const signature = getMessageSignature(message);
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(message);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

export function processPiEvent(event, result, opts) {
  const { stdin, injectMessage, onMaxTurns } = opts || {};

  if (!event || typeof event !== "object") return false;

  // Check max turns limit before processing new events
  if (result.maxTurns && result.usage.turns >= result.maxTurns) {
    result.maxTurns = true;
    result.stopReason = "max_turns";
    result.errorMessage = `Sub-agent exceeded maximum turns (${result.maxTurns})`;
    result.stderr = `Sub-agent exceeded maximum turns (${result.maxTurns})`;

    // Inject summary message into the running sub-agent via stdin
    if (!getInjectedFlag(result, "__maxTurnsInjected") && injectMessage) {
      setInjectedFlag(result, "__maxTurnsInjected", true);
      try {
        const summaryMsg = `You have reached your maximum number of turns (${result.maxTurns}). Please summarize what you did, where you stopped at, next steps, and anything relevant for the main agent.`;
        injectMessage(summaryMsg);
      } catch (e) {
        /* ignore injection errors */
      }
    }

    // Notify runner to terminate the child process
    if (onMaxTurns) {
      onMaxTurns();
    }
    return false;
  }

  // Block sub-agents from spawning further sub-agents
  // This is enforced at the runner level (not via system prompt) for reliability
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "toolCall" && part?.name === "subagent") {
          result.stopReason = "subagent_recursion_blocked";
          result.errorMessage = "Sub-agents are not allowed to spawn further sub-agents.";
          result.stderr = result.errorMessage;
          result.exitCode = 1;
          return false;
        }
      }
    }
  }

  switch (event.type) {
    case "message_end":
      return addAssistantMessage(result, event.message);

    case "turn_end":
      return addAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

    default:
      return false;
  }
}

// Track whether a summary message was injected for max turns / timeout
export function getInjectedFlag(result, key) {
  if (!Object.prototype.hasOwnProperty.call(result, key)) {
    Object.defineProperty(result, key, {
      value: false,
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  return result[key];
}

export function setInjectedFlag(result, key, value) {
  result[key] = value;
}

export function processPiJsonLine(line, result, opts) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result, opts);
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        return part.text;
      }
    }
  }

  return "";
}

export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}
