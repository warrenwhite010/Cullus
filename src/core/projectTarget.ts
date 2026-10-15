// What /fix is allowed to repair, and how to build and verify it.
//
// Two jobs:
//
//  1. Resolve a target safely. Cullus's own root is derived from this
//     module's location, never process.cwd() — `cullus` is usually launched
//     from whatever directory the user happens to be in, and repairing that by
//     accident is exactly the failure this avoids. Any other target must already
//     be in allowedPaths, so /paths IS the consent gate and there is no second
//     permission concept to keep in sync.
//
//  2. Decide how to prove a repair worked, per language. npm is one case among
//     several: Python, Rust, Go, Make and bare tsc projects all get a build and
//     verify command detected from what is actually on disk. A project with no
//     detectable build is allowed — the loop then leans on verify alone and says
//     so, rather than pretending a repair was proven.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadConfig, expandPath, getVaultPath } from "./config.js";

export interface ProjectCommands {
  /** Compile/typecheck step. null when the project has none. */
  build: string | null;
  /** Test/runtime step. null when the project has none. */
  verify: string | null;
  /** How these were chosen, for the report. */
  source: string;
}

export interface FixTarget {
  root: string;
  /** True when this is Cullus repairing itself. */
  isSelf: boolean;
  label: string;
  commands: ProjectCommands;
}

/**
 * Cullus's own project root.
 *
 * This file runs from dist/core/, so the root is two levels up. Validated by
 * package.json name rather than assumed, so a relocated or renamed install fails
 * loudly instead of editing the wrong tree.
 */
export function resolveSelf(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));

    for (const candidate of [path.resolve(here, "../.."), path.resolve(here, "..")]) {
      const manifest = path.join(candidate, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf-8"));
      if (parsed?.name === "cullus") return candidate;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Does this Makefile declare the given target? */
function makefileHasTarget(root: string, target: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(root, "Makefile"), "utf-8");
    return new RegExp(`^${target}\\s*:`, "m").test(raw);
  } catch {
    return false;
  }
}

/** The Python runner this project implies: uv, poetry, or bare python. */
function pythonRunner(root: string): string {
  if (fs.existsSync(path.join(root, "uv.lock"))) return "uv run";
  if (fs.existsSync(path.join(root, "poetry.lock"))) return "poetry run";
  return "";
}

function withRunner(runner: string, command: string): string {
  return runner ? `${runner} ${command}` : command;
}

/**
 * Build/verify commands for a project, first marker wins. User overrides in
 * config.fixCommands always take precedence.
 */
export function detectCommands(root: string): ProjectCommands {
  const detected = detectFromDisk(root);
  const overrides = loadConfig().fixCommands?.[path.resolve(root)];

  if (!overrides?.build && !overrides?.verify) return detected;

  // Merge, do not replace. Setting only a verify command used to blank out the
  // detected build, so `/fix set --verify "…"` quietly left the project with
  // nothing to compile it.
  const build = overrides.build ?? detected.build;
  const verify = overrides.verify ?? detected.verify;

  const overridden = [overrides.build ? "build" : null, overrides.verify ? "verify" : null]
    .filter(Boolean)
    .join(" + ");

  return {
    build,
    verify,
    source: `${detected.source}, ${overridden} overridden by \`/fix set\``,
  };
}

function detectFromDisk(root: string): ProjectCommands {
  const has = (file: string) => fs.existsSync(path.join(root, file));

  // Unity first, and specifically before package.json: Unity projects routinely
  // carry a package.json for tooling, and `npm run build` would then be detected
  // as the way to prove a C# fix — which it is not.
  //
  // Both commands stay null even though a batchmode invocation exists. /fix runs
  // its build command once per round, a Unity batchmode compile takes minutes
  // and holds an exclusive lock on the project, and the editor is usually open
  // while someone is working on it. The `unity_compile` tool is the deliberate
  // once-at-the-end route instead; this `source` string is what makes /fix's
  // report say so rather than claiming the project has no build system.
  if (has(path.join("ProjectSettings", "ProjectVersion.txt"))) {
    return {
      build: null,
      verify: null,
      source:
        "Unity project (ProjectVersion.txt) — no automatic build; verify with the " +
        "unity_compile tool, which runs the editor in batch mode once",
    };
  }

  if (has("package.json")) {
    const manifest = readJson(path.join(root, "package.json")) ?? {};
    const scripts = manifest.scripts ?? {};
    const build = scripts.build
      ? "npm run build"
      : has("tsconfig.json")
      ? "npx tsc --noEmit"
      : null;
    const verify = scripts.test ? "npm test" : null;
    return { build, verify, source: "package.json" };
  }

  if (has("pyproject.toml") || has("requirements.txt")) {
    const runner = pythonRunner(root);
    const hasTests =
      has("tests") || has("test") || fs.readdirSync(root).some((e) => /^test_.*\.py$/.test(e));
    return {
      build: withRunner(runner, "python -m compileall -q ."),
      verify: hasTests ? withRunner(runner, "python -m pytest -q") : null,
      source: has("pyproject.toml") ? "pyproject.toml" : "requirements.txt",
    };
  }

  if (has("Cargo.toml")) {
    return { build: "cargo build", verify: "cargo test", source: "Cargo.toml" };
  }

  if (has("go.mod")) {
    return { build: "go build ./...", verify: "go test ./...", source: "go.mod" };
  }

  if (has("Makefile")) {
    return {
      build: "make",
      verify: makefileHasTarget(root, "test") ? "make test" : null,
      source: "Makefile",
    };
  }

  if (has("tsconfig.json")) {
    return { build: "npx tsc --noEmit", verify: null, source: "tsconfig.json" };
  }

  return { build: null, verify: null, source: "no build system detected" };
}

/**
 * Resolve and authorise a target. `null` means Cullus itself.
 *
 * Returns a structured refusal rather than throwing, so every caller (REPL,
 * socket, HTTP) reports the same actionable reason.
 */
export function resolveTarget(
  requested: string | null | undefined
): { ok: true; target: FixTarget } | { ok: false; error: string; actionRequired: string } {
  if (!requested) {
    const self = resolveSelf();
    if (!self) {
      return {
        ok: false,
        error: "Could not locate Cullus's own project root.",
        actionRequired:
          "Run `cullus` from a proper install (a directory whose package.json name is cullus).",
      };
    }
    return {
      ok: true,
      target: { root: self, isSelf: true, label: "Cullus (self)", commands: detectCommands(self) },
    };
  }

  const root = expandPath(requested);

  if (!fs.existsSync(root)) {
    return {
      ok: false,
      error: `${root} does not exist.`,
      actionRequired: "Pass an existing project directory.",
    };
  }
  if (!fs.statSync(root).isDirectory()) {
    return {
      ok: false,
      error: `${root} is a file, not a project directory.`,
      actionRequired: "Pass the project's root directory.",
    };
  }

  // The vault is off limits even when granted: notes are not a build target, and
  // an edit loop with a verify step has no business rewriting prose.
  const vault = getVaultPath();
  if (vault) {
    const vaultRoot = path.resolve(vault);
    if (root === vaultRoot || root.startsWith(vaultRoot + path.sep)) {
      return {
        ok: false,
        error: `${root} is inside your Obsidian vault.`,
        actionRequired: "/fix repairs code, not notes. Edit notes through the obsidian-live tools.",
      };
    }
  }

  const granted = loadConfig().allowedPaths.map((p) => path.resolve(p));
  const isGranted = granted.some((g) => root === g || root.startsWith(g + path.sep));

  if (!isGranted) {
    return {
      ok: false,
      error: `${root} is not a granted directory.`,
      actionRequired: `Grant it first with \`/paths add ${root}\`, or the 📂 field in Settings → Connections.`,
    };
  }

  return {
    ok: true,
    target: {
      root,
      isSelf: resolveSelf() === root,
      label: path.basename(root),
      commands: detectCommands(root),
    },
  };
}

/** Targets offered in the UI: self plus every granted directory. */
export function listFixTargets(): Array<{ path: string; label: string; isSelf: boolean }> {
  const self = resolveSelf();
  const rows: Array<{ path: string; label: string; isSelf: boolean }> = [];

  if (self) rows.push({ path: self, label: "Cullus (self)", isSelf: true });

  const vault = getVaultPath() ? path.resolve(getVaultPath()!) : null;

  for (const granted of loadConfig().allowedPaths) {
    const resolved = path.resolve(granted);
    if (resolved === self) continue;
    if (vault && (resolved === vault || resolved.startsWith(vault + path.sep))) continue;
    rows.push({ path: resolved, label: path.basename(resolved), isSelf: false });
  }

  return rows;
}
