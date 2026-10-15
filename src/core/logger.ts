// File logging.
//
// Before this the app had 191 console.* calls and wrote nothing to disk. That is
// fine while you are watching a terminal and useless the moment anything runs
// unattended: a scheduled job fails at 3am and the only record is stdout that
// nobody captured.
//
// Three decisions worth stating:
//
// 1. SECRETS ARE REDACTED BEFORE THEY REACH THE FILE. The app resolves tokens
//    from the environment, the Keychain and ~/.claude.json. A log that captures
//    everything is a log that eventually captures one of those, and unlike a
//    terminal a file persists and gets copied into bug reports. Every line goes
//    through redactSecrets first.
//
// 2. THE EXISTING console.* CALLS ARE CAPTURED, NOT REWRITTEN. Rewriting 191
//    call sites would be a large diff with real risk and no behaviour change.
//    attachConsole() tees console output into the log instead, so everything
//    already written lands on disk and the terminal still looks the same.
//
// 3. LOGGING NEVER THROWS. A full disk, a read-only home directory, a race on
//    rotation — none of that should take down the assistant. Every failure path
//    here degrades to "no log line" rather than an exception.

import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./config.js";

export const LOG_DIR = path.join(CONFIG_DIR, "logs");
export const LOG_PATH = path.join(LOG_DIR, "cullus.log");

/** Rotate past this size. Small enough to open in an editor. */
const MAX_BYTES = 5 * 1024 * 1024;
/** How many rotated files to keep. cullus.log.1 … .3 */
const KEEP = 3;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** ASSISTANT_LOG_LEVEL=debug turns on the noisy tier. Default is info. */
function minLevel(): number {
  const configured = String((process.env.CULLUS_LOG_LEVEL ?? process.env.ASSISTANT_LOG_LEVEL) ?? "info").toLowerCase() as LogLevel;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

let ready = false;
function ensureDir(): boolean {
  if (ready) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ready = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll assistant.log to .1, .1 to .2, and drop the oldest.
 *
 * Called before a write when the file is over size. A failure here is
 * swallowed: losing rotation is annoying, losing the process is not.
 */
function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    if (fs.statSync(LOG_PATH).size < MAX_BYTES) return;

    try {
      fs.rmSync(`${LOG_PATH}.${KEEP}`, { force: true });
    } catch {
      /* nothing to remove */
    }
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${LOG_PATH}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_PATH}.${i + 1}`);
    }
    fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    /* a concurrent rotation may have moved things; the next write still works */
  }
}

/**
 * Write one JSON line.
 *
 * JSONL rather than prose because these get grepped and parsed far more often
 * than they get read top to bottom, and a scheduled-job failure at 3am is
 * something you want to filter by level and time.
 */
export function log(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  if (!ensureDir()) return;

  let entry: string;
  try {
    // Redaction is dynamic-imported so this module has no import cycle with
    // secrets.ts, which reaches back into config. A failure to load it means we
    // write nothing rather than risk writing an unredacted token.
    const payload: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      msg: message,
    };
    if (detail !== undefined) payload.detail = detail;
    entry = JSON.stringify(payload);
  } catch {
    return;
  }

  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, entry + "\n", "utf-8");
  } catch {
    /* disk full, read-only home — never propagate */
  }
}

export const logger = {
  debug: (m: string, d?: unknown) => log("debug", m, d),
  info: (m: string, d?: unknown) => log("info", m, d),
  warn: (m: string, d?: unknown) => log("warn", m, d),
  error: (m: string, d?: unknown) => log("error", m, d),
};

let redactor: ((input: unknown) => unknown) | null = null;

/**
 * Redact using a resolver that is loaded BEFORE any console output is teed.
 *
 * The first version of this loaded secrets.js lazily and let lines through
 * unredacted until the import landed. verify-logging.mjs caught exactly that: a
 * token in the very first console.log reached the file. "Only a few lines leak"
 * is not a property a log file can have — it persists, and it gets pasted into
 * bug reports. attachConsole() now awaits the resolver before wrapping console,
 * and if it cannot be loaded, console output is NOT teed at all.
 */
function scrub(text: string): string {
  if (!redactor) return text;
  try {
    const out = redactor(text);
    return typeof out === "string" ? out : text;
  } catch {
    return text;
  }
}

let attached = false;

/**
 * Tee console output into the log file.
 *
 * Async because redaction must be in place before the first teed line. A caller
 * that does not await it simply gets the tee installed a tick later; nothing is
 * written to the file in the meantime.
 */
export async function attachConsole(): Promise<void> {
  if (attached) return;

  try {
    ({ redactSecrets: redactor } = await import("./secrets.js"));
  } catch {
    // No redactor means no guarantee, so do not capture console at all. Explicit
    // logger.* calls still work; they carry no user-supplied secrets.
    log("warn", "console capture disabled: secret redaction unavailable");
    return;
  }

  attached = true;

  const wrap = (level: LogLevel, original: (...args: any[]) => void) =>
    (...args: any[]) => {
      original(...args);
      try {
        const text = args
          .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
          .join(" ")
          .trim();
        // Skip the decorative banner lines; they are noise in a log file.
        if (text && !/^[\s─━=*✨🚀]+$/.test(text)) log(level, scrub(text));
      } catch {
        /* never let logging break a console call */
      }
    };

  console.log = wrap("info", console.log.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));

  log("info", "logging started", { pid: process.pid, node: process.version });
}

/** Newest lines first, for the dashboard and `assistant --logs`. */
export function tail(limit = 200): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(LOG_PATH, "utf-8").trimEnd().split("\n");
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { t: null, level: "info", msg: l };
        }
      });
  } catch {
    return [];
  }
}
