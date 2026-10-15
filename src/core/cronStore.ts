// Scheduled job storage.
//
// Jobs live at ~/.cullus/cron/jobs.json. Per-run output goes to
// ~/.cullus/cron/output/{jobId}/{timestamp}.md, and monitor-mode state keeps
// the previous output alongside it so a change can be rendered as a diff.
//
// Two things make this file longer than "write some JSON":
//
// 1. WRITES ARE ATOMIC. Every save writes a temp file in the same directory and
//    renames it over the target. rename() is atomic on the same filesystem, so a
//    crash mid-write leaves either the old file or the new one — never a
//    half-written jobs.json that fails to parse and loses every job.
//
// 2. WRITES TAKE A LOCK. The dashboard, the CLI, and the scheduler tick can all
//    touch this file at once. Without a lock, two read-modify-write cycles that
//    overlap silently drop one of the changes. This is a lockfile-directory
//    approach: mkdir is atomic on every platform Node runs on, so creating the
//    directory *is* acquiring the lock.
//
// Failure mode being avoided: you add a job in the dashboard while a tick is
// recording a run, and your job vanishes with no error anywhere.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CONFIG_DIR } from "./config.js";

export const CRON_DIR = path.join(CONFIG_DIR, "cron");
export const JOBS_PATH = path.join(CRON_DIR, "jobs.json");
export const OUTPUT_DIR = path.join(CRON_DIR, "output");
const LOCK_DIR = path.join(CRON_DIR, ".lock");

export type JobKind = "prompt" | "monitor";

export interface MonitorState {
  /** sha256 of the monitor source's exact output bytes at the last agent-triggering tick. */
  lastOutputHash?: string;
  lastChangedAt?: string;
}

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression, interpreted in local time. */
  schedule: string;
  /** What the model is asked to do when the job fires. */
  prompt: string;
  enabled: boolean;
  kind: JobKind;
  /**
   * Monitor mode only. A shell command whose stdout is hashed each tick. The
   * model runs only when that output changes. See shouldRunMonitor().
   */
  monitorScript?: string;
  monitorState?: MonitorState;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "no_change";
  /** Consecutive failures. Reset on any success. Used to auto-disable. */
  failureCount?: number;
}

export interface JobsFile {
  version: 1;
  jobs: CronJob[];
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Acquire the cross-process lock, run fn, release.
 *
 * mkdir() fails if the directory exists, and that failure is atomic — no
 * check-then-create race. A stale lock (process killed mid-write) is broken
 * after STALE_MS so a crash does not wedge scheduling forever.
 */
function withLock<T>(fn: () => T): T {
  // The lock lives inside CRON_DIR, so on a fresh install that directory has to
  // exist before mkdir can create the lock inside it. Without this the very
  // first addJob() on a new machine fails with ENOENT — caught by
  // scripts/verify-cron-monitor.mjs, which runs against a throwaway HOME.
  ensureDirs();

  const STALE_MS = 30_000;
  const RETRY_MS = 50;
  const MAX_WAIT_MS = 5_000;
  const startedAt = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      } catch {
        // Lock vanished between mkdir and stat — loop and try to take it.
        continue;
      }
      if (age > STALE_MS) {
        try {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* another process beat us to the cleanup; loop */
        }
        continue;
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error(
          `cron: could not acquire ${LOCK_DIR} within ${MAX_WAIT_MS}ms. ` +
            `If no other assistant process is running, delete that directory.`
        );
      }
      // Busy-wait. Deliberately synchronous: callers are sync and the critical
      // section is a single small file write measured in milliseconds.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      /* nothing useful to do; the staleness sweep will clear it */
    }
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  fs.mkdirSync(CRON_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Read the job list. A corrupt or unreadable file returns an empty list rather
 * than throwing — a broken jobs.json should not stop the assistant from
 * starting. The corrupt file is preserved as jobs.json.corrupt for inspection.
 */
export function loadJobs(): CronJob[] {
  ensureDirs();
  if (!fs.existsSync(JOBS_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_PATH, "utf-8")) as JobsFile;
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    try {
      fs.copyFileSync(JOBS_PATH, `${JOBS_PATH}.corrupt`);
    } catch {
      /* best effort */
    }
    return [];
  }
}

function writeJobsUnlocked(jobs: CronJob[]): void {
  ensureDirs();
  const payload: JobsFile = { version: 1, jobs };
  // Temp file in the SAME directory: rename() is only atomic within one
  // filesystem, and /tmp is frequently a different one.
  const tmp = path.join(CRON_DIR, `.jobs.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, JOBS_PATH);
}

/**
 * Read-modify-write the job list under the lock.
 *
 * Always mutate through this rather than loadJobs() + saveJobs(): the read has
 * to happen inside the same lock as the write, or a concurrent change made
 * between them is silently discarded.
 */
export function updateJobs(mutate: (jobs: CronJob[]) => CronJob[]): CronJob[] {
  return withLock(() => {
    const next = mutate(loadJobs());
    writeJobsUnlocked(next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export function addJob(
  input: Omit<CronJob, "id" | "createdAt" | "enabled"> & { enabled?: boolean }
): CronJob {
  const job: CronJob = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    enabled: input.enabled ?? true,
  };
  updateJobs((jobs) => [...jobs, job]);
  return job;
}

export function removeJob(id: string): boolean {
  let removed = false;
  updateJobs((jobs) => {
    const next = jobs.filter((j) => j.id !== id);
    removed = next.length !== jobs.length;
    return next;
  });
  if (removed) {
    try {
      fs.rmSync(path.join(OUTPUT_DIR, id), { recursive: true, force: true });
    } catch {
      /* output is disposable */
    }
  }
  return removed;
}

export function setEnabled(id: string, enabled: boolean): boolean {
  let found = false;
  updateJobs((jobs) =>
    jobs.map((j) => {
      if (j.id !== id) return j;
      found = true;
      // Re-enabling clears the failure streak so an auto-disabled job gets a
      // clean slate rather than tripping again on the first failure.
      return { ...j, enabled, failureCount: enabled ? 0 : j.failureCount };
    })
  );
  return found;
}

export function getJob(id: string): CronJob | undefined {
  return loadJobs().find((j) => j.id === id);
}

// ---------------------------------------------------------------------------
// Monitor mode
// ---------------------------------------------------------------------------

export function hashOutput(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function monitorOutputPath(jobId: string): string {
  return path.join(OUTPUT_DIR, jobId, "monitor_last_output.txt");
}

export function readLastMonitorOutput(jobId: string): string | null {
  try {
    return fs.readFileSync(monitorOutputPath(jobId), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Record that a monitor source produced new output.
 *
 * Two writes, deliberately: the hash goes in jobs.json (durable, small, what the
 * next tick compares against) and the full text goes beside the run output (only
 * so the *next* change can be rendered as a diff).
 */
export function recordMonitorChange(jobId: string, output: string): void {
  const dir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.monitor.${process.pid}.tmp`);
  fs.writeFileSync(tmp, output, "utf-8");
  fs.renameSync(tmp, monitorOutputPath(jobId));

  updateJobs((jobs) =>
    jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            monitorState: {
              lastOutputHash: hashOutput(output),
              lastChangedAt: new Date().toISOString(),
            },
          }
        : j
    )
  );
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export function recordRun(
  jobId: string,
  status: "ok" | "error" | "no_change",
  body: string
): void {
  // A no_change tick is the common case for a monitor job and writing a file
  // every few minutes for "nothing happened" is just disk churn. Record it on
  // the job, not on disk.
  if (status !== "no_change") {
    const dir = path.join(OUTPUT_DIR, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.writeFileSync(path.join(dir, `${stamp}.md`), body, "utf-8");
    } catch {
      /* output is disposable; never fail a run over it */
    }
  }

  updateJobs((jobs) =>
    jobs.map((j) => {
      if (j.id !== jobId) return j;
      const failureCount = status === "error" ? (j.failureCount ?? 0) + 1 : 0;
      return {
        ...j,
        lastRunAt: new Date().toISOString(),
        lastStatus: status,
        failureCount,
      };
    })
  );
}

export function listRuns(jobId: string, limit = 20): string[] {
  try {
    return fs
      .readdirSync(path.join(OUTPUT_DIR, jobId))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}
