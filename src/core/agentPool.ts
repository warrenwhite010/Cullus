// Parallel worker fan-out: plan → map → reduce.
//
// Why worker count and not model count. Measured on this machine with Ollama:
//
//   qwen3.5:2b × 4 concurrent   2.83 GB resident, 1.64× throughput vs serial
//   qwen3.5:2b × 8 concurrent   2.83 GB resident, 1.75× — the curve is flat
//   qwen3.5:2b + qwen3.5:4b     7.06 GB resident — distinct models are ADDITIVE
//
// One model serving N concurrent requests shares a single copy of the weights, so
// scaling workers is nearly free in memory, while every extra distinct model
// costs its full size. Hence: one model splits the goal and executes the pieces,
// and a bigger model is worth loading only for the planner, where the quality of
// the decomposition actually changes the answer.
//
// Workers run the real tool loop (getAiResponse in isolated mode), so a subtask
// can read files, query the vault, or hit GitHub — the same read-only modes apply.
// Isolation is what makes that safe to do concurrently: each worker owns its
// message array and writes nothing to the session.

import { getAiResponse, AssistantError, type TokenUsage } from "./provider.js";
import { chatJson } from "./ollama.js";
import { setTasks, startTask, setTaskStatus } from "./tasks.js";
import { logActivity } from "./activity.js";

/** Hard ceiling. Past ~4 the throughput curve is flat, so 8 is generous. */
export const MAX_WORKERS = 8;
/**
 * Tool steps a single worker may spend.
 *
 * Was 4, which was the wrong lever: a worker that needed five reads reported
 * failure instead of finishing. Workers keep full tool access — nothing here is
 * tool-free — and get room to actually use it.
 */
const WORKER_STEPS = 16;

/** The reducer has tools too; it rarely needs them, but withholding them cost more. */
const REDUCE_STEPS = 6;

export interface FanOutEvent {
  phase: "plan" | "worker" | "reduce" | "finish";
  status: "running" | "ok" | "warn" | "fail";
  message: string;
  detail?: string;
  /** Which subtask this concerns, when it concerns one. */
  index?: number;
  title?: string;
}

export interface SubtaskResult {
  index: number;
  title: string;
  prompt: string;
  ok: boolean;
  output: string;
  ms: number;
  /**
   * The subtask never ran because the turn was already stopping.
   *
   * Distinct from `ok: false`, which means it ran and failed. Conflating them
   * reported a cancelled run as "Every subtask failed", which reads as five
   * separate errors to debug instead of one Stop press.
   */
  cancelled?: boolean;
}

export interface FanOutResult {
  content: string;
  usage: TokenUsage;
  degraded: string[];
  subtasks: SubtaskResult[];
  workers: number;
  /** Wall-clock of the parallel phase. */
  mapMs: number;
  /**
   * Sum of the individual subtask times. Against mapMs this is the overlap the
   * run ACTUALLY achieved, which is the only speedup figure worth showing: it
   * varies with Ollama's slot count and how much text each worker generates
   * (measured here: ~1.2× on generation-heavy subtasks, ~1.6× on short ones).
   */
  sumMs: number;
}

export interface FanOutOptions {
  goal: string;
  /** Splits the goal and writes the final answer. May be a bigger model. */
  plannerModel: string;
  /** Runs the subtasks. All workers share this one model. */
  workerModel: string;
  workers: number;
  signal?: AbortSignal;
  onEvent?: (event: FanOutEvent) => void;
  onToolExecuted?: (toolName: string, args: any, result: any, subtask: string) => void;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["title", "prompt"],
      },
    },
    reduceHint: { type: "string" },
  },
  required: ["subtasks"],
};

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * Deliberately not Promise.all over everything: Ollama serves a bounded number of
 * slots (OLLAMA_NUM_PARALLEL) and the rest queue inside it, so firing 30 requests
 * buys nothing and makes cancellation slower. A sliding window keeps exactly
 * `limit` busy.
 */
async function pool<T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runner));
  return results;
}

function addUsage(total: TokenUsage, part: TokenUsage): void {
  total.promptTokens += part.promptTokens;
  total.completionTokens += part.completionTokens;
  total.totalTokens = total.promptTokens + total.completionTokens;
  total.contextLength = Math.max(total.contextLength, part.contextLength);
  total.steps += part.steps;
  // A peak stays a peak across workers — summing it would recreate exactly the
  // sum-over-window confusion the field exists to avoid.
  total.peakPromptTokens = Math.max(total.peakPromptTokens, part.peakPromptTokens);
}

/**
 * Drop a chain-of-thought preamble a reasoning model wrote into its answer.
 *
 * Thinking is disabled for isolated turns, which fixes the common case; this
 * catches models that narrate anyway. Only trims when a clear answer marker
 * follows, so a legitimate answer is never truncated.
 */
export function stripReasoningPreamble(text: string): string {
  const marker = /^\s*(thinking process|let me think|reasoning|analysis)\s*:?\s*$/im;
  if (!marker.test(text)) return text;

  const answerMarker = text.match(/^\s*(final answer|answer|final output|result)\s*:?\s*$/im);
  if (answerMarker?.index !== undefined) {
    const after = text.slice(answerMarker.index + answerMarker[0].length).trim();
    if (after.length > 40) return after;
  }

  // No marker to cut at: leave it intact rather than guessing where the answer
  // starts. Showing a verbose answer beats showing half of one.
  return text;
}

/**
 * Is this goal a single compiler diagnostic?
 *
 * Splitting one across parallel workers is strictly worse than not splitting it.
 * Measured on `Assets/Scripts/StormSky.cs(71,37): error CS0103: The name
 * 'RenderQueue' does not exist in the current context`: the planner produced five
 * subtasks, four of which independently read the same file and grepped for the
 * same symbol, and the run took 23 minutes to reach a one-line answer that needed
 * no tool call at all.
 *
 * There is nothing to parallelise here. A diagnostic names one file, one line and
 * one symbol — the work is a lookup, and every worker does the same lookup.
 */
/**
 * A checklist line for a goal that was never split into named subtasks.
 *
 * Kept short and literal — this appears in the sidebar and as the prefix on every
 * tool row in the activity log, so it has to fit on one line.
 */
function taskTitle(goal: string): string {
  const firstLine = String(goal ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return "The whole goal";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function isSingleDiagnostic(goal: string): boolean {
  const text = String(goal ?? "");

  // More than one distinct file:line means there really is more than one
  // problem, and splitting those is legitimate.
  const sites = new Set(
    Array.from(text.matchAll(/([\w./\\-]+\.(?:cs|ts|tsx|js|py|go|rs|java|cpp|h))\((\d+),\d+\)/g)).map(
      (m) => `${m[1]}:${m[2]}`
    )
  );
  if (sites.size !== 1) return false;

  // C# (CS0103), TypeScript (TS2304), and the gcc/clang/rustc shapes.
  return /\b(?:error|warning)\s+(?:[A-Z]{2}\d{3,5}|\[?E\d{4}\]?)\b/.test(text) ||
    /:\s*(?:fatal\s+)?error:/.test(text);
}

/**
 * Run the goal once, and report it in the shape a fan-out would have.
 *
 * The caller and the UI already understand FanOutResult, so a goal that turns
 * out not to be splittable does not need a second code path through the socket
 * layer — it just comes back as a one-subtask run with an honest `workers: 1`.
 */
async function runSingleTask(
  goal: string,
  options: FanOutOptions,
  usage: TokenUsage,
  degraded: string[],
  emit: (event: FanOutEvent) => void,
  requestedWorkers: number
): Promise<FanOutResult> {
  // Name the task after the goal, not after the fact that there is one.
  //
  // "The whole goal" was a placeholder that reached the checklist and every tool
  // row in the activity log ("The whole goal · path=Assets/Scripts/StormSky.cs"),
  // where it told the reader nothing at all. The goal's own first line is both
  // available and informative.
  const title = taskTitle(goal);
  const started = Date.now();

  setTasks([{ subject: title, activeForm: title }], "chat");
  startTask(title);
  emit({ phase: "worker", status: "running", message: title, index: 0, title });

  try {
    const result = await getAiResponse(
      goal,
      options.workerModel,
      options.signal,
      (toolName, args, toolResult) => options.onToolExecuted?.(toolName, args, toolResult, title),
      { isolated: true, maxSteps: WORKER_STEPS }
    );

    addUsage(usage, result.usage);
    degraded.push(...result.degraded);
    setTaskStatus(title, "done");

    const ms = Date.now() - started;
    emit({ phase: "worker", status: "ok", message: `done in ${(ms / 1000).toFixed(1)}s`, index: 0, title });
    emit({
      phase: "finish",
      status: "ok",
      message: `Answered directly — ${requestedWorkers} worker(s) would not have helped`,
    });

    return {
      content: stripReasoningPreamble(result.content),
      usage,
      degraded,
      subtasks: [{ index: 0, title, prompt: goal, ok: true, output: result.content, ms }],
      workers: 1,
      mapMs: ms,
      sumMs: ms,
    };
  } catch (err: any) {
    setTaskStatus(title, "failed");
    const cancelled = options.signal?.aborted === true;
    const message = err instanceof AssistantError && err.hint ? `${err.message} (${err.hint})` : err.message;

    emit({
      phase: "finish",
      status: cancelled ? "warn" : "fail",
      message: cancelled ? "Stopped before it finished." : message,
    });
    degraded.push(message);

    return {
      content: message,
      usage,
      degraded,
      subtasks: [
        { index: 0, title, prompt: goal, ok: false, output: message, ms: Date.now() - started, cancelled },
      ],
      workers: 1,
      mapMs: Date.now() - started,
      sumMs: Date.now() - started,
    };
  }
}

export async function runFanOut(options: FanOutOptions): Promise<FanOutResult> {
  const { goal, plannerModel, workerModel, signal } = options;
  const workers = Math.min(Math.max(Math.floor(options.workers) || 1, 1), MAX_WORKERS);

  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextLength: 0,
    steps: 0,
    peakPromptTokens: 0,
  };
  const degraded: string[] = [];
  const emit = (event: FanOutEvent) => {
    logActivity({
      kind: event.phase === "worker" ? "worker" : "fix",
      status: event.status,
      label: event.title ? `${event.phase}: ${event.title}` : event.phase,
      // The title is already in the label. Emitting it as the summary too
      // rendered as "worker: The whole goal The whole goal" — the same string
      // twice on one line, which read like a bug because it was one.
      summary: event.message === event.title ? undefined : event.message,
      detail: event.detail,
    });
    options.onEvent?.(event);
  };

  // ---- Plan --------------------------------------------------------------

  // Some goals are not splittable, and paying a planner round-trip to discover
  // that costs more than the whole answer is worth. A compiler diagnostic is the
  // clearest case: see isSingleDiagnostic.
  if (isSingleDiagnostic(goal)) {
    emit({
      phase: "plan",
      status: "warn",
      message: "One compiler error — running as a single task, not a fan-out.",
      detail:
        "A diagnostic names one file, one line and one symbol. Split across workers, each " +
        "one repeats the same lookup, so the run is slower than a normal turn and no more " +
        "accurate. For Unity errors, unity_symbol answers CS0103/CS0246 directly.",
    });

    const single = await runSingleTask(goal, options, usage, degraded, emit, workers);
    return single;
  }

  emit({ phase: "plan", status: "running", message: `Splitting the goal for ${workers} worker(s)` });

  const planned = await chatJson<{ subtasks: Array<{ title: string; prompt: string }>; reduceHint?: string }>(
    plannerModel,
    "You split a goal into independent subtasks for parallel workers. Answer with JSON only.",
    `Goal: ${goal}\n\n` +
      `Split this into between 2 and ${workers * 2} subtasks that can run AT THE SAME TIME.\n` +
      `Rules:\n` +
      `1. Workers cannot see each other's work, so no subtask may depend on another's output.\n` +
      `2. Each prompt must be self-contained: restate whatever context the worker needs.\n` +
      `3. Each subtask must be genuinely different work, not the same question reworded.\n` +
      `4. Workers have tools for reading files, searching the web and querying the vault.\n\n` +
      `Return {"subtasks":[{"title":"<short label>","prompt":"<the full instruction>"}],"reduceHint":"<how to combine the results>"}`,
    PLAN_SCHEMA,
    (value) => {
      if (!Array.isArray(value?.subtasks) || value.subtasks.length === 0) {
        return "subtasks must be a non-empty array";
      }
      for (const task of value.subtasks) {
        if (!task?.title?.trim() || !task?.prompt?.trim()) {
          return "every subtask needs a non-empty title and prompt";
        }
      }
      return null;
    },
    signal
  );

  // A planner that cannot produce a split is not a dead end: run the goal as a
  // single subtask, which is exactly a normal turn, and say so.
  let subtasks: Array<{ title: string; prompt: string }>;
  let reduceHint = "";

  if (planned.ok && planned.value) {
    subtasks = planned.value.subtasks.slice(0, workers * 2);
    reduceHint = planned.value.reduceHint ?? "";
    emit({
      phase: "plan",
      status: "ok",
      message: `${subtasks.length} subtask(s)`,
      detail: subtasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n"),
    });
  } else {
    subtasks = [{ title: taskTitle(goal), prompt: goal }];
    degraded.push(
      `${plannerModel} could not split the goal (${planned.error}), so it ran as a single task.`
    );
    emit({ phase: "plan", status: "warn", message: `Could not split the goal: ${planned.error}` });
  }

  // The checklist and startTask/setTaskStatus key on the title, so two subtasks
  // sharing one — which planners do produce, especially when they have split a
  // goal badly — mark each other done and the sidebar shows the wrong state.
  // Disambiguate before anything downstream sees them.
  {
    const used = new Map<string, number>();
    subtasks = subtasks.map((task) => {
      const seen = used.get(task.title) ?? 0;
      used.set(task.title, seen + 1);
      return seen === 0 ? task : { ...task, title: `${task.title} (${seen + 1})` };
    });
  }

  setTasks(
    subtasks.map((task) => ({ subject: task.title, activeForm: task.title })),
    "chat"
  );

  // ---- Map ---------------------------------------------------------------
  const started = Date.now();

  const results = await pool<SubtaskResult>(
    workers,
    subtasks.map((task, index) => async () => {
      if (signal?.aborted) {
        return {
          index,
          title: task.title,
          prompt: task.prompt,
          ok: false,
          cancelled: true,
          output: "Cancelled before it started.",
          ms: 0,
        };
      }

      const began = Date.now();
      startTask(task.title);
      emit({ phase: "worker", status: "running", message: task.title, index, title: task.title });

      try {
        const result = await getAiResponse(
          task.prompt,
          workerModel,
          signal,
          (toolName, args, toolResult) => options.onToolExecuted?.(toolName, args, toolResult, task.title),
          {
            isolated: true,
            maxSteps: WORKER_STEPS,
            systemExtra:
              `You are one of ${workers} parallel workers. Your job is ONLY this subtask: ` +
              `${task.title}.\n` +
              `Use a tool ONLY if you need information you do not already have. If you can answer ` +
              `from what you know, answer immediately — do not call a tool first.\n` +
              `Your reply IS the deliverable: findings only, no preamble, no offer to help further. ` +
              `If you cannot complete it, say exactly what blocked you.`,
          }
        );

        addUsage(usage, result.usage);
        degraded.push(...result.degraded.map((note) => `${task.title}: ${note}`));
        setTaskStatus(task.title, "done");

        const ms = Date.now() - began;
        emit({
          phase: "worker",
          status: "ok",
          message: `${task.title} — done in ${(ms / 1000).toFixed(1)}s`,
          index,
          title: task.title,
        });

        return { index, title: task.title, prompt: task.prompt, ok: true, output: result.content, ms };
      } catch (err: any) {
        // One worker failing must never lose the others' work.
        setTaskStatus(task.title, "failed");
        const message = err instanceof AssistantError && err.hint ? `${err.message} (${err.hint})` : err.message;

        emit({ phase: "worker", status: "fail", message: `${task.title} — ${message}`, index, title: task.title });
        degraded.push(`${task.title} failed: ${message}`);

        return {
          index,
          title: task.title,
          prompt: task.prompt,
          ok: false,
          cancelled: signal?.aborted === true,
          output: message,
          ms: Date.now() - began,
        };
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok && !r.cancelled);
  const cancelled = results.filter((r) => r.cancelled);
  const mapMs = Date.now() - started;
  const sumMs = results.reduce((total, r) => total + r.ms, 0);
  const overlap = mapMs > 0 ? sumMs / mapMs : 1;

  emit({
    phase: "worker",
    status: failed.length === 0 ? "ok" : "warn",
    message:
      `${ok.length}/${results.length} subtask(s) in ${(mapMs / 1000).toFixed(1)}s ` +
      (cancelled.length > 0 ? `(${cancelled.length} cancelled) ` : "") +
      `across ${workers} worker(s) — ${overlap.toFixed(2)}× faster than one at a time`,
    detail:
      `sum of subtask times: ${(sumMs / 1000).toFixed(1)}s\n` +
      `wall clock: ${(mapMs / 1000).toFixed(1)}s\n` +
      // A cancelled run has no meaningful speedup figure — every unstarted
      // subtask returns in 0 ms, which drags the ratio to 1.00× and makes a Stop
      // press look like a performance problem. That is exactly how a stale
      // AbortSignal came to be reported as "1.00× faster than one at a time".
      (cancelled.length === results.length
        ? "Every subtask was cancelled before it started: the turn was already stopping when " +
          "the fan-out began. The speedup figure above is meaningless for this run."
        : overlap < 1.3 && workers > 1 && cancelled.length === 0
          ? "Low overlap. Ollama serves a fixed number of slots (OLLAMA_NUM_PARALLEL); " +
            "raise it and restart Ollama to get more from extra workers."
          : ""),
  });

  // Assembled from the parts, used verbatim if the reducer fails. The workers'
  // output is the valuable thing here; losing it to a bad merge is not acceptable.
  const assembled = results
    .map((r) => `## ${r.title}${r.ok ? "" : r.cancelled ? " — CANCELLED" : " — FAILED"}\n\n${r.output}`)
    .join("\n\n");

  if (ok.length === 0) {
    const allCancelled = cancelled.length === results.length;

    emit({
      phase: "finish",
      status: allCancelled ? "warn" : "fail",
      message: allCancelled
        ? "Stopped before any subtask ran."
        : `Every subtask failed${cancelled.length > 0 ? ` (${cancelled.length} cancelled)` : ""}.`,
      detail: allCancelled
        ? "The AbortSignal was already aborted when the map phase started — the previous turn " +
          "or a session reset cancelled it. Nothing was attempted, so there is nothing to debug " +
          "in the subtasks themselves."
        : undefined,
    });

    return {
      content: allCancelled ? "Stopped before any subtask ran." : assembled,
      usage,
      degraded,
      subtasks: results,
      workers,
      mapMs,
      sumMs,
    };
  }

  // ---- Reduce ------------------------------------------------------------
  emit({ phase: "reduce", status: "running", message: "Merging the results" });

  try {
    const reduced = await getAiResponse(
      `Goal: ${goal}\n\n` +
        (reduceHint ? `How to combine: ${reduceHint}\n\n` : "") +
        `Results from ${results.length} parallel workers:\n\n${assembled}\n\n` +
        `Write the final answer now. Rules:\n` +
        `1. Output ONLY the answer. No drafts, no restating these instructions, no thinking aloud.\n` +
        `2. Use only what the results above contain. Invent nothing.\n` +
        `3. One line per finding, naming the subtask it came from.\n` +
        `4. End with a single line listing any subtask that failed, or omit it if none did.`,
      plannerModel,
      signal,
      undefined,
      // Tools stay available: the reducer occasionally needs one more read to
      // reconcile two workers. Thinking is off for isolated turns, which is what
      // actually stopped it narrating instead of answering.
      { isolated: true, maxSteps: REDUCE_STEPS }
    );

    addUsage(usage, reduced.usage);
    emit({ phase: "finish", status: "ok", message: `Answered from ${ok.length} subtask(s)` });

    return {
      content: stripReasoningPreamble(reduced.content),
      usage,
      degraded,
      subtasks: results,
      workers,
      mapMs,
      sumMs,
    };
  } catch (err: any) {
    degraded.push(`The merge step failed (${err.message}); showing each worker's output instead.`);
    emit({ phase: "finish", status: "warn", message: `Merge failed: ${err.message}` });

    return { content: assembled, usage, degraded, subtasks: results, workers, mapMs, sumMs };
  }
}
