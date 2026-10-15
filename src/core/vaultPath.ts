// Giving a vault note path the extension it needs.
//
// Obsidian addresses notes by path INCLUDING the extension. A model asked to put
// something in `2026-08-claude-extension/overview` passes exactly that, and the
// Local REST API obliges: it creates an extensionless file called `overview`,
// right next to the `overview.md` the user meant.
//
// Nothing reports an error, and every symptom points away from the cause:
//
//   - the write returns success, so the model says it worked
//   - vault_read on the same path reads the file back, so "double check that"
//     confirms it
//   - Obsidian renders only .md, so the note the user is looking at is unchanged
//   - Obsidian's search indexes only .md, so searching for the text finds nothing
//
// Observed end to end: four writes across three turns, all "successful", all into
// a file the user could not see, followed by a model inventing an explanation
// (JSON escaping) for why its own search could not find what it had just written.
//
// So the extension is added here, at the dispatch chokepoint, for both reads and
// writes. Writes so the content lands in the real note; reads so a verifying read
// cannot silently confirm a phantom file.
//
// Two things this deliberately does NOT do:
//
//   1. Touch folder-addressing tools. `vault_list` and the search tools take a
//      directory, and `.md` on a directory is simply wrong.
//   2. Guess when a real extension is present. A known extension is left alone;
//      an unknown one is treated as part of the note name, so `v1.2 plan` becomes
//      `v1.2 plan.md` rather than being mistaken for a `.2 plan` file.

/** Vault-scoped tools, matching the catalogue in config.ts. */
const VAULT_SCOPED_TOOL = /^(note_|vault_|periodic_note_|active_file_)|obsidian/i;

/**
 * Tools that address a FOLDER rather than a note, and must keep their path as-is.
 *
 * Listing and searching are the whole of it: everything else in the vault surface
 * addresses a single note.
 */
const FOLDER_SCOPED_TOOL = /(list|directories|dirs|tree|folder|search|find|glob|tags)/i;

/**
 * Tools where completing the path would ENLARGE what the call destroys.
 *
 * Adding `.md` to a create-or-write is a correction: the extensionless file was
 * never what the user meant. Adding it to a delete is the opposite — it retargets
 * the call from the stray file onto the real note beside it. Asked to remove the
 * phantom `…/overview` this module's own bug created, the guard would rewrite it
 * to `…/overview.md` and delete the note instead.
 *
 * So a delete gets the path it was given, exactly. If that path is wrong the call
 * fails and says so, which is the correct outcome for a destructive one.
 */
const DESTRUCTIVE_TOOL = /(delete|remove|trash|unlink|destroy|purge)/i;

/** Argument names that carry a note path. */
const PATH_KEYS = [
  "path",
  "file",
  "filepath",
  "filePath",
  "file_path",
  "filename",
  "fileName",
  "note",
  "target",
  "oldPath",
  "newPath",
  "old_path",
  "new_path",
  "destination",
];

/**
 * Extensions that mean "this path is already complete".
 *
 * A list of what a vault actually holds, rather than "anything after a dot":
 * note titles contain dots, and treating `v1.2 plan` as extensioned recreates the
 * exact bug this module exists to stop.
 */
const VAULT_EXTENSIONS = new Set([
  "md", "markdown", "canvas", "base", "excalidraw",
  "txt", "json", "csv", "pdf", "html",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif",
  "mp3", "m4a", "wav", "ogg", "mp4", "mov", "webm",
]);

/** Does this path already name a file the vault would recognise? */
function hasVaultExtension(notePath: string): boolean {
  const base = notePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return VAULT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Add `.md` unless the path already names a vault file. Exported for tests. */
export function ensureNoteExtension(notePath: string): string {
  const trimmed = notePath.trim();

  // A trailing slash is the caller saying "folder", so leave it be. Same for an
  // empty value and for a path the tool resolves itself.
  if (!trimmed || trimmed.endsWith("/")) return notePath;
  if (hasVaultExtension(trimmed)) return notePath;

  return `${trimmed}.md`;
}

export interface VaultPathResult {
  args: any;
  /** Human-readable notes for the activity log; empty when nothing changed. */
  changed: string[];
}

/**
 * Normalise note paths in the arguments of a vault tool call.
 *
 * Returns the arguments to dispatch. Anything that is not a note-addressing vault
 * tool passes through untouched.
 */
export function guardVaultPath(toolName: string, rawArgs: any): VaultPathResult {
  const changed: string[] = [];

  if (!VAULT_SCOPED_TOOL.test(toolName)) return { args: rawArgs, changed };
  if (FOLDER_SCOPED_TOOL.test(toolName)) return { args: rawArgs, changed };
  if (DESTRUCTIVE_TOOL.test(toolName)) return { args: rawArgs, changed };
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: rawArgs, changed };
  }

  const args = { ...rawArgs };

  for (const key of PATH_KEYS) {
    if (typeof args[key] !== "string") continue;

    const next = ensureNoteExtension(args[key]);
    if (next !== args[key]) {
      changed.push(`"${args[key]}" → "${next}"`);
      args[key] = next;
    }
  }

  return { args, changed };
}
