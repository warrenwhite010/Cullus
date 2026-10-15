// Manual-mode tool approval.
//
// In manual mode the inference loop pauses before every tool call and waits for a
// human answer. That answer has to come from whatever surface is driving the turn
// — a socket in the browser, or the terminal — so the loop only knows about a
// handler it can await, and the surface registers one.
//
// Three rules make this safe to put in the middle of a loop:
//
//   1. No handler registered → the call is APPROVED. A headless run (cron, the
//      REPL with nothing listening) must not deadlock waiting for a click.
//   2. Every request times out. An unanswered prompt denies rather than hanging
//      the turn forever.
//   3. A denial is information, not an error: the model is told it was refused and
//      asked to try another way.

import { targetsVault, writesToVaultByName, expandPath } from "./config.js";
import { consultRules } from "./permissions.js";
import type { AgentMode } from "./session.js";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
  /** Why this is being asked, e.g. "it writes to Notes/x.md in your vault". */
  because?: string;
  /** Absolute path being written, when there is one. */
  resolvedPath?: string;
  /** First lines of what would be written, so "asked first" means something. */
  preview?: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

/**
 * Does this call need a human "yes" before it runs?
 *
 * One predicate, because the provider is the only place that asks and manual mode
 * would otherwise prompt twice for the same call.
 *
 *   manual      → everything, that is what the mode means
 *   auto        → writes into the vault, plus the handful of calls that change how
 *                 later turns behave. A note landing in a synced vault of real
 *                 notes is the one thing in auto mode worth interrupting for; a
 *                 skill is the other, because it steers the next conversation.
 *   plan        → nothing to ask about: mutating tools are already withheld
 *   acceptEdits → nothing. This mode exists to stop being asked.
 */




export function requiresApproval(
  toolName: string,
  args: unknown,
  mode: AgentMode
): { needed: boolean; because?: string; denied?: boolean } {
  // Rules first, and ahead of the modes.
  //
  // A `deny` rule is absolute — it outranks acceptEdits, because a mode that
  // exists to stop being asked should not also be a way to switch off a
  // prohibition the user wrote down. An `allow` rule is what makes `manual`
  // usable: without it that mode prompts for `ls`.
  //
  // Anything unmatched falls through to the mode below, so an install with no
  // rules file behaves exactly as it did before rules existed.
  const rule = consultRules(toolName, args);

  if (rule.verdict === "deny") {
    return { needed: true, denied: true, because: rule.because };
  }
  if (rule.verdict === "ask") {
    return { needed: true, because: rule.because };
  }
  if (rule.verdict === "allow" && mode !== "manual") {
    return { needed: false };
  }
  if (rule.verdict === "allow" && mode === "manual") {
    // An explicit allow is the user saying "never ask me about this", which is
    // more specific than "ask me about everything".
    return { needed: false };
  }

  if (mode === "manual") return { needed: true, because: "manual mode" };
  if (mode === "acceptEdits" || mode === "plan") return { needed: false };

  // A skill becomes a slash command and a standing instruction to the model, so
  // it is asked about wherever it lands — the vault check below would miss one
  // written to ~/.cullus/skills.
  // The destructive-shell and shrinking-overwrite gates that used to be
  // hardcoded here are now the shipped defaults in permissions.ts, consulted
  // above. Same behaviour, in a file the user can read and change.

  if (toolName === "skill_write") {
    const name = typeof (args as any)?.name === "string" ? (args as any).name : null;
    return {
      needed: true,
      because: name
        ? `it saves a new skill, "${name}", runnable as /${name}`
        : "it saves a new skill you will be able to run as a slash command",
    };
  }

  // By name first: our own note writer resolves its own path, so there is nothing
  // in the arguments for the scan below to find.
  if (writesToVaultByName(toolName)) {
    const named = typeof (args as any)?.path === "string" ? (args as any).path : null;
    const title = typeof (args as any)?.title === "string" ? (args as any).title : null;
    return {
      needed: true,
      because: `it writes ${named ?? (title ? `"${title}"` : "a note")} to your vault`,
    };
  }

  // Then by argument, which catches a write arriving through another server —
  // the filesystem one, since the vault usually sits inside a granted directory.
  const vaultTarget = targetsVault(toolName, args);
  if (vaultTarget) return { needed: true, because: `it writes to ${vaultTarget} in your vault` };

  return { needed: false };
}

/**
 * Pull the path and a content preview out of tool arguments, so the prompt shows
 * WHAT is about to be written rather than just a tool name.
 */
function describeWrite(args: unknown): { resolvedPath?: string; preview?: string } {
  if (!args || typeof args !== "object") return {};
  const record = args as Record<string, unknown>;

  const pathish = ["path", "file", "filepath", "target", "note", "filename"]
    .map((key) => record[key])
    .find((value) => typeof value === "string" && value.length > 0) as string | undefined;

  const bodyish = ["content", "text", "body", "replace", "data"]
    .map((key) => record[key])
    .find((value) => typeof value === "string" && value.length > 0) as string | undefined;

  return {
    resolvedPath: pathish ? expandPath(pathish) : undefined,
    preview: bodyish ? bodyish.split("\n").slice(0, 8).join("\n").slice(0, 600) : undefined,
  };
}

/** How long to wait for a human before denying. */
const APPROVAL_TIMEOUT_MS = Number((process.env.CULLUS_APPROVAL_TIMEOUT_MS ?? process.env.ASSISTANT_APPROVAL_TIMEOUT_MS) ?? 300_000);

let handler: ApprovalHandler | null = null;
let counter = 0;

/** Register the surface that will ask the human. Pass null to go back to auto-approve. */
export function setApprovalHandler(next: ApprovalHandler | null): void {
  handler = next;
}

export function hasApprovalHandler(): boolean {
  return handler !== null;
}

/**
 * Ask for permission to run one tool call.
 *
 * Returns approved:true when nothing is listening, so this can be called
 * unconditionally by the loop.
 */
export async function requestApproval(
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
  context?: { because?: string }
): Promise<ApprovalOutcome> {
  if (!handler) return { approved: true };
  if (signal?.aborted) return { approved: false, reason: "the turn was cancelled" };

  const request: ApprovalRequest = {
    id: `ap-${++counter}`,
    toolName,
    args,
    because: context?.because,
    ...describeWrite(args),
  };

  const timeout = new Promise<ApprovalOutcome>((resolve) => {
    setTimeout(
      () => resolve({ approved: false, reason: `nobody answered within ${APPROVAL_TIMEOUT_MS / 1000}s` }),
      APPROVAL_TIMEOUT_MS
    ).unref?.();
  });

  const cancelled = new Promise<ApprovalOutcome>((resolve) => {
    signal?.addEventListener("abort", () => resolve({ approved: false, reason: "the turn was cancelled" }), {
      once: true,
    });
  });

  try {
    return await Promise.race([handler(request), timeout, cancelled]);
  } catch (err: any) {
    // A broken surface must not take the turn down with it.
    return { approved: false, reason: `the approval prompt failed (${err.message})` };
  }
}
