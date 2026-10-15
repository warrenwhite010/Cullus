// Summarising the middle of a long turn instead of deleting it.
//
// `trimHistoryForSend` drops the oldest messages when the window fills. That is
// lossy by construction, and this session showed what it costs: the model
// established in round 1 that RuntimeInspector.cs was missing
// `using System.Reflection;` — a correct conclusion — and by round 3 no longer
// had it, re-derived it, and got it wrong. Two rounds of work thrown away
// because the only strategy was "forget the beginning".
//
// Compaction replaces those messages with one summary that keeps what was
// established: the task, the facts, what was tried and failed, files touched,
// open questions. Trimming still happens afterwards — this makes what survives
// worth surviving.
//
// Deliberately reuses the isolated-turn machinery agentPool.ts already relies on
// for its reducer, so a compaction is one ordinary local inference with thinking
// off and the session counters untouched.

import { debugLog } from "./session.js";

/** What the reducer is asked to preserve, in priority order. */
const REDUCER_PROMPT =
  `Summarise the work-in-progress below so another agent can pick it up without ` +
  `re-reading any of it.\n\n` +
  `Preserve, in this order of importance:\n` +
  `1. THE TASK — what was asked for, in the user's own terms.\n` +
  `2. ESTABLISHED FACTS — anything proven by a tool result. Quote file paths, line ` +
  `numbers, error codes and identifiers VERBATIM; they are the whole value here and a ` +
  `paraphrased path is useless.\n` +
  `3. DONE — changes already made, and whether each was verified.\n` +
  `4. FAILED — approaches tried that did not work, and why. This is what stops the next ` +
  `agent repeating them.\n` +
  `5. OPEN — what is still unknown or undecided.\n` +
  `6. ENVIRONMENT AT THE TIME — any tool, server or connection that was unavailable, and ` +
  `the time it was unavailable. Write these as point-in-time observations, never as ` +
  `properties of the world: "unity_compile could not reach the Editor at 127.0.0.1:7800 ` +
  `on those attempts", NOT "there is no Editor access". An unreachable service may be ` +
  `running by the time anyone reads this, and a capability recorded as absent is one ` +
  `nobody tries again.\n\n` +
  `Rules: invent nothing. Do not speculate about causes that were not established. Do ` +
  `not offer next steps or opinions. If something was uncertain, say it was uncertain ` +
  `rather than resolving it. Never promote a tool failure into a limitation of the ` +
  `toolset — a tool that errored is a tool that errored, not a tool that does not exist. ` +
  `Use short headed lists, no prose paragraphs. Call no tools — everything you need is ` +
  `in the text.`;

/**
 * How much of the window has to be used before compacting.
 *
 * Below this, trimming is not yet hurting and a compaction would be a local
 * inference spent for nothing.
 */
export const DEFAULT_COMPACT_AT = 0.7;

/**
 * Messages never eligible for compaction, counted back from the end.
 *
 * The recent tail is what the model is actively working from — summarising the
 * tool result it received two steps ago would be actively destructive. The
 * system prompt and the current request are protected separately by the caller.
 */
const KEEP_RECENT = 12;

/**
 * The shape of a model emitting a tool call, as opposed to describing one.
 *
 * Matched against the reducer's OUTPUT only — see the rejection site. Kept tight
 * on purpose: `renderForReducer` puts `[assistant called: name]` and `[result of
 * name]` into the input, and a summary that quotes either is doing its job.
 * These patterns are the formats models actually emit when they think they are
 * calling something.
 */
const FABRICATED_CALL =
  /\[tool[ _]call\b|<\s*tool_call\s*>|<\s*function_call\s*>|^\s*arguments\s*:\s*[{[]|```\s*(?:tool_call|json)?\s*\n\s*\{\s*"(?:name|tool|function)"\s*:/im;

export interface CompactionPlan {
  /** Index into `history` where compactable messages start (after the system prompt). */
  from: number;
  /** Exclusive end index. */
  to: number;
  /** The messages that would be replaced. */
  slice: any[];
}

/**
 * Which messages are worth compacting, or null when none are.
 *
 * Never touches the system prompt, the most recent real user message (that is
 * the task), or the last KEEP_RECENT messages. Requires a clean boundary so the
 * summary never replaces half of a tool cycle: cutting between an assistant's
 * tool_calls and its replies leaves an orphan, the same shape
 * `trimHistoryForSend` goes out of its way to avoid.
 */
export function planCompaction(history: any[]): CompactionPlan | null {
  if (history.length < KEEP_RECENT + 8) return null;

  // Anything from index 1 (past the system prompt) up to the protected tail.
  let from = 1;
  let to = history.length - KEEP_RECENT;
  if (to <= from) return null;

  // Never compact away a real user message.
  //
  // Move the START past the newest one rather than pulling the END back to it.
  // The task is almost always the first message after the system prompt, so
  // clamping `to` to its index collapsed the range to nothing and compaction
  // never fired at all — it returned null on a 62-message turn. Moving `from`
  // keeps the request and compacts the tool traffic that follows it, which is
  // the bulk and the part worth summarising.
  const lastRealUser = history.reduce(
    (found, message, index) =>
      index < to && message?.role === "user" && message?.synthetic !== true ? index : found,
    -1
  );
  if (lastRealUser >= from) from = lastRealUser + 1;
  if (to <= from) return null;

  // End on a clean boundary: not mid tool-cycle.
  while (to > from && (history[to]?.role === "tool" || history[to - 1]?.role === "assistant" && Array.isArray(history[to - 1]?.tool_calls))) {
    to--;
  }
  // Start on one too.
  while (from < to && history[from]?.role === "tool") from++;

  if (to - from < 6) return null;

  return { from, to, slice: history.slice(from, to) };
}

/** Flatten a slice into the plain text the reducer reads. */
export function renderForReducer(slice: any[]): string {
  const lines: string[] = [];

  for (const message of slice) {
    const role = message?.role ?? "unknown";
    const content =
      typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");

    if (role === "assistant" && Array.isArray(message?.tool_calls)) {
      const named = message.tool_calls
        .map((call: any) => call?.function?.name)
        .filter(Boolean)
        .join(", ");
      lines.push(`[assistant called: ${named}]${content ? `\n${content}` : ""}`);
      continue;
    }

    const label = role === "tool" ? `[result of ${message?.tool_name ?? "a tool"}]` : `[${role}]`;
    lines.push(`${label}\n${content}`);
  }

  return lines.join("\n\n");
}

export interface CompactionResult {
  history: any[];
  summary: string;
  replaced: number;
}

/**
 * Replace the compactable middle of `history` with one summary message.
 *
 * `summarise` is injected rather than imported so this stays testable without
 * Ollama — and so provider.ts keeps ownership of what an isolated turn means.
 * Returns null when there is nothing to do, or when the summary comes back
 * empty: a failed compaction must leave the conversation exactly as it was
 * rather than half-replacing it.
 */
export async function compactHistory(
  history: any[],
  summarise: (text: string, instruction: string) => Promise<string>
): Promise<CompactionResult | null> {
  const plan = planCompaction(history);
  if (!plan) return null;

  const rendered = renderForReducer(plan.slice);
  if (rendered.trim().length === 0) return null;

  let summary = "";
  try {
    summary = (await summarise(rendered, REDUCER_PROMPT)).trim();
  } catch (err: any) {
    debugLog("compaction-failed", { reason: String(err?.message ?? err) });
    return null;
  }

  // An empty or trivially short summary means the reducer did not do the job.
  // Keeping the original messages is strictly better than replacing 40 of them
  // with three words.
  if (summary.length < 40) {
    debugLog("compaction-rejected", { characters: summary.length });
    return null;
  }

  // A summary that contains tool calls is not a summary.
  //
  // This is the guard for the worst thing compaction can do. Handed a rendered
  // transcript, a reducer that decides to CONTINUE it instead of describing it
  // emits the next turn — and because its output is spliced into history as the
  // established record of what happened, those invented calls become facts the
  // agent then reasons from. Observed twice in five minutes on one run:
  //
  //   [tool call: create_gameobject
  //     arguments: {"name": "PlayerBike", ...}]
  //
  // neither of which ever executed. The agent read them, concluded the work was
  // still ahead of it, and redid two tasks its own checklist recorded as done.
  //
  // Rejecting costs one wasted inference and leaves the real messages in place,
  // which is strictly better than replacing them with fiction. Deliberately
  // narrow: renderForReducer writes `[assistant called: x]` and `[result of x]`
  // into the INPUT, so a summary legitimately quoting those shapes must not trip
  // this. What is matched is the model's own call syntax.
  if (FABRICATED_CALL.test(summary)) {
    debugLog("compaction-rejected", {
      reason: "the summary contains tool calls, so the reducer continued the transcript instead of summarising it",
      characters: summary.length,
    });
    return null;
  }

  const marker = {
    role: "system",
    // Synthetic so it can never be mistaken for something the user said, and so
    // trimHistoryForSend will not anchor to it.
    synthetic: true,
    // "Treat every fact as established and do not redo the steps" was the whole
    // instruction, and it is right about findings and badly wrong about
    // infrastructure. A run recorded "cannot connect to the Unity Editor
    // Pipeline server" while the Editor was closed; the user then opened the
    // Editor and said so; and the model, holding a summary that stated the
    // capability was absent and that it should not redo what the summary
    // described, spent nine rounds explaining that the task was impossible —
    // while the same tools succeeded whenever it did try them.
    //
    // So the exemption is explicit: findings stand, environment does not.
    content:
      `[${plan.slice.length} earlier messages from this turn were summarised to fit the ` +
      `context window. This is the record of that work — treat the findings in it as ` +
      `established and do not redo the steps it describes.\n\n` +
      `One exception, and it matters: anything in here about a tool, server or ` +
      `connection FAILING describes how things were at that moment, not how they are ` +
      `now. A service that was unreachable may be running; the user may have started it ` +
      `since, and may have told you so. Never conclude from this summary that you lack a ` +
      `capability — if a tool is in your list, it exists, and the only way to find out ` +
      `whether it works now is to call it. Retrying a tool costs one step; refusing a ` +
      `task that is actually possible costs the user the whole job.]\n\n${summary}`,
  };

  const next = [...history.slice(0, plan.from), marker, ...history.slice(plan.to)];

  debugLog("compaction-applied", {
    replaced: plan.slice.length,
    summaryCharacters: summary.length,
    before: history.length,
    after: next.length,
  });

  return { history: next, summary, replaced: plan.slice.length };
}
