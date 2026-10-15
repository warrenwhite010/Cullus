// What the model has actually read, so a whole-file write cannot destroy what it
// has never seen.
//
// The failure this exists for, measured. Asked to fix twelve compile errors, the
// model's FIRST action was `write_text_file` on RuntimeInspector.cs, and it
// replaced that file (5,378 bytes → 2,809) and DiscLauncher.cs (14,816 → 7,102)
// with rewrites at roughly half their size, then reported the task complete and
// blamed the remaining errors on the Editor.
//
// Two things about that run make the obvious rule useless:
//
//   1. The files HAD been read — two turns earlier, and modified by `edit_file`
//      in between. A session-scoped "has it read this?" would have said yes.
//   2. Those reads were partial. `read_text_file … head=135` returned 12,138 of
//      14,816 characters, so the model rewrote a file it had only ever seen 82%
//      of. A completeness-blind rule would also have said yes.
//
// So the rule is narrower and harder: a whole-file overwrite requires a COMPLETE
// read of the bytes that are on disk RIGHT NOW. Size and mtime are recorded at
// read time and re-checked at write time, which is what makes an intervening
// edit invalidate the read.
//
// A targeted `edit_file` is exempt throughout: it has to match text that exists,
// so it cannot silently drop the rest of a file. This is only about writes that
// replace everything.

import * as fs from "fs";
import * as path from "path";

interface ReadRecord {
  /** Size of the file when it was read. */
  size: number;
  mtimeMs: number;
  /** True when the whole file was read, not a head/tail/offset slice. */
  complete: boolean;
  /** How the read was made, for the error message. */
  how: string;
}

const reads = new Map<string, ReadRecord>();

/** Largest file we will re-read to measure its character length exactly. */
const MAX_MEASURE_BYTES = 8 * 1024 * 1024;

/** Argument keys that narrow a read to part of a file. */
const SLICE_KEYS = ["head", "tail", "offset", "limit", "length", "start", "end", "lines", "range"];

export function resetFileState(): void {
  reads.clear();
}

/** Tools whose job is to read a file. */
export function isReadTool(toolName: string): boolean {
  if (/write|edit|patch|delete|move|create|append/i.test(toolName)) return false;
  return /read|get_file_contents|view|open_file|cat/i.test(toolName);
}

/** Tools that replace a file wholesale. */
export function isWholeFileWrite(toolName: string): boolean {
  // An edit anchors on existing text; an append only adds. Neither can lose the
  // parts of a file the model never saw.
  if (/edit|patch|append|insert|prepend/i.test(toolName)) return false;
  return /write|create_file|save_file|put_file/i.test(toolName);
}

function pathFrom(args: any): string | null {
  const found = ["path", "file", "filepath", "filePath", "target"]
    .map((key) => args?.[key])
    .find((v) => typeof v === "string" && v.length > 0);
  return typeof found === "string" ? found : null;
}

/**
 * Remember that a file was read, and whether the whole thing came back.
 *
 * `returnedChars` is the size of what the tool actually handed over. Compared
 * against the file on disk rather than trusted: a tool can be asked for a whole
 * file and still return less, which is exactly the case that matters.
 *
 * `fullyStashed` covers the out-of-band path — toolResults.ts keeps oversized
 * results whole and hands back an id, so a read capped by `maxToolResultChars`
 * has still genuinely retrieved the file and must count as complete. Without
 * that, a large file would be permanently unwritable.
 */
export function recordRead(
  toolName: string,
  args: unknown,
  returnedChars: number,
  fullyStashed = false
): void {
  if (!isReadTool(toolName)) return;

  const target = pathFrom(args);
  if (!target) return;

  const record = args as any;
  const sliced = SLICE_KEYS.some((key) => record?.[key] != null);

  try {
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return;

    // Characters against characters.
    //
    // `returnedChars` is a character count and `stat.size` is a byte count, and
    // any non-ASCII in the file makes bytes exceed characters — so comparing the
    // two directly marks every UTF-8 file short and permanently unwritable. The
    // file's own character length is the only honest comparison, and reading it
    // is cheap next to the write we are about to allow.
    let fileChars = stat.size;
    if (stat.size <= MAX_MEASURE_BYTES) {
      try {
        fileChars = fs.readFileSync(resolved, "utf-8").length;
      } catch {
        /* fall back to the byte count, which errs towards "incomplete" */
      }
    }

    const covered = fullyStashed || returnedChars >= fileChars;

    reads.set(resolved, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      complete: !sliced && covered,
      how: sliced
        ? `a partial read (${SLICE_KEYS.filter((k) => record?.[k] != null).join(", ")})`
        : `a full read (${returnedChars.toLocaleString()} of ${fileChars.toLocaleString()} characters)`,
    });
  } catch {
    /* unreadable or vanished: nothing worth recording */
  }
}

/** Forget a file after it is written, so the next overwrite needs a fresh read. */
export function invalidate(args: unknown): void {
  const target = pathFrom(args);
  if (!target) return;
  try {
    reads.delete(path.resolve(target));
  } catch {
    /* nothing to forget */
  }
}

export interface OverwriteVerdict {
  allowed: boolean;
  /** Why not, phrased for the model. */
  message?: string;
  actionRequired?: string;
}

/**
 * May this call replace the whole file?
 *
 * Allowed when the file does not exist (nothing to lose) or when a complete,
 * still-current read is on record. Refused otherwise — and refused rather than
 * prompted, because "have you read this file?" is not a judgement a human can
 * make faster than the model can go and read it.
 */
export function mayOverwrite(toolName: string, args: unknown): OverwriteVerdict {
  if (!isWholeFileWrite(toolName)) return { allowed: true };

  const record = args as any;
  if (record?.dry_run === true || record?.dryRun === true) return { allowed: true };

  const target = pathFrom(args);
  if (!target) return { allowed: true };

  let resolved: string;
  let stat: fs.Stats;
  try {
    resolved = path.resolve(target);
    stat = fs.statSync(resolved);
    if (!stat.isFile()) return { allowed: true };
  } catch {
    return { allowed: true }; // new file
  }

  const name = path.basename(resolved);
  const seen = reads.get(resolved);

  if (!seen) {
    return {
      allowed: false,
      message:
        `You have not read ${name} (${stat.size.toLocaleString()} bytes) in this turn, so you ` +
        `cannot replace it wholesale. Whatever is in it that you have not seen would be lost.`,
      actionRequired:
        `Read ${name} first, with no head/tail/offset so you get all of it, then retry this ` +
        `write. If you only mean to change part of it, use the edit tool instead — that is ` +
        `both safer and cheaper than rewriting the file.`,
    };
  }

  if (!seen.complete) {
    return {
      allowed: false,
      message:
        `You have only seen part of ${name}: your read was ${seen.how}, and the file is ` +
        `${stat.size.toLocaleString()} bytes. Replacing it wholesale would delete the part you ` +
        `never read.`,
      actionRequired:
        `Read ${name} again with no head/tail/offset, then retry. If you only mean to change ` +
        `part of it, use the edit tool instead.`,
    };
  }

  if (seen.size !== stat.size || seen.mtimeMs !== stat.mtimeMs) {
    return {
      allowed: false,
      message:
        `${name} has changed since you read it (was ${seen.size.toLocaleString()} bytes, now ` +
        `${stat.size.toLocaleString()}). Your copy is stale, so writing it back would revert ` +
        `whatever changed.`,
      actionRequired:
        `Read ${name} again to see its current contents, then retry. Something else edited it — ` +
        `possibly an earlier step of this same turn.`,
    };
  }

  return { allowed: true };
}
