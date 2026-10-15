// The single write primitive used by the /fix loop.
//
// Small models are bad at producing whole files and good at producing "replace
// this exact string with that one". So the loop never lets a model write a file:
// it emits {file, find, replace} and this module applies it, refusing anything
// ambiguous. A `find` that matches zero times or more than once is an ERROR with
// the match count and nearby lines, which becomes the model's next-round input.
// That turns the most common small-model failure (plausible-looking edit against
// text that isn't there) into a correctable message instead of a broken file.
//
// Every mutation is preceded by a backup, so revert is a file copy: no git
// dependency, nothing staged, nothing committed, and it works in projects that
// aren't repositories at all.

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { CONFIG_DIR, ensureConfigDir, guardVaultWrite } from "./config.js";
import { SECRETS_PATH } from "./secrets.js";

export const BACKUP_ROOT = path.join(CONFIG_DIR, "fix-backups");

/** Records paths a run CREATED, so revert can remove them. */
const CREATED_MANIFEST = ".created-by-fix";

/** Path segments never edited, whatever the model asks for. */
const EXCLUDED_SEGMENTS = [".git", "node_modules", "dist", ".venv", "__pycache__"];

export interface EditRequest {
  file: string;
  /**
   * Create `file` with `replace` as its entire contents.
   *
   * Without this the loop could only ever modify what already existed, so any task
   * needing a new module was structurally impossible — not merely hard. Creation
   * obeys the same containment rules as an edit, and revert DELETES what it made,
   * so "the tree is as you left it" stays true.
   */
  create?: boolean;
  /** Exact existing text. Omit when using startLine/endLine. */
  find?: string;
  replace: string;
  /**
   * 1-based inclusive line range to replace, as an alternative to `find`.
   *
   * Added because find/replace is where small models actually fail: on a 560-line
   * file, three of four rounds in a real run were refused with "find does not
   * appear" or "find appears 2 times". Given a numbered excerpt, "replace lines
   * 520-540" is a target a 2B model can hit.
   */
  startLine?: number;
  endLine?: number;
  why?: string;
}

export interface EditOutcome {
  ok: boolean;
  file: string;
  /** Why it was refused, phrased for a model to act on. */
  error?: string;
  matches?: number;
  /** Lines near the closest partial match, to help the model retarget. */
  context?: string;
}

/**
 * Resolve `relative` inside `root`, or explain the refusal.
 *
 * Refuses traversal outside the root, excluded directories, the secrets file,
 * and — via the shared central guard — anything inside a read-only vault.
 */
export function resolveEditPath(
  root: string,
  relative: string
): { ok: true; path: string } | { ok: false; error: string } {
  if (!relative || typeof relative !== "string") {
    return { ok: false, error: "file is required and must be a path relative to the project root." };
  }

  const normalisedRoot = path.resolve(root);
  const resolved = path.resolve(normalisedRoot, relative);

  if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + path.sep)) {
    return {
      ok: false,
      error: `"${relative}" resolves outside the project root. Use a path relative to the root with no ".." segments.`,
    };
  }

  const relativeParts = path.relative(normalisedRoot, resolved).split(path.sep);
  const blocked = relativeParts.find((segment) => EXCLUDED_SEGMENTS.includes(segment));
  if (blocked) {
    return { ok: false, error: `"${blocked}/" is not editable. Edit the source it is built from.` };
  }

  if (resolved === path.resolve(SECRETS_PATH)) {
    return { ok: false, error: "The secrets file is never editable." };
  }

  // The vault normally sits inside a granted path, so the central guard is the
  // only thing that reliably keeps a repair loop out of the user's notes.
  const vaultRefusal = guardVaultWrite("write_file", { path: resolved });
  if (vaultRefusal) {
    return { ok: false, error: `${vaultRefusal.message} Repairs must not touch the vault.` };
  }

  return { ok: true, path: resolved };
}

/** Copy a file into this run's backup tree, once. Returns false if it could not. */
export function backupFile(runId: string, root: string, absolute: string): boolean {
  try {
    ensureConfigDir();
    const relative = path.relative(path.resolve(root), absolute);
    const target = path.join(BACKUP_ROOT, runId, relative);

    // First write wins: later rounds must not overwrite the pristine copy.
    if (fs.existsSync(target)) return true;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolute, target);
    return true;
  } catch (err: any) {
    console.warn(`⚠️  Could not back up ${absolute}: ${err.message}`);
    return false;
  }
}

/** Note that a run created this path, so restoreRun can delete it. */
function recordCreated(runId: string, root: string, absolute: string): void {
  try {
    ensureConfigDir();
    const runRoot = path.join(BACKUP_ROOT, runId);
    fs.mkdirSync(runRoot, { recursive: true });

    const relative = path.relative(path.resolve(root), absolute);
    const manifest = path.join(runRoot, CREATED_MANIFEST);
    const existing = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf-8").split("\n") : [];

    if (!existing.includes(relative)) {
      fs.appendFileSync(manifest, `${relative}\n`, "utf-8");
    }
  } catch (err: any) {
    console.warn(`⚠️  Could not record created file ${absolute}: ${err.message}`);
  }
}

/** Paths this run created. */
export function createdFiles(runId: string): string[] {
  try {
    return fs
      .readFileSync(path.join(BACKUP_ROOT, runId, CREATED_MANIFEST), "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A few lines around the best partial match, so the model can retarget. */
function nearestContext(content: string, find: string): string | undefined {
  // Longest leading fragment of `find` that does appear: usually reveals the
  // whitespace or wording the model got wrong.
  const firstLine = find.split("\n")[0].trim();
  const probe = firstLine.length > 12 ? firstLine.slice(0, Math.max(12, firstLine.length - 8)) : firstLine;
  if (!probe) return undefined;

  const index = content.indexOf(probe);
  if (index === -1) return undefined;

  const lines = content.slice(0, index).split("\n");
  const lineNumber = lines.length;
  const all = content.split("\n");
  const from = Math.max(0, lineNumber - 3);
  const to = Math.min(all.length, lineNumber + 3);

  return all
    .slice(from, to)
    .map((line, i) => `${from + i + 1}\t${line}`)
    .join("\n");
}

/**
 * Apply one exact-string edit. The file must exist and `find` must occur exactly
 * once; anything else is refused without touching disk.
 */
export function applyEdit(runId: string, root: string, edit: EditRequest): EditOutcome {
  const resolved = resolveEditPath(root, edit.file);
  if (!resolved.ok) return { ok: false, file: edit.file, error: resolved.error };

  if (typeof edit.replace !== "string") {
    return { ok: false, file: edit.file, error: "replace must be a string (use \"\" to delete the matched text)." };
  }

  // ---- create mode ---------------------------------------------------------
  if (edit.create) {
    if (fs.existsSync(resolved.path)) {
      return {
        ok: false,
        file: edit.file,
        error: `${edit.file} already exists. Edit it with startLine/endLine instead of creating it.`,
      };
    }
    if (!edit.replace.trim()) {
      return { ok: false, file: edit.file, error: "A created file needs its full contents in `replace`." };
    }

    try {
      fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
      fs.writeFileSync(resolved.path, edit.replace.endsWith("\n") ? edit.replace : `${edit.replace}\n`, "utf-8");
    } catch (err: any) {
      return { ok: false, file: edit.file, error: `Could not create ${edit.file}: ${err.message}` };
    }

    recordCreated(runId, root, resolved.path);
    return { ok: true, file: edit.file, matches: 1 };
  }

  const usesLines = typeof edit.startLine === "number" && typeof edit.endLine === "number";
  if (!usesLines && (typeof edit.find !== "string" || edit.find.length === 0)) {
    return {
      ok: false,
      file: edit.file,
      error:
        "Provide either `find` (exact text copied from the file) or `startLine` and `endLine` " +
        "(1-based, inclusive, from the numbered excerpt).",
    };
  }

  if (!fs.existsSync(resolved.path)) {
    return { ok: false, file: edit.file, error: `${edit.file} does not exist in this project.` };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved.path, "utf-8");
  } catch (err: any) {
    return { ok: false, file: edit.file, error: `Could not read ${edit.file}: ${err.message}` };
  }

  // ---- line-range mode -----------------------------------------------------
  if (usesLines) {
    const lines = content.split("\n");
    const from = Math.floor(edit.startLine!);
    const to = Math.floor(edit.endLine!);

    if (from < 1 || to < from) {
      return { ok: false, file: edit.file, error: `startLine ${from} / endLine ${to} is not a valid range.` };
    }
    if (to > lines.length) {
      return {
        ok: false,
        file: edit.file,
        error: `${edit.file} has ${lines.length} lines, so endLine ${to} is past the end.`,
      };
    }

    const replaced = lines.slice(from - 1, to).join("\n");
    if (replaced === edit.replace) {
      return { ok: false, file: edit.file, error: "Those lines already read exactly like `replace`." };
    }

    if (!backupFile(runId, root, resolved.path)) {
      return { ok: false, file: edit.file, error: "Refusing to edit: the backup could not be written." };
    }

    const next = [...lines.slice(0, from - 1), ...edit.replace.split("\n"), ...lines.slice(to)];
    try {
      fs.writeFileSync(resolved.path, next.join("\n"), "utf-8");
    } catch (err: any) {
      return { ok: false, file: edit.file, error: `Could not write ${edit.file}: ${err.message}` };
    }

    return { ok: true, file: edit.file, matches: 1 };
  }

  // ---- exact-string mode ---------------------------------------------------
  if (edit.find === edit.replace) {
    return { ok: false, file: edit.file, error: "find and replace are identical, so this edit would change nothing." };
  }

  const find = edit.find!;
  const matches = content.split(find).length - 1;

  if (matches === 0) {
    return {
      ok: false,
      file: edit.file,
      matches: 0,
      error:
        `find does not appear in ${edit.file}. Copy the text verbatim including indentation, ` +
        `or use startLine/endLine from the numbered excerpt instead.`,
      context: nearestContext(content, find),
    };
  }
  if (matches > 1) {
    return {
      ok: false,
      file: edit.file,
      matches,
      error:
        `find appears ${matches} times in ${edit.file}, so the edit is ambiguous. Include ` +
        `surrounding lines to make it unique, or use startLine/endLine instead.`,
    };
  }

  if (!backupFile(runId, root, resolved.path)) {
    return { ok: false, file: edit.file, error: "Refusing to edit: the backup could not be written." };
  }

  try {
    fs.writeFileSync(resolved.path, content.replace(find, edit.replace), "utf-8");
  } catch (err: any) {
    return { ok: false, file: edit.file, error: `Could not write ${edit.file}: ${err.message}` };
  }

  return { ok: true, file: edit.file, matches: 1 };
}

export interface RevertResult {
  restored: string[];
  /** Files the run created, now deleted. */
  removed: string[];
  failed: Array<{ file: string; error: string }>;
}

/** Copy every backed-up file for a run back over the working tree. */
export function restoreRun(runId: string, root: string): RevertResult {
  const runRoot = path.join(BACKUP_ROOT, runId);
  const result: RevertResult = { restored: [], removed: [], failed: [] };

  if (!fs.existsSync(runRoot)) return result;

  // Undo creations first: a file the run invented has no pristine copy to
  // restore, so leaving it behind would quietly break the revert guarantee.
  for (const relative of createdFiles(runId)) {
    const target = path.join(path.resolve(root), relative);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        result.removed.push(relative);

        // Prune directories the creation brought into being. rmdir refuses a
        // non-empty directory, so a pre-existing folder with other files in it is
        // never at risk.
        let parent = path.dirname(target);
        const stop = path.resolve(root);
        while (parent !== stop && parent.startsWith(stop + path.sep)) {
          try {
            fs.rmdirSync(parent);
          } catch {
            break;
          }
          parent = path.dirname(parent);
        }
      }
    } catch (err: any) {
      result.failed.push({ file: relative, error: err.message });
    }
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      const relative = path.relative(runRoot, full);
      if (relative === CREATED_MANIFEST) continue;
      const target = path.join(path.resolve(root), relative);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        result.restored.push(relative);
      } catch (err: any) {
        result.failed.push({ file: relative, error: err.message });
      }
    }
  };

  walk(runRoot);
  return result;
}

/** Files this run has backed up, i.e. everything it has modified. */
export function touchedFiles(runId: string): string[] {
  const runRoot = path.join(BACKUP_ROOT, runId);
  if (!fs.existsSync(runRoot)) return [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (path.relative(runRoot, full) !== CREATED_MANIFEST) {
        found.push(path.relative(runRoot, full));
      }
    }
  };
  walk(runRoot);

  // Created files are "touched" too, even though they have no backup.
  return [...found, ...createdFiles(runId)];
}

/**
 * A dangling commit capturing the pre-edit working tree, when the target is a
 * git repo. Recorded in the report as a second way back; the backups above are
 * the authoritative one, and no ref is created or moved.
 */
export function gitCheckpoint(root: string): string | null {
  try {
    const sha = execFileSync("git", ["stash", "create"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
    return sha || null;
  } catch {
    // Not a repo, or nothing to stash. Neither is an error here.
    return null;
  }
}
