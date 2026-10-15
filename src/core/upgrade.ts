// /upgrade — replace Cullus with the latest origin/main, recoverably.
//
// The hard part is not fetching code, it is that the thing being replaced is the
// thing doing the replacing. Two failures made that concrete:
//
//   1. An earlier attempt wrote files without going through applyEdit, so
//      backupFile() never ran, `/fix revert` had no record to restore, and the
//      loss was permanent. Backups are only created on the applyEdit path.
//   2. The app runs from dist/ (package.json bin), and `npm run build` starts
//      with `rm -rf dist/public`. Rebuilding in-process deletes the files the
//      running process is standing on.
//
// So: everything that mutates the install happens in a detached script that
// waits for this process to exit, and nothing starts until an explicit snapshot
// and a git checkpoint both exist. Git is the transport; the snapshot under
// ~/.cullus/upgrades/ is the guarantee, and it does not live in the tree
// being replaced.

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { execFileSync } from "child_process";

import { CONFIG_DIR, ensureConfigDir } from "./config.js";
import { resolveSelf } from "./projectTarget.js";
import { gitCheckpoint } from "./patch.js";
import { logActivity } from "./activity.js";

export const UPGRADE_ROOT = path.join(CONFIG_DIR, "upgrades");
const RUNS_PATH = path.join(CONFIG_DIR, "upgrade-runs.json");
const MAX_STORED_RUNS = 20;

export type UpgradeOutcome = "pending" | "upgraded" | "rolled-back" | "failed" | "reverted";

export interface UpgradeRunRecord {
  id: string;
  root: string;
  startedAt: number;
  endedAt: number | null;
  outcome: UpgradeOutcome;
  fromSha: string;
  toSha: string;
  fromVersion: string;
  gitStash: string | null;
  commits: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// git helpers
//
// execFileSync, never a shell: nothing here is user-supplied, and keeping the
// argv array explicit means a branch name can never be read as a flag.
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true, out: out.trim() };
  } catch (err: any) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message };
  }
}

// ---------------------------------------------------------------------------
// Run records — same shape and conventions as fix-runs.json
// ---------------------------------------------------------------------------

export function loadUpgradeRuns(): UpgradeRunRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUpgradeRun(record: UpgradeRunRecord): void {
  try {
    ensureConfigDir();
    const runs = [record, ...loadUpgradeRuns().filter((r) => r.id !== record.id)].slice(
      0,
      MAX_STORED_RUNS
    );
    fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`⚠️  Could not record upgrade run: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface Preflight {
  ok: boolean;
  /** Why this cannot proceed. Present whenever ok is false. */
  reason?: string;
  /** What the user should do about it. */
  actionRequired?: string;
  root?: string;
  fromSha?: string;
  toSha?: string;
  upstream?: string;
  commits?: string[];
  /** True when there is nothing to do — not an error. */
  current?: boolean;
}

/**
 * Everything that can refuse an upgrade, in order, before anything is written.
 *
 * Read-only apart from `git fetch`, which touches only refs. Deliberately
 * separate from the upgrade itself so `/upgrade --check` is the same code path.
 */
export function preflight(): Preflight {
  const root = resolveSelf();
  if (!root) {
    return {
      ok: false,
      reason: "Could not locate the Cullus install.",
      actionRequired: "This only upgrades Cullus itself, identified by its package.json.",
    };
  }

  if (!fs.existsSync(path.join(root, ".git"))) {
    return {
      ok: false,
      root,
      reason: `${root} is not a git repository.`,
      actionRequired: "Reinstall from a git clone, or upgrade by hand.",
    };
  }

  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) {
    return {
      ok: false,
      root,
      reason: "The current branch has no upstream to upgrade from.",
      actionRequired: "git branch --set-upstream-to origin/main",
    };
  }

  // The one guard that protects work rather than the install: an upgrade over a
  // dirty tree can destroy edits that exist nowhere else.
  const dirty = git(root, ["status", "--porcelain"]);
  if (dirty.ok && dirty.out.length > 0) {
    const files = dirty.out.split("\n").slice(0, 10).join("\n   ");
    return {
      ok: false,
      root,
      reason: `The working tree has uncommitted changes:\n   ${files}`,
      actionRequired: "Commit or stash them first. An upgrade must not be the thing that loses them.",
    };
  }

  const fetched = git(root, ["fetch", "origin", "--quiet"]);
  if (!fetched.ok) {
    return {
      ok: false,
      root,
      reason: `Could not fetch from origin: ${fetched.out}`,
      actionRequired: "Check your network and that you can reach the remote.",
    };
  }

  const fromSha = git(root, ["rev-parse", "HEAD"]).out;
  const toSha = git(root, ["rev-parse", "@{u}"]).out;

  if (fromSha === toSha) {
    return { ok: true, current: true, root, fromSha, toSha, upstream: upstream.out, commits: [] };
  }

  // Fast-forward only. A merge or rebase during a self-upgrade can leave the
  // install in a state neither the snapshot nor the checkpoint anticipated.
  const ancestor = git(root, ["merge-base", "--is-ancestor", "HEAD", "@{u}"]);
  if (!ancestor.ok) {
    return {
      ok: false,
      root,
      reason: `Local history has diverged from ${upstream.out}.`,
      actionRequired: "Reconcile by hand. This command only fast-forwards.",
    };
  }

  const log = git(root, ["log", "--oneline", "--no-decorate", `HEAD..@{u}`]);
  return {
    ok: true,
    root,
    fromSha,
    toSha,
    upstream: upstream.out,
    commits: log.ok && log.out ? log.out.split("\n") : [],
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Copy every tracked file into the run directory.
 *
 * Tracked only: node_modules/ and dist/ are ignored and get rebuilt, and
 * copying them would turn a 2 MB snapshot into a 300 MB one. The snapshot lives
 * under ~/.cullus so the upgrade cannot delete its own way back.
 */
function snapshot(root: string, runDir: string): { ok: boolean; count: number; error?: string } {
  try {
    const listed = git(root, ["ls-files"]);
    if (!listed.ok) return { ok: false, count: 0, error: listed.out };

    const files = listed.out.split("\n").filter(Boolean);
    const dest = path.join(runDir, "snapshot");

    for (const relative of files) {
      const from = path.join(root, relative);
      if (!fs.existsSync(from)) continue; // tracked but deleted; nothing to preserve
      const to = path.join(dest, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    return { ok: true, count: files.length };
  } catch (err: any) {
    return { ok: false, count: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// The handoff script
// ---------------------------------------------------------------------------

/**
 * The script that does every mutating step, written outside the install tree.
 *
 * It waits for this process to exit before touching anything, which is the
 * whole point: `npm run build` deletes dist/public and rewrites dist/*.js, and
 * the running app is loaded from there.
 */
function handoffScript(opts: {
  root: string;
  runDir: string;
  runId: string;
  parentPid: number;
  fromSha: string;
  toSha: string;
  runsPath: string;
  relaunch: boolean;
  mode: "upgrade" | "revert";
}): string {
  return `// Generated by /upgrade for run ${opts.runId}. Safe to delete once it has run.
import { execFileSync, spawnSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = ${JSON.stringify(opts.root)};
const RUN_DIR = ${JSON.stringify(opts.runDir)};
const RUN_ID = ${JSON.stringify(opts.runId)};
const PARENT = ${opts.parentPid};
const FROM = ${JSON.stringify(opts.fromSha)};
const TO = ${JSON.stringify(opts.toSha)};
const RUNS_PATH = ${JSON.stringify(opts.runsPath)};
const RELAUNCH = ${opts.relaunch ? "true" : "false"};
const MODE = ${JSON.stringify(opts.mode)};

const log = [];
function say(icon, message) {
  const line = \`  \${icon} \${message}\`;
  console.log(line);
  log.push(line);
  try { fs.appendFileSync(path.join(RUN_DIR, "upgrade.log"), line + "\\n"); } catch {}
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 900000 });
  const out = \`\${r.stdout ?? ""}\${r.stderr ?? ""}\`.trim();
  return { ok: r.status === 0, out };
}

function record(outcome, summary) {
  try {
    const runs = JSON.parse(fs.readFileSync(RUNS_PATH, "utf-8"));
    const i = runs.findIndex((r) => r.id === RUN_ID);
    if (i >= 0) {
      runs[i].outcome = outcome;
      runs[i].endedAt = Date.now();
      runs[i].summary = summary;
      fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2), "utf-8");
    }
  } catch {}
}

// Wait for the app to let go of its own files.
async function waitForParent() {
  for (let i = 0; i < 100; i++) {
    try { process.kill(PARENT, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false; // still alive after ~10s; proceed anyway rather than hang forever
}

function restoreSnapshot() {
  const src = path.join(RUN_DIR, "snapshot");
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const target = path.join(ROOT, path.relative(src, full));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(full, target);
      n++;
    }
  };
  walk(src);
  return n;
}

function rollback(why) {
  say("✗", why);
  say("↺", "rolling back");
  run("git", ["reset", "--hard", FROM]);
  const n = restoreSnapshot();
  say("✓", \`restored \${n} file(s) from the snapshot\`);
  run("npm", ["install", "--no-audit", "--no-fund"]);
  const rebuilt = run("npm", ["run", "build"]);
  say(rebuilt.ok ? "✓" : "✗", rebuilt.ok ? "rebuilt at the previous version" : "REBUILD FAILED after rollback");
  record("rolled-back", why);
  if (!rebuilt.ok) {
    console.log("");
    console.log("  The previous version is restored on disk but did not rebuild.");
    console.log(\`  Run \\\`npm install && npm run build\\\` in \${ROOT}.\`);
    console.log(\`  Snapshot: \${path.join(RUN_DIR, "snapshot")}\`);
  }
  process.exit(1);
}

(async () => {
  await waitForParent();
  console.log("");

  if (MODE === "upgrade") {
    const merged = run("git", ["merge", "--ff-only", TO]);
    if (!merged.ok) rollback("git merge --ff-only failed: " + merged.out.split("\\n")[0]);
    say("✓", \`merge --ff-only  \${FROM.slice(0, 7)} → \${TO.slice(0, 7)}\`);
  } else {
    const reset = run("git", ["reset", "--hard", TO]);
    if (!reset.ok) rollback("git reset failed: " + reset.out.split("\\n")[0]);
    restoreSnapshot();
    say("✓", \`reverted to \${TO.slice(0, 7)}\`);
  }

  // Only reinstall when the lockfile actually moved: npm install is the slowest
  // step by far and usually unnecessary.
  const changed = run("git", ["diff", "--name-only", FROM, "HEAD"]);
  if (changed.out.split("\\n").includes("package-lock.json") || MODE === "revert") {
    const installed = run("npm", ["install", "--no-audit", "--no-fund"]);
    if (!installed.ok) rollback("npm install failed: " + installed.out.split("\\n").slice(-1)[0]);
    say("✓", "npm install      (lockfile changed)");
  } else {
    say("·", "npm install      skipped, lockfile unchanged");
  }

  const built = run("npm", ["run", "build"]);
  if (!built.ok) rollback("npm run build failed: " + built.out.split("\\n").slice(-3).join(" "));
  say("✓", "npm run build    tsc clean");

  // Import a leaf module rather than dist/index.js: the entry point starts the
  // web server and opens a browser, which is not a smoke test.
  const probe = path.join(ROOT, "dist", "core", "projectTarget.js");
  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e",
    \`await import(\\\`file://\${probe}\\\`)\`], { encoding: "utf-8", timeout: 60000 });
  if (smoke.status !== 0) rollback("smoke check failed: " + \`\${smoke.stderr ?? ""}\`.split("\\n")[0]);
  say("✓", "smoke check      module loads");

  const version = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version; }
    catch { return "?"; }
  })();

  record(MODE === "upgrade" ? "upgraded" : "reverted", \`\${MODE} to \${version} (\${TO.slice(0, 7)})\`);

  if (RELAUNCH) {
    say("↻", "relaunching...");
    console.log("");
    const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
      cwd: ROOT, stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  } else {
    console.log("");
    console.log(\`  Now on v\${version}. Run \\\`assistant\\\` to start.\`);
    process.exit(0);
  }
})();
`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface StartResult {
  ok: boolean;
  message: string;
  runId?: string;
}

/**
 * Arm the undo, write the handoff script, detach it and leave.
 *
 * Returns only on failure — on success the process exits so the script can
 * safely replace the files this process is running from.
 */
export function startUpgrade(pre: Preflight, opts: { relaunch: boolean }): StartResult {
  const root = pre.root!;
  const runId = `up_${Date.now().toString(36)}`;
  const runDir = path.join(UPGRADE_ROOT, runId);

  try {
    ensureConfigDir();
    fs.mkdirSync(runDir, { recursive: true });
  } catch (err: any) {
    return { ok: false, message: `Could not create ${runDir}: ${err.message}` };
  }

  // Checkpoint before the snapshot: it is the cheaper of the two and its failure
  // says something is wrong with the repo that the snapshot would inherit.
  const stash = gitCheckpoint(root);

  const snap = snapshot(root, runDir);
  if (!snap.ok) {
    return {
      ok: false,
      message: `Refusing to upgrade: the snapshot could not be written (${snap.error}).`,
    };
  }

  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version ?? "?";
    } catch {
      return "?";
    }
  })();

  const record: UpgradeRunRecord = {
    id: runId,
    root,
    startedAt: Date.now(),
    endedAt: null,
    outcome: "pending",
    fromSha: pre.fromSha!,
    toSha: pre.toSha!,
    fromVersion: version,
    gitStash: stash,
    commits: pre.commits ?? [],
    summary: `Upgrade started from ${pre.fromSha!.slice(0, 7)}.`,
  };
  saveUpgradeRun(record);

  fs.writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({ ...record, snapshotFiles: snap.count }, null, 2),
    "utf-8"
  );

  const scriptPath = path.join(runDir, "upgrade.mjs");
  fs.writeFileSync(
    scriptPath,
    handoffScript({
      root,
      runDir,
      runId,
      parentPid: process.pid,
      fromSha: pre.fromSha!,
      toSha: pre.toSha!,
      runsPath: RUNS_PATH,
      relaunch: opts.relaunch,
      mode: "upgrade",
    }),
    "utf-8"
  );

  logActivity({
    kind: "edit",
    status: "ok",
    label: `upgrade ${runId}`,
    summary: `snapshot ${snap.count} file(s), ${pre.fromSha!.slice(0, 7)} → ${pre.toSha!.slice(0, 7)}`,
    detail: (pre.commits ?? []).join("\n"),
  });

  console.log(`  ✓ snapshot   ${runDir} (${snap.count} files)`);
  console.log(`  ✓ checkpoint ${stash ? `git stash ${stash.slice(0, 7)}` : "none (clean tree)"}`);

  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: "inherit" });
  child.unref();

  // The parent must go before the script touches dist/.
  process.exit(0);
}

/** Restore a recorded run: snapshot back, reset to its starting sha, rebuild. */
export function startRevert(runId?: string, opts: { relaunch: boolean } = { relaunch: true }): StartResult {
  const runs = loadUpgradeRuns();
  const record = runId ? runs.find((r) => r.id === runId) : runs.find((r) => r.outcome === "upgraded");

  if (!record) {
    return {
      ok: false,
      message: runId ? `No upgrade run "${runId}" is on record.` : "No completed upgrade to revert.",
    };
  }

  const runDir = path.join(UPGRADE_ROOT, record.id);
  if (!fs.existsSync(path.join(runDir, "snapshot"))) {
    return { ok: false, message: `Run ${record.id} has no snapshot left to restore.` };
  }

  const scriptPath = path.join(runDir, "revert.mjs");
  fs.writeFileSync(
    scriptPath,
    handoffScript({
      root: record.root,
      runDir,
      runId: record.id,
      parentPid: process.pid,
      fromSha: record.toSha,
      toSha: record.fromSha, // revert: go back to where the upgrade started
      runsPath: RUNS_PATH,
      relaunch: opts.relaunch,
      mode: "revert",
    }),
    "utf-8"
  );

  console.log(`  ↺ reverting ${record.id} → ${record.fromSha.slice(0, 7)}`);

  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: "inherit" });
  child.unref();
  process.exit(0);
}
