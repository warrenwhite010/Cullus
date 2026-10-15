// Scheduled jobs — the ticker, monitor-mode suppression, and the guards.
//
// Two kinds of job:
//
//   prompt  — on schedule, run `prompt` through the agent. Simple.
//   monitor — on schedule, run a cheap shell command FIRST and hash its output.
//             Only if that output CHANGED does the agent run at all.
//
// Monitor mode is the whole point for something like "watch an Oanda balance".
// Checking every 15 minutes is 96 model calls a day, 95 of which say "no
// change". Hashing a `curl | jq` first turns that into 96 nearly-free shell
// runs and a model call only when the number actually moves.
//
// Design borrowed from NousResearch/hermes-agent's cron/monitor.py. Their
// implementation is ~18k lines across 14 files; this is the core idea at a
// scale that fits this codebase.

import { spawn } from "child_process";
import { Cron } from "croner";
import {
  type CronJob,
  type JobKind,
  loadJobs,
  recordRun,
  recordMonitorChange,
  readLastMonitorOutput,
  hashOutput,
  setEnabled,
} from "./cronStore.js";
import { logActivity } from "./activity.js";

/** Stop a runaway job from taking the process down with it. */
const MONITOR_TIMEOUT_MS = 30_000;
const MONITOR_MAX_OUTPUT = 256 * 1024;
/** Consecutive failures before a job disables itself. */
const FAILURE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Guard 1: reject jobs that would restart the thing running them
// ---------------------------------------------------------------------------

/**
 * A scheduled job that restarts the assistant is a self-sustaining crash loop:
 * job fires → process dies → supervisor revives it → scheduler starts → job
 * fires. Hermes hit exactly this and wrote a guard for it; the same shape
 * applies here.
 *
 * Deliberately command-shaped, not prose-shaped. A monitor script is fed to a
 * shell so a command match is meaningful; a job's `prompt` is fed to a model,
 * where matching English would fire on "restart the deployment" in a sentence
 * that never touches a shell. So this checks scripts, not prompts.
 */
const LIFECYCLE_PATTERNS: RegExp[] = [
  /\b(cullus|assistant)\s+(restart|stop|upgrade)\b/i,
  /\bpkill\b[^\n]*\b(cullus|assistant)\b/i,
  /\bkillall\b[^\n]*\bnode\b/i,
  /\bsystemctl\s+(restart|stop)\b[^\n]*(cullus|assistant)/i,
  /\blaunchctl\s+(unload|kickstart|stop)\b[^\n]*(cullus|assistant)/i,
  /\bnpm\s+(start|run\s+start)\b/i,
];

export function checkLifecycleSafety(script: string | undefined): string | null {
  if (!script) return null;
  for (const pattern of LIFECYCLE_PATTERNS) {
    if (pattern.test(script)) {
      return (
        `Refusing this monitor script: it matches ${pattern} , which can stop or ` +
        `restart the assistant. A scheduled job that restarts its own host loops ` +
        `forever — the supervisor revives the process and the job fires again.`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard 2: is the schedule even valid?
// ---------------------------------------------------------------------------

export function validateSchedule(expression: string): string | null {
  try {
    const probe = new Cron(expression, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    if (!next) return `"${expression}" parses but will never fire.`;
    return null;
  } catch (err: any) {
    return `"${expression}" is not a valid cron expression: ${err?.message ?? err}`;
  }
}

export function describeSchedule(expression: string): string {
  try {
    const probe = new Cron(expression, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next ? `next run ${next.toLocaleString()}` : "never fires";
  } catch {
    return "invalid schedule";
  }
}

// ---------------------------------------------------------------------------
// Monitor sources
// ---------------------------------------------------------------------------

interface MonitorResult {
  ok: boolean;
  output: string;
  error?: string;
}

/**
 * Run a monitor script and capture stdout.
 *
 * Note what is NOT done here: no timestamp stripping, no whitespace
 * normalisation. Output is compared as exact bytes, so a script that prints
 * "generated at 14:32" looks changed on every single tick and defeats the whole
 * mechanism. Monitor scripts must emit stable output — sort your results, drop
 * the clock. This is called out in the /cron help text too.
 */
function runMonitorScript(script: string): Promise<MonitorResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;

    const finish = (result: MonitorResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, output: "", error: `monitor script exceeded ${MONITOR_TIMEOUT_MS}ms` });
    }, MONITOR_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > MONITOR_MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish({ ok: false, output: "", error: `monitor output exceeded ${MONITOR_MAX_OUTPUT} bytes` });
      }
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, output: "", error: e.message }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, output: out });
      else finish({ ok: false, output: "", error: `exit ${code}: ${err.trim().slice(0, 500)}` });
    });
  });
}

/** Small unified-ish diff, capped, for injecting into the model's prompt. */
function renderDiff(before: string, after: string, maxLines = 40): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit && lines.length < maxLines; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) lines.push(`- ${a[i]}`);
    if (b[i] !== undefined) lines.push(`+ ${b[i]}`);
  }
  if (lines.length >= maxLines) lines.push(`… diff truncated at ${maxLines} lines`);
  return lines.join("\n") || "(no line-level differences; bytes differ)";
}

// ---------------------------------------------------------------------------
// Deciding whether a tick should wake the model
// ---------------------------------------------------------------------------

export type TickDecision =
  | { run: false; status: "no_change"; reason: string }
  | { run: false; status: "error"; reason: string }
  | { run: true; contextBlock?: string };

/**
 * For a monitor job: run the source, compare hashes, decide.
 *
 * A source FAILURE is an error, never a change — and the stored hash is left
 * untouched. That matters: if a flaky `curl` fails once, you do not want the
 * recovery tick to look like a change and fire the model for nothing.
 */
export async function evaluateMonitor(job: CronJob): Promise<TickDecision> {
  if (!job.monitorScript) {
    return { run: false, status: "error", reason: "monitor job has no monitorScript" };
  }

  const result = await runMonitorScript(job.monitorScript);
  if (!result.ok) {
    return { run: false, status: "error", reason: result.error ?? "monitor source failed" };
  }

  const nextHash = hashOutput(result.output);
  const lastHash = job.monitorState?.lastOutputHash;

  if (lastHash && lastHash === nextHash) {
    return { run: false, status: "no_change", reason: "monitor output unchanged" };
  }

  const previous = readLastMonitorOutput(job.id);
  recordMonitorChange(job.id, result.output);

  const contextBlock = [
    "MONITOR CHANGE DETECTED",
    "",
    lastHash ? "Diff since the last change:" : "First run — no previous output to compare.",
    lastHash ? "```diff" : "",
    lastHash ? renderDiff(previous ?? "", result.output) : "",
    lastHash ? "```" : "",
    "",
    "Current output:",
    "```",
    result.output.slice(0, 8000),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { run: true, contextBlock };
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

/**
 * Runs one job's turn. Injected rather than imported so the scheduler does not
 * depend on the agent loop — and so tests can drive it without a model.
 */
export type JobRunner = (job: CronJob, contextBlock?: string) => Promise<string>;

let runner: JobRunner | null = null;
const active = new Map<string, Cron>();
/** A job already running does not get started again by the next tick. */
const inFlight = new Set<string>();

export function setJobRunner(fn: JobRunner): void {
  runner = fn;
}

async function fire(job: CronJob): Promise<void> {
  if (inFlight.has(job.id)) {
    logActivity({ kind: "turn", status: "warn", label: `cron: ${job.name}`, summary: "still running from the last tick; skipped" });
    return;
  }
  inFlight.add(job.id);
  try {
    let contextBlock: string | undefined;

    if (job.kind === "monitor") {
      const decision = await evaluateMonitor(job);
      if (!decision.run) {
        recordRun(job.id, decision.status, decision.reason);
        if (decision.status === "error") {
          logActivity({ kind: "command", status: "fail", label: `cron: ${job.name}`, summary: `monitor source failed — ${decision.reason}` });
          maybeAutoDisable(job.id, job.name);
        }
        return;
      }
      contextBlock = decision.contextBlock;
    }

    if (!runner) {
      recordRun(job.id, "error", "no job runner registered");
      return;
    }

    const body = await runner(job, contextBlock);
    recordRun(job.id, "ok", body);
    logActivity({ kind: "turn", status: "ok", label: `cron: ${job.name}`, summary: "completed" });
  } catch (err: any) {
    recordRun(job.id, "error", String(err?.stack ?? err));
    logActivity({ kind: "turn", status: "fail", label: `cron: ${job.name}`, summary: String(err?.message ?? err) });
    maybeAutoDisable(job.id, job.name);
  } finally {
    inFlight.delete(job.id);
  }
}

/**
 * Disable a job that keeps failing.
 *
 * Without this, a job broken at a 5-minute interval fails 288 times a day and
 * fills the activity log with the same message. Hermes solves this with durable
 * incidents and acknowledgement; the smaller version is to stop after five and
 * say so once.
 */
function maybeAutoDisable(jobId: string, jobName: string): void {
  const job = loadJobs().find((j) => j.id === jobId);
  if (!job) return;
  if ((job.failureCount ?? 0) < FAILURE_LIMIT) return;
  setEnabled(jobId, false);
  reload();
  logActivity({
    kind: "turn",
    status: "fail",
    label: `cron: ${jobName}`,
    summary: `disabled after ${FAILURE_LIMIT} consecutive failures. Re-enable with /cron enable <id>.`,
  });
}

/** Stop every timer. Safe to call when nothing is scheduled. */
/** How many jobs are mid-run. Shutdown waits on this so a job is not killed
 *  halfway through with no record of what it did. */
export function inFlightCount(): number {
  return inFlight.size;
}

export function stop(): void {
  for (const [, task] of active) task.stop();
  active.clear();
}

/**
 * Read jobs.json and (re)arm timers to match. Call after any change.
 *
 * An invalid schedule disables that job rather than throwing — one bad
 * expression should not stop every other job from running.
 */
export function reload(): number {
  stop();
  let armed = 0;
  for (const job of loadJobs()) {
    if (!job.enabled) continue;
    const scheduleError = validateSchedule(job.schedule);
    if (scheduleError) {
      logActivity({ kind: "server", status: "warn", label: `cron: ${job.name}`, summary: `disabled — ${scheduleError}` });
      setEnabled(job.id, false);
      continue;
    }
    const task = new Cron(job.schedule, { protect: true }, () => {
      // Re-read the job each fire so an edit between ticks takes effect without
      // a restart, and a job deleted mid-flight simply stops.
      const current = loadJobs().find((j) => j.id === job.id);
      if (current?.enabled) void fire(current);
    });
    active.set(job.id, task);
    armed++;
  }
  return armed;
}

export function start(): number {
  const armed = reload();
  if (armed > 0) logActivity({ kind: "server", status: "ok", label: "cron", summary: `${armed} scheduled job(s) armed` });
  return armed;
}

export function status(): Array<{
  id: string;
  name: string;
  schedule: string;
  kind: JobKind;
  enabled: boolean;
  nextRun: string | null;
  lastStatus?: string;
  lastRunAt?: string;
  failureCount: number;
}> {
  return loadJobs().map((j) => {
    const task = active.get(j.id);
    const next = task?.nextRun() ?? null;
    return {
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      kind: j.kind,
      enabled: j.enabled,
      nextRun: next ? next.toISOString() : null,
      lastStatus: j.lastStatus,
      lastRunAt: j.lastRunAt,
      failureCount: j.failureCount ?? 0,
    };
  });
}
