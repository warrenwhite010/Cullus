// One log of everything the assistant does.
//
// The sidebar used to show only tool calls, which meant most of what happened was
// invisible: /fix ran builds and applied edits, fan-out started workers, servers
// connected and dropped, a mode changed what the model was allowed to do — and
// none of it appeared anywhere except the terminal that launched the process.
//
// Everything now writes here, the browser renders this stream, and a reload
// replays the buffer. Deliberately a ring buffer in memory: this is a record of
// what is happening, not an audit trail, and it must never be able to fill a disk.

import { EventEmitter } from "events";
import { redactSecrets } from "./secrets.js";

export type ActivityKind =
  | "tool" // an MCP or local tool call
  | "thinking" // a reasoning model's chain of thought for one step
  | "command" // a shell command run by /fix (build, verify, probe)
  | "edit" // a file created, changed, or reverted
  | "fix" // a /fix phase
  | "worker" // a fan-out subtask
  | "server" // an MCP server connecting, failing, or being removed
  | "session" // chat/session/mode changes
  | "turn"; // a turn starting, finishing or being stopped

export type ActivityStatus = "running" | "ok" | "warn" | "fail";

export interface ActivityEntry {
  id: number;
  at: number;
  kind: ActivityKind;
  status: ActivityStatus;
  /** Short headline, e.g. `vault_list` or `npm run build`. */
  label: string;
  /** One line of context, e.g. exit code or which file. */
  summary?: string;
  /** Full payload, shown on expand. Redacted before it leaves the process. */
  detail?: string;
}

const MAX_ENTRIES = 400;

export const activityEvents = new EventEmitter();

let entries: ActivityEntry[] = [];
let nextId = 1;

/**
 * Indent a string that happens to be JSON; return it untouched otherwise.
 *
 * Only worth doing for objects and arrays — a bare `"123"` or `"true"` is valid
 * JSON but reprinting it gains nothing, and `JSON.parse` on a long plain string
 * is wasted work on every entry.
 */
function reindentJson(text: string): string {
  const trimmed = text.trim();
  const looksStructured =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksStructured) return text;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text; // Truncated or malformed: show what we actually got.
  }
}

function clip(value: unknown, limit = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;

  let text: string;
  if (typeof value === "string") {
    // Tool results arrive already serialised, so the common case is a single
    // 4,000-character line of JSON with no newline to wrap at. Re-print it
    // indented when it parses; leave ordinary prose and log output alone.
    text = reindentJson(value);
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  if (!text.trim()) return undefined;
  // Defence in depth: a tool result or command output could carry a token.
  const safe = String(redactSecrets(text));
  return safe.length > limit ? `${safe.slice(0, limit)}\n… ${safe.length - limit} more characters` : safe;
}

/** Record something that happened. Never throws — logging must not break work. */
export function logActivity(entry: {
  kind: ActivityKind;
  status?: ActivityStatus;
  label: string;
  summary?: string;
  detail?: unknown;
  /**
   * Raise the detail clip for this entry. Only reasoning uses it: a chain of
   * thought at /effort high routinely runs past 4,000 characters, and cutting it
   * there hides the part that explains the answer. Hard-capped so one verbose
   * step still cannot dominate the buffer.
   */
  detailLimit?: number;
}): ActivityEntry | null {
  try {
    const record: ActivityEntry = {
      id: nextId++,
      at: Date.now(),
      kind: entry.kind,
      status: entry.status ?? "ok",
      label: entry.label.slice(0, 200),
      summary: entry.summary?.slice(0, 300),
      detail: clip(entry.detail, Math.min(Math.max(entry.detailLimit ?? 4000, 1), 12_000)),
    };

    entries.push(record);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

    activityEvents.emit("entry", record);
    return record;
  } catch {
    return null;
  }
}

/** The buffer, oldest first, so a reloaded page can replay it. */
export function listActivity(limit = MAX_ENTRIES): ActivityEntry[] {
  return entries.slice(-limit);
}

export function clearActivity(): void {
  entries = [];
  activityEvents.emit("cleared");
}
