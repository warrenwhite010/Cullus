// Health check for `/doctor`.
//
// Every check reports pass/warn/fail plus the exact command or click that fixes
// it. A check that cannot run is a warn, never a thrown error — the whole point
// is to still produce a report when things are broken.

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { loadConfig, CONFIG_PATH, CONFIG_DIR, isVaultReadOnly } from "./config.js";
import { getOllamaHealth } from "./ollama.js";
import { getServersWithMode, unityModeTradeoff } from "./mcpServers.js";
import { mcpManager } from "./mcpManager.js";
import { getSettings } from "./session.js";
import { resolveSelf } from "./projectTarget.js";

const run = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface Diagnostics {
  summary: { pass: number; warn: number; fail: number };
  checks: Check[];
}

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18
    ? { name: "Node.js", status: "pass", detail: `v${process.versions.node}` }
    : {
        name: "Node.js",
        status: "fail",
        detail: `v${process.versions.node} is too old; global fetch() requires 18+.`,
        fix: "Upgrade Node: `brew upgrade node`.",
      };
}

async function checkOllama(): Promise<Check[]> {
  const health = await getOllamaHealth();

  if (!health.running) {
    return [
      {
        name: "Ollama server",
        status: "fail",
        detail: health.error ?? "Unreachable.",
        fix: health.hint ?? "Start it with `ollama serve`.",
      },
    ];
  }

  const checks: Check[] = [
    { name: "Ollama server", status: "pass", detail: `Reachable at ${health.url}` },
  ];

  checks.push(
    health.models.length > 0
      ? {
          name: "Ollama models",
          status: "pass",
          detail: `${health.models.length} pulled: ${health.models.join(", ")}`,
        }
      : {
          name: "Ollama models",
          status: "fail",
          detail: "No models pulled, so nothing can generate.",
          fix: "Pull one: `ollama pull qwen3.5:9b`.",
        }
  );

  const config = loadConfig();
  if (config.defaultModel && !health.models.includes(config.defaultModel)) {
    checks.push({
      name: "Default model",
      status: "warn",
      detail: `Config names "${config.defaultModel}", which isn't pulled.`,
      fix: `Run \`ollama pull ${config.defaultModel}\`, or pick another model in the sidebar.`,
    });
  } else if (config.defaultModel) {
    checks.push({ name: "Default model", status: "pass", detail: config.defaultModel });
  }

  return checks;
}

async function checkConfig(): Promise<Check> {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      name: "Config file",
      status: "warn",
      detail: `Not created yet at ${CONFIG_PATH}. Defaults are in use.`,
      fix: "It is written automatically on the first settings change.",
    };
  }

  try {
    JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return { name: "Config file", status: "pass", detail: CONFIG_PATH };
  } catch (err: any) {
    return {
      name: "Config file",
      status: "fail",
      detail: `${CONFIG_PATH} is not valid JSON (${err.message}).`,
      fix: `Fix the syntax or delete it: \`rm ${CONFIG_PATH}\`.`,
    };
  }
}

async function checkVault(): Promise<Check[]> {
  const config = loadConfig();

  if (!config.vaultPath) {
    return [
      {
        name: "Obsidian vault",
        status: "warn",
        detail:
          "No path configured. Vault tools still work through `obsidian-live`, but the " +
          "read-only guard cannot recognise vault paths in shell or filesystem writes.",
        fix: "Set the path Obsidian has open with `/vault set <path>`, or the 📁 button in the sidebar.",
      },
    ];
  }

  if (!fs.existsSync(config.vaultPath)) {
    return [
      {
        name: "Obsidian vault",
        status: "fail",
        detail: `Configured path does not exist: ${config.vaultPath}`,
        fix: "Correct it with `/vault set <path>`.",
      },
    ];
  }

  const checks: Check[] = [];
  let noteCount = 0;
  try {
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.endsWith(".md")) noteCount++;
      }
    };
    walk(config.vaultPath, 0);
  } catch {
    /* count is best-effort */
  }

  checks.push({
    name: "Obsidian vault",
    status: "pass",
    detail: `${config.vaultPath} (${noteCount} note${noteCount === 1 ? "" : "s"} found)`,
  });

  // Ask-first is the normal, intended state now, so it is a pass rather than a
  // warning: an unlocked vault whose writes are confirmed one at a time is the
  // design, not a risk to flag on every health check.
  const locked = isVaultReadOnly();
  checks.push({
    name: "Vault write mode",
    status: "pass",
    detail: locked
      ? "Locked. Vault writes are refused outright, with no prompt."
      : "Unlocked. Vault writes ask for confirmation first (auto and manual modes); " +
        "accept-edits mode writes without asking.",
    fix: locked
      ? "Unlock it next to `obsidian-live` in Settings → MCP Servers to allow confirmed writes."
      : undefined,
  });

  return checks;
}

async function checkMcp(): Promise<Check[]> {
  const servers = getServersWithMode();

  if (servers.length === 0) {
    return [{ name: "MCP servers", status: "warn", detail: "None registered." }];
  }

  return servers.map((srv) => ({
    name: `MCP: ${srv.name}`,
    status: srv.connected ? ("pass" as CheckStatus) : ("warn" as CheckStatus),
    detail: srv.connected
      ? `Connected${srv.supportsReadOnly ? (srv.readOnly ? " (read-only)" : " (READ-WRITE)") : ""}`
      : srv.unavailableReason ?? "Not connected.",
    fix: srv.connected ? undefined : srv.unavailableReason ? undefined : "Toggle it on in the sidebar.",
  }));
}

/**
 * The Unity chain, one check per link.
 *
 * Cullus never talks to the Editor. It spawns `unity mcp`, which reads
 * <project>/Library/Pipeline/.unity-pipeline-port and calls the HTTP server the
 * Pipeline package runs inside the Editor. Four things must hold, and the whole
 * reason this exists is that missing any one produces the SAME symptom: the
 * server connects, exposes zero tools, and the model reports it has no Unity
 * tools — indistinguishable from a broken install.
 *
 * So each link is reported separately, and the fix names the step.
 */
async function checkUnity(): Promise<Check[]> {
  const cli = findUnityCli();

  if (!cli) {
    return [
      {
        name: "Unity: CLI",
        status: "warn",
        detail: "Not installed (looked on PATH and in ~/.unity/bin).",
        fix: "brew install unity-cli — or ignore this if you do not use Unity.",
      },
    ];
  }

  const checks: Check[] = [];

  let version = "unknown";
  try {
    version = (await run(cli, ["--version"], { timeout: 15_000 })).stdout.trim();
  } catch {
    /* version is a nicety; the real checks follow */
  }
  checks.push({ name: "Unity: CLI", status: "pass", detail: `${version} at ${cli}` });

  // `pipeline list` answers running / installed / reachable in one call, and is
  // also the command to hand someone who is stuck.
  // Field names come from `unity pipeline list --json` on 1.0.0-beta.8, which
  // does NOT match the TSV column headers — the human table says "Running" and
  // "Pipeline", the JSON says isRunning and hasPipelinePackage. Read the JSON.
  let rows: any[] = [];
  try {
    const { stdout } = await run(cli, ["pipeline", "list", "--json"], { timeout: 30_000 });
    const data = JSON.parse(stdout)?.data;
    rows = Array.isArray(data) ? data : data?.instances ?? [];
  } catch (err: any) {
    checks.push({
      name: "Unity: Editor",
      status: "warn",
      detail: `Could not query the Editor: ${String(err?.message ?? err).slice(0, 120)}`,
      fix: "Run `unity pipeline list` yourself to see the raw error.",
    });
    return checks;
  }

  const running = rows.filter((r) => r?.isRunning);
  if (running.length === 0) {
    checks.push({
      name: "Unity: Editor",
      status: "warn",
      detail: `No Unity Editor is running. ${unityModeTradeoff()}`,
      fix:
        "Open your project in Unity — the Unity tool list stays empty until then. " +
        "If you wanted unity_compile, leave it closed: that is the mode it needs.",
    });
    return checks;
  }

  for (const row of running) {
    const project = row.projectName ?? "project";
    const projectPath = row.projectPath ?? "";
    const pipelineVersion = row.pipelineVersion ?? "";

    if (!row.hasPipelinePackage) {
      checks.push({
        name: `Unity: ${project}`,
        status: "warn",
        detail: "Editor is running, but com.unity.pipeline is not installed in this project.",
        fix: `unity pipeline install --project-path ${projectPath}`.trim(),
      });
      continue;
    }

    if (!row.pipelineServer?.isReachable) {
      // The case that cost the most time here: the package sits in
      // manifest.json unresolved, so no server ever starts. Focusing the Editor
      // window makes Unity resolve it.
      checks.push({
        name: `Unity: ${project}`,
        status: "warn",
        detail: `Pipeline ${pipelineVersion} is installed but its server is not reachable.`.trim(),
        fix:
          "Click into the Unity Editor window so it resolves the package, then re-run. " +
          "If it stays unreachable, check `lsof -nP -iTCP:7800` — a server bound to [::1] only " +
          "is a known IPv6 bug that the CLI reports as unreachable.",
      });
      continue;
    }

    checks.push({
      name: `Unity: ${project}`,
      status: "pass",
      // The other half is stated even on a pass: this is the exact state in
      // which someone reaches for unity_compile and is told the project is
      // locked, with no hint that the lock is the Editor they just opened.
      detail:
        `Pipeline ${pipelineVersion} reachable on port ${row.pipelineServer.port}. `.trim() +
        ` ${unityModeTradeoff()}`,
    });
  }

  // Several reachable Editors means `unity mcp` picks one, and which one is not
  // something the user chose.
  if (running.filter((r) => r?.pipelineServer?.isReachable).length > 1) {
    checks.push({
      name: "Unity: multiple Editors",
      status: "warn",
      detail: "More than one Editor is reachable; `unity mcp` will connect to one of them.",
      fix: "Close the ones you are not using, or pin the server with --project-path.",
    });
  }

  return checks;
}

/** Same resolution order as the MCP server definition, including ~/.unity/bin. */
function findUnityCli(): string | null {
  const candidates = [
    path.join(process.env.HOME ?? "", ".unity", "bin", "unity"),
    "/opt/homebrew/bin/unity",
    "/usr/local/bin/unity",
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "unity")),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable PATH entry */
    }
  }
  return null;
}

async function checkTools(): Promise<Check> {
  try {
    const tools = await mcpManager.getAllOllamaTools();
    const names = tools.map((t: any) => t?.function?.name).filter(Boolean);
    const duplicates = names.filter((n: string, i: number) => names.indexOf(n) !== i);

    if (duplicates.length > 0) {
      return {
        name: "Tool registry",
        status: "fail",
        detail: `${names.length} tools, but these names are duplicated: ${[...new Set(duplicates)].join(", ")}`,
        fix: "This is a bug in tool registration — duplicate names make routing ambiguous.",
      };
    }

    const aliases = mcpManager.getToolAliases();

    if (aliases.length > 0) {
      return {
        name: "Tool registry",
        status: "pass",
        detail:
          `${names.length} tools, all reachable. Renamed to avoid clashes: ` +
          aliases
            .map((a) => `"${a.original}" from "${a.server}" → "${a.exposedAs}" (name held by "${a.shadowedBy}")`)
            .join("; "),
      };
    }

    return { name: "Tool registry", status: "pass", detail: `${names.length} tools available` };
  } catch (err: any) {
    return {
      name: "Tool registry",
      status: "fail",
      detail: `Tool discovery failed: ${err.message}`,
      fix: "Check the terminal running `cullus` for the underlying error.",
    };
  }
}

async function checkNpx(): Promise<Check> {
  try {
    const { stdout } = await run("npx", ["--version"], { timeout: 15_000 });
    return { name: "npx", status: "pass", detail: `v${stdout.trim()} (needed to spawn MCP servers)` };
  } catch {
    return {
      name: "npx",
      status: "fail",
      detail: "npx not found, so npx-based MCP servers cannot start.",
      fix: "Install Node.js properly: `brew install node`.",
    };
  }
}

/**
 * Playwright is optional on purpose — it pulls a large browser download — so a
 * missing one is a warning, never a failure. Without it, fetch_url still works;
 * it just cannot read JavaScript-rendered pages or get past a site that blocks
 * plain requests.
 */
async function checkBrowser(): Promise<Check> {
  const { browserAvailable } = await import("./browser.js");

  if (!(await browserAvailable())) {
    return {
      name: "Browser rendering",
      status: "warn",
      detail:
        "Playwright is not installed. fetch_url works, but pages that render client-side " +
        "or block automated requests will come back empty.",
      fix: "npm install --save-optional playwright && npx playwright install chromium",
    };
  }

  try {
    // Installed is not the same as usable: the package can be present with no
    // browser binary downloaded, which only fails at launch.
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    return {
      name: "Browser rendering",
      status: "pass",
      detail: `Chromium available (${path.split("/").slice(-3).join("/")})`,
    };
  } catch (err: any) {
    return {
      name: "Browser rendering",
      status: "warn",
      detail: `Playwright is installed but no browser binary was found: ${err?.message ?? err}`,
      fix: "npx playwright install chromium",
    };
  }
}

async function checkAllowedPaths(): Promise<Check> {
  const paths = mcpManager.getAllowedPaths();

  if (paths.length === 0) {
    return {
      name: "Accessible directories",
      status: "warn",
      detail: "None granted, so filesystem tools cannot read anything.",
      fix: "Add one with the 📁 button, or `/paths add <path>`.",
    };
  }

  const missing = paths.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      name: "Accessible directories",
      status: "warn",
      detail: `${paths.length} granted, but these no longer exist: ${missing.join(", ")}`,
      fix: "Remove the stale entries with the ✕ button in the sidebar.",
    };
  }

  return {
    name: "Accessible directories",
    status: "pass",
    detail: `${paths.length}: ${paths.join(", ")}`,
  };
}

async function checkSession(): Promise<Check> {
  const s = getSettings();
  const notes = [`effort=${s.effort}`];
  if (s.planMode) notes.push("plan mode ON (mutating tools withheld)");
  if (s.goal) notes.push(`goal set`);
  if (s.debug) notes.push("debug ON");
  if (s.outputStyle !== "default") notes.push(`style=${s.outputStyle}`);
  if (s.fidelity !== "playable") notes.push(`fidelity=${s.fidelity}`);

  // The one combination that cannot be satisfied. "Implement fully, expect this
  // to take several turns" against a six-step budget is an instruction the model
  // has no way to follow, and the symptom — production work that stops halfway —
  // looks like a model failure rather than a settings conflict.
  if (s.effort === "low" && s.fidelity === "production") {
    return {
      name: "Session settings",
      status: "warn",
      detail: `${notes.join(", ")} — effort=low caps the turn at 6 tool steps, which cannot deliver production fidelity. Raise /effort or lower /fidelity.`,
    };
  }

  return { name: "Session settings", status: "pass", detail: notes.join(", ") };
}

async function checkDiskState(): Promise<Check> {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      return {
        name: "State directory",
        status: "warn",
        detail: `${CONFIG_DIR} does not exist yet.`,
        fix: "Created automatically on first write.",
      };
    }
    fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
    return { name: "State directory", status: "pass", detail: `${CONFIG_DIR} is writable` };
  } catch {
    return {
      name: "State directory",
      status: "fail",
      detail: `${CONFIG_DIR} is not writable, so settings cannot persist.`,
      fix: `Fix permissions: \`chmod u+w ${CONFIG_DIR}\`.`,
    };
  }
}

/**
 * Is the running process older than the build on disk?
 *
 * Node reads its modules once, at startup. `npm run build` after that rewrites
 * `dist/` and changes nothing about the process already serving — so a fix that
 * is genuinely on disk appears not to work, which is indistinguishable from a
 * fix that is wrong. That cost three consecutive debugging runs here: the
 * process had started at 16:36:26 and the corrected module was written at
 * 16:39:37, and the old error string kept coming back.
 *
 * Compares process start time against the newest mtime in `dist/`. Both are
 * cheap and neither needs the build to cooperate.
 */
export function buildDrift(): { stale: boolean; builtAt?: Date; startedAt: Date; newest?: string } {
  const startedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000));
  const self = resolveSelf();
  if (!self) return { stale: false, startedAt };

  const dist = path.join(self, "dist");

  let newestMs = 0;
  let newest: string | undefined;

  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newestMs) {
          newestMs = mtimeMs;
          newest = path.relative(self, full);
        }
      } catch {
        /* a file that vanished mid-walk is not the newest */
      }
    }
  };

  walk(dist, 0);
  if (newestMs === 0) return { stale: false, startedAt };

  // A few seconds of slack: a build that finishes while the process is booting
  // is not drift, and mtime granularity is not worth a false alarm over.
  const stale = newestMs > startedAt.getTime() + 5_000;
  return { stale, builtAt: new Date(newestMs), startedAt, newest };
}

async function checkBuildDrift(): Promise<Check> {
  const drift = buildDrift();
  const when = (d: Date) => d.toTimeString().slice(0, 8);

  if (!drift.builtAt) {
    return {
      name: "Running build",
      status: "warn",
      detail: "Could not locate dist/ to compare against the running process.",
      fix: "Run `npm run build` from the Cullus checkout.",
    };
  }

  if (drift.stale) {
    return {
      name: "Running build",
      status: "fail",
      detail:
        `The build on disk is NEWER than this process — your code changes are not running. ` +
        `Process started ${when(drift.startedAt)}; ${drift.newest} built ${when(drift.builtAt)}.`,
      fix: "Restart: quit this process and run `assistant` again. Rebuilding alone will not help.",
    };
  }

  return {
    name: "Running build",
    status: "pass",
    detail: `Current. Started ${when(drift.startedAt)}, built ${when(drift.builtAt)}.`,
  };
}

export async function runDiagnostics(): Promise<Diagnostics> {
  const groups = await Promise.all([
    checkBuildDrift().then((c) => [c]),
    checkNode().then((c) => [c]),
    checkNpx().then((c) => [c]),
    checkBrowser().then((c) => [c]),
    checkOllama(),
    checkConfig().then((c) => [c]),
    checkDiskState().then((c) => [c]),
    checkVault(),
    checkMcp(),
    checkUnity(),
    checkTools().then((c) => [c]),
    checkAllowedPaths().then((c) => [c]),
    checkSession().then((c) => [c]),
  ]);

  const checks = groups.flat();

  return {
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      warn: checks.filter((c) => c.status === "warn").length,
      fail: checks.filter((c) => c.status === "fail").length,
    },
    checks,
  };
}
