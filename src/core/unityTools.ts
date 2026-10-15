// Unity: resolve a symbol offline, and compile for real.
//
// Written after watching a fan-out spend 23 minutes and five workers on
// `CS0103: The name 'RenderQueue' does not exist in the current context`. The
// answer was `using UnityEngine.Rendering;` — one line, knowable in under a
// second from files already on this machine. What the workers actually did was
// grep the project four times over, fail `web_search` on every call, and then
// hand-fetch DuckDuckGo, Mojeek and Ecosia through `fetch_url`.
//
// The lesson is not "the models are bad at Unity". It is that the assistant had
// no way to answer a Unity question except by guessing or searching the web, so
// that is what it did. These two tools close that gap:
//
//   unity_symbol   which namespace a type lives in — read-only, offline, ~1s
//   unity_compile  what the compiler actually says — the only real verification
//
// unity_symbol reads the XML documentation files Unity ships beside every
// managed assembly. They carry fully-qualified type ids in plain text
// (`<member name="T:UnityEngine.Rendering.RenderQueue">`), which makes a
// namespace lookup a text search rather than an ECMA-335 metadata parse.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFileSync } from "child_process";
import { localToolRegistry } from "./tools.js";
import { resolveTarget } from "./projectTarget.js";
import {
  unityCliPath,
  unityCommandCatalogue,
  unityToolAllowed,
  unityModeTradeoff,
  type UnityCommand,
} from "./mcpServers.js";
import { loadConfig } from "./config.js";

/** Where Unity Hub installs editors, per platform. */
function editorSearchRoots(): string[] {
  const roots: string[] = [];
  const override = process.env.CULLUS_UNITY_EDITOR_DIR ?? process.env.ASSISTANT_UNITY_EDITOR_DIR;
  if (override) roots.push(override);

  if (process.platform === "darwin") {
    roots.push("/Applications/Unity/Hub/Editor");
    roots.push(path.join(os.homedir(), "Applications/Unity/Hub/Editor"));
  } else if (process.platform === "win32") {
    roots.push("C:\\Program Files\\Unity\\Hub\\Editor");
  } else {
    roots.push(path.join(os.homedir(), "Unity/Hub/Editor"));
  }

  return roots.filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface UnityProject {
  root: string;
  version: string;
}

/**
 * Walk up from `start` looking for `ProjectSettings/ProjectVersion.txt`.
 *
 * That file, not the presence of an `Assets/` directory, is what makes a
 * directory a Unity project: it also names the exact editor version, which is
 * the thing both tools need next.
 */
export function findUnityProject(start: string): UnityProject | null {
  let current = path.resolve(start);

  for (let depth = 0; depth < 12; depth++) {
    const marker = path.join(current, "ProjectSettings", "ProjectVersion.txt");
    try {
      const raw = fs.readFileSync(marker, "utf-8");
      const version = raw.match(/^m_EditorVersion:\s*(\S+)/m)?.[1];
      if (version) return { root: current, version };
    } catch {
      /* not here; keep walking up */
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/** The editor executable for `version`, or the closest installed one. */
export function findEditor(version: string): { path: string; version: string; exact: boolean } | null {
  const direct = process.env.CULLUS_UNITY_EDITOR ?? process.env.ASSISTANT_UNITY_EDITOR;
  if (direct && fs.existsSync(direct)) return { path: direct, version, exact: false };

  const binary =
    process.platform === "darwin"
      ? path.join("Unity.app", "Contents", "MacOS", "Unity")
      : process.platform === "win32"
        ? path.join("Editor", "Unity.exe")
        : path.join("Editor", "Unity");

  const installed: string[] = [];
  for (const root of editorSearchRoots()) {
    try {
      for (const entry of fs.readdirSync(root)) {
        if (fs.existsSync(path.join(root, entry, binary))) installed.push(path.join(root, entry));
      }
    } catch {
      /* unreadable install root */
    }
  }

  const exact = installed.find((dir) => path.basename(dir) === version);
  if (exact) return { path: path.join(exact, binary), version, exact: true };

  // A near-miss is worth reporting rather than swallowing: compiling 6000.3.12f1
  // sources with 6000.3.1f1 mostly works and sometimes does not, and the caller
  // should be told which happened.
  const sameMajor = installed
    .filter((dir) => path.basename(dir).split(".")[0] === version.split(".")[0])
    .sort()
    .pop();

  if (sameMajor) {
    return { path: path.join(sameMajor, binary), version: path.basename(sameMajor), exact: false };
  }

  return null;
}

/** Directories of `.xml` doc files shipped with an editor install. */
function docDirectories(editorBinary: string): string[] {
  // .../Unity.app/Contents/MacOS/Unity -> .../Unity.app/Contents
  const contents = path.resolve(path.dirname(editorBinary), "..");

  return [
    path.join(contents, "Resources", "Scripting", "Managed", "UnityEngine"),
    path.join(contents, "Resources", "Scripting", "Managed"),
    path.join(contents, "Managed", "UnityEngine"),
    path.join(contents, "Managed"),
    // Windows/Linux installs put the same tree under Editor/Data.
    path.join(contents, "Data", "Managed", "UnityEngine"),
    path.join(contents, "Data", "Managed"),
  ].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface SymbolMatch {
  /** e.g. `UnityEngine.Rendering.RenderQueue` */
  fullName: string;
  /** e.g. `UnityEngine.Rendering` — empty for a global-namespace type. */
  namespace: string;
  /** e.g. `UnityEngine.CoreModule` */
  assembly: string;
}

/**
 * short type name -> every fully-qualified type with that name.
 *
 * Built once per editor install and kept: the doc tree is ~50 MB of XML, which
 * is a second of I/O the first time and unacceptable on every lookup. Keyed by
 * editor path so two installed versions do not contaminate each other.
 */
const symbolIndexes = new Map<string, Map<string, SymbolMatch[]>>();

export function buildSymbolIndex(editorBinary: string): Map<string, SymbolMatch[]> {
  const cached = symbolIndexes.get(editorBinary);
  if (cached) return cached;

  const index = new Map<string, SymbolMatch[]>();
  // `<member name="T:Some.Name.Space.TypeName">` — types only. Methods (M:),
  // properties (P:) and fields (F:) are noise for a "which using?" question.
  const typeRe = /name="T:([A-Za-z0-9_.`+]+)"/g;

  for (const dir of docDirectories(editorBinary)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".xml"));
    } catch {
      continue;
    }

    for (const file of files) {
      const assembly = file.replace(/\.xml$/, "");
      let xml: string;
      try {
        xml = fs.readFileSync(path.join(dir, file), "utf-8");
      } catch {
        continue;
      }

      for (const match of xml.matchAll(typeRe)) {
        // Generic arity (`List\`1`) and nested-type separators are not part of
        // the name you type in source.
        const fullName = match[1].replace(/`\d+/g, "").replace(/\+/g, ".");
        const short = fullName.split(".").pop() ?? "";
        if (!short) continue;

        const namespace = fullName.slice(0, Math.max(fullName.length - short.length - 1, 0));
        const bucket = index.get(short) ?? [];
        if (!bucket.some((m) => m.fullName === fullName && m.assembly === assembly)) {
          bucket.push({ fullName, namespace, assembly });
        }
        index.set(short, bucket);
      }
    }
  }

  symbolIndexes.set(editorBinary, index);
  return index;
}

// ---------------------------------------------------------------------------
// Package and project types
// ---------------------------------------------------------------------------
//
// The editor's XML docs cover what Unity ships in the install. They do NOT
// cover packages, and packages are where the questions are: asked to wire up a
// camera-look script, a model spent roughly two thousand tokens of visible
// reasoning arguing with itself about whether `InputActionsAsset`,
// `PlayerInput.InstantiateDefault` and `InputSystem.LoadAssetAtPath` exist —
// "I'm not 100% sure", "I genuinely am not certain", "let me not guess" — and
// then settled on `using Unity.InputSystem;`, which does not compile. The real
// namespace is `UnityEngine.InputSystem`, and it was sitting in
// Library/PackageCache the whole time.
//
// unity_symbol answered "No type named PlayerInput exists in this Unity
// install's assemblies" — true as written, and read by the model as "that API
// is not real". A tool that claims to be authoritative for this machine has to
// look where the code actually is.
//
// Packages ship C# source rather than compiled assemblies with XML beside them,
// so this is a source scan: the declaration and its enclosing namespace, which
// is exactly the "which using?" question and nothing more.

/** Directories holding C# a project can compile against. */
function sourceRoots(projectRoot: string): { dir: string; label: string }[] {
  const roots: { dir: string; label: string }[] = [];

  const cache = path.join(projectRoot, "Library", "PackageCache");
  try {
    for (const entry of fs.readdirSync(cache)) {
      // `com.unity.inputsystem@21a28c3a6c83` -> `com.unity.inputsystem`
      roots.push({ dir: path.join(cache, entry), label: entry.split("@")[0] });
    }
  } catch {
    /* no resolved packages */
  }

  for (const local of ["Packages", "Assets"]) {
    const dir = path.join(projectRoot, local);
    try {
      if (fs.statSync(dir).isDirectory()) roots.push({ dir, label: local });
    } catch {
      /* absent */
    }
  }

  return roots;
}

/** Every `.cs` under `dir`, bounded so a pathological tree cannot hang a turn. */
function csFiles(dir: string, budget: { left: number }): string[] {
  const found: string[] = [];
  const stack = [dir];

  while (stack.length && budget.left > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (budget.left <= 0) break;
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        // `Tests~`/`Samples~` are excluded from compilation by Unity, so a type
        // found there is not one the project can actually reference.
        if (entry.name.endsWith("~") || entry.name === "Tests" || entry.name === ".git") continue;
        stack.push(full);
      } else if (entry.name.endsWith(".cs")) {
        found.push(full);
        budget.left--;
      }
    }
  }

  return found;
}

// `public sealed partial class Foo` / `public enum Bar` / `public delegate void Baz`.
// Only `public`: an internal type is not referenceable from Assets, so offering
// it as the answer to a missing-using question would be a wrong answer.
const TYPE_DECL =
  /^[ \t]*public\s+(?:(?:sealed|abstract|static|partial|unsafe|readonly|ref)\s+)*(?:class|struct|interface|enum|delegate(?:\s+[\w<>\[\],. ]+?)?)\s+([A-Za-z_]\w*)/gm;
const NAMESPACE_DECL = /^[ \t]*namespace\s+([\w.]+)\s*[;{]/gm;

function indexSourceTree(root: { dir: string; label: string }, index: Map<string, SymbolMatch[]>, budget: { left: number }): void {
  for (const file of csFiles(root.dir, budget)) {
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 512 * 1024) continue;
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // Namespace by position: a file may declare several, and a type belongs to
    // the last one opened before it. Handles both block and file-scoped forms.
    const namespaces: { at: number; name: string }[] = [];
    for (const m of text.matchAll(NAMESPACE_DECL)) namespaces.push({ at: m.index ?? 0, name: m[1] });

    for (const m of text.matchAll(TYPE_DECL)) {
      const short = m[1];
      const at = m.index ?? 0;

      let namespace = "";
      for (const ns of namespaces) {
        if (ns.at < at) namespace = ns.name;
        else break;
      }

      const fullName = namespace ? `${namespace}.${short}` : short;
      const bucket = index.get(short) ?? [];
      if (!bucket.some((e) => e.fullName === fullName && e.assembly === root.label)) {
        bucket.push({ fullName, namespace, assembly: root.label });
      }
      index.set(short, bucket);
    }
  }
}

const packageIndexes = new Map<string, Map<string, SymbolMatch[]>>();

/** Types declared by this project's packages and its own scripts. */
export function buildPackageIndex(projectRoot: string): Map<string, SymbolMatch[]> {
  const cached = packageIndexes.get(projectRoot);
  if (cached) return cached;

  const index = new Map<string, SymbolMatch[]>();
  // Generous, but finite. A full URP + Input System + test-framework project is
  // roughly 12k files; the cap only bites on something pathological.
  const budget = { left: 40_000 };

  for (const root of sourceRoots(projectRoot)) indexSourceTree(root, index, budget);

  packageIndexes.set(projectRoot, index);
  return index;
}

// ---------------------------------------------------------------------------
// unity_compile
// ---------------------------------------------------------------------------

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/**
 * Pull `Assets/Foo.cs(71,37): error CS0103: …` out of an editor log.
 *
 * Unity repeats each diagnostic several times in one log (compiler output, the
 * console, and the final summary), so identical lines are collapsed — a model
 * handed the same error four times treats it as four problems.
 */
export function parseCompilerDiagnostics(log: string): CompileDiagnostic[] {
  const re = /^(.*?)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.*)$/gm;
  const seen = new Set<string>();
  const found: CompileDiagnostic[] = [];

  for (const match of log.matchAll(re)) {
    const entry: CompileDiagnostic = {
      file: match[1].trim(),
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5].trim(),
    };

    const key = `${entry.file}:${entry.line}:${entry.column}:${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(entry);
  }

  return found;
}

/**
 * Is an Editor actually holding this project open? Batchmode cannot then run.
 *
 * The lockfile alone is not the answer, which is what this used to return.
 * Unity does not remove `Temp/UnityLockfile` when it crashes or is force-quit,
 * so the file long outlives the process — measured on this machine: a 0-byte
 * lockfile, no process holding it, and no Editor in the process table at all.
 *
 * Trusting the file produced a refusal that contradicted the next tool call:
 * `unity_compile` said "the Editor currently has this project open" while
 * `unity_commands` said "no Editor is answering", and the refusal's own advice
 * ("the Editor is open, which means its own MCP tools are live") pointed at a
 * route that `editorCompileRoute()` had already computed as empty. The model
 * alternated between the two for four steps, which is the correct response to
 * being handed two mutually exclusive facts.
 *
 * So: the file is the cheap precondition, and a real holder is the evidence.
 */
function lockedBy(root: string): LockState {
  const lockfile = path.join(root, "Temp", "UnityLockfile");
  if (!fs.existsSync(lockfile)) return { locked: false, lockfile, reason: "no lockfile" };

  const holders = lockfileHolders(lockfile);

  if (holders === null) {
    // The liveness check itself could not run. Keep the old, cautious answer —
    // a false "locked" costs a redirect, a false "unlocked" starts a second
    // Editor against a project another one may genuinely have open.
    return {
      locked: true,
      lockfile,
      reason: "lockfile present; could not determine whether a process holds it",
      unverified: true,
    };
  }

  if (holders.length > 0) {
    return { locked: true, lockfile, reason: `held by pid ${holders.join(", ")}` };
  }

  return {
    locked: false,
    lockfile,
    reason: "lockfile present but no process holds it — stale, left by a crash or force-quit",
    stale: true,
  };
}

interface LockState {
  locked: boolean;
  lockfile: string;
  /** Plain-language basis for the verdict, quoted into tool output. */
  reason: string;
  /** The lockfile exists but nothing holds it. */
  stale?: boolean;
  /** The liveness check could not run, so `locked` is the cautious default. */
  unverified?: boolean;
}

/**
 * PIDs with the lockfile open, or null when that cannot be established.
 *
 * `lsof` distinguishes "held" from "left behind", which nothing on the
 * filesystem can. Null rather than an empty array when lsof is missing or
 * errors, so the caller can tell "nobody holds it" from "I could not look" —
 * conflating those is how a stale-lock check becomes a way to stomp a live one.
 *
 * lsof exits 1 both when a file has no holders and on some errors, so the
 * distinction is drawn on whether it produced parseable output, not on the code.
 */
function lockfileHolders(lockfile: string): number[] | null {
  try {
    const out = execFileSync("lsof", ["-t", "--", lockfile], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (err: any) {
    // Exit 1 with no output is lsof's "no process has this open" — the stale
    // case, and the whole point of the check.
    if (err?.status === 1 && !String(err?.stdout ?? "").trim()) return [];
    return null;
  }
}

/**
 * What to compile with instead, when the Editor holds the project.
 *
 * A refusal that names no alternative is how "the Editor has this open" became
 * "the project cannot be compiled" — so the locked path hands back the Editor's
 * own equivalents. Resolved against the live catalogue at call time: on
 * 6000.3.12f1 these are `recompile`, `recompile_status` and `get_console_logs`,
 * but an Editor that does not expose one must not be told it does.
 */
function editorCompileRoute(): { name: string; description: string }[] {
  const wanted = ["recompile", "recompile_status", "get_console_logs", "console"];
  const catalogue = unityCommandCatalogue();

  return wanted
    .map((name) => catalogue.find((c) => c.name === name))
    .filter((c): c is UnityCommand => Boolean(c))
    .map((c) => ({ name: c.name, description: c.description }));
}

/**
 * Run one command on the live Editor through the CLI, returning its `result`.
 *
 * The same Pipeline server the Unity MCP server talks to, reached the same way
 * `unityCommandCatalogue` reaches it. Shelling out rather than routing through
 * mcpManager keeps this working when the Unity MCP server is disabled or
 * filtered — the Editor is what matters here, not our view of it.
 */
function editorCommand(
  projectRoot: string,
  name: string,
  timeoutSeconds: number
): { ok: true; result: any } | { ok: false; error: string } {
  const cli = unityCliPath();
  if (!cli) return { ok: false, error: "The Unity CLI is not installed." };

  try {
    const raw = execFileSync(
      cli,
      [
        "command",
        name,
        "--json",
        "--project-path",
        projectRoot,
        "--timeout",
        String(timeoutSeconds),
        "--non-interactive",
        "--no-banner",
      ],
      {
        encoding: "utf-8",
        timeout: (timeoutSeconds + 15) * 1000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );

    const parsed = JSON.parse(raw);
    if (parsed?.success === false || parsed?.data?.success === false) {
      const why = Array.isArray(parsed?.errors) && parsed.errors.length
        ? parsed.errors.map((e: any) => e?.message ?? String(e)).join("; ")
        : `${name} reported failure.`;
      return { ok: false, error: why };
    }

    // `result` arrives either as a JSON string or as an object, depending on the
    // command. Normalise so callers do not each have to guess.
    let result = parsed?.data?.result;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        /* a plain string result is a legitimate shape */
      }
    }
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Console lines the Editor is holding, newest last, as compiler-log text. */
function editorConsoleAsLog(projectRoot: string): string {
  const logs = editorCommand(projectRoot, "get_console_logs", 30);
  if (!logs.ok) return "";

  const entries = Array.isArray(logs.result?.logs) ? logs.result.logs : [];
  return entries
    .map((entry: any) => String(entry?.message ?? ""))
    .join("\n");
}

/**
 * Compile without closing the Editor.
 *
 * The refusal this replaces was correct and useless in equal measure: batch mode
 * genuinely cannot open a project the Editor holds, so `unity_compile` told the
 * user to close Unity and try again — every time, on a project they were
 * actively working in.
 *
 * But the Editor that is blocking batch mode is itself a compiler, reachable
 * over the Pipeline server: `recompile` triggers it, `recompile_status` reports
 * progress, `get_console_logs` carries the diagnostics. Delegating is strictly
 * better than the close/compile/reopen dance it was asked to do instead — no
 * unsaved scene work at risk, no thirty-second domain reload, and the Editor is
 * where a developer wants to be anyway.
 *
 * Returns the same shape as the batch path so nothing downstream has to care
 * which compiler produced the answer.
 */
async function compileViaEditor(
  projectRoot: string,
  timeoutMs: number
): Promise<
  | { ok: true; log: string; waitedMs: number; recompiled: boolean; triggerStatus: string }
  | { ok: false; error: string }
> {
  const started = Date.now();

  const triggered = editorCommand(projectRoot, "recompile", 60);
  if (!triggered.ok) return { ok: false, error: `recompile failed: ${triggered.error}` };

  // `up_to_date` means no scripts needed compiling, so the console holds
  // whatever it held before rather than the result of a fresh compile. Reported
  // rather than smoothed over — Unity's own CLI channel has two separate threads
  // about people being misled by exactly this.
  const triggerStatus = String(triggered.result?.status ?? "unknown");
  const recompiled = triggerStatus !== "up_to_date";

  // Poll rather than trust the trigger's return: a recompile is asynchronous and
  // the console is only worth reading once it has settled.
  //
  // Transient failures here are EXPECTED, not fatal. A recompile tears the
  // Pipeline server down and rebinds it, giving a ~1–2s window in which the CLI
  // cannot reach the Editor at all — and discovery is purely file-based on
  // `Library/Pipeline/.unity-pipeline-port` with no fallback port scan, so there
  // is nothing to fall back to while the descriptor is being rewritten. Treating
  // the first such failure as "compile failed" would have made delegation break
  // on precisely the compiles that actually did something.
  const RECONNECT_GRACE_MS = 20_000;
  let last = triggerStatus;
  let unreachableSince = 0;
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const status = editorCommand(projectRoot, "recompile_status", 30);

    if (!status.ok) {
      lastError = status.error;
      if (unreachableSince === 0) unreachableSince = Date.now();

      // Still inside the teardown window: keep waiting for it to come back.
      if (Date.now() - unreachableSince < RECONNECT_GRACE_MS) continue;

      return {
        ok: false,
        error:
          `the Editor stopped answering for over ` +
          `${Math.round(RECONNECT_GRACE_MS / 1000)}s during the recompile ` +
          `(last error: ${lastError}). A recompile restarts the Editor's Pipeline ` +
          `server, so this usually means it did not come back.`,
      };
    }

    unreachableSince = 0;
    last = String(status.result?.status ?? "unknown");

    if (last !== "compiling" && last !== "pending" && last !== "running") {
      return {
        ok: true,
        log: editorConsoleAsLog(projectRoot),
        waitedMs: Date.now() - started,
        recompiled,
        triggerStatus,
      };
    }
  }

  return {
    ok: false,
    error: `the Editor was still "${last}" after ${Math.round(timeoutMs / 1000)}s`,
  };
}

function runEditor(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "ignore" });
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// unity_commands
// ---------------------------------------------------------------------------
//
// The Editor exposes 149 commands. The per-turn tool budget is 28. Those two
// numbers mean the model is *structurally* unable to see most of what Unity can
// do, and what it saw instead was a truncated slice chosen by a keyword ranker —
// which is how "create a cube" produced "no such tool" while `create_gameobject`
// sat connected and one call away.
//
// A catalogue tool fixes that at the right layer. One cheap, always-present tool
// answers "what can Unity do, and what arguments does it take?" from the same
// `unity command --json` data the MCP server is serving, so the model can look
// the name up instead of guessing it — and so can a person, via /tools.

/** How well `command` answers `needle`. 0 means no match. */
function scoreCommand(command: UnityCommand, needle: string): number {
  const name = command.name.toLowerCase();
  if (name === needle) return 100;

  let score = 0;
  if (name.includes(needle)) score += 40;
  // Word-part hits: "gameobject" should find create_gameobject AND set_parent's
  // description, but a name hit is worth more than a prose one.
  //
  // Words under three characters are dropped rather than scored. "create a
  // cube" matched 147 of 149 commands with them in: almost every command name
  // contains an "a", so the filler word in a natural-language query silently
  // turned the search back into the full list it was meant to narrow.
  for (const word of needle.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)) {
    if (name.includes(word)) score += 10;
    if (command.description.toLowerCase().includes(word)) score += 4;
    if (command.tags.some((t) => t.toLowerCase().includes(word))) score += 6;
  }
  return score;
}

function describeParameters(command: UnityCommand) {
  return command.parameters.map((p) => ({
    name: p.name,
    type: p.type,
    required: p.required,
    ...(p.default !== undefined ? { default: p.default } : {}),
    description: p.description,
  }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerUnityTools(): void {
  localToolRegistry.register({
    name: "unity_commands",
    description:
      "List or search everything the running Unity Editor can do — the full command catalogue " +
      "(scenes, GameObjects, components, prefabs, assets, scripts, materials, builds, tests, " +
      "play mode, screenshots). Call this FIRST for any Unity task before concluding a " +
      "capability is missing: only a subset of these commands is attached to any one turn, so " +
      "a tool you cannot see may still exist and will run if you name it. Returns each " +
      "command's name, purpose and arguments.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you want to do, or a command name — e.g. 'create a cube', 'gameobject', " +
            "'save scene', 'create_gameobject'. Omit to get the whole catalogue by category.",
        },
        limit: {
          type: "number",
          description: "How many matches to return (default 15, max 40).",
        },
      },
      required: [],
    },
    handler: async (args) => {
      const catalogue = unityCommandCatalogue();

      if (catalogue.length === 0) {
        return {
          error: true,
          message: "The Unity command catalogue is empty — no Editor is answering.",
          hint:
            "`unity command --json` returned nothing. The Editor must be open on a project " +
            "with the com.unity.pipeline package installed.",
          // Without this the model reads "no Unity tools" as "no Unity support"
          // and gives up, when unity_compile and unity_symbol are working right
          // now *because* the Editor is closed.
          modes: unityModeTradeoff(),
          actionRequired:
            "The Editor is closed, so unity_compile and unity_symbol ARE available and are the " +
            "right tools for a compiler error — use them. Only ask the user to open the project " +
            "in Unity if the task needs the Editor itself (scenes, GameObjects, play mode), then " +
            "run /doctor. Do not guess at Unity command names or search the web for them.",
        };
      }

      const config = loadConfig();
      const exposed = (name: string) => unityToolAllowed(name, config);
      const query = String(args?.query ?? "").trim().toLowerCase();

      // No query: the whole catalogue, grouped by top-level tag. Names only —
      // 149 descriptions is a wall of text, and the name plus its category is
      // enough to pick a candidate and ask again.
      if (!query) {
        const groups = new Map<string, string[]>();
        for (const command of catalogue) {
          const group = (command.tags[0] ?? "other").split("/")[0];
          const bucket = groups.get(group) ?? [];
          bucket.push(exposed(command.name) ? command.name : `${command.name} (hidden)`);
          groups.set(group, bucket);
        }

        return {
          total: catalogue.length,
          categories: Object.fromEntries(
            [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sort()])
          ),
          actionRequired:
            "Pick the command you need and call unity_commands again with its name to get its " +
            "arguments, then call the command itself. Commands marked (hidden) are filtered out " +
            'by "unityToolTags" in ~/.cullus/config.json and will refuse to run until that is widened.',
        };
      }

      const ranked = catalogue
        .map((command) => ({ command, score: scoreCommand(command, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));

      if (ranked.length === 0) {
        return {
          query,
          total: catalogue.length,
          found: false,
          message: `No Unity command matches "${query}".`,
          actionRequired:
            "Call unity_commands with no query to see all " +
            `${catalogue.length} commands by category, then pick one. The capability may exist ` +
            "under a different name.",
        };
      }

      // An exact name match is a "how do I call this?" question, not a browse.
      const exact = ranked[0].score === 100 ? ranked[0].command : null;
      if (exact) {
        return {
          query,
          found: true,
          command: {
            name: exact.name,
            description: exact.description,
            tags: exact.tags,
            parameters: describeParameters(exact),
            exposedThisTurn: exposed(exact.name),
          },
          actionRequired: exposed(exact.name)
            ? `Call \`${exact.name}\` directly with those arguments. It will run even if it is ` +
              "not in the tool list you were given this turn."
            : `\`${exact.name}\` is filtered out by "unityToolTags" in ~/.cullus/config.json. ` +
              "Tell the user to widen that setting; do not attempt a workaround.",
        };
      }

      const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 40);
      return {
        query,
        total: catalogue.length,
        matched: ranked.length,
        commands: ranked.slice(0, limit).map(({ command }) => ({
          name: command.name,
          description: command.description,
          tags: command.tags,
          ...(exposed(command.name) ? {} : { hidden: true }),
        })),
        actionRequired:
          "Call the command that fits — it runs even if it was not in this turn's tool list. " +
          "If you need its arguments first, call unity_commands again with the exact name.",
      };
    },
  });

  localToolRegistry.register({
    name: "unity_symbol",
    description:
      "Resolve a Unity/C# type name to its namespace, so you know which `using` directive a " +
      "file is missing — and to confirm a type exists at all before you write code against it. " +
      "Answers CS0103 and CS0246 (\"the name X does not exist\", \"could not find type X\") " +
      "offline from the installed editor plus the project's packages (Input System, URP, " +
      "Cinemachine and the rest live in packages, not the editor). ALWAYS use this instead of " +
      "reasoning about whether a Unity API exists or guessing its namespace, and before " +
      "searching the web — it is faster and it is authoritative for this machine.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The bare type name from the error, e.g. 'RenderQueue' — no namespace.",
        },
        projectPath: {
          type: "string",
          description:
            "Any path inside the Unity project. Pass this whenever you have it: it selects the " +
            "matching editor version AND indexes the project's packages and Assets, which is " +
            "where every non-core type lives. Without it only the editor install is searched, " +
            "so a package type comes back 'not found'.",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const name = String(args?.name ?? "").trim();
      if (!name) {
        return {
          error: true,
          message: "name is required and must be a string.",
          actionRequired: 'Call unity_symbol again with {"name": "RenderQueue"}.',
        };
      }

      // The error text often arrives pasted in whole, so pull the identifier out
      // of it. It has to be the QUOTED one: C# writes `The name 'RenderQueue'
      // does not exist in the current context`, and taking the last identifier
      // instead yields "context", which then looks like a confident "no such
      // type" answer to a question that was never asked.
      const extracted = (): string | null => {
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return name;

        const quoted = name.match(/['"`]([A-Za-z_][A-Za-z0-9_.]*)['"`]/);
        if (quoted) return quoted[1];

        return null;
      };

      const bare = extracted();
      if (!bare) {
        return {
          error: true,
          message: `Could not tell which symbol to look up in: ${name.slice(0, 120)}`,
          actionRequired:
            'Call unity_symbol again with just the type name, e.g. {"name": "RenderQueue"} — ' +
            "not the whole error message.",
        };
      }

      const short = bare.split(".").pop() ?? bare;

      const project = args?.projectPath ? findUnityProject(String(args.projectPath)) : null;
      const wanted = project?.version ?? "";
      const editor = findEditor(wanted || "6000");

      if (!editor) {
        return {
          error: true,
          message: "No Unity editor install was found on this machine.",
          hint: "Looked in the Unity Hub editor directories.",
          actionRequired:
            "Set CULLUS_UNITY_EDITOR to the editor binary, or tell the user Unity is not " +
            "installed here. Do not search the web for the namespace — answer from the C# " +
            "you can read in the project instead.",
        };
      }

      const index = buildSymbolIndex(editor.path);

      // Packages second, and only with a project to look in. Every Input System
      // type lives here rather than in the editor install, which is the whole
      // reason a "not found" from the editor index alone is a misleading answer.
      const packageIndex = project ? buildPackageIndex(project.root) : null;
      const matches = [...(index.get(short) ?? []), ...(packageIndex?.get(short) ?? [])];

      const searched = ["the Unity editor install"];
      if (packageIndex) searched.push(`${project!.root}'s packages and Assets`);

      if (matches.length === 0) {
        return {
          symbol: short,
          editorVersion: editor.version,
          found: false,
          indexedTypes: index.size + (packageIndex?.size ?? 0),
          searched,
          message: `No public type named "${short}" was found in ${searched.join(" or ")}.`,
          actionRequired: packageIndex
            ? "The symbol is not a public type in this project, its packages, or Unity itself — " +
              "it is most likely misspelled, internal, or a member (method/property) rather than " +
              "a type. Do NOT conclude the API does not exist without checking the spelling first."
            : "Nothing but the editor install was searched. Call unity_symbol again with " +
              "projectPath set to the Unity project so its packages are indexed too — most " +
              "non-core Unity APIs (Input System, URP, Cinemachine) live in packages, not the " +
              "editor. Do not answer from memory until you have.",
        };
      }

      // One type routinely appears in several assemblies — Unity ships an
      // umbrella `UnityEngine.dll` that forwards to the module DLLs, so every
      // type is listed at least twice. Reporting that as "2 types share this
      // name, pick one" is a fabricated ambiguity, and a small model handed it
      // will go and search the web to break the tie. Group by the name that
      // actually matters.
      const byFullName = new Map<string, { match: SymbolMatch; assemblies: string[] }>();
      for (const m of matches) {
        const entry = byFullName.get(m.fullName);
        if (entry) entry.assemblies.push(m.assembly);
        else byFullName.set(m.fullName, { match: m, assemblies: [m.assembly] });
      }

      const distinct = [...byFullName.values()];
      const only = distinct.length === 1 ? distinct[0].match : null;

      return {
        symbol: short,
        editorVersion: editor.version,
        exactEditorMatch: editor.exact,
        searched,
        found: true,
        matches: distinct.map(({ match, assemblies }) => ({
          fullName: match.fullName,
          namespace: match.namespace,
          assemblies,
          usingDirective: match.namespace ? `using ${match.namespace};` : null,
        })),
        actionRequired: only
          ? (only.namespace
              ? `Add \`using ${only.namespace};\` to the top of the file, or write the type fully qualified as \`${only.fullName}\`.`
              : `\`${only.fullName}\` is in the global namespace and needs no using directive.`) +
            " That is the whole fix — do not search the web to confirm it."
          : `${distinct.length} different types share this name (${distinct
              .map((d) => d.match.fullName)
              .join(", ")}). Pick the one that fits the surrounding code and add its using directive.`,
      };
    },
  });

  localToolRegistry.register({
    name: "unity_compile",
    description:
      "Compile a Unity project with the real editor in batch mode and return the compiler " +
      "errors. This is the only way to actually verify a Unity fix — reading the file is not " +
      "verification. Slow (minutes on a cold Library), so call it once at the end, not between " +
      "edits. The project directory must already be granted with /paths.",
    parameters: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "The Unity project root, or any path inside it.",
        },
        timeoutSeconds: {
          type: "number",
          description: "How long to allow (default 300, max 900).",
        },
      },
      required: ["projectPath"],
    },
    handler: async (args) => {
      const requested = String(args?.projectPath ?? "").trim();
      if (!requested) {
        return {
          error: true,
          message: "projectPath is required and must be a string.",
          actionRequired: 'Call unity_compile again with {"projectPath": "/path/to/project"}.',
        };
      }

      const project = findUnityProject(requested);
      if (!project) {
        return {
          error: true,
          message: `No Unity project found at or above ${requested}.`,
          hint: "A Unity project is a directory containing ProjectSettings/ProjectVersion.txt.",
          actionRequired: "Pass the project root, or check the path.",
        };
      }

      // Consent gate. Deliberately the same one /fix uses rather than a second
      // permission concept: batchmode writes Library/ and Temp/, so this is not
      // a read-only operation and it must not run on an ungranted directory.
      const granted = resolveTarget(project.root);
      if (!granted.ok) {
        return {
          error: true,
          message: granted.error,
          actionRequired: granted.actionRequired,
        };
      }

      const editor = findEditor(project.version);
      if (!editor) {
        return {
          error: true,
          message: `Unity ${project.version} is not installed on this machine.`,
          actionRequired:
            "Install it through Unity Hub, or set CULLUS_UNITY_EDITOR to an editor binary. " +
            "Report this to the user rather than guessing whether the code compiles.",
        };
      }

      const lock = lockedBy(project.root);

      // A stale lockfile is not a lock. Removing it is the Editor's job and it
      // did not do it, so batch mode proceeds and says why — the alternative is
      // the refusal that sent the model round in circles.
      if (lock.stale) {
        console.log(`Unity: ignoring a stale lockfile at ${lock.lockfile} (${lock.reason}).`);
      }

      if (lock.locked) {
        // Only claim the Editor's own tools are available if they answered.
        //
        // The old text asserted "the Editor is open, which means its own MCP
        // tools are live" unconditionally, and `useInstead` came back empty
        // whenever the catalogue was — so the model was redirected to a route
        // this same function had already computed as nonexistent, then told by
        // unity_commands that nothing was answering. Two contradictory facts and
        // a dead end.
        const route = editorCompileRoute();
        const editorAnswering = route.length > 0;

        // The Editor is holding the project AND answering, so it can compile it.
        // Delegate instead of refusing: this is the path that turns "close Unity
        // and try again" into an answer.
        if (editorAnswering) {
          const delegateTimeout = Math.min(Math.max(Number(args?.timeoutSeconds) || 300, 30), 900) * 1000;
          console.log(
            `Unity: project held by ${lock.reason}; compiling through the open Editor instead.`
          );

          const viaEditor = await compileViaEditor(project.root, delegateTimeout);

          if (viaEditor.ok) {
            const diagnostics = parseCompilerDiagnostics(viaEditor.log);
            const errors = diagnostics.filter((d) => /^CS/.test(d.code));

            return {
              compiledBy: "the open Unity Editor (recompile), not batch mode",
              project: project.root,
              unityVersion: project.version,
              durationMs: viaEditor.waitedMs,
              errorCount: errors.length,
              diagnostics: diagnostics.slice(0, 50),
              truncated: diagnostics.length > 50 ? diagnostics.length - 50 : 0,
              recompiled: viaEditor.recompiled,
              note:
                "The Editor has this project open, so batch mode could not run. It was " +
                "recompiled in place through the Editor instead — nothing was closed and no " +
                "Editor state was lost. Diagnostics come from the Editor console." +
                (viaEditor.recompiled
                  ? ""
                  : ` NOTHING WAS ACTUALLY RECOMPILED: the Editor reported ` +
                    `"${viaEditor.triggerStatus}", meaning no script had changed since its last ` +
                    `compile. These diagnostics are whatever the console was already holding, ` +
                    `not the result of a fresh compile.`),
              ...(errors.length === 0
                ? {
                    actionRequired:
                      (viaEditor.recompiled
                        ? "No compiler errors in the console after the recompile. "
                        : "No compiler errors in the console, but nothing was recompiled. ") +
                      "The Editor console only holds what it has logged since it was last " +
                      "cleared, so an empty console is NOT proof that the project builds. Do " +
                      "not report the project as clean on this alone — say what was checked " +
                      "and what that does and does not establish.",
                  }
                : {}),
            };
          }

          // Delegation failed. Say that plainly rather than falling back to the
          // old "close the Editor" advice as if nothing had been tried.
          return {
            error: true,
            message:
              `The Editor has this project open and compiling through it did not work: ` +
              `${viaEditor.error}`,
            hint: `${lock.lockfile}: ${lock.reason}.`,
            modes: unityModeTradeoff(),
            useInstead: route,
            actionRequired:
              "Do not retry unity_compile — batch mode cannot open a locked project. Either " +
              "call the commands in useInstead directly, or tell the user that the in-Editor " +
              "recompile failed and ask whether to close the Editor so batch mode can run. Do " +
              "not close it yourself.",
          };
        }

        return {
          error: true,
          message: "This project is locked, but no Editor is answering — the two do not agree.",
          hint: `${lock.lockfile}: ${lock.reason}.`,
          modes: unityModeTradeoff(),
          useInstead: route,
          actionRequired: lock.unverified
              ? "Do not retry this call — it will fail the same way, and do not call " +
                "unity_commands, which has no catalogue to search. I could not check whether a " +
                "process actually holds the lockfile, so it may be a leftover from a crash. Ask " +
                "the user to confirm whether the Editor is really open, and say that " +
                `\`lsof -t ${lock.lockfile}\` settles it.`
              : "Do not retry this call and do not call unity_commands — neither can succeed " +
                "in this state. Report to the user that the lockfile says the project is open " +
                "while the Editor is not responding, which usually means a crashed or " +
                "force-quit Editor left the file behind. Ask whether to remove it before " +
                "retrying; do not remove it yourself.",
        };
      }

      const timeoutMs = Math.min(Math.max(Number(args?.timeoutSeconds) || 300, 30), 900) * 1000;
      const logFile = path.join(
        os.tmpdir(),
        `cullus-unity-${path.basename(project.root)}-${Date.now()}.log`
      );

      const started = Date.now();
      const outcome = await runEditor(
        editor.path,
        [
          "-batchmode",
          "-quit",
          "-nographics",
          "-projectPath",
          project.root,
          "-logFile",
          logFile,
        ],
        timeoutMs
      );

      let log = "";
      try {
        log = fs.readFileSync(logFile, "utf-8");
      } catch {
        /* the editor may have failed before opening its log */
      }

      const errors = parseCompilerDiagnostics(log);
      const seconds = Math.round((Date.now() - started) / 1000);

      if (outcome.timedOut) {
        return {
          error: true,
          message: `Unity did not finish within ${timeoutMs / 1000}s and was killed.`,
          project: project.root,
          editorVersion: editor.version,
          errors,
          actionRequired:
            "A cold Library import can genuinely take longer. Retry once with a larger " +
            "timeoutSeconds, then report the timeout rather than assuming it compiled.",
        };
      }

      return {
        project: project.root,
        editorVersion: editor.version,
        exactEditorMatch: editor.exact,
        exitCode: outcome.code,
        seconds,
        compiled: errors.length === 0 && outcome.code === 0,
        errorCount: errors.length,
        errors: errors.slice(0, 40),
        logFile,
        actionRequired:
          errors.length > 0
            ? "Fix these errors. For a CS0103 or CS0246, call unity_symbol on the missing name " +
              "first — the answer is almost always a missing using directive."
            : outcome.code === 0
              ? "The project compiled. This is real verification; report it as such."
              : `Unity exited ${outcome.code} with no compiler errors parsed — the failure is ` +
                `not a compile error. Read ${logFile} before drawing a conclusion.`,
      };
    },
  });
}
