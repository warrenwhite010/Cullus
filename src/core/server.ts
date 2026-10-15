import express from "express";
import { loadJobs as loadCronJobs } from "./cronStore.js";
import http from "http";
import { Server, Socket } from "socket.io";
import path from "path";
import * as fsSync from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import {
  getAiResponse,
  getSessionUsage,
  resetSession,
  activateLoadedSession,
  restoreActiveSession,
  AssistantError,
  estimateTokens,
  trimHistoryForSend,
} from "./provider.js";
import { mcpManager } from "./mcpManager.js";
import { runAgentPipeline } from "./pipeline.js";
import {
  loadConfig,
  saveConfig,
  expandPath,
  isVaultReadOnly,
  PERFORMANCE_BOUNDS,
  PERFORMANCE_KEYS,
  VAULT_PATH_KEYS,
} from "./config.js";
import { getOllamaHealth, getModelSizes } from "./ollama.js";
import {
  getServersWithMode,
  setServerReadOnly,
  refreshFilesystemServer,
  isReadOnly,
  getServerDefinitions,
  saveCustomServer,
  removeCustomServer,
  discoverImportableServers,
  reconnectServer,
  unityCatalogueReason,
  unityModeTradeoff,
} from "./mcpServers.js";
import { getSecret, getSecretStatus, setSecret, deleteSecret } from "./secrets.js";
import {
  getSettings,
  updateSettings,
  cycleMode,
  listEffortLevels,
  sessionEvents,
  MODE_CYCLE,
  MODE_DETAIL,
  MODE_LABELS,
  MAX_TOOL_STEPS,
  CONTINUE_MARKER,
  parseContinuation,
  stripContinuation,
  isBarrenRound,
  BARREN_ROUNDS_BEFORE_STOP,
  listFidelityLevels,
  FIDELITY_LEVELS,
  type SessionSettings,
} from "./session.js";
import { listSkills, readSkill, SKILLS_DIR } from "./skills.js";
import { hasValidator, repairPrompt, validateSkillOutput } from "./skillValidators.js";
import {
  baselineSurvey,
  defaultProject,
  ensureBaseline,
  listSnapshots,
  snapshot,
  undoToSnapshot,
} from "./gitBaseline.js";
import { runDiagnostics, buildDrift } from "./doctor.js";
import { readMemory } from "./systemMemory.js";
import { DeepResearchEngine } from "./deepResearch.js";
import { activeSearchBackend } from "./webTools.js";
import { runFix, loadRuns, revertRun, isFixRunning, type FixEvent } from "./fixLoop.js";
import { resolveTarget, listFixTargets, detectCommands } from "./projectTarget.js";
import {
  listSessions,
  createSession,
  activateSession,
  renameSession,
  deleteSession,
  readSession,
  getActiveSession,
} from "./sessions.js";
import {
  listTasks,
  setTasks,
  clearTasks,
  startTask,
  setTaskStatus,
  addTask,
  updateTask,
  removeTask,
  taskEvents,
} from "./tasks.js";
import { setApprovalHandler, type ApprovalOutcome } from "./approval.js";
import { setInquiryHandler, type InquiryOutcome } from "./inquiry.js";
import { logActivity, listActivity, clearActivity, activityEvents } from "./activity.js";
import {
  inspectVaultPath,
  invalidateVaultCache,
  loadVaultContext,
  loadPersonalProfile,
} from "./vaultStore.js";
import { registerRecipeTools, scanRecipes, createRecipe } from "./recipes.js";
import {
  CONNECTORS,
  describeConnectors,
  saveConnector,
  removeConnectorSecret,
} from "./connectors.js";
import { runFanOut, MAX_WORKERS, type FanOutEvent } from "./agentPool.js";

const app = express();
const server = http.createServer(app);

// The socket has to outlive a long step.
//
// engine.io's defaults give the browser a 45s liveness budget (25s ping interval
// + 20s ping timeout). A local model routinely spends one to three minutes inside
// a single step, and the client's ping timer is a plain setTimeout — which Chrome
// and Safari throttle hard in a backgrounded tab. Tab away mid-step and the tab
// declares the connection dead while the server is working perfectly. That is
// what "Lost connection to the assistant server" was, every time.
//
// connectionStateRecovery restores the same socket id and replays missed packets
// across a short drop, so a blip no longer even looks like one to the UI.
export const io = new Server(server, {
  pingInterval: 25_000,
  pingTimeout: 120_000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60_000,
    skipMiddlewares: true,
  },
});

// Resolve the UI relative to this file, NOT process.cwd() — otherwise the
// dashboard 404s whenever `cullus` is launched from another directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicPath = path.join(__dirname, "..", "public");

app.use(express.static(publicPath));
app.use(express.json());

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"), (err) => {
    if (err) {
      res
        .status(404)
        .send(`Dashboard UI not found at ${publicPath}. Run \`npm run build\` and retry.`);
    }
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Health.
 *
 * Returns an overall status, not just a pile of data, so a supervisor or an
 * uptime check can act on it without knowing the shape of the response:
 *
 *   ok       everything the assistant needs is working
 *   degraded it runs, but something is off — a scheduled job is failing, an
 *            MCP server will not connect. Worth looking at, not worth paging.
 *   down     Ollama is unreachable, so no turn can complete at all.
 *
 * The HTTP code follows: 200 for ok and degraded, 503 for down. A load balancer
 * or `launchctl` KeepAlive should pull a down instance; a degraded one is still
 * serving and pulling it would make things worse.
 */
app.get("/api/health", async (_req, res) => {
  const [health, config] = [await getOllamaHealth(), loadConfig()];

  const problems: string[] = [];

  const ollamaUp = Boolean((health as any)?.running ?? (health as any)?.ok ?? health);
  if (!ollamaUp) problems.push("ollama is not reachable");

  const servers = getServersWithMode();
  const failedServers = (servers as any[]).filter((s) => s?.status === "error" || s?.connected === false);
  for (const s of failedServers) problems.push(`mcp server ${s.name ?? "unknown"} is not connected`);

  let cron: { armed: number; failing: number; disabled: number } | null = null;
  try {
    const { status } = await import("./cron.js");
    const jobs = status();
    cron = {
      armed: jobs.filter((j) => j.enabled && j.nextRun).length,
      failing: jobs.filter((j) => j.failureCount > 0).length,
      disabled: jobs.filter((j) => !j.enabled).length,
    };
    if (cron.failing > 0) problems.push(`${cron.failing} scheduled job(s) failing`);
  } catch {
    /* scheduler may not have started; not a health problem in itself */
  }

  const status = !ollamaUp ? "down" : problems.length > 0 ? "degraded" : "ok";

  res.status(status === "down" ? 503 : 200).json({
    status,
    problems,
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? null,
    ollama: health,
    vaultPath: config.vaultPath,
    mcpServers: servers,
    cron,
    session: getSessionUsage(),
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Every credential this app manages, derived from the connector definitions so
 * the two cannot drift: a connector that declares a secret field is manageable
 * here by construction, and nothing else is.
 *
 * The UI enters tokens through Settings → Connections. These endpoints remain
 * for the CLI and for /doctor, which report on presence, never on values.
 */
const MANAGED_SECRETS = Array.from(
  new Set(
    CONNECTORS.flatMap((connector) =>
      connector.fields.filter((field) => field.secret).map((field) => field.key)
    )
  )
);

app.get("/api/config", (_req, res) => {
  const config = loadConfig();
  res.json({
    vaultPath: config.vaultPath,
    defaultModel: config.defaultModel,
    port: config.port,
    // Presence only. Token values never leave the server process.
    secrets: MANAGED_SECRETS.map((key) => getSecretStatus(key)),
  });
});

// ---------------------------------------------------------------------------
// Secrets
//
// The value is write-only across this boundary: it can be set and deleted, but
// no endpoint ever returns it. Reads yield presence, storage backend, and a
// masked preview (`••••7f3a`) that is enough to confirm identity and useless if
// intercepted.
// ---------------------------------------------------------------------------

app.get("/api/secrets", (_req, res) => {
  res.json({ secrets: MANAGED_SECRETS.map((key) => getSecretStatus(key)) });
});

app.post("/api/secrets", async (req, res) => {
  const { key, value } = req.body ?? {};

  if (!MANAGED_SECRETS.includes(key)) {
    return res
      .status(400)
      .json({ success: false, error: `Unknown secret "${key}".`, allowed: MANAGED_SECRETS });
  }
  if (typeof value !== "string" || !value.trim()) {
    return res.status(400).json({ success: false, error: "value must be a non-empty string." });
  }

  const existing = getSecretStatus(key);
  if (existing.source === "env") {
    return res.status(409).json({
      success: false,
      error: `${key} is set by an environment variable, which takes precedence.`,
      hint: `Unset ${key} in your shell before storing it here.`,
    });
  }

  try {
    const source = await setSecret(key, value);
    const status = getSecretStatus(key);

    // Restart anything that depends on this token so it takes effect immediately.
    const dependsOn: Record<string, string> = {
      OBSIDIAN_API_KEY: "obsidian-live",
      GITHUB_TOKEN: "github",
    };
    const dependents = getServerDefinitions().filter((d) => d.name === dependsOn[key]);
    for (const definition of dependents) {
      try {
        await setServerReadOnly(definition.name, isReadOnly(definition.name));
      } catch (err: any) {
        console.warn(`⚠️  Could not start ${definition.name}: ${err.message}`);
      }
    }

    res.json({ success: true, source, status, servers: getServersWithMode() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/secrets/:key", async (req, res) => {
  const key = req.params.key;
  if (!MANAGED_SECRETS.includes(key)) {
    return res.status(400).json({ success: false, error: `Unknown secret "${key}".` });
  }

  try {
    await deleteSecret(key);

    // A token discovered in ~/.claude.json is not ours to delete, so the secret
    // may still resolve after this. Only tear the dependent server down when the
    // token is really gone; otherwise restart it so it keeps the working value.
    if (key === "OBSIDIAN_API_KEY") {
      if (getSecret("OBSIDIAN_API_KEY")) {
        try {
          await setServerReadOnly("obsidian-live", isReadOnly("obsidian-live"));
        } catch (err: any) {
          console.warn(`⚠️  Could not restart obsidian-live: ${err.message}`);
        }
      } else {
        await mcpManager.unregisterServer("obsidian-live");
      }
    }

    res.json({ success: true, status: getSecretStatus(key), servers: getServersWithMode() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/config/vault", (req, res) => {
  const raw = req.body?.path;

  // An empty value clears the vault rather than setting a bogus one.
  if (raw === null || raw === "" || raw === undefined) {
    const next = saveConfig({ vaultPath: null });
    return res.json({ success: true, vaultPath: next.vaultPath });
  }

  if (typeof raw !== "string") {
    return res.status(400).json({ success: false, error: "path must be a string." });
  }

  const next = saveConfig({ vaultPath: expandPath(raw) });
  res.json({ success: true, vaultPath: next.vaultPath });
});

app.post("/api/config/model", (req, res) => {
  const model = req.body?.model;
  if (model !== null && typeof model !== "string") {
    return res.status(400).json({ success: false, error: "model must be a string or null." });
  }
  const next = saveConfig({ defaultModel: model || null });
  res.json({ success: true, defaultModel: next.defaultModel });
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

app.get("/api/session/usage", (_req, res) => {
  res.json(getSessionUsage());
});

// ---------------------------------------------------------------------------
// Session switches: /effort, /goal, /debug, /plan, /adhd
// ---------------------------------------------------------------------------

/**
 * The machine's memory state, for the status bar.
 *
 * Polled by the client rather than pushed on a server timer: a headless server
 * with no browser attached should spend nothing, and a backgrounded tab gets
 * throttled by the browser without us having to arrange it. readMemory caches
 * for 1.5s, so several tabs polling in step do not multiply the cost.
 */
app.get("/api/system/memory", async (_req, res) => {
  res.json(await readMemory());
});

app.get("/api/session/settings", (_req, res) => {
  res.json({
    settings: getSettings(),
    effortLevels: listEffortLevels(),
    fidelityLevels: listFidelityLevels(),
  });
});

app.post("/api/session/settings", (req, res) => {
  const patch = req.body ?? {};
  const allowed = [
    "effort",
    "goal",
    "debug",
    "outputStyle",
    "fidelity",
    "planMode",
    "plan",
    "mode",
    "maxSteps",
    "autoContinue",
    "maxAutoContinues",
  ];
  const clean: Record<string, any> = {};

  for (const key of allowed) {
    if (key in patch) clean[key] = patch[key];
  }

  if ("autoContinue" in clean) clean.autoContinue = Boolean(clean.autoContinue);

  // Clamped rather than rejected: this is a safety rail on a self-resuming loop,
  // so a bad value should land somewhere sane instead of failing the request.
  if ("maxAutoContinues" in clean) {
    const rounds = Number(clean.maxAutoContinues);
    if (!Number.isFinite(rounds)) {
      return res
        .status(400)
        .json({ success: false, error: "maxAutoContinues must be a number." });
    }
    clean.maxAutoContinues = Math.max(1, Math.min(Math.round(rounds), 40));
  }

  if ("effort" in clean && !["low", "medium", "high"].includes(clean.effort)) {
    return res
      .status(400)
      .json({ success: false, error: "effort must be low, medium or high." });
  }

  if ("outputStyle" in clean && !["default", "adhd"].includes(clean.outputStyle)) {
    return res
      .status(400)
      .json({ success: false, error: "outputStyle must be default or adhd." });
  }

  // Validated against the exported level list rather than a second copy of the
  // names, so adding a level cannot leave the API rejecting it.
  if ("fidelity" in clean && !FIDELITY_LEVELS.includes(clean.fidelity)) {
    return res.status(400).json({
      success: false,
      error: `fidelity must be one of: ${FIDELITY_LEVELS.join(", ")}.`,
    });
  }

  if ("mode" in clean && !MODE_CYCLE.includes(clean.mode)) {
    return res
      .status(400)
      .json({ success: false, error: `mode must be one of: ${MODE_CYCLE.join(", ")}.` });
  }

  if ("maxSteps" in clean && clean.maxSteps !== null) {
    const steps = Math.floor(Number(clean.maxSteps));
    if (!Number.isFinite(steps) || steps < 1) {
      return res.status(400).json({ success: false, error: "maxSteps must be a positive number or null." });
    }
    clean.maxSteps = Math.min(steps, MAX_TOOL_STEPS);
  }

  res.json({ success: true, settings: updateSettings(clean) });
});

// ---------------------------------------------------------------------------
// Autonomy mode (shift+tab in the composer)
// ---------------------------------------------------------------------------

app.get("/api/session/modes", (_req, res) => {
  res.json({
    modes: MODE_CYCLE.map((mode) => ({ mode, label: MODE_LABELS[mode], detail: MODE_DETAIL[mode] })),
    current: getSettings().mode,
    maxToolSteps: MAX_TOOL_STEPS,
  });
});

app.post("/api/session/mode/cycle", (_req, res) => {
  const settings = cycleMode();
  logActivity({ kind: "session", label: `mode → ${settings.mode}`, summary: MODE_DETAIL[settings.mode] });
  res.json({ success: true, settings });
});

// ---------------------------------------------------------------------------
// Skills: reusable prompt macros stored as markdown in ~/.cullus/skills/
// ---------------------------------------------------------------------------

app.get("/api/skills", (_req, res) => {
  res.json({ skills: listSkills(), directory: SKILLS_DIR });
});

app.get("/api/skills/:name", (req, res) => {
  const skill = readSkill(req.params.name);
  if (!skill) {
    return res.status(404).json({ error: `No skill named "${req.params.name}".` });
  }
  res.json(skill);
});

// ---------------------------------------------------------------------------
// Git baseline: is this project recoverable before something rewrites it?
// ---------------------------------------------------------------------------
//
// Split into a read route and a write route rather than one route with a flag.
// The listing is rendered for every granted directory the moment /gitinit is
// typed with no argument, and a survey that could initialise repositories as a
// side effect of being looked at would be a bad trade for one fewer route.

app.get("/api/git/baseline", (_req, res) => {
  res.json({ projects: baselineSurvey() });
});

app.post("/api/git/baseline", (req, res) => {
  const requested = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!requested) {
    return res.status(400).json({
      error: "A project path is required.",
      actionRequired: "Call /gitinit <path>, or pick one of the listed projects.",
    });
  }

  const result = ensureBaseline(requested);
  if ("error" in result) return res.status(400).json(result);
  res.json(result);
});

// The snapshot/undo loop. `path` is optional on all three: an absent path means
// "the one granted project that is not Cullus itself", and when that is
// ambiguous the resolver returns the choices instead of guessing — a hard reset
// is not something to default.
function resolveRequestedProject(body: any): { root: string } | { choices: string[] } {
  const supplied = typeof body?.path === "string" ? body.path.trim() : "";
  return supplied ? { root: supplied } : defaultProject();
}

app.get("/api/git/snapshots", (req, res) => {
  const chosen = resolveRequestedProject({ path: req.query.path });
  if ("choices" in chosen) {
    return res.status(400).json({
      error: "More than one project is granted, so the target is ambiguous.",
      actionRequired: `Name one: ${chosen.choices.join(", ")}`,
      choices: chosen.choices,
    });
  }

  const result = listSnapshots(chosen.root, Number(req.query.limit) || 10);
  if ("error" in result) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/git/snapshot", (req, res) => {
  const chosen = resolveRequestedProject(req.body);
  if ("choices" in chosen) {
    return res.status(400).json({
      error: "More than one project is granted, so the target is ambiguous.",
      actionRequired: `Name one with --target: ${chosen.choices.join(", ")}`,
      choices: chosen.choices,
    });
  }

  const label = typeof req.body?.label === "string" ? req.body.label : undefined;
  const result = snapshot(chosen.root, label);
  if ("error" in result) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/git/undo", (req, res) => {
  const chosen = resolveRequestedProject(req.body);
  if ("choices" in chosen) {
    return res.status(400).json({
      error: "More than one project is granted, so the target is ambiguous.",
      actionRequired: `Name one with --target: ${chosen.choices.join(", ")}`,
      choices: chosen.choices,
    });
  }

  const result = undoToSnapshot(chosen.root, { force: req.body?.force === true });
  if ("error" in result) return res.status(400).json(result);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Doctor: one call that checks everything and says how to fix what's broken
// ---------------------------------------------------------------------------

// Recent log lines, newest first. The dashboard reads this so a scheduled job
// that failed overnight is visible without opening a terminal.
app.get("/api/logs", async (req, res) => {
  try {
    const { tail } = await import("./logger.js");
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const level = String(req.query.level ?? "");
    let lines = tail(limit);
    if (level) lines = lines.filter((l) => l.level === level);
    res.json({ lines });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// Switch a whole tool source on or off.
//
// The lever the popup's token count implies: a server contributing 34 tools
// costs its schema on every message whether or not you use it. Disabling
// withholds them from the model entirely rather than refusing at call time.
app.post("/api/tools/source/:name/enabled", (req, res) => {
  try {
    const name = String(req.params.name);
    const enabled = Boolean(req.body?.enabled);
    const config = loadConfig();
    const next = { ...(config.mcpToolsDisabled ?? {}) };
    if (enabled) delete next[name];
    else next[name] = true;
    saveConfig({ mcpToolsDisabled: next });
    res.json({ ok: true, source: name, enabled });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// --- scheduled jobs -------------------------------------------------------
app.get("/api/cron", async (_req, res) => {
  try {
    const { status } = await import("./cron.js");
    res.json({ jobs: status() });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// Schedule preview. The form calls this on every change so the user sees what
// their choice actually means before creating anything — same validator the
// create path uses, so there is one source of truth for "is this valid".
app.get("/api/cron/preview", async (req, res) => {
  try {
    const { validateSchedule } = await import("./cron.js");
    const { Cron } = await import("croner");
    const schedule = String(req.query.schedule ?? "");
    const error = validateSchedule(schedule);
    if (error) return res.json({ valid: false, error });

    const probe = new Cron(schedule, { paused: true });
    const upcoming: string[] = [];
    let cursor: Date | null = probe.nextRun();
    for (let i = 0; i < 3 && cursor; i++) {
      upcoming.push(cursor.toISOString());
      cursor = probe.nextRun(cursor);
    }
    probe.stop();
    res.json({ valid: true, upcoming });
  } catch (err: any) {
    res.json({ valid: false, error: String(err?.message ?? err) });
  }
});

app.post("/api/cron", async (req, res) => {
  try {
    const { validateSchedule, checkLifecycleSafety, reload } = await import("./cron.js");
    const { addJob } = await import("./cronStore.js");
    const { name, schedule, prompt, kind, monitorScript } = req.body ?? {};

    if (!name || !schedule || !prompt) {
      return res.status(400).json({ error: "name, schedule and prompt are required" });
    }
    const scheduleError = validateSchedule(schedule);
    if (scheduleError) return res.status(400).json({ error: scheduleError });

    const lifecycleError = checkLifecycleSafety(monitorScript);
    if (lifecycleError) return res.status(400).json({ error: lifecycleError });

    const job = addJob({
      name,
      schedule,
      prompt,
      kind: kind === "monitor" ? "monitor" : "prompt",
      monitorScript: kind === "monitor" ? monitorScript : undefined,
    });
    reload();
    res.json({ job });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.post("/api/cron/:id/enabled", async (req, res) => {
  try {
    const { reload } = await import("./cron.js");
    const { setEnabled } = await import("./cronStore.js");
    const ok = setEnabled(req.params.id, Boolean(req.body?.enabled));
    if (!ok) return res.status(404).json({ error: "no job with that id" });
    reload();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.delete("/api/cron/:id", async (req, res) => {
  try {
    const { reload } = await import("./cron.js");
    const { removeJob } = await import("./cronStore.js");
    const ok = removeJob(req.params.id);
    if (!ok) return res.status(404).json({ error: "no job with that id" });
    reload();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.get("/api/doctor", async (_req, res) => {
  res.json(await runDiagnostics());
});

// ---------------------------------------------------------------------------
// Vault memory: where context, notes, skills and recipes live
// ---------------------------------------------------------------------------

// Single source of truth in config.ts, so a new role appears here without edits.

app.get("/api/vault/paths", (_req, res) => {
  const config = loadConfig();
  const context = loadVaultContext();
  const profile = loadPersonalProfile();
  const recipes = scanRecipes();

  res.json({
    vaultPath: config.vaultPath,
    // The 🔒 toggle is the hard lock; modes decide whether a write is asked about.
    locked: isVaultReadOnly(),
    paths: VAULT_PATH_KEYS.map((key) => {
      const configured = config.vaultPaths?.[key] ?? null;
      return {
        key,
        value: configured,
        ...(configured ? inspectVaultPath(configured) : { exists: false, kind: "unset" }),
      };
    }),
    context: context
      ? { sources: context.sources, characters: context.text.length, truncated: context.truncated }
      : null,
    profile: profile
      ? { sources: profile.sources, characters: profile.text.length, truncated: profile.truncated }
      : null,
    recipes: {
      ready: recipes.recipes.map((r) => ({ tool: `recipe_${r.slug}`, command: r.command, path: r.vaultPath })),
      broken: recipes.broken,
    },
  });
});

app.post("/api/vault/paths", (req, res) => {
  const current = loadConfig().vaultPaths;
  const next = { ...current };

  for (const key of VAULT_PATH_KEYS) {
    if (!(key in (req.body ?? {}))) continue;
    const value = req.body[key];

    if (value === null || value === "") {
      next[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      return res.status(400).json({ success: false, error: `${key} must be a string or null.` });
    }

    const cleaned = value.trim().replace(/^\/+/, "");
    if (cleaned.split("/").includes("..")) {
      return res.status(400).json({ success: false, error: `${key} must not contain ".." segments.` });
    }
    next[key] = cleaned;
  }

  saveConfig({ vaultPaths: next });
  invalidateVaultCache();

  // Recipes are tools, so a changed folder must re-register them immediately.
  const recipes = registerRecipeTools();

  logActivity({
    kind: "session",
    label: "vault paths updated",
    summary: VAULT_PATH_KEYS.map((key) => `${key}=${next[key] ?? "(unset)"}`).join(" · "),
  });

  res.json({
    success: true,
    vaultPaths: next,
    recipes: { ready: recipes.recipes.length, broken: recipes.broken.length },
  });
});

// ---------------------------------------------------------------------------
// Performance
//
// The dials that decide how much the model has to read before it can answer,
// plus a live measurement of the active session so the numbers are not abstract.
// ---------------------------------------------------------------------------

/**
 * Fuzzy file search for the chat input's `@` picker.
 *
 * Scoped to the granted directories and nothing else: `@` must not become a way
 * to enumerate a filesystem the model was never given access to. Results are
 * paths the user can then reference in a message.
 */
const FILE_PICKER_IGNORED = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".venv", "venv", "__pycache__", ".cache", ".DS_Store", ".obsidian",
]);

app.get("/api/files", (req, res) => {
  const query = String(req.query.q ?? "").trim().toLowerCase();
  const roots = mcpManager.getAllowedPaths();
  const limit = 40;
  const matches: Array<{ path: string; name: string; root: string }> = [];

  // Breadth-first with a hard node budget: an `@` keystroke must not walk a
  // 200k-file tree while someone is typing.
  let budget = 20_000;

  for (const root of roots) {
    const queue: string[] = [root];

    while (queue.length > 0 && matches.length < limit && budget > 0) {
      const dir = queue.shift()!;
      budget--;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory is not an error worth failing the request over
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (FILE_PICKER_IGNORED.has(entry.name)) continue;

        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;

        // Match on the path relative to its root, so "src/prov" works as well as
        // a bare filename.
        const relative = path.relative(root, full);
        if (query && !relative.toLowerCase().includes(query)) continue;

        matches.push({ path: full, name: entry.name, root });
        if (matches.length >= limit) break;
      }
    }
  }

  // A filename hit beats a directory-name hit: typing "provider" wants
  // provider.ts, not every file under a folder called provider.
  matches.sort((a, b) => {
    const aName = a.name.toLowerCase().includes(query) ? 0 : 1;
    const bName = b.name.toLowerCase().includes(query) ? 0 : 1;
    return aName - bName || a.path.length - b.path.length;
  });

  res.json({
    files: matches.slice(0, limit).map((m) => ({
      path: m.path,
      name: m.name,
      display: path.relative(m.root, m.path),
    })),
    roots: roots.length,
  });
});

/**
 * Create a callable tool from a name, a description and a command.
 *
 * Recipes are the safe way to add functionality: the command comes from a file
 * the user wrote, and the model only ever chooses whether to run it.
 */
app.post("/api/recipes", (req, res) => {
  const { name, description, command } = req.body ?? {};

  for (const [field, value] of Object.entries({ name, description, command })) {
    if (typeof value !== "string" || !value.trim()) {
      return res.status(400).json({ success: false, error: `${field} is required.` });
    }
  }

  const result = createRecipe(name, description, command);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });

  logActivity({
    kind: "session",
    label: `tool created: ${result.toolName}`,
    summary: `${command} · ${result.vaultPath}`,
  });

  res.json({ success: true, toolName: result.toolName, vaultPath: result.vaultPath });
});

/** Attached dashboards, for diagnosing the auto-exit. */
app.get("/api/clients", (_req, res) => {
  res.json({
    clients: clientCount(),
    namespace: io.sockets.sockets.size,
    engine: io.engine?.clientsCount ?? null,
    exitPending: exitTimer !== null,
  });
});

app.get("/api/performance", async (_req, res) => {
  const config = loadConfig();
  const session = getActiveSession();
  const history = session.history ?? [];

  // Which of these are being overridden from the environment: a dial that has no
  // effect because a shell variable outranks it is worse than no dial at all.
  const ENV_OF: Partial<Record<string, string>> = {
    stepIdleTimeoutMs: "ASSISTANT_STEP_TIMEOUT_MS",
    firstTokenTimeoutMs: "ASSISTANT_STEP_FIRST_TOKEN_TIMEOUT_MS",
    stepTotalTimeoutMs: "ASSISTANT_STEP_TOTAL_TIMEOUT_MS",
    toolTimeoutMs: "ASSISTANT_TOOL_TIMEOUT_MS",
  };
  const overriddenByEnv = Object.entries(ENV_OF)
    .filter(([, name]) => process.env[name!])
    .map(([key, name]) => ({ key, env: name, value: process.env[name!] }));

  let toolCount: number | null = null;
  try {
    toolCount = (await mcpManager.getAllOllamaTools()).length;
  } catch {
    toolCount = null; // servers down; not worth failing the whole pane over
  }

  const sent = trimHistoryForSend(history, config.performance.maxHistoryMessages);

  res.json({
    performance: config.performance,
    bounds: PERFORMANCE_BOUNDS,
    overriddenByEnv,
    shutdown: {
      exitWhenLastClientDisconnects: config.exitWhenLastClientDisconnects,
      exitGraceSeconds: config.exitGraceSeconds,
    },
    // What the next turn would actually cost, at the current settings.
    diagnostics: {
      historyMessages: history.length,
      sentMessages: history.length > 0 ? sent.length : 0,
      estimatedPromptTokens: history.length > 0 ? estimateTokens(sent) : 0,
      untrimmedPromptTokens: history.length > 0 ? estimateTokens(history) : 0,
      toolsAvailable: toolCount,
      // Measured on this machine: prompt eval runs at roughly 250 tokens/second,
      // and none of it is streamed, so it is dead time before the first word.
      estimatedPromptEvalSeconds:
        history.length > 0 ? Math.round(estimateTokens(sent) / 250) : 0,
    },
  });
});

app.post("/api/performance", (req, res) => {
  const current = loadConfig().performance;
  const next = { ...current };

  for (const key of PERFORMANCE_KEYS) {
    if (!(key in (req.body ?? {}))) continue;

    const bounds = PERFORMANCE_BOUNDS[key];
    const value = Number(req.body[key]);

    if (!Number.isFinite(value)) {
      return res.status(400).json({ success: false, error: `${key} must be a number.` });
    }
    if (bounds.allowUnlimited && value === 0) {
      next[key] = 0;
      continue;
    }
    if (value < bounds.min || value > bounds.max) {
      return res.status(400).json({
        success: false,
        error:
          `${key} must be between ${bounds.min} and ${bounds.max}` +
          `${bounds.allowUnlimited ? ", or 0 for unlimited" : ""}.`,
      });
    }
    next[key] = Math.floor(value);
  }

  // Shutdown behaviour rides along in the same form, so it saves in one action.
  const patch: Record<string, unknown> = { performance: next };

  if ("exitWhenLastClientDisconnects" in (req.body ?? {})) {
    const value = req.body.exitWhenLastClientDisconnects;
    if (typeof value !== "boolean") {
      return res
        .status(400)
        .json({ success: false, error: "exitWhenLastClientDisconnects must be true or false." });
    }
    patch.exitWhenLastClientDisconnects = value;
  }

  if ("exitGraceSeconds" in (req.body ?? {})) {
    const value = Number(req.body.exitGraceSeconds);
    if (!Number.isFinite(value) || value < 1 || value > 3600) {
      return res
        .status(400)
        .json({ success: false, error: "exitGraceSeconds must be between 1 and 3600." });
    }
    patch.exitGraceSeconds = Math.floor(value);
  }

  saveConfig(patch as Partial<ReturnType<typeof loadConfig>>);

  // No restart, no cache to clear: the inference loop reads these per turn, and
  // the disconnect handler reads the shutdown pair when it fires.
  const changed = PERFORMANCE_KEYS.filter((key) => next[key] !== current[key]);

  logActivity({
    kind: "session",
    label: "performance settings updated",
    summary: changed.length
      ? changed.map((key) => `${key}=${next[key]}`).join(" · ")
      : "no change",
  });

  res.json({ success: true, performance: next, changed });
});

// ---------------------------------------------------------------------------
// Chat sessions
//
// Switching a session rehydrates the inference loop's message array, so the next
// turn continues the conversation the sidebar is showing.
// ---------------------------------------------------------------------------

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.post("/api/sessions", (_req, res) => {
  const session = createSession();
  activateLoadedSession(session.history, session.usage);
  clearTasks();
  res.json({ success: true, session: { id: session.id, title: session.title } });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = readSession(req.params.id);
  if (!session) return res.status(404).json({ error: `No session "${req.params.id}".` });
  res.json({
    id: session.id,
    title: session.title,
    usage: session.usage,
    // The system prompt is machinery, not conversation.
    messages: session.history.filter((m: any) => m?.role === "user" || m?.role === "assistant"),
  });
});

app.post("/api/sessions/:id/activate", (req, res) => {
  const session = activateSession(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: `No session "${req.params.id}".` });

  activateLoadedSession(session.history, session.usage);
  res.json({
    success: true,
    id: session.id,
    title: session.title,
    usage: session.usage,
    messages: session.history.filter((m: any) => m?.role === "user" || m?.role === "assistant"),
  });
});

app.post("/api/sessions/:id/rename", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : "";
  if (!title.trim()) return res.status(400).json({ success: false, error: "title is required." });
  if (!renameSession(req.params.id, title)) {
    return res.status(404).json({ success: false, error: `No session "${req.params.id}".` });
  }
  res.json({ success: true, sessions: listSessions() });
});

app.delete("/api/sessions/:id", (req, res) => {
  if (!deleteSession(req.params.id)) {
    return res.status(404).json({ success: false, error: `No session "${req.params.id}".` });
  }
  res.json({ success: true, sessions: listSessions() });
});

// ---------------------------------------------------------------------------
// Work checklist
// ---------------------------------------------------------------------------

app.get("/api/fanout", (_req, res) => {
  const config = loadConfig();
  res.json({ ...config.fanout, maxWorkers: MAX_WORKERS });
});

app.post("/api/fanout", (req, res) => {
  const current = loadConfig().fanout;
  const workers = req.body?.workers;
  const next = {
    enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : current.enabled,
    workers:
      workers === undefined
        ? current.workers
        : Math.min(Math.max(Math.floor(Number(workers)) || 1, 1), MAX_WORKERS),
    plannerModel:
      req.body?.plannerModel === undefined ? current.plannerModel : req.body.plannerModel || null,
  };
  res.json({ success: true, ...saveConfig({ fanout: next }).fanout, maxWorkers: MAX_WORKERS });
});

app.get("/api/activity", (_req, res) => {
  res.json({ entries: listActivity(Number(req_limit(_req)) || 200) });
});

app.delete("/api/activity", (_req, res) => {
  clearActivity();
  res.json({ success: true });
});

app.get("/api/tasks", (_req, res) => {
  res.json({ tasks: listTasks() });
});

app.delete("/api/tasks", (_req, res) => {
  clearTasks();
  res.json({ success: true, tasks: [] });
});

// Hand-editing the checklist. A list you can only watch is the wrong thing to
// be looking at when a run is going somewhere you did not want.
const TASK_STATUSES = ["pending", "active", "done", "failed"] as const;

app.post("/api/tasks", (req, res) => {
  const subject = typeof req.body?.subject === "string" ? req.body.subject : "";
  if (!subject.trim()) {
    return res.status(400).json({ error: "A task needs a subject." });
  }

  const task = addTask(subject, {
    activeForm: typeof req.body?.activeForm === "string" ? req.body.activeForm : undefined,
  });

  if (!task) {
    return res.status(400).json({ error: "The checklist is full; delete something first." });
  }

  res.json({ success: true, task, tasks: listTasks() });
});

app.patch("/api/tasks/:id", (req, res) => {
  const status = req.body?.status;
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Unknown status "${status}".`,
      actionRequired: `Use one of: ${TASK_STATUSES.join(", ")}.`,
    });
  }

  const task = updateTask(req.params.id, {
    subject: typeof req.body?.subject === "string" ? req.body.subject : undefined,
    activeForm: typeof req.body?.activeForm === "string" ? req.body.activeForm : undefined,
    status,
  });

  if (!task) return res.status(404).json({ error: `No task "${req.params.id}".` });
  res.json({ success: true, task, tasks: listTasks() });
});

app.delete("/api/tasks/:id", (req, res) => {
  if (!removeTask(req.params.id)) {
    return res.status(404).json({ error: `No task "${req.params.id}".` });
  }
  res.json({ success: true, tasks: listTasks() });
});

// ---------------------------------------------------------------------------
// Connections (Settings → Connections)
// ---------------------------------------------------------------------------

app.get("/api/connections", (_req, res) => {
  res.json({ connectors: describeConnectors() });
});

app.post("/api/connections/:id", async (req, res) => {
  const result = await saveConnector(req.params.id, req.body?.values ?? {});
  res.status(result.ok ? 200 : 400).json({ ...result, connectors: describeConnectors() });
});

// Deleting a credential is scoped to the connector that declares it, so this
// cannot reach a secret belonging to anything else.
app.delete("/api/connections/:id/secrets/:key", async (req, res) => {
  const result = await removeConnectorSecret(req.params.id, req.params.key);
  res.status(result.ok ? 200 : 400).json({ ...result, connectors: describeConnectors() });
});

// ---------------------------------------------------------------------------
// User-added MCP servers
//
// Three ways in, one validator: a manual form, a pasted {"mcpServers":{…}} blob
// from a project README, or an import of something the Claude CLI already runs.
// ---------------------------------------------------------------------------

app.get("/api/mcp/discover", (_req, res) => {
  res.json({ servers: discoverImportableServers() });
});

app.post("/api/mcp/custom", async (req, res) => {
  const body = req.body ?? {};

  // A pasted blob may hold several servers; add them all and report each.
  if (typeof body.json === "string" && body.json.trim()) {
    let parsed: any;
    try {
      parsed = JSON.parse(body.json);
    } catch (err: any) {
      return res.status(400).json({ ok: false, message: `That is not valid JSON (${err.message}).` });
    }

    const map = parsed?.mcpServers ?? parsed;
    if (!map || typeof map !== "object") {
      return res.status(400).json({
        ok: false,
        message: 'Expected {"mcpServers": { "name": { … } }} or a single server object.',
      });
    }

    const results: string[] = [];
    const errors: string[] = [];

    for (const [name, entry] of Object.entries<any>(map)) {
      const outcome = await saveCustomServer({
        name,
        transport: entry?.url || entry?.type === "http" || entry?.type === "sse" ? "http" : "stdio",
        command: entry?.command,
        args: Array.isArray(entry?.args) ? entry.args.map(String) : undefined,
        env: entry?.env,
        url: entry?.url,
        allowSelfSigned: entry?.allowSelfSigned === true,
        readOnly: entry?.readOnly !== false,
      });
      if (outcome.ok) results.push(outcome.message);
      else errors.push(`${name}: ${(outcome.errors ?? [outcome.message]).join(" ")}`);
    }

    return res.status(errors.length && !results.length ? 400 : 200).json({
      ok: results.length > 0,
      message: [...results, ...errors].join(" "),
      errors,
      servers: getServersWithMode(),
      connectors: describeConnectors(),
    });
  }

  const outcome = await saveCustomServer(body);
  res.status(outcome.ok ? 200 : 400).json({
    ...outcome,
    servers: getServersWithMode(),
    connectors: describeConnectors(),
  });
});

app.delete("/api/mcp/custom/:name", async (req, res) => {
  const outcome = await removeCustomServer(req.params.name);
  res.status(outcome.ok ? 200 : 400).json({
    ...outcome,
    servers: getServersWithMode(),
    connectors: describeConnectors(),
  });
});

// ---------------------------------------------------------------------------
// /fix — the self-repair loop
// ---------------------------------------------------------------------------

app.get("/api/fix/runs", (_req, res) => {
  res.json({ running: isFixRunning(), runs: loadRuns(), targets: listFixTargets() });
});

app.get("/api/fix/target", (req, res) => {
  const requested = typeof req.query.path === "string" && req.query.path ? req.query.path : null;
  const resolved = resolveTarget(requested);
  if (!resolved.ok) return res.status(400).json(resolved);
  res.json({ ok: true, ...resolved.target, commands: detectCommands(resolved.target.root) });
});

app.post("/api/fix/commands", (req, res) => {
  const resolved = resolveTarget(req.body?.target || null);
  if (!resolved.ok) return res.status(400).json({ success: false, error: resolved.error });

  const root = resolved.target.root;
  const config = loadConfig();
  const existing = config.fixCommands?.[root] ?? {};

  const build = typeof req.body?.build === "string" && req.body.build.trim() ? req.body.build.trim() : existing.build;
  const verify =
    typeof req.body?.verify === "string" && req.body.verify.trim() ? req.body.verify.trim() : existing.verify;

  saveConfig({ fixCommands: { ...(config.fixCommands ?? {}), [root]: { build, verify } } });

  res.json({ success: true, root, commands: detectCommands(root) });
});

app.post("/api/fix/revert", (req, res) => {
  const runId = req.body?.runId;
  if (typeof runId !== "string" || !runId) {
    return res.status(400).json({ ok: false, message: "runId is required." });
  }
  const result = revertRun(runId);
  res.status(result.ok ? 200 : 400).json({ ...result, runs: loadRuns() });
});

// ---------------------------------------------------------------------------
// Shutdown, for /exit
// ---------------------------------------------------------------------------

function stopServer(why: string): void {
  console.log(`\n👋 ${why} Stopping.\n`);
  io.close();
  server.close(() => process.exit(0));
  // Backstop in case a socket refuses to close.
  setTimeout(() => process.exit(0), 2000);
}

app.post("/api/shutdown", (_req, res) => {
  res.json({ success: true, message: "Shutting down." });

  // Let the response flush before tearing the process down.
  setTimeout(() => stopServer("Shutdown requested from the web UI."), 150);
});

// ---------------------------------------------------------------------------
// Exit when the last browser window closes
//
// The dashboard is the only interface, so a server nobody is attached to is
// usually a forgotten process holding a port.
//
// Three things stop this from being a footgun, because a socket cannot tell a
// closed tab from a reload:
//   1. a grace period, cancelled the moment anything reconnects;
//   2. work in flight defers the exit rather than being killed by it;
//   3. it only arms after a client has connected at least once, so
//      `assistant --no-open` does not exit before anyone has had a chance to
//      open the page.
// ---------------------------------------------------------------------------

let everConnected = false;
let exitTimer: NodeJS.Timeout | null = null;

/**
 * Live client count, straight from socket.io.
 *
 * Hand-counting connects and disconnects drifts: a reload opens the new socket
 * before the old one times out, so the tally climbs and never returns to zero —
 * observed reporting "2 still connected" with no browser open at all, which made
 * the exit never arm. socket.io already tracks this correctly.
 */
function clientCount(): number {
  // Namespace size, not `engine.clientsCount`: the engine still counts a
  // connection while it is tearing down, so after a closed tab it reported a
  // live client and the exit never fired. The namespace map is updated when the
  // `disconnect` event fires, which is the moment we care about.
  const namespaceSize = io.sockets.sockets.size;
  const engineSize = io.engine?.clientsCount ?? namespaceSize;
  return Math.min(namespaceSize, engineSize);
}

function cancelPendingExit(): void {
  if (!exitTimer) return;
  clearTimeout(exitTimer);
  exitTimer = null;
  console.log("Reconnected — shutdown cancelled.");
}

function considerExit(): void {
  const config = loadConfig();
  if (!config.exitWhenLastClientDisconnects) return;
  if (!everConnected || exitTimer) return;

  // Scheduled jobs beat the auto-exit, unconditionally.
  //
  // exitWhenLastClientDisconnects defaults to true, which is right for an
  // assistant you open, use and close. It is exactly wrong once you have asked
  // for something to run at 9am: closing the browser would kill the scheduler,
  // the job would never fire, and nothing would say why. Under a service
  // manager with KeepAlive it is worse -- restart, no client, exit, restart.
  //
  // Having an enabled job IS the statement that this process should outlive the
  // window, so it overrides the setting rather than warning about it.
  try {
    const armed = loadCronJobs().filter((j) => j.enabled).length;
    if (armed > 0) {
      console.log(
        `Dashboard closed, but ${armed} scheduled job(s) are enabled — staying up to run them.`
      );
      return;
    }
  } catch {
    /* no scheduler, no reason to stay up */
  }

  const grace = Math.max(1, config.exitGraceSeconds) * 1000;

  // Count at disconnect time is unreliable — this socket may or may not have been
  // removed yet — so arm unconditionally and let the timer decide once things
  // have settled.
  exitTimer = setTimeout(function check() {
    exitTimer = null;

    const remaining = clientCount();
    if (remaining > 0) {
      // Keep watching rather than giving up. A browser can hold a socket open
      // for a while after its window is gone, and a single failed check used to
      // disarm the exit permanently — the feature then silently never fired.
      exitTimer = setTimeout(check, 5_000);
      return;
    }

    // Never pull the process out from under a running turn: a browser closed
    // mid-answer should still let the tool calls and the save finish.
    if (activeTurns.size > 0 || isFixRunning()) {
      console.log("Work still running — deferring shutdown.");
      exitTimer = setTimeout(check, 5_000);
      return;
    }

    stopServer("Last dashboard window closed.");
  }, grace);

  console.log(`Dashboard disconnected. Exiting in ${grace / 1000}s unless one reopens.`);
}

app.post("/api/session/reset", (_req, res) => {
  // Stop the work before clearing what it is working on.
  //
  // Reset used to clear the history array and nothing else, while a turn kept
  // running against it. Because the in-flight turn holds an alias to the OLD
  // array and saveTurn writes that array into whatever session is active, the
  // next auto-continue round found the fresh session populated with the entire
  // pre-reset transcript and carried straight on with the abandoned work. The
  // abort is what makes the reset mean anything.
  cancelAllTurns();

  // Same reasoning as POST /api/sessions, which has always done this: the
  // checklist describes work that no longer exists.
  clearTasks();

  resetSession();
  res.json({ success: true, session: getSessionUsage() });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Every tool the model can currently call, with its source and its cost.
 *
 * The cost matters and is usually invisible. Tool schemas are sent on EVERY
 * request — not once per session — so a hundred tools is a hundred schemas in
 * the prompt of every single turn. On a local model with a small context that
 * is the difference between room to think and none. Hermes states this as the
 * reason its core toolset stays small; this endpoint makes it measurable here.
 *
 * `source` is the MCP server a tool came from, or "local" for built-ins. It is
 * parsed out of the "[Server: x]" prefix getAllOllamaTools() puts in the
 * description, so grouping stays correct without a second source of truth.
 */
app.get("/api/tools", async (_req, res) => {
  try {
    const tools = await mcpManager.getAllOllamaTools();

    const parsed = tools.map((t: any) => {
      const rawDescription = String(t?.function?.description ?? "");
      const serverMatch = rawDescription.match(/^\[Server: ([^\]]+)\]\s*/);
      // A rough proxy: ~4 characters per token is close enough to compare tools
      // against each other and to show an order of magnitude.
      const schemaChars = JSON.stringify(t?.function?.parameters ?? {}).length;
      const descriptionChars = rawDescription.length;
      return {
        name: t?.function?.name,
        description: serverMatch ? rawDescription.slice(serverMatch[0].length) : rawDescription,
        source: serverMatch ? serverMatch[1] : "local",
        approxTokens: Math.round((schemaChars + descriptionChars) / 4),
      };
    });

    const bySource: Record<string, number> = {};
    for (const t of parsed) bySource[t.source] = (bySource[t.source] ?? 0) + 1;

    // Servers that are configured but contributing nothing, and why.
    //
    // Without this the popup silently omits them and the only signal is an
    // absence — you go looking for your Obsidian tools, do not find them, and
    // have no idea whether the server is missing, misconfigured or just not
    // running. Each definition already knows its own prerequisite; this
    // surfaces it at the point where the question is actually asked.
    const unavailable = getServersWithMode()
      .filter((srv: any) => !srv.connected)
      .map((srv: any) => ({
        name: srv.name,
        reason: srv.unavailableReason ?? srv.lastError ?? "not connected",
      }));

    // Sources the user switched off. They are connected and could contribute
    // tools; the model just is not being shown them. Reported separately from
    // `unavailable` because the fix is a toggle, not a prerequisite.
    const disabledMap = loadConfig().mcpToolsDisabled ?? {};
    const disabled = Object.keys(disabledMap).filter((k) => disabledMap[k]);

    // Connected and offering nothing — the worst state to be in, because every
    // other signal says the server is fine. Unity does this whenever Cullus
    // starts before the Editor: the tool list is read once, at connect, and it
    // was empty then. A reconnect is the entire fix, so it is offered inline.
    const silent = getServersWithMode()
      .filter((srv: any) => srv.connected && !disabledMap[srv.name] && !bySource[srv.name])
      .map((srv: any) => ({
        name: srv.name,
        // Unity can say precisely why; other servers cannot, and an invented
        // reason would be worse than none.
        reason: srv.name === "unity" ? unityCatalogueReason() : null,
        // And what you still have while it is in that state — the row otherwise
        // reads as a total loss of Unity support, which it is not.
        modes: srv.name === "unity" ? unityModeTradeoff() : null,
      }));

    res.json({
      tools: parsed,
      unavailable,
      disabled,
      silent,
      summary: {
        count: parsed.length,
        approxTokens: parsed.reduce((n, t) => n + t.approxTokens, 0),
        bySource,
      },
    });
  } catch (err: any) {
    res.status(500).json({ tools: [], error: err.message });
  }
});

// ---------------------------------------------------------------------------
// MCP servers and allowed paths
// ---------------------------------------------------------------------------

app.get("/api/mcp/servers", (_req, res) => {
  res.json(getServersWithMode());
});

// Flip a server between read-only and read-write. The mode is an argv flag, so
// this respawns the subprocess; the preference is persisted to config.
app.post("/api/mcp/mode", async (req, res) => {
  const { name, readOnly } = req.body ?? {};

  if (!name || typeof readOnly !== "boolean") {
    return res
      .status(400)
      .json({ success: false, error: "name (string) and readOnly (boolean) are required." });
  }

  try {
    await setServerReadOnly(name, readOnly);
    res.json({
      success: true,
      name,
      readOnly,
      servers: getServersWithMode(),
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.message,
      servers: getServersWithMode(),
    });
  }
});

app.post("/api/mcp/toggle", async (req, res) => {
  const { name, enable } = req.body ?? {};
  if (!name) {
    return res.status(400).json({ success: false, error: "name is required." });
  }

  try {
    if (enable) {
      await mcpManager.reconnectServer(name);
    } else {
      await mcpManager.disconnectServer(name);
    }
    res.json({ success: true, servers: mcpManager.getServersStatus() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Re-spawn a server and re-read its tools. Rebuilt from the definition rather
// than the stored spawn config, so Unity's tag cache is re-read too — an Editor
// opened after Cullus started is exactly the case this exists for.
app.post("/api/mcp/reconnect", async (req, res) => {
  const name = String(req.body?.name ?? "");
  if (!name) return res.status(400).json({ ok: false, error: "name is required." });

  try {
    const { tools, reason } = await reconnectServer(name);
    res.json({
      ok: true,
      name,
      tools,
      reason,
      modes: name === "unity" ? unityModeTradeoff() : undefined,
    });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: String(error?.message ?? error) });
  }
});

// The UI has always called this; it previously did not exist, so the sidebar's
// path list silently failed on every load.
app.get("/api/mcp/paths", (_req, res) => {
  res.json(mcpManager.getAllowedPaths());
});

app.post("/api/mcp/paths/add", async (req, res) => {
  const raw = req.body?.path;
  if (!raw || typeof raw !== "string") {
    return res.status(400).json({ success: false, error: "path is required." });
  }

  const dirPath = expandPath(raw);

  try {
    mcpManager.addAllowedPath(dirPath);
    saveConfig({ allowedPaths: mcpManager.getAllowedPaths() });
    await refreshFilesystemServer();
    res.json({ success: true, paths: mcpManager.getAllowedPaths() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, paths: mcpManager.getAllowedPaths() });
  }
});

app.post("/api/mcp/paths/remove", async (req, res) => {
  const raw = req.body?.path;
  if (!raw || typeof raw !== "string") {
    return res.status(400).json({ success: false, error: "path is required." });
  }

  try {
    mcpManager.removeAllowedPath(expandPath(raw));
    saveConfig({ allowedPaths: mcpManager.getAllowedPaths() });
    await refreshFilesystemServer();
    res.json({ success: true, paths: mcpManager.getAllowedPaths() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, paths: mcpManager.getAllowedPaths() });
  }
});

// ---------------------------------------------------------------------------
// Native directory picker
//
// The server runs on the same machine as the browser, so we can open a real
// Finder dialog via AppleScript. A browser cannot supply an absolute directory
// path on its own — `<input webkitdirectory>` only exposes relative names.
// ---------------------------------------------------------------------------

app.post("/api/system/choose-directory", (req, res) => {
  if (process.platform !== "darwin") {
    return res.status(501).json({
      success: false,
      error: `Native folder picker is macOS-only (this is ${process.platform}).`,
      hint: "Type the absolute path into the field instead.",
    });
  }

  const prompt = String(req.body?.prompt ?? "Choose a directory to grant access to")
    .replace(/["\\]/g, "")
    .slice(0, 120);

  const script = `
    tell application "System Events"
      activate
      set chosen to choose folder with prompt "${prompt}"
      return POSIX path of chosen
    end tell
  `;

  execFile("osascript", ["-e", script], { timeout: 120_000 }, (err, stdout, stderr) => {
    if (err) {
      const combined = `${stderr ?? ""}${err.message ?? ""}`;

      // Cancelling the dialog is a normal outcome, not a failure.
      if (/User canceled|-128/i.test(combined)) {
        return res.json({ success: false, cancelled: true });
      }

      return res.status(500).json({
        success: false,
        error: "Could not open the folder picker.",
        detail: combined.slice(0, 300),
        hint: "Type the absolute path into the field instead.",
      });
    }

    const chosen = stdout.trim();
    if (!chosen) return res.json({ success: false, cancelled: true });

    res.json({ success: true, path: chosen.replace(/\/$/, "") });
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

app.get("/api/models", async (_req, res) => {
  const [health, sizes] = await Promise.all([getOllamaHealth(), getModelSizes()]);
  res.json({
    // Tag names, as every existing caller expects.
    models: health.models,
    // Same list with sizes, for the worker-dial memory estimate.
    details: sizes,
    running: health.running,
    error: health.error,
    hint: health.hint,
  });
});

// ---------------------------------------------------------------------------
// Socket handlers
//
// NOTE: this is the ONLY place `send-message` and `send-pipeline` are bound.
// A second `send-pipeline` listener used to live in index.ts, which meant every
// pipeline run executed twice.
// ---------------------------------------------------------------------------

/** Query-string limit, kept tiny so the activity route stays readable. */
function req_limit(request: any): string | undefined {
  return request?.query?.limit;
}

/** A one-line rendering of tool arguments, for the activity list. */
/**
 * The one line the checklist shows before the model has planned anything.
 *
 * Just the request itself, trimmed to a title. It is a placeholder, so it is
 * deliberately not clever: the point is that the panel is never blank while work
 * is happening, not that this line is a good summary.
 */
function checklistSeed(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return "Working on the request";
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${String(rendered).slice(0, 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" ");
}

/**
 * Should this answer be resumed automatically, and with what prompt?
 *
 * Two triggers, deliberately narrow:
 *
 *   1. The model emitted the continuation marker — an explicit hand-off.
 *   2. The turn ran out of tool steps. The model never got to answer at all, so
 *      the honest thing is to give it a fresh budget rather than to show the
 *      "used all N steps" message and stop. This is the case behind "it starts
 *      working then times out until I prompt it to continue".
 *
 * Prose is never sniffed for intent: resuming a finished turn costs a full local
 * inference, and "next, I'll…" is far too common in complete answers.
 */
function decideContinuation(
  result: { content: string; stepsExhausted?: boolean },
  settings: SessionSettings,
  originalRequest: string
): { prompt: string; summary: string } | null {
  if (!settings.autoContinue) return null;

  // Carry the user's own words into every round.
  //
  // `anchorRequest` in provider.ts restates "the user's request for THIS turn"
  // as the last thing the model reads — and on a continuation round that request
  // IS this prompt. So whatever is written here is what the model treats as the
  // task. Without the original text, round 2 was anchored to "carry on from
  // where you stopped" and nothing else, and once the opening message had been
  // trimmed out of the window there was no longer anything in the prompt that
  // said what the work was. Observed: by round 3 the model was asking the user
  // what they had originally wanted, about a file it had wandered into.
  const task = originalRequest.trim().slice(0, 600);
  const restated = task
    ? `\n\nThe user's original request, which has not changed and is still the task:\n"""\n${task}\n"""\n`
    : "";

  const stated = parseContinuation(result.content);
  if (stated) {
    return {
      summary: stated,
      prompt:
        `Continue. Your previous turn ended with ${CONTINUE_MARKER} ${stated}` +
        restated +
        `\nDo that step now with tools. Do not re-plan, do not re-read what you have already ` +
        `read, and do not summarise what you did last turn. When this step is done, either ` +
        `finish or emit the marker again with the next one.`,
    };
  }

  if (result.stepsExhausted) {
    return {
      summary: "ran out of tool steps mid-task",
      prompt:
        `You ran out of tool steps before answering, so this is a fresh budget on the same ` +
        `task. Carry on from exactly where you stopped.` +
        restated +
        `\n` +
        // This used to promise "the transcript above still has everything you
        // gathered". It does not: a turn long enough to exhaust its step budget
        // is long enough for trimHistoryForSend to have cut most of it, so the
        // promise sent the model looking for a task that was no longer in the
        // window — and, finding none, off exploring unrelated directories.
        `The transcript above MAY HAVE BEEN TRIMMED to fit the context window, so treat it as ` +
        `incomplete. Before you touch anything: confirm from the messages you can actually see ` +
        `what the task is and which files or paths it involves. If you cannot tell — if the ` +
        `request is not in front of you, or you cannot tell which of several things you were ` +
        `working on — call ask_user and ask. Do NOT infer the task from directory listings, do ` +
        `not pick a plausible-looking project, and do not start anything the user did not ask ` +
        `for.\n\n` +
        `Once you know the task: pick the single most useful next action, do it, and if the ` +
        `work still is not done end with ${CONTINUE_MARKER} <next step>. If you were looping ` +
        `on a call that keeps failing, change approach instead of repeating it.`,
    };
  }

  return null;
}

function toClientError(err: any): { message: string; hint?: string } {
  if (err instanceof AssistantError) {
    return { message: err.message, hint: err.hint };
  }
  return {
    message: err?.message ? String(err.message) : "Something went wrong.",
    hint: "Check the terminal running `cullus` for details.",
  };
}

// Fan debug traces out to every connected browser when /debug is on.
sessionEvents.on("debug", (payload) => io.emit("debug-trace", payload));

// The checklist has two producers (the model and the /fix loop); the browser
// only ever renders what this emits, so both stay in sync for free.
taskEvents.on("changed", (tasks) => io.emit("tasks-updated", tasks));

// One stream for everything the app does; the browser renders only this.
activityEvents.on("entry", (entry) => io.emit("activity", entry));

/** Cancels the in-flight /fix run, when there is one. */
let activeFixController: AbortController | null = null;

/**
 * One in-flight chat/pipeline/fan-out run.
 *
 * Keyed by a stable id of its own rather than by the socket that started it.
 * That indirection is the point: a disconnect deliberately does NOT cancel a
 * turn (see the `disconnect` handler), so a browser refresh mid-run leaves the
 * work running under a socket id that no longer exists. While the registry was
 * keyed by socket id, everything addressed to the run went to the dead key — the
 * refreshed tab's Stop button did nothing, and a message typed into it was
 * queued somewhere nothing would ever drain. The turn owns its queue; the socket
 * is just the screen currently attached to it, and can be replaced.
 */
interface RunningTurn {
  id: string;
  controller: AbortController;
  /** The socket currently attached. Reassigned on adoption after a reconnect. */
  socketId: string;
  /** What kind of run, for the log line when a socket adopts it. */
  kind: string;
  /** Messages typed while this run was already going; drained per step. */
  queue: string[];
}

const activeTurns = new Map<string, RunningTurn>();
let turnCounter = 0;

function startTurn(socketId: string, kind: string): RunningTurn {
  const turn: RunningTurn = {
    id: `turn_${++turnCounter}`,
    controller: new AbortController(),
    socketId,
    kind,
    queue: [],
  };
  activeTurns.set(turn.id, turn);
  return turn;
}

function endTurn(turn: RunningTurn): void {
  activeTurns.delete(turn.id);
}

/**
 * The run this socket should be talking to, adopting an orphan if need be.
 *
 * Exact ownership first. Failing that, a socket with no run of its own adopts
 * the single running one — which is precisely the post-refresh case, and is why
 * adoption is restricted to `size === 1`: with two runs in flight there is no
 * non-guess about which one a new tab meant, and guessing is the thing being
 * fixed everywhere else in this file.
 */
function turnForSocket(socketId: string): RunningTurn | null {
  for (const turn of activeTurns.values()) {
    if (turn.socketId === socketId) return turn;
  }

  if (activeTurns.size !== 1) return null;

  const orphan = Array.from(activeTurns.values())[0];
  // Only adopt from a socket that is genuinely gone. A second live tab must not
  // steal the first one's run out from under it.
  if (io.sockets.sockets.get(orphan.socketId)) return null;

  console.log(`Socket ${socketId} adopted orphaned ${orphan.kind} run ${orphan.id}.`);
  orphan.socketId = socketId;
  return orphan;
}

/** Hand the run everything queued for it, and clear the queue. */
function drainInjections(turn: RunningTurn): string[] {
  if (turn.queue.length === 0) return [];
  return turn.queue.splice(0, turn.queue.length);
}

/**
 * Emit to whichever socket is attached to this run right now.
 *
 * Resolved at call time, not captured: after an adoption the run's output has to
 * follow the new tab, or a refresh leaves the user watching a turn that is still
 * working and saying nothing. Falls back to a broadcast when no socket is
 * attached, which matches what activity and the checklist already do.
 */
function emitToTurn(turn: RunningTurn, event: string, payload?: any): void {
  const attached = io.sockets.sockets.get(turn.socketId);
  if (attached) attached.emit(event, payload);
  else io.emit(event, payload);
}

/**
 * Which socket currently owns the process-global approval and inquiry handlers.
 *
 * Both handlers are singletons, registered per connection. On a reconnect the
 * order is: the new socket connects and registers, THEN the old socket's
 * disconnect fires — so an unconditional `setApprovalHandler(null)` there tore
 * down the live socket's handler. The result was silent and bad: ask_user came
 * back "nothing is listening for questions in this run", and every vault write
 * auto-approved because approval.ts treats an absent surface as consent. Only
 * the owner may clear.
 */
let approvalOwner: string | null = null;
let inquiryOwner: string | null = null;

export function cancelTurn(socketId: string): boolean {
  const turn = turnForSocket(socketId);
  if (!turn) return false;
  turn.controller.abort();
  endTurn(turn);
  return true;
}

/** Abort everything in flight. Used by session reset, which must not race a run. */
function cancelAllTurns(): void {
  for (const turn of Array.from(activeTurns.values())) {
    turn.controller.abort();
    endTurn(turn);
  }
}

io.on("connection", (socket: Socket) => {
  console.log("Client connected via browser.");

  everConnected = true;
  cancelPendingExit();

  socket.emit("session-usage", getSessionUsage());

  // Warn about a stale process before anything else.
  //
  // Unprompted rather than waiting for /doctor, because the symptom of build
  // drift is "my fix did not work" — which nobody responds to by running a
  // health check. They respond by editing the fix that was already correct.
  {
    const drift = buildDrift();
    if (drift.stale && drift.builtAt) {
      const when = (d: Date) => d.toTimeString().slice(0, 8);
      socket.emit("assistant-error", {
        message:
          `This process is running an OLD build. It started at ${when(drift.startedAt)}, but ` +
          `${drift.newest} was built at ${when(drift.builtAt)} — so recent code changes are ` +
          `not loaded.`,
        hint: "Quit this process and run `assistant` again. Rebuilding alone will not help.",
      });
    }
  }

  // Tell a fresh tab that work is already in flight.
  //
  // `turn-started` is emitted once, when the run begins, so a tab opened or
  // refreshed after that point had no idea anything was happening: no Stop
  // button, and the composer still said "Send" rather than "Add" — which made
  // the queue unreachable through the UI even once the server could route to it.
  // Replaying the state on connect is what closes that.
  if (activeTurns.size > 0) {
    const [inFlight] = Array.from(activeTurns.values());
    socket.emit("turn-started", { kind: inFlight.kind, resumed: true });
    socket.emit("status", "Working...");
  }

  socket.on("send-message", async ({ prompt, model, skill }) => {
    // A second send while a turn runs is not an error — it is the user steering.
    //
    // Still one loop at a time: starting a second would interleave two tool
    // loops over one chat history. So the message is queued and the RUNNING turn
    // picks it up at its next step boundary, which is what makes "tell it
    // something while it works" possible at all.
    //
    // `turnForSocket`, not a socket-id lookup: after a refresh this socket is
    // new and the run it should be steering is attached to a socket that no
    // longer exists. Adoption is what lets the message reach it.
    const existing = turnForSocket(socket.id);

    if (existing) {
      const text = String(prompt ?? "").trim();
      if (!text) return;

      existing.queue.push(text);

      // Acknowledge immediately. The model's own acknowledgement comes a step
      // later, and without this the composer looks like it swallowed the message.
      socket.emit("message-queued", {
        prompt: text,
        position: existing.queue.length,
        note:
          existing.queue.length > 1
            ? `Queued (${existing.queue.length} waiting). It will be picked up at the next step.`
            : "Got it — this goes to the run at its next step.",
      });

      logActivity({
        kind: "turn",
        status: "running",
        label: "message queued for the running turn",
        summary: text.slice(0, 140),
      });

      return;
    }

    const turn = startTurn(socket.id, "chat");
    const controller = turn.controller;
    /** Emits to whichever tab is attached now, so output survives a refresh. */
    const emit = (event: string, payload?: any) => emitToTurn(turn, event, payload);

    /** The placeholder line, so the finally block can close it out. */
    let seededTask = "";

    try {
      emit("status", "Working...");
      emit("turn-started", { kind: "chat" });
      logActivity({
        kind: "turn",
        status: "running",
        label: `chat turn on ${model}`,
        summary: String(prompt ?? "").slice(0, 140),
      });

      // The checklist describes the work in progress, so a new turn drops the
      // last /fix run's phases — but it must never go blank while a turn runs.
      //
      // Clearing and then waiting for plan_tasks meant the panel read "Nothing in
      // progress" through every turn the model didn't plan, which is most of them
      // on a small model, and through the whole of any turn where plan_tasks was
      // dropped. Seed it with the request itself so there is always a visible
      // line; the model's own plan replaces this wholesale the moment it calls
      // plan_tasks, and a one-line plan is still a plan worth showing.
      clearTasks();
      seededTask = checklistSeed(String(prompt ?? ""));
      setTasks([{ subject: seededTask, activeForm: seededTask }], "chat");
      startTask(seededTask);

      // Auto-continue.
      //
      // A long job — "work through this task file" — reliably outlives one turn:
      // the model hits the step budget, or hands off with the continuation marker.
      // Both used to end with the user typing "continue" to get the same work
      // resumed, which is the friction this removes. Each round is a full turn
      // against the same chat history, so the model keeps everything it learned.
      //
      // Bounded three ways, because a self-resuming loop on a local model is
      // exactly the thing you do not want running unattended: a round cap, the
      // Stop button (one shared AbortController), and the requirement that the
      // model itself asks to continue.
      const settings = getSettings();
      const maxRounds = settings.autoContinue
        ? Math.max(1, Math.min(settings.maxAutoContinues ?? 12, 40))
        : 1;

      /** The user's own words, kept verbatim for every continuation round. */
      const originalRequest = String(prompt ?? "");
      let message = originalRequest;
      let result: Awaited<ReturnType<typeof getAiResponse>> | null = null;

      /**
       * Every tool call made so far in this auto-continue run.
       *
       * The in-turn repeat guard keeps its own map, but that map is built fresh
       * inside each getAiResponse call — so it cannot see across a round
       * boundary, which is precisely where the expensive loop lives. A round
       * that re-reads the same nine files the previous round read looks, to that
       * guard, like nine perfectly reasonable first-time reads.
       *
       * Signature format matches the in-turn guard so the two agree on what
       * "the same call" means.
       */
      const seenCalls = new Set<string>();
      /** Calls this round that were not in `seenCalls` when the round began. */
      let novelThisRound = 0;
      let toolCallsThisRound = 0;
      /** Consecutive rounds that discovered nothing new. */
      let barrenRounds = 0;

      /**
       * Output-validation repair rounds spent so far.
       *
       * Capped separately from `maxRounds`, and low. A validator that keeps
       * rejecting is describing a check the model cannot satisfy — two attempts
       * is enough to fix a named line, and beyond that the honest thing is to
       * hand the user the answer plus the outstanding findings rather than burn
       * their evening proving a point. Counted across the whole run, not per
       * round, so it cannot interleave with auto-continue to get more tries.
       */
      const skillName = typeof skill === "string" ? skill : null;
      let repairRounds = 0;
      const MAX_REPAIR_ROUNDS = 2;
      let lastFindings: ReturnType<typeof validateSkillOutput> = [];
      /**
       * True while the round about to run is a repair round.
       *
       * The barren-round guard stops a run whose last two rounds made no NEW
       * tool calls, and a repair round makes none at all by design — the repair
       * prompt forbids tools, because everything needed is in the text the model
       * already wrote. Without this exemption two repairs in a row would trip
       * that guard and print "the last two repeated tool calls already made
       * earlier", which is both wrong and unhelpful.
       */
      let roundIsRepair = false;
      /** Whether the "your message is waiting" notice has already been shown. */
      let heldDuringRepair = false;

      for (let round = 1; round <= maxRounds; round++) {
        novelThisRound = 0;
        toolCallsThisRound = 0;
        // Consumed here, so the flag describes the round now running rather
        // than leaking into the next one.
        const thisRoundWasRepair = roundIsRepair;
        roundIsRepair = false;
        heldDuringRepair = false;

        result = await getAiResponse(
          message,
          model,
          controller.signal,
          (toolName, args, toolResult) => {
            let signature = "";
            try {
              signature = `${toolName}:${JSON.stringify(args)}`;
            } catch {
              // Unserialisable arguments cannot be compared, so treat the call
              // as novel rather than letting a stringify failure vote for "stop".
              signature = `${toolName}:${Date.now()}:${Math.random()}`;
            }
            toolCallsThisRound++;
            if (!seenCalls.has(signature)) {
              novelThisRound++;
              seenCalls.add(signature);
            }

            emit("tool-executed", { name: toolName, args, result: toolResult });
            logActivity({
              kind: "tool",
              status: (toolResult as any)?.error ? "warn" : "ok",
              label: toolName,
              summary: summariseArgs(args),
              detail: toolResult,
            });
          },
          {
            // Live one-liners while the turn runs. A local turn can spend minutes
            // inside a single step, and an idle screen is indistinguishable from a
            // hung one — which is what made the old timeouts so confusing.
            onProgress: (event) => emit("turn-progress", event),
            // Whatever the user typed since the last step. Bound to the TURN,
            // not the socket, so a message typed into a refreshed tab still
            // reaches the loop that is running.
            // Whatever the user typed since the last step — EXCEPT during a
            // repair round.
            //
            // A repair round's prompt says "Change nothing else. Do not call
            // any tool." Folding a new task into it guarantees a conflict, and
            // the conflict that actually happened is instructive: the skill's
            // closing line tells the user to paste the build prompt into a new
            // chat, they pasted it into this one while the repair was still in
            // flight, and from that message on the model held two incompatible
            // tasks — "build nothing, edit no files" from the skill and
            // "implement a robust disc-throwing system" from the paste. It
            // resolved the contradiction by doing the only thing both allowed,
            // reading files, for six rounds and 780,000 tokens.
            //
            // Not dropped, just held: the queue is left intact, so the stranded
            // -message branch below spends the round after the repair on it.
            drainUserMessages: () => {
              if (!thisRoundWasRepair) return drainInjections(turn);

              if (turn.queue.length > 0 && !heldDuringRepair) {
                heldDuringRepair = true;
                emit("status", "Finishing the repair first, then your message...");
                logActivity({
                  kind: "turn",
                  status: "running",
                  label: "holding a typed message until the repair round finishes",
                  summary: turn.queue.join(" / ").slice(0, 140),
                });
              }

              return [];
            },
          }
        );

        let next = decideContinuation(result, settings, originalRequest);

        // Output validation.
        //
        // Runs only when the turn would OTHERWISE END: a model mid-task has not
        // written its final answer yet, and validating a partial one would
        // reject it for missing sections it was about to write.
        //
        // This replaces a self-audit section in the skill prompt, which failed
        // for the obvious reason — it asked the model that made the mistake to
        // notice the mistake, in the same context. The repair prompt is a
        // different task: the failing line is named and the fault explained, so
        // the model is fixing something, not hunting for it.
        let unresolvedFindings: typeof lastFindings = [];

        if (!next && hasValidator(skillName) && !controller.signal.aborted) {
          lastFindings = validateSkillOutput(skillName, result.content);

          if (lastFindings.length > 0 && repairRounds < MAX_REPAIR_ROUNDS) {
            repairRounds++;
            roundIsRepair = true;
            next = {
              summary: `fixing ${lastFindings.length} failed output check(s)`,
              prompt: repairPrompt(lastFindings),
            };
            logActivity({
              kind: "turn",
              status: "warn",
              label: `/${skillName} output failed ${lastFindings.length} check(s)`,
              summary: lastFindings.map((f) => f.check).join(", "),
              detail: lastFindings,
            });
          } else if (lastFindings.length > 0) {
            // Out of repair attempts. The answer still goes to the user — it is
            // the best the model produced — but silently dropping the findings
            // would leave them trusting output the harness knows is wrong.
            unresolvedFindings = lastFindings;
            logActivity({
              kind: "turn",
              status: "warn",
              label: `/${skillName} output still failing after ${MAX_REPAIR_ROUNDS} repair attempt(s)`,
              summary: lastFindings.map((f) => f.check).join(", "),
              detail: lastFindings,
            });
          }
        }

        // Show the round's answer before resuming: on a job of ten rounds the
        // user wants to watch it work, and be able to Stop when it goes wrong.
        emit("ai-response", {
          content: next ? stripContinuation(result.content) : result.content,
          usage: result.usage,
          degraded: result.degraded,
          session: getSessionUsage(),
          continuing: next ? { round, of: maxRounds, next: next.summary } : undefined,
        });
        emit("session-usage", getSessionUsage());

        // Say what is still wrong, after the answer rather than instead of it.
        if (unresolvedFindings.length > 0) {
          emit("ai-response", {
            content:
              `⚠️ The answer above still fails ${unresolvedFindings.length} automatic check` +
              `${unresolvedFindings.length > 1 ? "s" : ""} after ${MAX_REPAIR_ROUNDS} repair ` +
              `attempt${MAX_REPAIR_ROUNDS > 1 ? "s" : ""}. Use it with that in mind:\n\n` +
              unresolvedFindings.map((f) => `- ${f.detail}`).join("\n") +
              `\n\nA check the model cannot satisfy in two tries usually means a bigger model ` +
              `for this step, not another attempt.`,
            usage: result.usage,
            degraded: [],
            session: getSessionUsage(),
          });
        }

        // A message that landed after the last step of the round would otherwise
        // be stranded: the loop is about to exit and nothing will ever drain it.
        // Spend a round on it instead — the user typed it expecting it to be
        // acted on, and it is already in the queue.
        if (!next && !controller.signal.aborted && round < maxRounds) {
          const stranded = drainInjections(turn);
          if (stranded.length > 0) {
            emit("status", "Picking up your message...");
            logActivity({
              kind: "turn",
              status: "running",
              label: "resuming for a message that arrived late",
              summary: stranded.join(" / ").slice(0, 140),
            });
            message = stranded.join("\n\n");
            continue;
          }
        }

        if (!next) break;

        // Stop a run that is going round without getting anywhere.
        //
        // A round that made several tool calls and not one of them new has, by
        // definition, learned nothing this round: it re-read files it had
        // already read and re-ran commands it had already run. Observed on a
        // twelve-round run where rounds 5 through 8 re-read the same nine files
        // each time, produced no edit, and ended each round asking to continue.
        // The round cap eventually caught it, four rounds and several hundred
        // thousand tokens later.
        //
        // The rule and its threshold live in session.ts, next to the rest of the
        // auto-continue protocol and where they can be tested without a socket.
        // A repair round is exempt: it is text-only by design, so "made no new
        // tool calls" is the expected outcome, not evidence of a stuck loop.
        barrenRounds = thisRoundWasRepair
          ? barrenRounds
          : isBarrenRound(toolCallsThisRound, novelThisRound)
            ? barrenRounds + 1
            : 0;

        if (barrenRounds >= BARREN_ROUNDS_BEFORE_STOP) {
          logActivity({
            kind: "turn",
            status: "warn",
            label: "auto-continue stopped: no progress",
            summary: `Rounds ${round - 1} and ${round} repeated earlier tool calls without making any new ones.`,
          });
          emit("ai-response", {
            content:
              `Stopped after ${round} rounds: the last two repeated tool calls already made ` +
              `earlier in this run without making a single new one, so the loop was not ` +
              `getting closer to an answer.\n\nOutstanding work, as last stated: ${next.summary}` +
              `\n\nIt is worth checking that step is actually achievable before resuming — a ` +
              `round that only re-reads is usually a sign of something missing or blocked. ` +
              `Send "continue" to carry on anyway.`,
            usage: result.usage,
            degraded: result.degraded,
            session: getSessionUsage(),
          });
          emit("session-usage", getSessionUsage());
          break;
        }

        if (round === maxRounds) {
          emit("ai-response", {
            content:
              `Paused after ${maxRounds} automatic continuations, with work still outstanding: ` +
              `${next.summary}\n\nSend "continue" to carry on, or raise the cap in ` +
              `Settings → Auto-continue.`,
            usage: result.usage,
            degraded: [],
            session: getSessionUsage(),
          });
          break;
        }

        if (controller.signal.aborted) break;

        emit("status", `Continuing (${round + 1}/${maxRounds})...`);
        logActivity({
          kind: "turn",
          status: "running",
          label: `auto-continue ${round + 1}/${maxRounds}`,
          summary: next.summary.slice(0, 140),
        });
        message = next.prompt;
      }

      emit("status", "Ready");
    } catch (err: any) {
      const cancelled = controller.signal.aborted;
      emit("assistant-error", toClientError(err));
      emit("status", cancelled ? "Stopped" : "Error");
    } finally {
      // By turn id, not socket id: after an adoption the socket this closure
      // captured is not the one the run is attached to, and deleting by it would
      // leave the finished turn in the registry forever — blocking every later
      // send as "already working" and deferring shutdown indefinitely.
      endTurn(turn);

      // Anything still queued belongs to a turn that is over. Leaking it into
      // the next, unrelated turn would be worse than dropping it — so do
      // neither silently: hand it back and ask for a resend.
      const unread = drainInjections(turn);
      if (unread.length > 0) {
        emit("ai-response", {
          content:
            `${unread.length} message(s) arrived after the run had already finished, so they ` +
            `were not acted on:\n\n` +
            unread.map((text) => `> ${text}`).join("\n\n") +
            `\n\nSend again to pick them up.`,
          degraded: [],
          session: getSessionUsage(),
        });
      }

      // Close out the placeholder, but only while it is still the whole list —
      // if the model called plan_tasks the list is its plan now, and the statuses
      // on it are the model's to set.
      const current = listTasks();
      if (
        seededTask &&
        current.length === 1 &&
        current[0].subject === seededTask &&
        current[0].status === "active"
      ) {
        setTaskStatus(seededTask, controller.signal.aborted ? "failed" : "done");
      }

      emit("turn-finished", {});
    }
  });

  // This socket becomes the approval surface for manual mode. Requests are
  // resolved by the matching `tool-approval-response`, or by approval.ts's
  // timeout if the tab goes away mid-prompt.
  const pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();

  approvalOwner = socket.id;
  setApprovalHandler(
    (request) =>
      new Promise<ApprovalOutcome>((resolve) => {
        pendingApprovals.set(request.id, resolve);
        socket.emit("tool-approval-request", {
          id: request.id,
          name: request.toolName,
          args: request.args,
        });
      })
  );

  socket.on("tool-approval-response", ({ id, approved }) => {
    const resolve = pendingApprovals.get(id);
    if (!resolve) return;
    pendingApprovals.delete(id);
    resolve({ approved: Boolean(approved), reason: approved ? undefined : "denied in the dashboard" });
  });

  // ...and the surface for ask_user. Same shape as approvals, different question:
  // this one is the model asking for a decision rather than for permission.
  const pendingInquiries = new Map<string, (outcome: InquiryOutcome) => void>();

  inquiryOwner = socket.id;
  setInquiryHandler(
    (request) =>
      new Promise<InquiryOutcome>((resolve) => {
        pendingInquiries.set(request.id, resolve);
        socket.emit("user-choice-request", request);
      })
  );

  socket.on("user-choice-response", ({ id, chosen, text }) => {
    const resolve = pendingInquiries.get(id);
    if (!resolve) return;
    pendingInquiries.delete(id);

    const labels = Array.isArray(chosen) ? chosen.map((c: unknown) => String(c)) : [];
    const typed = typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;

    // A dismissed prompt is "unanswered", not an empty choice: the model is told
    // to assume a default and carry on rather than to treat silence as a veto.
    resolve(
      labels.length === 0 && !typed
        ? { chosen: [], unanswered: true, reason: "dismissed in the dashboard" }
        : { chosen: labels, text: typed }
    );
  });

  // Stop, from the composer. Also covers pipeline and fan-out runs on this socket.
  socket.on("cancel-turn", () => {
    const stopped = cancelTurn(socket.id);
    logActivity({
      kind: "turn",
      status: stopped ? "warn" : "ok",
      label: stopped ? "turn stopped by the user" : "nothing running to stop",
    });
    socket.emit("status", stopped ? "Stopping..." : "Ready");
    if (!stopped) socket.emit("turn-finished", {});
  });

  socket.on("send-pipeline", async ({ prompt, models, mode, workers }) => {
    // Pipeline and fan-out runs are not steerable mid-flight — their workers do
    // not share one tool loop with a step boundary to fold a message into — so a
    // second send is still refused here. `turnForSocket` rather than a socket-id
    // lookup so the refusal is at least accurate after a refresh, instead of
    // starting a second run alongside the first.
    if (turnForSocket(socket.id)) {
      socket.emit("assistant-error", {
        message: "This chat is already working on something.",
        hint: "Press Stop to cancel it first.",
      });
      return;
    }

    const turn = startTurn(socket.id, mode === "fanout" ? "fanout" : "pipeline");
    const controller = turn.controller;

    try {
      socket.emit("turn-started", { kind: mode === "fanout" ? "fanout" : "pipeline" });
      clearTasks();
      // Two shapes behind one button: "fanout" splits the goal across N workers on
      // one model, "roles" is the original triage → engineer → manager sequence.
      if (mode === "fanout") {
        const requested = Math.min(Math.max(Number(workers) || 1, 1), MAX_WORKERS);
        const active = loadConfig().defaultModel ?? "";
        const workerModel = models?.workerModel || models?.engineerModel || active;
        const plannerModel = models?.plannerModel || models?.triageModel || workerModel;

        socket.emit("status", `Running ${requested} parallel worker(s)...`);
        saveConfig({
          fanout: { enabled: true, workers: requested, plannerModel: plannerModel || null },
        });

        const fanned = await runFanOut({
          goal: prompt,
          plannerModel,
          workerModel,
          workers: requested,
          signal: controller.signal,
          // socket.emit, not io.emit. Broadcasting fan-out progress sent every
          // run's phase lines to every connected tab, so two runs — or one run
          // and one stale tab — interleaved in a single Activity feed. That is
          // how a run reported "splitting the goal for 4 worker(s)" and then
          // "across 3 worker(s)", which is impossible within one run: both lines
          // print the same variable. Tool results next to this already use
          // socket.emit; this was the odd one out.
          onEvent: (event: FanOutEvent) => socket.emit("fanout-progress", event),
          onToolExecuted: (name, args, result, subtask) => {
            socket.emit("tool-executed", { name, args, result, subtask });
            logActivity({
              kind: "tool",
              status: (result as any)?.error ? "warn" : "ok",
              label: name,
              summary: `${subtask} · ${summariseArgs(args)}`,
              detail: result,
            });
          },
        });

        socket.emit("ai-response", {
          content: fanned.content,
          usage: fanned.usage,
          degraded: fanned.degraded,
          session: getSessionUsage(),
          subtasks: fanned.subtasks.map((s) => ({ title: s.title, ok: s.ok, ms: s.ms })),
          fanout: { workers: fanned.workers, mapMs: fanned.mapMs, sumMs: fanned.sumMs },
        });
        socket.emit("session-usage", getSessionUsage());
        socket.emit("status", "Ready");
        return;
      }

      socket.emit("status", "Running Multi-Agent Pipeline...");

      const result = await runAgentPipeline(prompt, models, (role, output) => {
        socket.emit("pipeline-step-complete", { role, output });
      });

      socket.emit("ai-response", {
        content: result.content,
        usage: result.usage,
        degraded: result.degraded,
        session: getSessionUsage(),
      });

      socket.emit("session-usage", getSessionUsage());
      socket.emit("status", "Ready");
    } catch (err: any) {
      const cancelled = controller.signal.aborted;
      socket.emit("assistant-error", toClientError(err));
      socket.emit("status", cancelled ? "Stopped" : "Error");
    } finally {
      // By turn id — see the same note on the chat handler's finally block.
      endTurn(turn);
      socket.emit("turn-finished", {});
    }
  });

  // Deep research: a code-orchestrated multi-stage pipeline. It runs for minutes
  // on local models, so every stage streams progress.
  socket.on("send-research", async ({ topic, model }) => {
    try {
      socket.emit("status", "Researching...");

      const engine = new DeepResearchEngine(model);
      engine.on("progress", (payload) => socket.emit("research-progress", payload));
      engine.on("usage", (payload) => socket.emit("research-usage", payload));

      const report = await engine.run(topic);
      engine.removeAllListeners();

      socket.emit("research-complete", report);
      socket.emit("status", "Ready");
    } catch (err: any) {
      socket.emit("assistant-error", toClientError(err));
      socket.emit("status", "Error");
    }
  });

  // ---- /fix ---------------------------------------------------------------
  //
  // The loop can run for minutes on local models, so every phase is streamed.
  // One run at a time process-wide: a second request is refused, not queued,
  // because two loops editing one tree would corrupt each other's backups.
  socket.on("send-fix", async ({ symptom, target, models, rounds }) => {
    if (isFixRunning()) {
      socket.emit("assistant-error", {
        message: "A /fix run is already in progress.",
        hint: "Wait for it to finish, or press Cancel in the Self-repair panel.",
      });
      return;
    }

    const resolved = resolveTarget(target || null);
    if (!resolved.ok) {
      socket.emit("assistant-error", { message: resolved.error, hint: resolved.actionRequired });
      return;
    }

    const controller = new AbortController();
    activeFixController = controller;

    try {
      socket.emit("status", "Repairing...");

      const report = await runFix({
        symptom: String(symptom ?? "").trim(),
        target: resolved.target,
        models: {
          locate: models?.locate || loadConfig().defaultModel || "",
          plan: models?.plan || models?.locate || loadConfig().defaultModel || "",
        },
        rounds: Number(rounds) || 3,
        signal: controller.signal,
        onEvent: (event: FixEvent) => io.emit("fix-progress", event),
      });

      io.emit("fix-complete", report);
      socket.emit("status", "Ready");
    } catch (err: any) {
      socket.emit("assistant-error", toClientError(err));
      socket.emit("status", "Error");
    } finally {
      activeFixController = null;
    }
  });

  socket.on("fix-cancel", () => {
    activeFixController?.abort();
  });

  socket.on("disconnect", () => {
    // A disconnect is not a stop.
    //
    // This used to call cancelTurn(socket.id), which made the run's lifetime the
    // socket's lifetime: a throttled tab, a refresh or a Wi-Fi blip destroyed
    // whatever step was in flight and ended the auto-continue loop with it. The
    // user has a Stop button; that is the way to stop a turn. A turn left running
    // is still bounded — stepTotalTimeoutMs caps the step, the step budget caps
    // the turn, and considerExit's `activeTurns.size > 0` guard (which was dead
    // code while this line emptied the map first) now correctly defers shutdown
    // until the work finishes.
    //
    // Pending questions still have to be released: nobody is on the other end of
    // this socket to answer them, and the loop would otherwise block on a surface
    // that no longer exists.
    for (const resolve of pendingApprovals.values()) {
      resolve({ approved: false, reason: "the dashboard disconnected" });
    }
    pendingApprovals.clear();
    if (approvalOwner === socket.id) {
      setApprovalHandler(null);
      approvalOwner = null;
    }

    for (const resolve of pendingInquiries.values()) {
      resolve({ chosen: [], unanswered: true, reason: "the dashboard disconnected" });
    }
    pendingInquiries.clear();
    if (inquiryOwner === socket.id) {
      setInquiryHandler(null);
      inquiryOwner = null;
    }

    console.log("Client disconnected.");
    considerExit();
  });
});

export { app };

export function startWebServer(port = 3000): Promise<number> {
  // Bring the previous conversation back into the inference loop BEFORE the
  // port opens. `getActiveSession()` already resumes it by id on the write
  // side, so without this the first turn after a restart saved a two-message
  // history over the stored one and the usage bar sat at zero.
  //
  // Never fatal: a corrupt session file should cost you the old transcript,
  // not the ability to start.
  try {
    const restored = restoreActiveSession();
    if (restored.messages > 0) {
      console.log(`Resumed previous session: ${restored.messages} message(s), ${restored.turns} turn(s).`);
    }
  } catch (err) {
    console.warn(`Could not resume the previous session, starting fresh: ${(err as Error).message}`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use.\n` +
            `Either stop what's using it (\`lsof -ti:${port} | xargs kill\`) ` +
            `or start on another port: \`assistant --port ${port + 1}\`.`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`\n🚀 Cullus Ai assistant Web UI active at: http://localhost:${port}\n`);

      // Start capturing console output to ~/.cullus/logs/assistant.log.
      // Wired here rather than at import so a CLI invocation that never serves
      // does not create a log file it will not use.
      void import("./logger.js")
        .then(({ attachConsole }) => attachConsole())
        .catch(() => {
          /* logging is a nicety; never block startup on it */
        });

      // Signals are wired here rather than at import time so a process that
      // never starts a server (the CLI, a test) does not install them.
      void import("./lifecycle.js")
        .then(({ installShutdownHandlers }) => installShutdownHandlers(server))
        .catch(() => {
          /* shutdown handling is a nicety; never block startup on it */
        });

      // Scheduled jobs start with the server, not with the process, so a job
      // can only fire once there is something to report to. Failing to arm the
      // scheduler must never stop the dashboard coming up — a broken jobs.json
      // should cost you your cron, not your assistant.
      void (async () => {
        try {
          const { registerCronRunner } = await import("./cronRunner.js");
          const { start } = await import("./cron.js");
          registerCronRunner();
          const armed = start();
          if (armed > 0) console.log(`   ${armed} scheduled job(s) armed. /cron list to see them.\n`);
        } catch (err: any) {
          console.warn(`   Scheduled jobs did not start: ${err?.message ?? err}`);
        }
      })();

      resolve(port);
    });
  });
}
