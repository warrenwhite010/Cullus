// One-time migration from ~/.assistant to ~/.cullus.
//
// The rename would otherwise strand everything a working install has
// accumulated: config.json, resolved secrets, scheduled jobs and their run
// history, sessions, skills, fix backups. Someone upgrades, the app comes up
// looking brand new, and their cron jobs stop firing with nothing to explain
// why.
//
// Two decisions make this safe:
//
// 1. COPY, DO NOT MOVE. The old directory is left exactly as it was. If the
//    migration gets something wrong, or you roll back to a build that still
//    reads ~/.assistant, your data is still there. A move would make the
//    rename irreversible for no benefit.
//
// 2. ONLY WHEN THE NEW DIRECTORY DOES NOT EXIST. Once ~/.cullus is present the
//    migration never runs again, so it cannot overwrite newer state with a
//    stale copy — the failure mode where you edit config, restart, and get
//    yesterday's settings back.
//
// It runs synchronously at config import, before anything reads CONFIG_DIR,
// and it never throws: a failed migration must leave you with a working app on
// defaults rather than no app at all.

import fs from "fs";
import os from "os";
import path from "path";

export const LEGACY_DIR = path.join(os.homedir(), ".assistant");
export const CURRENT_DIR = path.join(os.homedir(), ".cullus");

let done = false;

export interface MigrationResult {
  migrated: boolean;
  from?: string;
  to?: string;
  entries?: number;
  error?: string;
}

/**
 * Copy the legacy directory across if this looks like a first run after the
 * rename. Returns what happened so the caller can say so once, out loud —
 * a silent migration is one you cannot verify.
 */
export function migrateLegacyConfigDir(): MigrationResult {
  if (done) return { migrated: false };
  done = true;

  try {
    // Nothing to migrate.
    if (!fs.existsSync(LEGACY_DIR)) return { migrated: false };
    // Already migrated, or a fresh install that started on the new name.
    if (fs.existsSync(CURRENT_DIR)) return { migrated: false };

    const entries = fs.readdirSync(LEGACY_DIR);
    if (entries.length === 0) return { migrated: false };

    // Node 16.7+ has fs.cpSync with recursive copy. Everything in this
    // directory is small — config, JSON, markdown, logs — so a synchronous
    // copy at startup is not worth making async.
    fs.cpSync(LEGACY_DIR, CURRENT_DIR, { recursive: true, errorOnExist: false });

    // A marker, so anyone looking at the directory later knows where it came
    // from and that the original still exists.
    try {
      fs.writeFileSync(
        path.join(CURRENT_DIR, "MIGRATED_FROM_ASSISTANT.txt"),
        `Copied from ${LEGACY_DIR} on ${new Date().toISOString()}.\n` +
          `The original was left in place and is safe to delete once you are happy.\n`,
        "utf-8"
      );
    } catch {
      /* the marker is a courtesy, not part of the migration */
    }

    return { migrated: true, from: LEGACY_DIR, to: CURRENT_DIR, entries: entries.length };
  } catch (err: any) {
    // Never let this stop startup. Running on defaults is recoverable; failing
    // to boot because a copy went wrong is not.
    return { migrated: false, error: String(err?.message ?? err) };
  }
}

/**
 * Read an environment variable under the new name, falling back to the old one.
 *
 * Every ASSISTANT_* variable keeps working. Someone with CULLUS_LOG_LEVEL and
 * ASSISTANT_LOG_LEVEL both set gets the new one, which is the only sane
 * precedence — you set the new name deliberately.
 */
export function readEnv(suffix: string): string | undefined {
  return process.env[`CULLUS_${suffix}`] ?? process.env[`ASSISTANT_${suffix}`];
}
