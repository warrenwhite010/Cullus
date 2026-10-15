// Per-session behaviour switches driven by slash commands.
//
// These are deliberately in-memory and NOT persisted: they shape how the current
// conversation behaves, and silently carrying "read-write plan mode with a goal"
// into tomorrow's session would be surprising. Vault mode and model choice are
// the persisted settings; these are not.

import { EventEmitter } from "events";
import { redactSecrets } from "./secrets.js";
import { setEditsAccepted } from "./config.js";

export type EffortLevel = "low" | "medium" | "high";
export type OutputStyle = "default" | "adhd";

/**
 * How much polish to build to — a different question from how hard to think.
 *
 * `/effort` sets the model's budget: thinking, generation cap, tool steps. This
 * sets the standard the output is held to. They are genuinely orthogonal, and
 * the combination that proves it is "spend thirty steps making grey cubes move
 * really well" — high effort, low fidelity, and a completely reasonable way to
 * prototype a game.
 */
export type FidelityLevel = "blockout" | "playable" | "production";

export interface EffortProfile {
  /** Ask reasoning-capable models to think before answering. */
  think: boolean;
  /** Cap on generated tokens; -1 means the model's own default. */
  numPredict: number;
  /**
   * The generation allowance assumed when SIZING the context window, which is a
   * different question from the cap above.
   *
   * These were one number, and that coupling made the cap unraisable. A
   * whole-file write goes out as a JSON string tool argument: 16 KB of C#, once
   * newlines and quotes are escaped, needs well past 4,096 output tokens. At the
   * old medium cap generation stopped mid-string and llama-server rejected the
   * step with "unexpected end of JSON input" — observed four times in one
   * session, always on write_text_file, never on a small call.
   *
   * Raising numPredict alone would have fixed that and quietly cost memory:
   * chooseContextWindow used it as headroom, so a 16k cap pushes every turn into
   * a larger bucket and num_ctx is what allocates the KV cache (measured on
   * qwen3.5:2b: 8k → 2.47 GB resident, 200k → 5.23 GB). The turn that needs a
   * big generation is rare; paying its KV cost on every "hi" is not worth it.
   *
   * So: numPredict is the ceiling a rare big write is allowed to reach, and this
   * is the typical answer we size the window for. num_predict is a cap, not a
   * reservation — nothing is spent until the model actually generates it.
   */
  sizingHeadroom: number;
  /** Max tool round-trips allowed for one turn. */
  maxSteps: number;
  description: string;
}

const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  low: {
    think: false,
    numPredict: 1024,
    sizingHeadroom: 1024,
    maxSteps: 6,
    description: "No thinking, short answers, 6 tool steps. Fastest; best for lookups.",
  },
  medium: {
    think: false,
    numPredict: 16_384,
    sizingHeadroom: 4096,
    maxSteps: 15,
    description: "No thinking, normal answers, 15 tool steps. The default.",
  },
  high: {
    think: true,
    numPredict: -1,
    sizingHeadroom: 4096,
    maxSteps: 30,
    description:
      "Thinking enabled, unlimited length, 30 tool steps. Slow on local models but much better at multi-step work.",
  },
};

export interface FidelityProfile {
  /** One line for the /fidelity table. Written for a person. */
  description: string;
  /** The block appended to the system prompt. Written for the model. */
  guidance: string;
  /**
   * A short restatement carried next to the user's request every step, or "" to
   * carry nothing.
   *
   * The system-prompt block competes with roughly two thousand tokens of other
   * instructions — base prompt, capabilities, vault context, goal, continuation
   * protocol, effort — and small models weight the user turn far above any of
   * it. Fifteen tokens beside the actual request outpull a paragraph that far
   * upstream. See anchorRequest in provider.ts for where this lands.
   *
   * Empty for the default level on purpose: the anchor exists to correct drift
   * towards the middle, and tagging every ordinary turn with the setting it
   * already has is pure noise.
   */
  anchor: string;
}

/**
 * The three standards of work, and the text that expresses each.
 *
 * EVERY LEVEL SPEAKS, INCLUDING THE DEFAULT. That is deliberate and it is the
 * decision most likely to be undone by a well-meaning pass trying to save
 * tokens, so: effort can leave `medium` silent because effort has a second
 * channel — numPredict, sizingHeadroom, maxSteps and think all still bite at
 * medium, and the prompt text is a garnish on a dial that already works.
 * Fidelity has exactly one channel. Silencing the default silences the default
 * entirely, which breaks the feature in two ways at once: `playable` stops
 * meaning "tuned, playable, no TODOs on the main path" and starts meaning
 * "whatever the model felt like", and coming down from `production` REMOVES
 * instructions rather than replacing them — a dial that visibly moves and
 * behaviourally does not.
 *
 * Each block opens by scoping itself to building work, so a turn that is just
 * answering a question does not read Unity advice as a task.
 */
const FIDELITY_PROFILES: Record<FidelityLevel, FidelityProfile> = {
  blockout: {
    description: "Crudest thing that demonstrates the idea. Primitives, no polish. Fastest to a demo.",
    guidance:
      "BUILD FIDELITY — BLOCKOUT. When you build or change something: make the crudest thing " +
      "that demonstrates the idea, then stop.\n" +
      "- Primitives, defaults and hard-coded values. In Unity: cubes and capsules, the default " +
      "material, no lighting or effects. Elsewhere: no styling, plain output.\n" +
      "- Happy path only. No validation, no options, no tests.\n" +
      "- Fewest files possible. No abstractions, no config.\n" +
      "- Name in one line what you deliberately left out, then do not go back and add it.\n" +
      "None of this excuses shipping something broken: what you do build must run.",
    anchor: "fidelity: blockout — crudest version that works, then stop",
  },
  playable: {
    description: "Placeholder art, real feel. Tuned movement, visible feedback, no TODOs on the main path.",
    guidance:
      "BUILD FIDELITY — PLAYABLE. When you build or change something: make it genuinely usable, " +
      "not pretty.\n" +
      "- Placeholder art stays. Primitives, default materials and plain styling are fine; do not " +
      "spend the turn on looks.\n" +
      "- Spend it on feel instead. Tune the numbers until the thing behaves well — in Unity: " +
      "speed, acceleration, gravity, jump height — and give visible feedback for every action " +
      "and state change.\n" +
      "- Handle the failures that will actually happen (a missing reference, empty input) with a " +
      "clear message rather than a crash.\n" +
      "- Leave no TODO on the path the user will actually exercise.",
    anchor: "",
  },
  production: {
    description: "Ship quality. Real assets, full mechanics, edge cases, no placeholders.",
    guidance:
      "BUILD FIDELITY — PRODUCTION. When you build or change something: ship quality, no " +
      "placeholders anywhere.\n" +
      "- Real assets and real structure. In Unity: proper materials, prefabs, lighting and an " +
      "organised hierarchy. Elsewhere: real styling, real data, a sensible layout.\n" +
      "- Implement the mechanic fully, including the cases the user did not name, and cover the " +
      "edge cases.\n" +
      "- Nothing hard-coded that should be configurable. No debug logging, dead code or stubs " +
      "left behind.\n" +
      "- Expect this to take several turns. Do not cut scope to finish in one.",
    anchor: "fidelity: production — ship quality, no placeholders, several turns is fine",
  },
};

/**
 * The valid levels, derived from the profiles rather than restated.
 *
 * server.ts validates against this. The existing effort check hard-codes
 * ["low","medium","high"] in the HTTP handler, which is a second copy of a list
 * that already exists — exactly the shape that goes stale the day a fourth
 * level is added. Not copying that here.
 */
export const FIDELITY_LEVELS = Object.keys(FIDELITY_PROFILES) as FidelityLevel[];

/**
 * Hard ceiling on tool steps for one turn.
 *
 * Raised from 14: the old cap was the binding constraint on real work, and
 * running out of steps is far more annoying than a turn that takes longer. The
 * repetition guard and the "one step left" warning are what actually stop a
 * looping model, not this number.
 */
export const MAX_TOOL_STEPS = 40;

/**
 * How the model says "I am not finished".
 *
 * A marker rather than a heuristic on the prose: "next I will…" appears in plenty
 * of finished answers, and resuming a completed turn wastes a whole local
 * inference. The model is told to emit this only when work genuinely remains, so
 * a false positive costs one extra turn and a false negative costs nothing worse
 * than the old behaviour — the user types "continue".
 */
export const CONTINUE_MARKER = "[[CONTINUE]]";

/**
 * A "next step" that is really a statement that there is no next step.
 *
 * The marker is supposed to carry the single next concrete action, and whatever
 * follows it becomes the LITERAL prompt for the following round — decideContinuation
 * writes it into "Continue. Your previous turn ended with [[CONTINUE]] <stated>",
 * and anchorRequest then restates that as the task. So a model that emits
 * `[[CONTINUE]] Task complete, all functionality implemented` has just made
 * "Task complete" the instruction it will be given next, which it answers by
 * asserting completion, which it emits with the marker again.
 *
 * That loop ran nine rounds. Every round's continuation summary read "next: Task
 * complete all required functionality implemented and documented. System ready
 * for manual implementation by user in Unity Editor. Cannot…" — a completion
 * claim and an impossibility claim, being handed back as the work to do.
 *
 * Matching prose is normally the wrong instinct, and it is the right one here:
 * these are not next steps under any reading, and the cost of treating one as a
 * step is a self-reinforcing loop rather than a wasted turn.
 */
/**
 * The discriminator is grammatical, and getting it wrong is worse than not
 * checking.
 *
 * "Complete the trail renderer setup on the bike" is a perfectly good next step
 * and an earlier version of this pattern rejected it, which would have stopped
 * legitimate work — a strictly worse failure than the loop being prevented. The
 * difference is that a completion CLAIM has a subject before the word ("task
 * complete", "the system is functionally complete") while an INSTRUCTION has an
 * object after it ("complete the setup"). So a subject is required; the bare
 * imperative never matches.
 */
const NOT_A_NEXT_STEP = new RegExp(
  [
    // Subject + (is/has been) + optional adverb + completion adjective.
    String.raw`^(?:the\s+)?(?:task|tasks|work|system|implementation|feature|scene|everything|it|this|all\s+\w+)\s+(?:is\s+|are\s+|has\s+been\s+|have\s+been\s+|was\s+|were\s+)?(?:\w+ly\s+)?(?:complete|completed|done|finished|implemented)\b`,
    // Impossibility, which loops exactly as hard as false completion.
    String.raw`^(?:the\s+)?(?:task|work|it|this)?\s*(?:cannot|can(?:'|’)?t|could\s+not|unable\s+to)\s+(?:be\s+)?(?:complete|completed|done|performed|fulfilled|proceed)\b`,
    String.raw`^nothing\s+(?:further|more|else|left)\b`,
    String.raw`^no\s+(?:further|more|remaining|additional)\s+(?:steps?|work|actions?|changes?)\b`,
    String.raw`^already\s+(?:complete|completed|done|finished|implemented)\b`,
    // The abdication shape: handing the remaining work back to the user while
    // still asking to be resumed.
    String.raw`^(?:system\s+|project\s+)?ready\s+for\s+manual\b`,
    String.raw`^requires?\s+manual\s+(?:implementation|intervention|steps?)\b`,
  ].join("|"),
  "i"
);

/**
 * Does this answer ask to be resumed? Returns the stated next step, or null.
 *
 * Tolerates the shapes small models actually produce: bold, bulleted, fenced, or
 * with the marker restated mid-sentence. Only the last few lines are considered,
 * so a marker quoted while *explaining* the protocol earlier in the answer does
 * not trigger a resume.
 *
 * Returns null when the "step" is a completion or impossibility claim — see
 * NOT_A_NEXT_STEP. The model saying "continue: I am finished" means finished,
 * and taking it at its word on the marker rather than the sentence is how a
 * twelve-round loop starts.
 */
export function parseContinuation(content: string): string | null {
  const lines = content.trimEnd().split("\n");
  for (const raw of lines.slice(-4).reverse()) {
    const line = raw.replace(/[*_`>\-\s]+/g, " ").trim();
    const at = line.indexOf(CONTINUE_MARKER);
    if (at === -1) continue;
    const rest = line.slice(at + CONTINUE_MARKER.length).replace(/^[:\-–\s]+/, "").trim();

    // "Continue: I'm done" is not a continuation. Stop rather than hand the
    // claim back as the next round's task.
    if (NOT_A_NEXT_STEP.test(rest)) return null;

    return rest.length > 0 ? rest : "the next step you named";
  }
  return null;
}

/**
 * Did this auto-continue round discover anything?
 *
 * A round that made several tool calls and not one of them new has, by
 * definition, learned nothing: it re-read files it had already read and re-ran
 * commands it had already run. The in-turn repeat guard cannot see this, because
 * its record of attempted calls is rebuilt inside each turn — so a round that
 * repeats the previous round's work looks, to that guard, like a series of
 * perfectly reasonable first-time calls.
 *
 * Observed on a twelve-round run: rounds 5 through 8 each re-read the same nine
 * files, produced no edit, and ended asking to continue. Only the round cap
 * stopped it, four rounds later.
 *
 * NO FLOOR ON THE CALL COUNT, and the first version of this had one. It required
 * two or more calls before a round could count as barren, reasoning that a round
 * making no calls had answered from what it already knew. That reasoning was
 * wrong, and the run that proved it spent nine rounds on the worst possible
 * shape: zero tool calls, a flat refusal, and a continuation marker. Round after
 * round of "I cannot do this with my available tools", each one asking to be
 * resumed, each one exempt from the check because it had done nothing at all.
 *
 * The exemption was reasoning about the wrong situation. A round that genuinely
 * answers from what it has does not ask to continue — and this predicate is only
 * consulted AFTER the continuation has been parsed, so by the time we are here
 * the model has already claimed work remains. Zero calls at that point is not
 * thrift, it is a model asserting there is more to do and doing none of it.
 *
 * So the rule is simply: no new calls, no progress. Zero novel covers zero
 * total.
 */
export function isBarrenRound(toolCallsThisRound: number, novelCallsThisRound: number): boolean {
  return novelCallsThisRound === 0;
}

/**
 * Barren rounds tolerated before the run stops.
 *
 * Two rather than one: a round can legitimately spend itself re-verifying state
 * before acting — after an external change, or after the user says they closed
 * an editor — and cutting that off would be worse than the loop it prevents.
 */
export const BARREN_ROUNDS_BEFORE_STOP = 2;

/** Strip the marker line so the user never sees the plumbing. */
export function stripContinuation(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.includes(CONTINUE_MARKER))
    .join("\n")
    .trimEnd();
}

/**
 * How much the model may do without asking.
 *
 * Ordered from least to most autonomous in the shift+tab cycle:
 *   plan        — mutating tools withheld entirely; produce a plan
 *   manual      — every tool call needs approval in the UI
 *   auto        — tools run freely, but read-only servers stay read-only
 *   acceptEdits — tools run freely AND read-only guards are lifted for this session
 */
export type AgentMode = "plan" | "manual" | "auto" | "acceptEdits";

export const MODE_CYCLE: AgentMode[] = ["auto", "manual", "acceptEdits", "plan"];

export const MODE_LABELS: Record<AgentMode, string> = {
  auto: "auto mode on",
  manual: "manual mode",
  acceptEdits: "accept edits on",
  plan: "plan mode on",
};

export const MODE_DETAIL: Record<AgentMode, string> = {
  auto: "Tools run without asking. Read-only servers still refuse writes.",
  manual: "Every tool call waits for your approval.",
  acceptEdits: "Tools run without asking AND read-only guards are lifted for this session.",
  plan: "Mutating tools are withheld. The model produces a plan instead.",
};

export interface SessionSettings {
  effort: EffortLevel;
  /** Autonomy level; cycled with shift+tab in the composer. */
  mode: AgentMode;
  /** Per-turn tool-step override, when the user wants more than the effort profile. */
  maxSteps: number | null;
  /** A standing objective the model must satisfy before it stops. */
  goal: string | null;
  /** Stream raw request/response detail to the UI. */
  debug: boolean;
  outputStyle: OutputStyle;
  /** How much polish to build to. Orthogonal to effort — see FidelityLevel. */
  fidelity: FidelityLevel;
  /** Plan-first mode: no mutating tools, produce a plan for approval. */
  planMode: boolean;
  /** The most recent plan the model produced in plan mode. */
  plan: string | null;
  /**
   * Keep going by itself when a turn ends with work still outstanding, instead
   * of waiting for the user to type "continue". Bounded by `maxAutoContinues`.
   */
  autoContinue: boolean;
  /** How many times one send may be resumed automatically. */
  maxAutoContinues: number;
}

const DEFAULTS: SessionSettings = {
  effort: "medium",
  mode: "auto",
  maxSteps: null,
  goal: null,
  debug: false,
  outputStyle: "default",
  fidelity: "playable",
  planMode: false,
  plan: null,
  autoContinue: true,
  maxAutoContinues: 12,
};

let settings: SessionSettings = { ...DEFAULTS };

/** Emits `debug` events so the web UI can display verbose traces. */
export const sessionEvents = new EventEmitter();

export function getSettings(): SessionSettings {
  return { ...settings };
}

export function updateSettings(patch: Partial<SessionSettings>): SessionSettings {
  settings = { ...settings, ...patch };

  // planMode is derived from the mode now; keep the old flag in step so every
  // existing check (tool withholding, /plan, the chips) keeps working.
  if (patch.mode !== undefined) settings.planMode = patch.mode === "plan";
  if (patch.planMode !== undefined && patch.mode === undefined) {
    settings.mode = patch.planMode ? "plan" : "auto";
  }

  // Accept-edits lifts the read-only guards, which live in config.ts because
  // tools.ts and mcpManager.ts both consult them without importing this module.
  setEditsAccepted(settings.mode === "acceptEdits");

  return getSettings();
}

/** Advance the mode one step in the shift+tab cycle. */
export function cycleMode(): SessionSettings {
  const index = MODE_CYCLE.indexOf(settings.mode);
  return updateSettings({ mode: MODE_CYCLE[(index + 1) % MODE_CYCLE.length] });
}

export function resetSettings(): SessionSettings {
  settings = { ...DEFAULTS };
  setEditsAccepted(false);
  return getSettings();
}

export function getEffortProfile(level: EffortLevel = settings.effort): EffortProfile {
  return EFFORT_PROFILES[level] ?? EFFORT_PROFILES.medium;
}

export function listEffortLevels(): Array<{ level: EffortLevel } & EffortProfile> {
  return (Object.keys(EFFORT_PROFILES) as EffortLevel[]).map((level) => ({
    level,
    ...EFFORT_PROFILES[level],
  }));
}

export function getFidelityProfile(level: FidelityLevel = settings.fidelity): FidelityProfile {
  return FIDELITY_PROFILES[level] ?? FIDELITY_PROFILES.playable;
}

export function listFidelityLevels(): Array<{ level: FidelityLevel } & FidelityProfile> {
  return FIDELITY_LEVELS.map((level) => ({ level, ...FIDELITY_PROFILES[level] }));
}

/** Emit a debug trace. No-op unless /debug is on, so callers can be unconditional. */
export function debugLog(stage: string, detail: unknown): void {
  if (!settings.debug) return;

  let safe: unknown = detail;
  try {
    JSON.stringify(detail);
  } catch {
    safe = String(detail);
  }

  // Defence in depth: nothing should be routing a token through here, but a
  // debug panel that leaks one to the browser would be a nasty way to find out.
  const scrubbed = redactSecrets(safe);

  sessionEvents.emit("debug", { stage, detail: scrubbed, timestamp: Date.now() });
  console.log(
    `🐛 [${stage}]`,
    typeof scrubbed === "string" ? scrubbed : JSON.stringify(scrubbed).slice(0, 500)
  );
}

/** Tool-name fragments that indicate a mutating operation, for plan mode. */
const MUTATING_PATTERNS =
  /(write|create|delete|remove|move|patch|update|append|rename|mkdir|shell|exec|manage_tags|close_trade|cancel)/i;

// `edit` needs a boundary, unlike the rest.
//
// As a bare substring it matches `editor_status`, `editor_play`, `get_editor` —
// reads, every one. That misclassification stopped mattering the moment the
// repetition guard started using this function to decide what may be polled: a
// status tool was treated as a write and banned from being called twice, which
// is the whole of how you wait for a compile. The other fragments do not have
// this problem (`remote` does not contain `remove`), so only this one is
// anchored.
const EDIT_SEGMENT = /(^|[^a-z])edit([^a-z]|$)/i;

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_PATTERNS.test(toolName) || EDIT_SEGMENT.test(toolName);
}

/**
 * Extra system-prompt guidance assembled from the active settings.
 * Returned as one string so provider.ts can append it to the base prompt.
 */
export function buildSystemGuidance(): string {
  const parts: string[] = [];

  if (settings.planMode) {
    parts.push(
      "PLAN MODE IS ACTIVE. Do not modify anything. Read-only tools are available for " +
        "investigation, but every tool that writes, deletes or executes has been withheld. " +
        "Produce a numbered plan of what you WOULD do, name the files or notes involved, " +
        "and stop. Do not ask permission to proceed — the user will approve by turning off " +
        "plan mode."
    );
  }

  if (settings.goal) {
    parts.push(
      `STANDING GOAL — THIS IS ACTIVE WORK, NOT A NOTE: "${settings.goal}".\n` +
        `You own this goal until it is met or the user clears it. Rules:\n` +
        `1. If the user's message is about the goal, or is a bare "continue"/"go on", ` +
        `pick up at the first unfinished part and DO the work with tools. Do not restate ` +
        `the goal back and wait.\n` +
        `2. Never end a turn with "shall I proceed?", "let me know", or a plan you have not ` +
        `started. Take the next concrete step yourself.\n` +
        `3. Before every final answer, check the goal. If any part is outstanding, ` +
        `say which part and emit the continuation marker described below.\n` +
        `4. If the user's message is genuinely unrelated to the goal, answer it normally ` +
        `and do not force a connection.`
    );
  }

  if (settings.autoContinue) {
    parts.push(
      `CONTINUATION PROTOCOL. Long jobs are expected; you are not required to finish in one ` +
        `turn, and you must not stop early to ask for permission to keep going.\n` +
        `- When work remains after your answer, make the LAST line of your reply exactly:\n` +
        `  ${CONTINUE_MARKER} <the single next concrete step>\n` +
        `- You will then be resumed automatically and should do that step immediately, ` +
        `without re-planning from scratch or re-reading what you already read.\n` +
        `- Omit the marker only when the work is genuinely finished, or when you are blocked ` +
        `on something only the user can decide — in that case ask with the ask_user tool ` +
        `so the choice is answerable, rather than ending on an open question.\n` +
        `- Working through a checklist or task file: do one task per turn, mark it done in ` +
        `the file, then emit the marker naming the next task.`
    );
  }

  if (settings.outputStyle === "adhd") {
    parts.push(
      "OUTPUT STYLE — ADHD:\n" +
        "1. First line is the next action: a command, path, or snippet. No preamble.\n" +
        "2. Number multi-step work, one action per step, max 5 steps per list.\n" +
        "3. State what is done and what is next, concretely.\n" +
        "4. Give specific time estimates, not vague ones.\n" +
        "5. End with exactly ONE concrete next action if anything is open.\n" +
        "6. No greetings, no recaps, no 'let me know if you need anything else'.\n" +
        "7. Matter-of-fact tone for errors: state the cause and the fix."
    );
  }

  if (settings.effort === "low") {
    parts.push("Answer briefly. Prefer one tool call over exploration.");
  } else if (settings.effort === "high") {
    parts.push(
      "Be thorough. Verify assumptions with tools before concluding, and say explicitly " +
        "what you could not determine."
    );
  }

  // Last on purpose. A small model weights the tail of a long system prompt more
  // heavily than its middle, and this is the block most at risk of being read
  // past — it competes with the base prompt, the capability list, vault context,
  // the goal and the continuation protocol, none of which it can outrank on
  // length. Unconditional: every level speaks, including the default. See
  // FIDELITY_PROFILES for why that is not the same call effort makes.
  parts.push(FIDELITY_PROFILES[settings.fidelity].guidance);

  return parts.join("\n\n");
}
