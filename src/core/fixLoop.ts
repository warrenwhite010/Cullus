// The /fix repair loop.
//
// This is the method I want a 2B model to be able to execute: probe reality
// before believing anything, find every reference, make a surgical edit, rebuild,
// verify, sweep for leftovers, and stop only when the thing actually works.
//
// The trick is that almost none of it is left to the model. Locating candidates,
// running builds, applying edits, comparing failure signatures, deciding whether
// there is progress and rolling back are all deterministic code here. The model
// answers three narrow questions with JSON contracts:
//
//   1. Of these grep hits, which files matter?      (≤5 paths)
//   2. What ONE read-only command would prove it?   (allowlisted, optional)
//   3. What exact string becomes what other string? (find/replace edits)
//
// Everything else — including "is it fixed?" — is measured, never asserted. A
// model that says "fixed" while the build fails does not get the last word.

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { chatJson } from "./ollama.js";
import { applyEdit, gitCheckpoint, restoreRun, touchedFiles, type EditRequest } from "./patch.js";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";
import { setTasks, startTask, setTaskStatus } from "./tasks.js";
import { logActivity } from "./activity.js";
import type { FixTarget } from "./projectTarget.js";

const RUNS_PATH = path.join(CONFIG_DIR, "fix-runs.json");
const MAX_STORED_RUNS = 20;

/** Per-command ceiling. Builds on cold caches are slow; runaway ones are worse. */
const COMMAND_TIMEOUT_MS = 300_000;

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".py", ".rs", ".go",
  ".toml", ".yml", ".yaml", ".html", ".css", ".sh", ".txt", ".sql",
]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".next", "coverage"]);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type FixPhase =
  | "baseline"
  | "locate"
  | "probe"
  | "plan"
  | "apply"
  | "verify"
  | "sweep"
  | "decide";

export interface FixEvent {
  runId: string;
  round: number;
  phase: FixPhase | "start" | "finish";
  status: "running" | "ok" | "warn" | "fail";
  message: string;
  /** Exact command output or model JSON, when there is any. */
  detail?: string;
}

export type FixOutcome = "kept" | "reverted" | "noop" | "cancelled" | "blocked";

export interface FixRunRecord {
  id: string;
  root: string;
  label: string;
  symptom: string;
  startedAt: number;
  endedAt: number;
  outcome: FixOutcome;
  rounds: number;
  touched: string[];
  gitStash: string | null;
  summary: string;
  /** Every event, so a completed run can be re-read in the UI. */
  log: FixEvent[];
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Run a build/verify/probe command in the target root.
 *
 * `shell: true` is intentional and safe here because commands come from the
 * project's own config or detection, never from the model — except probes, which
 * pass through isAllowedProbe() first.
 */
export function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });

    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      // Keep the tail: compiler errors land at the end of a long build log.
      if (output.length > 200_000) output = output.slice(-200_000);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ command, ok: false, code: null, output: `${output}\n${err.message}`.trim(), timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      logActivity({
        kind: "command",
        status: code === 0 && !timedOut ? "ok" : "fail",
        label: command,
        summary: timedOut ? "killed after timing out" : `exit ${code}`,
        detail: output,
      });

      resolve({
        command,
        ok: code === 0 && !timedOut,
        code,
        output: timedOut ? `${output}\n[killed after ${COMMAND_TIMEOUT_MS / 1000}s]`.trim() : output.trim(),
        timedOut,
      });
    });
  });
}

/**
 * Read-only commands a model may propose as a probe.
 *
 * Allowlisted by leading verb, with chaining, redirection and privilege
 * escalation refused outright. This is what made the Obsidian diagnosis factual
 * instead of guessed — one curl against the real endpoint beat any amount of
 * reading code — so it is worth having, but it is not a general shell.
 */
export function isAllowedProbe(command: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty command" };
  if (trimmed.length > 600) return { ok: false, reason: "command is implausibly long" };

  const allowed = [
    /^curl\s/, /^grep\s/, /^rg\s/, /^ls(\s|$)/, /^cat\s/, /^head\s/, /^tail\s/, /^wc\s/,
    /^find\s/, /^file\s/, /^git\s+(status|diff|log|show|rev-parse|ls-files|grep)(\s|$)/,
    /^node\s+(--input-type=module\s+)?-e\s/, /^python3?\s+-c\s/,
    /^npm\s+run\s+\S+$/, /^npm\s+ls(\s|$)/, /^pip\s+show\s/, /^which\s/, /^printenv$/,
  ];

  if (!allowed.some((pattern) => pattern.test(trimmed))) {
    return { ok: false, reason: "not in the read-only probe allowlist" };
  }

  // Shell metacharacters are checked OUTSIDE quoted strings only. A `python -c`
  // or `node -e` probe legitimately contains semicolons, and rejecting those
  // outright removed the most useful probe there is — running a snippet against
  // the real system is exactly how the Obsidian endpoint got diagnosed.
  const quoted: string[] = [];
  const unquoted = trimmed.replace(/'[^']*'|"[^"]*"/g, (match) => {
    quoted.push(match.slice(1, -1));
    return " Q ";
  });

  if (/[;&|`]|\$\(|>>|>|</.test(unquoted)) {
    return { ok: false, reason: "contains shell chaining or redirection outside a quoted argument" };
  }
  if (/\b(sudo|rm|mv|dd|tee|chmod|chown|kill|shutdown)\b/.test(unquoted)) {
    return { ok: false, reason: "names a mutating or privileged command" };
  }

  // Inline code can still reach the filesystem or spawn a shell, so the snippet
  // itself is checked for anything that writes or executes.
  const isInlineCode = /^(node|python3?)\s/.test(trimmed);
  if (isInlineCode) {
    const code = quoted.join(" ");
    const dangerous =
      /\b(os\.system|subprocess|shutil|os\.remove|os\.rmdir|os\.unlink|os\.rename|child_process|execSync|spawnSync|writeFileSync|writeFile|appendFile|unlink|rmdir|mkdir|rename|truncate)\b/.test(code) ||
      // Python's open() in any writing mode.
      /open\s*\([^)]*['"][wax]/.test(code);
    if (dangerous) {
      return { ok: false, reason: "the inline snippet writes files or spawns a process" };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Candidate discovery (code, not model)
// ---------------------------------------------------------------------------

/** Identifiers and quoted phrases worth grepping for, from the symptom text. */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const match of text.matchAll(/["'`]([^"'`]{3,60})["'`]/g)) {
    terms.add(match[1].trim());
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{3,})\b/g)) {
    const word = match[1];
    // Skip prose: keep things that look like code identifiers or filenames.
    if (/[A-Z_$]/.test(word.slice(1)) || word.includes("_") || /\.(ts|js|py|json|md)$/.test(word)) {
      terms.add(word);
    }
  }
  for (const match of text.matchAll(/\b([\w./-]+\.(?:ts|tsx|js|mjs|py|rs|go|json|md|html|css|toml|ya?ml))\b/g)) {
    terms.add(match[1]);
  }

  return Array.from(terms).slice(0, 12);
}

export interface Candidate {
  file: string;
  hits: number;
  lines: Array<{ line: number; text: string }>;
}

/** Files mentioning any term, with hit lines. A walk, not a grep: same result on every platform. */
export function findCandidates(root: string, terms: string[], limit = 12): Candidate[] {
  if (terms.length === 0) return [];

  const found: Candidate[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    if (scanned > 4000) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned > 4000) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > 512 * 1024) continue;

      scanned++;

      let content: string;
      try {
        content = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const hitLines: Array<{ line: number; text: string }> = [];

      lines.forEach((text, index) => {
        if (hitLines.length >= 6) return;
        if (terms.some((term) => text.includes(term))) {
          hitLines.push({ line: index + 1, text: text.trim().slice(0, 200) });
        }
      });

      if (hitLines.length > 0) {
        found.push({ file: path.relative(root, full), hits: hitLines.length, lines: hitLines });
      }
    }
  };

  walk(root);
  return found.sort((a, b) => b.hits - a.hits).slice(0, limit);
}

/**
 * Hit-centred, line-numbered excerpt.
 *
 * Wider than it used to be (70 → 160 lines) because edits are now line-anchored:
 * a model can only target lines it can see, and a narrow window left it guessing
 * at line numbers in the omitted regions.
 */
function excerpt(root: string, file: string, terms: string[], maxLines = 160): string {
  const full = path.join(root, file);
  let content: string;
  try {
    content = fs.readFileSync(full, "utf-8");
  } catch {
    return `[could not read ${file}]`;
  }

  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return lines.map((text, i) => `${i + 1}\t${text}`).join("\n");
  }

  const hit = lines.findIndex((text) => terms.some((term) => text.includes(term)));
  const centre = hit === -1 ? 0 : hit;
  const from = Math.max(0, centre - Math.floor(maxLines / 3));
  const to = Math.min(lines.length, from + maxLines);

  return (
    (from > 0 ? `… ${from} earlier lines omitted …\n` : "") +
    lines
      .slice(from, to)
      .map((text, i) => `${from + i + 1}\t${text}`)
      .join("\n") +
    (to < lines.length ? `\n… ${lines.length - to} later lines omitted …` : "")
  );
}

// ---------------------------------------------------------------------------
// Failure comparison and sweep (code, not model)
// ---------------------------------------------------------------------------

/**
 * A stable fingerprint of a failure, used to detect "no progress".
 *
 * Line and column numbers are stripped so an unchanged error that merely moved
 * still compares equal — otherwise a model that adds a blank line looks like
 * it's making progress forever.
 */
export function failureSignature(output: string): string {
  return output
    .split("\n")
    .filter((line) => /error|failed|cannot|not found|Traceback|assert/i.test(line))
    .slice(0, 6)
    .map((line) => line.replace(/:\d+(:\d+)?/g, ":#").replace(/\s+/g, " ").trim())
    .join(" | ")
    .slice(0, 800);
}

/** Identifiers that disappeared from the edits — candidates for stale references. */
export function removedIdentifiers(edits: EditRequest[]): string[] {
  const removed = new Set<string>();

  for (const edit of edits) {
    const before = new Set(((edit.find ?? "").match(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g) ?? []));
    const after = new Set((edit.replace.match(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g) ?? []));
    for (const name of before) {
      if (!after.has(name) && /[A-Z_$]/.test(name.slice(1))) removed.add(name);
    }
  }

  return Array.from(removed).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Model contracts
// ---------------------------------------------------------------------------

const LOCATE_SCHEMA = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "string" }, maxItems: 5 },
    reason: { type: "string" },
  },
  required: ["files"],
};

const PROBE_SCHEMA = {
  type: "object",
  properties: {
    skip: { type: "boolean" },
    command: { type: "string" },
    why: { type: "string" },
  },
  required: ["skip"],
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      // Raised from 4: implementing something (rather than repairing one line)
      // means a new module plus the two or three wire-ups that reference it.
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          create: { type: "boolean" },
          find: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          replace: { type: "string" },
          why: { type: "string" },
        },
        required: ["file", "replace"],
      },
    },
    expectation: { type: "string" },
  },
  required: ["edits"],
};

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export function loadRuns(): FixRunRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRun(record: FixRunRecord): void {
  try {
    ensureConfigDir();
    const runs = [record, ...loadRuns().filter((r) => r.id !== record.id)].slice(0, MAX_STORED_RUNS);
    fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`⚠️  Could not record fix run: ${err.message}`);
  }
}

/** Undo a completed run from its backups. */
export function revertRun(runId: string): { ok: boolean; message: string; restored: string[] } {
  const record = loadRuns().find((r) => r.id === runId);
  if (!record) return { ok: false, message: `No fix run "${runId}" is on record.`, restored: [] };

  const result = restoreRun(runId, record.root);

  logActivity({
    kind: "edit",
    status: result.failed.length > 0 ? "warn" : "ok",
    label: `revert ${runId}`,
    summary:
      `restored ${result.restored.length}` +
      (result.removed.length > 0 ? `, removed ${result.removed.length} created` : ""),
    detail: [...result.restored, ...result.removed.map((f) => `${f} (deleted)`)].join("\n"),
  });

  if (result.restored.length === 0 && result.failed.length === 0) {
    return { ok: false, message: `Run ${runId} has no backups left to restore.`, restored: [] };
  }
  if (result.failed.length > 0) {
    return {
      ok: false,
      message: `Restored ${result.restored.length} file(s); ${result.failed.length} failed: ${result.failed
        .map((f) => `${f.file} (${f.error})`)
        .join(", ")}`,
      restored: result.restored,
    };
  }

  saveRun({ ...record, outcome: "reverted", summary: `${record.summary} Reverted on request.` });
  return {
    ok: true,
    message: `Restored ${result.restored.length} file(s) in ${record.root}.`,
    restored: result.restored,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface FixModels {
  /** Locate + sweep triage. Cheapest model is fine. */
  locate: string;
  /** Probe + plan. The strongest model available should go here. */
  plan: string;
}

export interface FixOptions {
  symptom: string;
  target: FixTarget;
  models: FixModels;
  rounds?: number;
  signal?: AbortSignal;
  onEvent?: (event: FixEvent) => void;
}

export interface FixReport extends FixRunRecord {
  baselineOutput: string;
  finalOutput: string;
}

/** True when the loop is already running: one repair at a time, process-wide. */
let running = false;
export function isFixRunning(): boolean {
  return running;
}

export async function runFix(options: FixOptions): Promise<FixReport> {
  const { symptom, target, models, signal } = options;
  // Up to 30 attempts. The ceiling is not the safety mechanism — the
  // repeated-failure rule below stops a run that has stopped making progress,
  // usually long before the budget runs out.
  const rounds = Math.min(Math.max(Math.floor(options.rounds ?? 3), 1), 30);
  const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const startedAt = Date.now();
  const log: FixEvent[] = [];

  // The checklist mirrors the phases rather than asking a model to keep it
  // honest: a phase that ran is ticked, one that failed is marked failed.
  const TASK_FOR_PHASE: Partial<Record<FixEvent["phase"], string>> = {
    baseline: "See the failure for real",
    locate: "Find the files involved",
    probe: "Probe live state for evidence",
    plan: "Plan exact edits",
    apply: "Apply the edits",
    verify: "Rebuild and verify",
    sweep: "Sweep for stale references",
  };

  const emit = (
    phase: FixEvent["phase"],
    status: FixEvent["status"],
    message: string,
    detail?: string,
    round = 0
  ) => {
    const event: FixEvent = { runId, round, phase, status, message, detail };
    log.push(event);

    logActivity({
      kind: "fix",
      status,
      label: round > 0 ? `${phase} · round ${round}` : phase,
      summary: message,
      detail,
    });

    const subject = TASK_FOR_PHASE[phase];
    if (subject) {
      if (status === "running") {
        startTask(subject);
      } else {
        // Observation phases succeed by observing. A red baseline is the whole
        // point of running, so only phases that were supposed to fix something
        // are marked failed.
        const observational = phase === "baseline" || phase === "locate" || phase === "sweep";
        setTaskStatus(subject, status === "fail" && !observational ? "failed" : "done");
      }
    }

    options.onEvent?.(event);
  };

  const finish = (outcome: FixOutcome, summary: string, baselineOutput: string, finalOutput: string): FixReport => {
    const record: FixRunRecord = {
      id: runId,
      root: target.root,
      label: target.label,
      symptom,
      startedAt,
      endedAt: Date.now(),
      outcome,
      rounds: log.filter((e) => e.phase === "verify").length,
      touched: touchedFiles(runId),
      gitStash: stash,
      summary,
      log,
    };
    saveRun(record);
    emit("finish", outcome === "kept" ? "ok" : outcome === "noop" ? "ok" : "warn", summary);
    running = false;
    return { ...record, baselineOutput, finalOutput };
  };

  if (running) {
    throw new Error("A /fix run is already in progress. Wait for it to finish, or cancel it.");
  }
  running = true;

  setTasks(
    [
      { subject: "See the failure for real", activeForm: "Running build and verify" },
      { subject: "Find the files involved", activeForm: "Searching for candidates" },
      { subject: "Probe live state for evidence", activeForm: "Gathering evidence" },
      { subject: "Plan exact edits", activeForm: "Planning edits" },
      { subject: "Apply the edits", activeForm: "Applying edits" },
      { subject: "Rebuild and verify", activeForm: "Rebuilding and verifying" },
      { subject: "Sweep for stale references", activeForm: "Sweeping for leftovers" },
    ],
    "fix"
  );

  let stash: string | null = null;

  try {
    const { build, verify, source } = target.commands;

    emit(
      "start",
      "running",
      `Repairing ${target.label} — ${rounds} round${rounds === 1 ? "" : "s"} max`,
      `root: ${target.root}\nbuild: ${build ?? "(none detected)"}\nverify: ${verify ?? "(none detected)"}\ndetected from: ${source}`
    );

    if (!build && !verify) {
      return finish(
        "blocked",
        `No build or verify command could be detected for ${target.label}, so a repair cannot be proven. ` +
          `Set one with \`/fix set ${target.root} --build "<cmd>"\`.`,
        "",
        ""
      );
    }

    // ---- Baseline ---------------------------------------------------------
    const runChecks = async (): Promise<{ pass: boolean; output: string; failing: string | null }> => {
      const parts: string[] = [];

      if (build) {
        const result = await runCommand(build, target.root, signal);
        parts.push(`$ ${build}\n${result.output || "(no output)"}`);
        if (!result.ok) return { pass: false, output: parts.join("\n\n"), failing: build };
      }
      if (verify) {
        const result = await runCommand(verify, target.root, signal);
        parts.push(`$ ${verify}\n${result.output || "(no output)"}`);
        if (!result.ok) return { pass: false, output: parts.join("\n\n"), failing: verify };
      }
      return { pass: true, output: parts.join("\n\n"), failing: null };
    };

    emit("baseline", "running", "Running build and verify to see the failure for real");
    const baseline = await runChecks();
    if (signal?.aborted) return finish("cancelled", "Cancelled during baseline.", baseline.output, "");

    emit(
      "baseline",
      baseline.pass ? "ok" : "fail",
      baseline.pass ? "Baseline is already green" : `Baseline fails at: ${baseline.failing}`,
      tail(baseline.output, 60)
    );

    stash = gitCheckpoint(target.root);

    // ---- Rounds -----------------------------------------------------------
    const terms = extractTerms(`${symptom}\n${baseline.output}`);
    let context = baseline.pass
      ? "The build and verify commands pass. The reported symptom is therefore behavioural, not a build error."
      : `Current failure output:\n${tail(baseline.output, 50)}`;

    let lastSignature = failureSignature(baseline.output);
    let repeats = 0;
    /** Consecutive rounds where not a single edit could be applied. */
    let emptyRounds = 0;
    let finalOutput = baseline.output;
    const allEdits: EditRequest[] = [];

    for (let round = 1; round <= rounds; round++) {
      if (signal?.aborted) return finish("cancelled", "Cancelled between rounds.", baseline.output, finalOutput);

      // ---- Locate --------------------------------------------------------
      emit("locate", "running", "Searching for files that mention the symptom", undefined, round);
      const candidates = findCandidates(target.root, terms);

      if (candidates.length === 0) {
        emit("locate", "fail", `Nothing in ${target.label} mentions: ${terms.join(", ") || "(no terms)"}`, undefined, round);
        return finish(
          "blocked",
          `Could not find any file referencing the symptom. Describe it with an identifier, error string or filename.`,
          baseline.output,
          finalOutput
        );
      }

      const candidateList = candidates
        .map((c, i) => `${i + 1}. ${c.file} (${c.hits} hit${c.hits === 1 ? "" : "s"})\n${c.lines.map((l) => `     ${l.line}: ${l.text}`).join("\n")}`)
        .join("\n");

      const located = await chatJson<{ files: string[]; reason?: string }>(
        models.locate,
        "You select files for a repair. Answer with JSON only. Never invent a path.",
        `Symptom: ${symptom}\n\n${context}\n\nFiles that mention the symptom:\n${candidateList}\n\n` +
          `Return {"files":["path", …]} listing at most 4 of the paths above, most likely relevant first. ` +
          `Copy paths exactly as written.`,
        LOCATE_SCHEMA,
        (value) => {
          if (!Array.isArray(value?.files) || value.files.length === 0) return "files must be a non-empty array";
          const known = new Set(candidates.map((c) => c.file));
          const unknown = value.files.filter((f: string) => !known.has(f));
          if (unknown.length > 0) return `these paths were not in the list: ${unknown.join(", ")}`;
          return null;
        },
        signal
      );

      // A locate failure is survivable: fall back to the top grep hits, which is
      // what the model was being asked to rank anyway.
      const chosen =
        located.ok && located.value?.files.length
          ? located.value.files.slice(0, 4)
          : candidates.slice(0, 2).map((c) => c.file);

      emit(
        "locate",
        located.ok ? "ok" : "warn",
        located.ok ? `Chose ${chosen.join(", ")}` : `Model did not choose usable files (${located.error}); using top grep hits: ${chosen.join(", ")}`,
        undefined,
        round
      );

      // ---- Probe (first round only) --------------------------------------
      if (round === 1) {
        emit("probe", "running", "Asking for one read-only command to confirm the diagnosis", undefined, round);

        const probe = await chatJson<{ skip: boolean; command?: string; why?: string }>(
          models.plan,
          "You propose ONE read-only shell command to gather evidence. Answer with JSON only.",
          `Symptom: ${symptom}\n\n${context}\n\nFiles under suspicion: ${chosen.join(", ")}\n\n` +
            `Return {"skip":true} if the failure output is already conclusive. Otherwise return ` +
            `{"skip":false,"command":"<one read-only command>","why":"<what it will show>"}. ` +
            `Allowed: curl, grep, rg, ls, cat, head, tail, find, git status/diff/log, node -e, python -c, npm run <script>. ` +
            `No pipes, no redirection, no chaining, nothing that writes.\n` +
            `Do NOT cat or read the suspect files — their contents are already provided to the next step. ` +
            `A probe is only worth running to observe LIVE state you cannot get from the source: an HTTP ` +
            `endpoint's real response, a resolved config value, what actually exists on disk.`,
          PROBE_SCHEMA,
          (value) => (typeof value?.skip === "boolean" ? null : "skip must be a boolean"),
          signal
        );

        if (probe.ok && probe.value && !probe.value.skip && probe.value.command) {
          const allowed = isAllowedProbe(probe.value.command);
          if (!allowed.ok) {
            emit("probe", "warn", `Refused probe "${probe.value.command}" — ${allowed.reason}`, undefined, round);
          } else {
            const result = await runCommand(probe.value.command, target.root, signal);
            context += `\n\nEvidence from \`${probe.value.command}\`:\n${tail(result.output, 30)}`;
            emit(
              "probe",
              result.ok ? "ok" : "warn",
              `Ran ${probe.value.command} (exit ${result.code})`,
              tail(result.output, 30),
              round
            );
          }
        } else {
          emit("probe", "ok", "Skipped: the failure output is already conclusive", undefined, round);
        }
      }

      // ---- Plan ----------------------------------------------------------
      emit("plan", "running", "Asking for exact find/replace edits", undefined, round);

      const fileBlocks = chosen
        .map((file) => `--- ${file} ---\n${excerpt(target.root, file, terms)}`)
        .join("\n\n");

      const planned = await chatJson<{ edits: EditRequest[]; expectation?: string }>(
        models.plan,
        "You change code by replacing a numbered line range, or by creating a new file. " +
          "Answer with JSON only.",
        `Symptom: ${symptom}\n\n${context}\n\n${fileBlocks}\n\n` +
          `Each edit is ONE of two shapes:\n` +
          `  edit an existing file: {"file":"<path above>","startLine":<N>,"endLine":<M>,"replace":"<new text for those lines>","why":"<one line>"}\n` +
          `  create a new file:     {"file":"<new path>","create":true,"replace":"<the ENTIRE file contents>","why":"<one line>"}\n\n` +
          `Return {"edits":[…],"expectation":"<what should pass after this>"}\n` +
          `Rules:\n` +
          `1. startLine and endLine are the 1-based numbers shown before each line, inclusive. ` +
          `Every line in that range is replaced by "replace".\n` +
          `2. The "N\\t" prefixes are NOT part of the file. Never include them in "replace".\n` +
          `3. "replace" must be complete, syntactically valid code, with the same indentation style as ` +
          `the surrounding lines. Include every closing brace you opened.\n` +
          `4. Only lines shown in the excerpt above can be edited. Never guess line numbers from omitted regions.\n` +
          `5. Use create:true only for a file that does not exist yet. To change an existing file, use ` +
          `startLine/endLine — creating over it is refused.\n` +
          `6. A new file is inert until something imports it. When you create one, also edit the file ` +
          `that should use it in the SAME response.\n` +
          `7. At most 4 edits. Prefer the smallest change that achieves the goal.`,
        PLAN_SCHEMA,
        (value) => {
          if (!Array.isArray(value?.edits) || value.edits.length === 0) return "edits must be a non-empty array";
          for (const edit of value.edits) {
            if (!edit?.file || typeof edit.replace !== "string") return "every edit needs file and replace";

            if (edit.create === true) {
              if (!edit.replace.trim()) return `create for ${edit.file} needs the file's full contents in replace`;
              continue;
            }

            const hasLines = typeof edit.startLine === "number" && typeof edit.endLine === "number";
            const hasFind = typeof edit.find === "string" && edit.find.length > 0;
            if (!hasLines && !hasFind) {
              return "every edit needs either startLine and endLine, or find, or create:true";
            }
            if (hasLines && edit.endLine < edit.startLine) {
              return `endLine ${edit.endLine} is before startLine ${edit.startLine}`;
            }
            // A model that pastes the numbered prefixes back corrupts the file.
            if (/^\s*\d+\t/m.test(edit.replace)) {
              return "replace still contains the \"N\\t\" line-number prefixes; send the code only";
            }
          }
          return null;
        },
        signal
      );

      if (!planned.ok || !planned.value) {
        emit("plan", "fail", `No usable edit plan: ${planned.error}`, planned.raw?.slice(0, 500), round);
        context += `\n\nYour previous attempt produced no usable edits (${planned.error}). Return smaller, exact edits.`;
        continue;
      }

      emit(
        "plan",
        "ok",
        `${planned.value.edits.length} edit(s) proposed`,
        planned.value.edits.map((e) => `${e.file}: ${e.why ?? "(no reason given)"}`).join("\n"),
        round
      );

      // ---- Apply ---------------------------------------------------------
      emit("apply", "running", "Applying edits", undefined, round);

      const applied: EditRequest[] = [];
      const rejections: string[] = [];

      for (const edit of planned.value.edits) {
        const outcome = applyEdit(runId, target.root, edit);

        logActivity({
          kind: "edit",
          status: outcome.ok ? "ok" : "warn",
          label: `${edit.create ? "create" : "edit"} ${edit.file}`,
          summary: outcome.ok ? (edit.why ?? "applied") : outcome.error,
          detail: outcome.ok ? edit.replace : `${outcome.error}\n${outcome.context ?? ""}`,
        });

        if (outcome.ok) {
          applied.push(edit);
          allEdits.push(edit);
        } else {
          rejections.push(
            `${edit.file}: ${outcome.error}${outcome.context ? `\n   nearby:\n${outcome.context}` : ""}`
          );
        }
      }

      if (applied.length === 0) {
        emptyRounds++;
        emit("apply", "fail", "Every edit was refused", rejections.join("\n"), round);

        // Two rounds in a row that change nothing means the model cannot target
        // this file. Burning the remaining budget on identical refusals — which is
        // exactly what happened on a real 4-round run — helps nobody.
        if (emptyRounds >= 2) {
          emit(
            "decide",
            "fail",
            "Two rounds in a row applied no edits — stopping rather than repeating the same refusal",
            undefined,
            round
          );
          break;
        }

        context =
          `Your edits were ALL refused:\n${rejections.join("\n")}\n\n` +
          `Use startLine and endLine from the numbered excerpt instead of find. ` +
          `Only edit lines you can see in the excerpt.`;
        continue;
      }

      emptyRounds = 0;

      const createdNow = applied.filter((e) => e.create).map((e) => e.file);

      emit(
        "apply",
        rejections.length > 0 ? "warn" : "ok",
        `Applied ${applied.length} of ${planned.value.edits.length} edit(s)` +
          (createdNow.length > 0 ? ` — created ${createdNow.join(", ")}` : ""),
        rejections.length > 0 ? `Refused:\n${rejections.join("\n")}` : undefined,
        round
      );

      // ---- Verify --------------------------------------------------------
      emit("verify", "running", `Rebuilding and verifying`, undefined, round);
      const checks = await runChecks();
      finalOutput = checks.output;

      if (signal?.aborted) {
        restoreRun(runId, target.root);
        return finish("cancelled", "Cancelled during verification; edits were rolled back.", baseline.output, finalOutput);
      }

      emit(
        "verify",
        checks.pass ? "ok" : "fail",
        checks.pass ? "Build and verify pass" : `Still failing at: ${checks.failing}`,
        tail(checks.output, 50),
        round
      );

      // An edit that breaks the build must not survive into the next round. Left
      // in place, every later `find` misses because the file no longer looks like
      // the excerpt the model was shown — observed as three wasted rounds after
      // one bad edit introduced a TS1005 syntax error.
      if (!checks.pass && introducedSyntaxError(baseline.output, checks.output)) {
        const undone = restoreRun(runId, target.root);
        emit(
          "apply",
          "warn",
          `Those edits broke the build (${firstErrorLine(checks.output)}), so they were rolled back`,
          `restored: ${undone.restored.join(", ")}`,
          round
        );

        context =
          `Your edit did NOT compile and has been undone, so the file is back to its ` +
          `original state:\n${tail(checks.output, 20)}\n\n` +
          `The most common cause is an incomplete line range: "replace" must contain valid, ` +
          `complete code for every line from startLine to endLine, including closing braces.`;
        continue;
      }

      // ---- Sweep ---------------------------------------------------------
      const removed = removedIdentifiers(applied);
      let stale: Candidate[] = [];

      if (removed.length > 0) {
        stale = findCandidates(target.root, removed, 6).filter(
          (c) => !applied.some((e) => e.file === c.file)
        );
      }

      emit(
        "sweep",
        stale.length === 0 ? "ok" : "warn",
        stale.length === 0
          ? "No stale references left behind"
          : `${stale.length} file(s) still reference removed names: ${removed.join(", ")}`,
        stale.map((c) => `${c.file}: ${c.lines.map((l) => `${l.line}: ${l.text}`).join(" / ")}`).join("\n"),
        round
      );

      // ---- Decide --------------------------------------------------------
      if (checks.pass && stale.length === 0) {
        const diff = await runCommand("git diff --stat", target.root, signal);
        return finish(
          "kept",
          `Fixed in ${round} round${round === 1 ? "" : "s"}. ${applied.length} edit(s) kept in ${
            new Set(allEdits.map((e) => e.file)).size
          } file(s). Revert with \`/fix revert ${runId}\`.`,
          baseline.output,
          `${finalOutput}\n\n$ git diff --stat\n${diff.output}`
        );
      }

      if (checks.pass && stale.length > 0) {
        // Green but inconsistent: this is the mcpvault-comment case. Keep going,
        // with the leftovers as the next round's work.
        context = `The build passes, but these files still reference names you removed:\n${stale
          .map((c) => `${c.file}: ${c.lines.map((l) => `${l.line}: ${l.text}`).join(" / ")}`)
          .join("\n")}\nUpdate them.`;
        terms.push(...removed);
        continue;
      }

      const signature = failureSignature(checks.output);
      repeats = signature === lastSignature ? repeats + 1 : 0;
      lastSignature = signature;

      if (repeats >= 1) {
        emit("decide", "fail", "Same failure twice in a row — stopping instead of guessing again", undefined, round);
        break;
      }

      context = `Your edits did not fix it. Current failure:\n${tail(checks.output, 50)}\n\nEdits already applied this run:\n${allEdits
        .map((e) => `${e.file}: ${e.why ?? "(no reason)"}`)
        .join("\n")}`;
    }

    // ---- Unresolved: roll everything back --------------------------------
    const restored = restoreRun(runId, target.root);
    return finish(
      "reverted",
      restored.restored.length > 0
        ? `Could not fix it. Restored ${restored.restored.length} file(s) to their original state; the tree is as you left it.`
        : `Could not fix it. Nothing was modified.`,
      baseline.output,
      finalOutput
    );
  } catch (err: any) {
    // Any unexpected throw must still leave the tree clean.
    restoreRun(runId, target.root);
    running = false;
    emit("finish", "fail", `Aborted: ${err.message}. Any edits were rolled back.`);
    throw err;
  } finally {
    running = false;
  }
}

/** The first compiler/test error line, for a one-line message. */
export function firstErrorLine(output: string): string {
  const line = output.split("\n").find((text) => /error|Error:|SyntaxError|Traceback/.test(text));
  return (line ?? "build failed").trim().slice(0, 160);
}

/**
 * Did this round introduce a *compile* error the baseline did not have?
 *
 * Only syntax/type errors are treated this way. A failing test is legitimate
 * progress information the model should iterate on; a file that no longer parses
 * is not, because it invalidates every excerpt the model was given.
 */
export function introducedSyntaxError(baselineOutput: string, currentOutput: string): boolean {
  const syntaxish = /error TS\d+|SyntaxError|Unexpected token|'\}' expected|IndentationError/;
  if (!syntaxish.test(currentOutput)) return false;
  return !syntaxish.test(baselineOutput);
}

/** Last N lines of command output — the end is where the errors are. */
function tail(text: string, lines: number): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return `… ${all.length - lines} earlier lines omitted …\n${all.slice(-lines).join("\n")}`;
}
