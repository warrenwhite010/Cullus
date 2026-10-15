// Catching the case where a path the model supplied exists under more than one
// granted root.
//
// The failure this exists for, measured: two Unity projects were reachable —
// `~/TronGame` (live: 28 .cs files, 17 touched that week, a `Temp/` directory
// because the Editor had it open) and `~/Documents/Obsidian_Vault/TronGame` (a
// snapshot from three days earlier: 13 .cs files, no `Temp/`, and no
// `SceneLoader.cs` at all). Asked to find SceneLoader.cs, the model searched the
// snapshot. That search could only ever return nothing, and on any file the
// snapshot DID contain it would have edited a dead copy and reported success.
//
// Nothing in the prompt distinguished them. `describeCapabilities` said "the
// granted directories" without naming any, so the model discovered roots through
// `list_allowed_directories` and picked between two identically-named ones on
// nothing but name similarity. From its side there was no visible ambiguity to
// notice — it never listed both and compared — which is why the "ask rather than
// guess" instruction in the system prompt does not catch this on its own. The
// ambiguity is only visible from here, where the whole grant list is.
//
// Deliberately suffix-based rather than relative-to-root. The two paths above
// share the suffix `TronGame/Assets`, but their root-relative tails are
// `TronGame/Assets` and `Assets` — matching on those finds nothing.

import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config.js";
import { mcpManager } from "./mcpManager.js";
import { existingPaths } from "./mcpServers.js";

/**
 * Shortest suffix that counts as a real collision.
 *
 * One segment is far too loose: every Unity project on the machine has an
 * `Assets`, and asking about that would be noise the user learns to click
 * through. Two segments (`TronGame/Assets`) is the level at which a match means
 * the same project laid out twice.
 */
const MIN_SUFFIX_SEGMENTS = 2;

/** Argument keys that carry a filesystem path, across our tools and the MCP ones. */
const PATH_KEYS = ["path", "file", "filepath", "filePath", "target", "directory", "dir", "root"];

export interface AmbiguousPath {
  /** The path as the model supplied it, absolute. */
  supplied: string;
  /** The path suffix that exists in more than one place. */
  suffix: string;
  /** Every granted root under which that suffix exists, `supplied`'s own first. */
  candidates: PathCandidate[];
}

export interface PathCandidate {
  /** The full path this root would resolve the suffix to. */
  resolved: string;
  /** True when this is the one the model actually asked for. */
  supplied: boolean;
  /** Freshness and size, so the question put to the user is answerable. */
  description: string;
}

/**
 * The roots the filesystem server was actually spawned with.
 *
 * `mcpManager`, not the config file — those two disagree, and the disagreement
 * is the whole reason a vault path was reachable while the config named only two
 * directories. `bootstrapPaths` in index.ts grants `process.cwd()` on every boot
 * on top of whatever config held, so the live grant list includes every
 * directory the app has ever been launched from. Reading config here made this
 * check silently inert against exactly the paths it exists to catch.
 */
export function grantedRoots(): string[] {
  try {
    const live = mcpManager.getAllowedPaths();
    const source = live.length > 0 ? live : loadConfig().allowedPaths;
    return existingPaths(source).map((p) => path.resolve(p));
  } catch {
    return [];
  }
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * A one-line "how live is this?" for a candidate.
 *
 * The user is being asked to choose between two paths that look the same, so the
 * answer has to come with the thing that actually distinguishes them. Modified
 * date and child count are cheap and were exactly what separated the live
 * project from the snapshot.
 */
function describe(target: string): string {
  try {
    const stat = fs.statSync(target);
    const when = stat.mtime.toISOString().slice(0, 10);

    if (!stat.isDirectory()) {
      return `file, ${stat.size.toLocaleString()} bytes, modified ${when}`;
    }

    const children = fs.readdirSync(target).length;
    return `directory, ${children} entr${children === 1 ? "y" : "ies"}, modified ${when}`;
  } catch {
    return "unreadable";
  }
}

/**
 * Does this path exist in more than one granted root? Returns the collision.
 *
 * Null for the overwhelmingly common case of an unambiguous path, so the caller
 * can treat a non-null return as "stop and ask".
 */
export function findAmbiguity(supplied: string): AmbiguousPath | null {
  if (!supplied || !path.isAbsolute(supplied)) return null;

  const target = path.resolve(supplied);
  const roots = grantedRoots();
  if (roots.length < 2) return null;

  // The root the model's path came from. Longest match wins, so a root nested
  // inside another is attributed to the nearer one.
  const owner = roots
    .filter((root) => contains(root, target))
    .sort((a, b) => b.length - a.length)[0];
  if (!owner) return null;

  const segments = target.split(path.sep).filter(Boolean);

  let bestSuffix = "";
  const others: PathCandidate[] = [];

  for (const root of roots) {
    if (root === owner) continue;

    const match = counterpart(root, segments);
    if (!match) continue;

    // A root nested inside the owner (or vice versa) would otherwise report the
    // owner's own file back as a rival for itself.
    if (match.resolved === target) continue;
    if (contains(target, match.resolved) || contains(match.resolved, target)) continue;

    others.push({
      resolved: match.resolved,
      supplied: false,
      description: describe(match.resolved),
    });
    if (match.suffix.length > bestSuffix.length) bestSuffix = match.suffix;
  }

  if (others.length === 0) return null;

  return {
    supplied: target,
    suffix: bestSuffix,
    candidates: [
      { resolved: target, supplied: true, description: describe(target) },
      ...others,
    ],
  };
}

/**
 * Does `root` hold its own copy of the thing `segments` points at?
 *
 * Joining one fixed suffix onto each root is not enough, because the two
 * directions of the same collision do not have the same shape. Given the roots
 * `~/TronGame` and `~/Documents/Obsidian_Vault`:
 *
 *   - from `~/TronGame/Assets`, the suffix `TronGame/Assets` joins cleanly onto
 *     the vault root and resolves.
 *   - from `~/Documents/Obsidian_Vault/TronGame/Assets`, that same suffix joins
 *     onto `~/TronGame` as `~/TronGame/TronGame/Assets`, which does not exist —
 *     the root's own basename is already inside the suffix.
 *
 * The first direction fired and the second did not, which is the direction the
 * model actually went. So: try every tail, longest first, and accept a
 * single-segment tail only when the root's basename matches the segment that
 * would have preceded it — precisely the "this root IS that project" case.
 * Without that condition a bare `Assets` collides with every Unity project on
 * the machine.
 */
function counterpart(
  root: string,
  segments: string[]
): { resolved: string; suffix: string } | null {
  for (let take = Math.min(segments.length, 4); take >= 1; take--) {
    const suffix = segments.slice(segments.length - take).join(path.sep);
    const resolved = path.join(root, suffix);

    let exists = false;
    try {
      exists = fs.existsSync(resolved);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    if (take >= MIN_SUFFIX_SEGMENTS) return { resolved, suffix };

    // Single-segment tail: a collision only if this root is the counterpart of
    // the directory that contained it.
    const parentSegment = segments[segments.length - take - 1];
    if (parentSegment && path.basename(root) === parentSegment) {
      return { resolved, suffix: `${parentSegment}${path.sep}${suffix}` };
    }
  }

  return null;
}

/**
 * The first ambiguous path among a tool call's arguments, if any.
 *
 * Only the declared path keys are inspected. `command` is excluded on purpose:
 * a shell string can mention half a dozen paths and gating on it would fire on
 * `ls` and `grep`, which is how a prompt becomes something the user dismisses
 * without reading.
 */
export function findAmbiguityInArgs(args: unknown): AmbiguousPath | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;

  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    const found = findAmbiguity(value);
    if (found) return found;
  }

  // `paths: []`, as the filesystem server's multi-read tool takes.
  const list = record.paths;
  if (Array.isArray(list)) {
    for (const value of list) {
      if (typeof value !== "string" || !value) continue;
      const found = findAmbiguity(value);
      if (found) return found;
    }
  }

  return null;
}

/** Render a collision as the lines the model (or the user) needs to choose. */
export function describeAmbiguity(found: AmbiguousPath): string {
  return found.candidates
    .map(
      (candidate) =>
        `- ${candidate.resolved} (${candidate.description})${
          candidate.supplied ? "  ← the one you asked for" : ""
        }`
    )
    .join("\n");
}
