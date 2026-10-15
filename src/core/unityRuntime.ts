/**
 * Guards around the Unity Editor's command surface, measured by building two
 * Tron levels through it.
 *
 * Every rule in this file is here because the raw surface let a caller — model
 * or human — believe something false about the Editor. They are grouped as one
 * module rather than scattered through mcpManager because they share a cause:
 * the pipeline reports on the command it ran, not on the state of the thing the
 * caller is actually reasoning about.
 *
 * The four failures, in the order they cost the most time:
 *
 *  1. Play mode does not tick while the Editor is unfocused. A whole playtest
 *     ran against `Time.frameCount == 2`: the probe reported the disc Outbound
 *     at 26 m/s, the enemy alive, the player healthy — a still photograph of
 *     frame 2, sampled eight times over four seconds and read as gameplay. No
 *     command failed, nothing was logged, and every conclusion drawn from it
 *     was wrong.
 *  2. `eval`'s timeout is milliseconds, and a scene build takes longer than any
 *     plausible millisecond value. Passing 120 (seconds, as intended) returned
 *     "Main thread operation timed out after 120ms" — and the code had already
 *     started, so the build ran twice.
 *  3. Files written outside the Editor are invisible until the asset database is
 *     refreshed, and `recompile` answers "No scripts needed recompilation" for
 *     both "your change is compiled" and "your change was never seen". Two
 *     opposite states, one reply.
 *  4. The first call after a domain reload fails with a bare "Network error",
 *     which reads as the Editor being gone rather than as the Editor restarting.
 */

/** Tools whose work is arbitrary code: never silently retried. */
export const UNITY_CODE_TOOLS = new Set(["eval", "eval_file", "run_script"]);

/** Tools that force or report a compile. */
export const UNITY_COMPILE_TOOLS = new Set(["recompile", "recompile_status"]);

/** Tools that return Editor console output. */
export const UNITY_CONSOLE_TOOLS = new Set(["get_console_logs", "console"]);

/**
 * Timeout arguments and the smallest value that is plausibly already in
 * milliseconds.
 *
 * A caller writing `timeout: 120` means two minutes, because nobody asks for a
 * tenth of a second. Below the floor the value is read as seconds and scaled,
 * and the caller is told — silently "fixing" an argument teaches nothing and
 * the next call repeats the mistake.
 */
const TIMEOUT_FIELDS: Record<string, number> = {
  timeout: 1000,
  timeout_ms: 1000,
};

export interface TimeoutFix {
  args: any;
  note?: string;
}

export function normaliseUnityTimeout(toolName: string, args: any): TimeoutFix {
  if (!args || typeof args !== "object") return { args };
  if (!UNITY_CODE_TOOLS.has(toolName) && toolName !== "editor_status") return { args };

  const fixed = { ...args };
  const notes: string[] = [];

  for (const [field, floor] of Object.entries(TIMEOUT_FIELDS)) {
    const value = fixed[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (value >= floor) continue;

    fixed[field] = Math.round(value * 1000);
    notes.push(
      `${field} was ${value}, which this command reads as ${value}ms — far too short for ` +
        `anything but a trivial expression. Sent as ${fixed[field]}ms (${value}s). ` +
        `This argument is in MILLISECONDS.`
    );
  }

  return notes.length > 0 ? { args: fixed, note: notes.join(" ") } : { args };
}

/**
 * Did this call fail because the Editor was mid-reload rather than because it
 * is unreachable?
 *
 * Recompiling drops the pipeline's HTTP listener for a second or two. The error
 * is indistinguishable from a dead Editor unless you know a reload just
 * happened, so it is worth exactly one retry.
 */
export function isTransientUnityError(error: unknown): boolean {
  const text = String((error as any)?.message ?? error ?? "");
  return (
    /network error/i.test(text) ||
    /an error occurred while sending the request/i.test(text) ||
    /socket hang up|ECONNRESET|ECONNREFUSED|fetch failed/i.test(text)
  );
}

/**
 * Did a code-running tool time out?
 *
 * The distinction matters because the code kept running. Reporting this as a
 * plain failure invites a retry, and a retried scene build is a scene built
 * twice — which is survivable for an idempotent builder and corrupting for
 * anything that appends.
 */
export function isTimeoutResult(result: any): boolean {
  const text = serialise(result);
  return /timed out after \d+ms|operation timed out|timeout (?:of )?\d+ms exceeded/i.test(text);
}

export function describeCodeTimeout(toolName: string, args: any): Record<string, unknown> {
  const timeout = args?.timeout ?? args?.timeout_ms;
  return {
    error: true,
    mayHaveRun: true,
    message:
      `${toolName} timed out${typeof timeout === "number" ? ` after ${timeout}ms` : ""}, but the ` +
      `code was already executing when the timeout fired. It may have completed, partly ` +
      `completed, or still be running.`,
    actionRequired:
      "Do NOT simply call it again — a second run repeats every side effect the first one had. " +
      "Check the state first (read the scene, the file, or the console), then either raise the " +
      "timeout and re-run only what is missing, or report what you found.",
  };
}

/**
 * Trim stack traces out of console results.
 *
 * Measured: six console entries came back as 8,600 characters, of which 7,400
 * were Unity's own frames — `Internal_CallUpdateFunctions`, the dispatcher, the
 * pipeline server. One console read could consume the entire tool-result budget
 * and push the actual compile error out of the window. The first two frames are
 * where the caller's own code appears; the rest is the engine.
 */
export function condenseUnityConsole(
  toolName: string,
  result: any,
  keepFrames = 2
): { result: any; note?: string } {
  if (!UNITY_CONSOLE_TOOLS.has(toolName)) return { result };

  const envelope = readEnvelope(result);
  if (!envelope) return { result };

  const { parsed, rewrap } = envelope;
  const logs = Array.isArray(parsed?.logs) ? parsed.logs : Array.isArray(parsed) ? parsed : null;
  if (!logs) return { result };

  let dropped = 0;

  for (const entry of logs) {
    const trace = entry?.stackTrace;
    if (typeof trace !== "string" || trace.length === 0) continue;

    const frames = trace.split("\n").filter((line: string) => line.trim().length > 0);
    if (frames.length <= keepFrames) continue;

    dropped += trace.length;
    entry.stackTrace = frames.slice(0, keepFrames).join("\n");
    entry.stackTraceTruncated = `${frames.length - keepFrames} engine frames omitted`;
    dropped -= entry.stackTrace.length;
  }

  if (dropped <= 0) return { result };

  return {
    result: rewrap(parsed),
    note:
      `Stack traces trimmed to their first ${keepFrames} frames; ${dropped.toLocaleString()} ` +
      `characters of engine frames removed. Ask for the full trace only if the first frames ` +
      `do not name the file.`,
  };
}

export interface TickVerdict {
  ticking: boolean;
  frames: number[];
  message: string;
}

/**
 * Turn two or more frame-count samples into a verdict about whether the game is
 * actually running.
 *
 * This is the check whose absence invalidated a whole playtest. It belongs next
 * to `editor_play`, because that is the call after which a caller starts
 * believing that what it reads is gameplay.
 */
export function judgeFrameSamples(samples: number[]): TickVerdict {
  const frames = samples.filter((n) => typeof n === "number" && Number.isFinite(n));

  if (frames.length < 2) {
    return {
      ticking: false,
      frames,
      message:
        "Could not sample Time.frameCount twice, so whether the game is running is unknown. " +
        "Sample it yourself before trusting anything you read from play mode.",
    };
  }

  const advanced = frames[frames.length - 1] - frames[0];
  if (advanced > 0) {
    return {
      ticking: true,
      frames,
      message: `Play mode is ticking: Time.frameCount advanced by ${advanced} between samples.`,
    };
  }

  return {
    ticking: false,
    frames,
    message:
      `PLAY MODE IS FROZEN. Time.frameCount stayed at ${frames[0]} across samples, because the ` +
      `Unity Editor only runs the game loop while its window has focus. Nothing you read from ` +
      `the running game right now is gameplay — it is one still frame, and physics, AI, input ` +
      `and timers are all stopped.\n\nCall editor_focus, then sample Time.frameCount twice again ` +
      `and confirm it moves before drawing any conclusion. If focus cannot be held, drive the ` +
      `scene deterministically instead (call methods directly, step physics yourself) and say ` +
      `plainly that the observation came from a frozen editor.`,
  };
}

/**
 * Should a compile be preceded by an asset-database refresh?
 *
 * Yes, whenever the caller may have written files by any route other than the
 * Editor's own write commands — which, for an automated caller, is most of the
 * time. The refresh is idempotent and costs a fraction of the compile it
 * precedes.
 */
export function needsAssetRefresh(toolName: string): boolean {
  return toolName === "recompile";
}

/** The refresh, as an `eval` payload. */
export function assetRefreshCall(): { name: string; arguments: Record<string, unknown> } {
  return {
    name: "eval",
    arguments: {
      code: "UnityEditor.AssetDatabase.Refresh(); return \"refreshed\";",
      timeout: 60000,
    },
  };
}

/**
 * Annotate an "up_to_date" compile so the two states it conflates can be told
 * apart.
 */
export function annotateCompileResult(toolName: string, result: any, refreshed: boolean): any {
  if (!UNITY_COMPILE_TOOLS.has(toolName)) return result;

  const text = serialise(result);
  if (!/up_to_date|no scripts needed recompilation/i.test(text)) return result;

  const note = refreshed
    ? "The asset database was refreshed immediately before this call, so 'up_to_date' means " +
      "your changes are compiled into the loaded assembly — not that they were missed. " +
      "Verify a specific change by reading back the symbol you added if it matters."
    : "'up_to_date' means the Editor saw nothing to compile. It does NOT confirm your edit is " +
      "live: a file written outside the Editor is invisible until the asset database is " +
      "refreshed, and both states return this same answer. Call eval with " +
      "UnityEditor.AssetDatabase.Refresh() and try again if you edited files by another route.";

  return attachNote(result, note);
}

/** Attach a harness note to a result without disturbing its shape. */
/**
 * Recognise the play-mode refusal and say what to do about it.
 *
 * Unity answers a scene-building command during play mode with "This cannot be
 * used during play mode, please use SceneManager.CreateScene() instead" — advice
 * that is correct for a runtime spawn and useless for an Editor build, which is
 * what the caller was doing. Measured: a local model's `run_script` build failed
 * this way and it spent the rest of its turn editing the builder, looking for a
 * bug in code that was fine. The Editor was in play mode because somebody was
 * playing the game.
 *
 * One line of the right advice — stop play mode, then build — turns a dead end
 * into a two-call recovery.
 */
export function annotatePlayModeRefusal(result: any): any {
  const text = serialise(result);
  if (!/cannot be used during play mode|not (?:be )?allowed (?:while|during) play ?mode/i.test(text)) {
    return result;
  }

  return attachNote(
    result,
    "The Editor is in PLAY MODE, which is why this was refused — the code is not necessarily " +
      "wrong. Unity's own suggestion (SceneManager.CreateScene) applies to spawning a scene at " +
      "runtime, not to building one in the Editor. Call editor_stop, confirm with editor_status " +
      "that playMode is stopped, then re-issue this exact call. Somebody may be playing the " +
      "game, so say what you are doing rather than stopping it silently."
  );
}

export function attachNote(result: any, note: string): any {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const existing = typeof (result as any).harnessNote === "string" ? `${(result as any).harnessNote} ` : "";
    return { ...result, harnessNote: `${existing}${note}` };
  }

  return { value: result, harnessNote: note };
}

function serialise(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Read an MCP text envelope whose payload is itself JSON, and hand back a way to
 * put the modified payload back in the same shape.
 */
function readEnvelope(result: any): { parsed: any; rewrap: (next: any) => any } | null {
  if (!result || typeof result !== "object") return null;

  if (Array.isArray(result.content)) {
    const index = result.content.findIndex((part: any) => part?.type === "text");
    if (index < 0) return null;

    try {
      const parsed = JSON.parse(result.content[index].text);
      return {
        parsed,
        rewrap: (next) => {
          const content = result.content.map((part: any, i: number) =>
            i === index ? { ...part, text: JSON.stringify(next) } : part
          );
          return { ...result, content };
        },
      };
    } catch {
      return null;
    }
  }

  if (Array.isArray(result.logs)) {
    return { parsed: result, rewrap: (next) => next };
  }

  return null;
}
