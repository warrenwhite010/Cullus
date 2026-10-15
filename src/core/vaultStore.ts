// Reading and writing the assistant's own memory inside the vault.
//
// Two access routes, deliberately:
//
//   Reads prefer the `obsidian-live` tools, because they are authoritative for
//   whichever vault Obsidian actually has open, and they see the plugin's own view
//   of the file. They fall back to reading `config.vaultPath` from disk, because
//   the system-prompt context must load even with Obsidian closed — a turn that
//   loses its standing instructions because an app is shut is not acceptable.
//
//   Writes always go through the filesystem. One code path, working whether or not
//   Obsidian is running, and independent of the obsidian-live read-only toggle —
//   so the approval gate in core/approval.ts is the only thing that can permit a
//   write, rather than there being two ways in with different rules.

import * as fs from "fs";
import * as path from "path";
import { loadConfig, getVaultPath, type VaultPathKey } from "./config.js";
import { mcpManager } from "./mcpManager.js";

export type { VaultPathKey };

/** The configured vault-relative path for a role, or null when unset. */
export function vaultPathFor(key: VaultPathKey): string | null {
  return loadConfig().vaultPaths?.[key] ?? null;
}

/**
 * Resolve a vault-relative path to an absolute one, refusing escapes.
 *
 * Everything here is relative to the vault root, so `..` is always a mistake or an
 * attack; either way it stops at this boundary rather than at the filesystem.
 */
export function resolveInVault(
  relative: string
): { ok: true; absolute: string; relative: string } | { ok: false; error: string } {
  const vault = getVaultPath();
  if (!vault) {
    return {
      ok: false,
      error:
        "No vault folder is configured, so vault notes cannot be read or written. " +
        "Set it in Settings → Connections → Obsidian Vault.",
    };
  }

  const cleaned = String(relative ?? "").trim().replace(/^\/+/, "");
  if (!cleaned) return { ok: false, error: "A vault-relative path is required." };

  const root = path.resolve(vault);
  const absolute = path.resolve(root, cleaned);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { ok: false, error: `"${relative}" resolves outside the vault.` };
  }

  return { ok: true, absolute, relative: path.relative(root, absolute) };
}

// ---------------------------------------------------------------------------
// Reads, with a small cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  mtimeMs: number;
  value: string;
}

const CACHE_TTL_MS = 30_000;
const readCache = new Map<string, CacheEntry>();

function cachedRead(absolute: string): string | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(absolute).mtimeMs;
  } catch {
    readCache.delete(absolute);
    return null;
  }

  const hit = readCache.get(absolute);
  // mtime as well as age: an edit in Obsidian must show up immediately, and a
  // file nobody touches must not be re-read on every turn.
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const value = fs.readFileSync(absolute, "utf-8");
    readCache.set(absolute, { at: Date.now(), mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

/** Contents of one vault note, or null when it does not exist. */
export async function readVaultFile(relative: string): Promise<string | null> {
  const resolved = resolveInVault(relative);
  if (!resolved.ok) return null;

  // Prefer the plugin when it is connected: it reflects the vault Obsidian has
  // open, which may not be the folder configured here.
  if (mcpManager.getConnectedServers().includes("obsidian-live")) {
    try {
      const result: any = await mcpManager.callTool("vault_read", { path: resolved.relative });
      const text = result?.content?.[0]?.text ?? result?.text;
      if (typeof text === "string" && text.length > 0) return text;
    } catch {
      // Fall through to disk: a dead session or a missing tool must not cost us
      // the context note.
    }
  }

  return cachedRead(resolved.absolute);
}

/** Names of `.md` files directly inside a vault folder, sorted. */
export function listVaultNotes(relative: string): string[] {
  const resolved = resolveInVault(relative);
  if (!resolved.ok) return [];

  try {
    return fs
      .readdirSync(resolved.absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Does this vault path exist, and is it a file or a folder? */
export function inspectVaultPath(
  relative: string
): { exists: boolean; kind: "file" | "folder" | "missing"; notes?: number; error?: string } {
  const resolved = resolveInVault(relative);
  if (!resolved.ok) return { exists: false, kind: "missing", error: resolved.error };

  try {
    const stat = fs.statSync(resolved.absolute);
    if (stat.isDirectory()) {
      return { exists: true, kind: "folder", notes: listVaultNotes(relative).length };
    }
    return { exists: true, kind: "file" };
  } catch {
    return { exists: false, kind: "missing" };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface WriteResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
  actionRequired?: string;
}

/**
 * Write or append a vault note.
 *
 * Callers must have passed the approval gate already — this function does not ask.
 * It creates parent folders, because the configured notes folder may not exist
 * until the first note is written.
 */
export function writeVaultNote(
  relative: string,
  content: string,
  options?: { append?: boolean }
): WriteResult {
  const resolved = resolveInVault(relative);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      actionRequired: "Ask the user to set the vault folder, or use a path inside the vault.",
    };
  }

  if (typeof content !== "string" || !content.trim()) {
    return {
      ok: false,
      error: "content is required and must not be empty.",
      actionRequired: 'Call again with {"content": "<the note body>"}.',
    };
  }

  const target = resolved.absolute.endsWith(".md") ? resolved.absolute : `${resolved.absolute}.md`;
  const body = content.endsWith("\n") ? content : `${content}\n`;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (options?.append && fs.existsSync(target)) {
      fs.appendFileSync(target, `\n${body}`, "utf-8");
    } else {
      fs.writeFileSync(target, body, "utf-8");
    }
    readCache.delete(target);
  } catch (err: any) {
    return { ok: false, error: `Could not write ${resolved.relative}: ${err.message}` };
  }

  const vault = getVaultPath()!;
  return { ok: true, path: path.relative(path.resolve(vault), target), bytes: body.length };
}

// ---------------------------------------------------------------------------
// Context for the system prompt
// ---------------------------------------------------------------------------

/** Ceiling on injected context. Beyond this the prompt says it was cut. */
export const CONTEXT_CHAR_LIMIT = 6000;

/**
 * Smaller ceiling for the profile. It is injected on top of the context note on
 * every turn, so it gets its own budget rather than competing for the same 6000
 * characters — a profile that grows must not silently evict standing instructions.
 */
export const PROFILE_CHAR_LIMIT = 2500;

export interface VaultContext {
  text: string;
  /** Notes that contributed, for the debug trace. */
  sources: string[];
  truncated: boolean;
}

/**
 * Read one configured role into prompt-ready text: a single note, or every note
 * in a folder with its filename as a heading.
 *
 * Shared by context and personal because they differ only in which key they read
 * and how many characters they are allowed — not in how a folder becomes text.
 */
export function loadVaultRole(key: VaultPathKey, limit: number): VaultContext | null {
  const configured = vaultPathFor(key);
  if (!configured) return null;

  const info = inspectVaultPath(configured);
  if (!info.exists) return null;

  const parts: string[] = [];
  const sources: string[] = [];

  const add = (relative: string, label: string) => {
    const resolved = resolveInVault(relative);
    if (!resolved.ok) return;
    const body = cachedRead(resolved.absolute);
    if (!body?.trim()) return;
    parts.push(`## ${label}\n\n${body.trim()}`);
    sources.push(relative);
  };

  if (info.kind === "file") {
    add(configured, path.basename(configured, ".md"));
  } else {
    for (const name of listVaultNotes(configured)) {
      add(`${configured}/${name}`, name.replace(/\.md$/, ""));
    }
  }

  if (parts.length === 0) return null;

  const joined = parts.join("\n\n");
  const truncated = joined.length > limit;

  // Say it was cut rather than cutting silently: a model that has half a rule is
  // more dangerous than one that knows it is missing something.
  const text = truncated
    ? `${joined.slice(0, limit)}\n\n[Truncated at ${limit} characters. ` +
      `${sources.length} note(s) totalling ${joined.length} characters — the rest was not included.]`
    : joined;

  return { text, sources, truncated };
}

/** The standing context to prepend to every turn. */
export function loadVaultContext(): VaultContext | null {
  return loadVaultRole("context", CONTEXT_CHAR_LIMIT);
}

/** The user profile, prepended to every turn so the model stays consistent. */
export function loadPersonalProfile(): VaultContext | null {
  return loadVaultRole("personal", PROFILE_CHAR_LIMIT);
}

/** Clear the read cache, e.g. after the vault paths change. */
export function invalidateVaultCache(): void {
  readCache.clear();
}
