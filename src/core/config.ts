// Persistent user configuration for Cullus.
//
// Lives at ~/.cullus/config.json so `cullus` behaves identically from any
// working directory. Environment variables win over the file, the file wins over
// the built-in defaults. There is deliberately NO default vault path — vault
// tools stay disabled with an actionable message until one is configured.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { migrateLegacyConfigDir, CURRENT_DIR } from "./migrate.js";

export interface AssistantConfig {
  /** Absolute path to an Obsidian vault. null = not configured, vault tools disabled. */
  vaultPath: string | null;
  // NOTE: no token fields here, deliberately. Secrets live in core/secrets.ts
  // (Keychain, or a 0600 file) and must never be persisted to this JSON.
  // An earlier version copied OBSIDIAN_API_KEY in from the environment, which
  // meant any saveConfig() wrote the token to disk in plaintext.
  /** Preferred Ollama tag. null = resolve to the first locally available model. */
  defaultModel: string | null;
  /** Directories the filesystem MCP server is allowed to touch. */
  allowedPaths: string[];
  /**
   * Which Unity command tags are exposed to the model.
   *
   * A connected Editor offers 149 commands, whose schemas cost ~25,000 tokens
   * on EVERY turn — more than ten times every other server combined, and enough
   * to crowd out the conversation in a small context window. The commands carry
   * 18 top-level tags, so this narrows them to the ones an authoring session
   * actually uses.
   *
   * Empty array means no filter: all 149, and the token cost that comes with it.
   */
  unityToolTags: string[];
  /** Web UI port. */
  port: number;
  /**
   * Per-server read-only preference, keyed by MCP server name. Absent means
   * "use that server's default" (see MCP_SERVER_DEFINITIONS).
   */
  mcpReadOnly: Record<string, boolean>;
  /**
   * Tool sources the model should not see, keyed by MCP server name (or
   * "local"). `true` means withheld.
   *
   * This exists because tool schemas are sent on EVERY request, not once per
   * session. A server contributing 34 tools costs ~8k tokens of context on
   * every single message whether or not you use it — on a local model that is
   * the difference between room to think and none. Turning a source off is the
   * only lever that reclaims it.
   *
   * Withheld, not refused: a tool the model cannot see is one it cannot try to
   * work around. Same principle as the read-only handling above.
   */
  mcpToolsDisabled: Record<string, boolean>;
  /**
   * Per-project build/verify commands for `/fix`, keyed by absolute project root.
   * Absent means "detect from what's on disk" (see projectTarget.detectCommands).
   */
  fixCommands: Record<string, { build?: string; verify?: string }>;
  /** Chat session shown on load. null = start a new one. */
  activeSessionId: string | null;
  /**
   * Non-secret connection settings, keyed by connector id — e.g. the Obsidian
   * HTTPS base URL, a GitHub host or email. Tokens NEVER live here; they go
   * through core/secrets.ts.
   */
  connections: Record<string, Record<string, string>>;
  /**
   * Parallel worker fan-out. `workers` is the concurrency dial; they all share
   * one model, so memory is flat in this number. `plannerModel` is the only place
   * a second model is worth loading — null means "use the active model".
   */
  fanout: { enabled: boolean; workers: number; plannerModel: string | null };
  /**
   * MCP servers the user added from Settings, keyed by server name. Merged with
   * the built-ins by getServerDefinitions(), so a user server behaves exactly
   * like a shipped one — same read-only toggle, same connection state, same
   * tool routing. Tokens are NOT here: they live in the Keychain under
   * MCP_<NAME>_TOKEN.
   */
  customServers: Record<string, CustomServerConfig>;
  /**
   * Where the assistant's memory lives inside the vault, relative to the vault
   * root. null = that feature is off.
   *
   * Deliberately paths rather than one folder: people already have a place for
   * this stuff (`_assistant/`, `docs/`, a daily-notes folder) and forcing a new
   * convention on an existing vault is how you get a second, ignored copy.
   */
  /**
   * Whether the one-time clearing of the old implicit vault lock has run. See
   * migrateVaultLock().
   */
  vaultLockMigrated: boolean;
  vaultPaths: {
    /** Note or folder injected into the system prompt every turn. */
    context: string | null;
    /** Default destination for notes the assistant writes. */
    notes: string | null;
    /** Folder of skill notes, which override the built-ins by name. */
    skills: string | null;
    /** Folder of shell-recipe notes. */
    recipes: string | null;
    /** Work in progress: unfinished writing the assistant is asked to hold. */
    drafts: string | null;
    /** One note per day, summarising what happened. */
    briefs: string | null;
    /**
     * The user profile. Injected into every turn like context, so tone and
     * assumptions stay the same across sessions rather than being re-derived.
     */
    personal: string | null;
    /** One note per project, holding its open tasks. */
    tasks: string | null;
  };
  /**
   * Ceiling on the context window requested from Ollama, in tokens.
   *
   * Ollama defaults num_ctx to 4096 REGARDLESS of what the model supports, so a
   * long conversation was being silently truncated while the UI showed a 262k
   * window. We now ask for min(model's advertised window, this). Raise it for
   * long sessions; lower it if the KV cache is costing too much memory.
   */
  maxContextTokens: number;
  /**
   * Stop the server once the last browser window closes.
   *
   * The dashboard is the only interface, so a server with nobody attached is
   * usually just a forgotten process holding a port. Not unconditional: a reload
   * and a tab close look identical to a socket, so the exit waits out
   * `exitGraceSeconds` and is cancelled if anything reconnects or if work is
   * still running.
   */
  exitWhenLastClientDisconnects: boolean;
  /** How long to wait for a reconnect before exiting. Also covers reloads. */
  exitGraceSeconds: number;
  /**
   * What the model is made to read before it can answer.
   *
   * Every dial here trades completeness for latency, and on a local model that
   * trade is steep: prompt eval runs at roughly 250 tokens/second, so each 10k
   * tokens of prompt is ~40 seconds before the first token appears. Measured on
   * this setup, a turn arrived at 38,774 prompt tokens — of which 65k characters
   * were stale tool output replayed from earlier in the session — and took five
   * minutes to answer a one-line question.
   *
   * They live in config rather than environment variables so they can be tuned
   * from Settings while the app is running.
   */
  performance: {
    /** Max tools sent in one turn. Fewer tools = shorter prompt, better aim. */
    toolBudget: number;
    /**
     * How many past messages to replay. 0 = the whole transcript.
     *
     * The single biggest lever: history was replayed unbounded, and tool results
     * are 79% of it by volume.
     *
     * Raised from 40 to 120 after session mu4mi91s-cc6o, a Unity build that spent
     * 7.10M prompt tokens against 191K completion — 37:1. At 40 messages the
     * window held roughly six tool round-trips, so a turn re-read the same
     * script (54 `read_text_file` calls), re-grepped the same scene, and invented
     * `read_tool_result` IDs for results that had aged out of it. Trimming to
     * save prompt tokens was buying them back at a worse rate.
     */
    maxHistoryMessages: number;
    /** Truncate any one tool result to this many characters. 0 = no limit. */
    maxToolResultChars: number;
    /**
     * Force `num_ctx` instead of sizing it to the conversation. 0 = auto.
     *
     * The automatic sizing is right most of the time and is not always right:
     * a fixed window keeps the model loaded (changing num_ctx makes Ollama
     * reload) and lets you trade KV-cache RAM deliberately rather than having
     * it grow under you mid-turn.
     */
    numCtxOverride: number;
    /** How long Ollama keeps the model resident after a turn. 0 = its default. */
    keepAliveSeconds: number;
    /** Sampling temperature. 0 = leave unset (the model's own default). */
    temperature: number;
    /** Nucleus sampling. 0 = leave unset. */
    topP: number;
    /** Top-k sampling. 0 = leave unset. */
    topK: number;
    /** Penalty on repeated tokens — the dial for a model that loops. 0 = unset. */
    repeatPenalty: number;
    /**
     * When the prompt reaches this fraction of the window, summarise the middle
     * of the turn rather than dropping it. 0 = old behaviour, trim only.
     *
     * Trimming deletes; compaction keeps what was established. Costs one local
     * inference when it fires, which is cheaper than the rounds of rework that
     * losing a finding causes.
     */
    compactAtFraction: number;
    /** Silence allowed mid-answer before the model is called wedged. */
    stepIdleTimeoutMs: number;
    /** Silence allowed BEFORE the first token, i.e. the prompt-eval budget. */
    firstTokenTimeoutMs: number;
    /** Absolute ceiling on one inference step. 0 = no ceiling. */
    stepTotalTimeoutMs: number;
    /** Wall-clock cap on a single tool call. */
    toolTimeoutMs: number;
    /**
     * Extra attempts for a failed inference step, before the turn gives up.
     *
     * Small models fail in ways that are worth simply trying again — a timeout,
     * a dropped connection, a malformed response — and losing the whole turn to
     * one of those wastes every tool call already made. Each retry also degrades
     * the request (shorter history, then no tools) rather than repeating the
     * thing that just failed. 0 = fail on the first error.
     */
    stepRetries: number;
  };
}

export interface CustomServerConfig {
  transport: "stdio" | "http";
  /** Shown in the Connections table; defaults to the server name. */
  label?: string;
  /** Which column the Connections table files it under. */
  type?: "Database" | "Web" | "Local";
  /** stdio */
  command?: string;
  args?: string[];
  /**
   * Non-secret environment for a stdio server. Anything token-shaped is moved
   * out of here into `envSecrets` before this object is written to disk, so
   * config.json never holds a credential.
   */
  env?: Record<string, string>;
  /**
   * Environment variable name → secrets.ts key, for the token-shaped entries.
   * The value is resolved from the Keychain at connect time.
   */
  envSecrets?: Record<string, string>;
  /** http */
  url?: string;
  /** Secret key holding the bearer token, when the endpoint needs one. */
  tokenSecret?: string;
  /** Accept a self-signed certificate. Only ever honoured for loopback URLs. */
  allowSelfSigned?: boolean;
  readOnly?: boolean;
}

/**
 * Every vault-memory role, in the order Settings shows them. One list so a new
 * folder cannot be added to the config type and then silently skipped by the
 * loader's validation or the settings API.
 */
export const VAULT_PATH_KEYS = [
  "context",
  "personal",
  "notes",
  "drafts",
  "briefs",
  "tasks",
  "skills",
  "recipes",
] as const;

export type VaultPathKey = (typeof VAULT_PATH_KEYS)[number];

const DEFAULTS: AssistantConfig = {
  vaultPath: null,
  defaultModel: null,
  allowedPaths: [],
  // The five tags an authoring session uses: make a thing, script it, put it in
  // a scene, save it as a prefab, manage the asset. Leaves out baking, settings,
  // animation and the rest — 57 tools instead of 149, ~9.5k tokens instead of
  // ~25k. Add tags here when a job needs them.
  unityToolTags: ["gameobjects", "scripts", "scenes", "prefabs", "assets"],
  port: 3000,
  mcpReadOnly: {},
  mcpToolsDisabled: {},
  fixCommands: {},
  activeSessionId: null,
  connections: {},
  fanout: { enabled: false, workers: 3, plannerModel: null },
  customServers: {},
  vaultPaths: {
    context: null,
    notes: null,
    skills: null,
    recipes: null,
    drafts: null,
    briefs: null,
    personal: null,
    tasks: null,
  },
  vaultLockMigrated: false,
  maxContextTokens: 200_000,
  exitWhenLastClientDisconnects: true,
  exitGraceSeconds: 10,
  performance: {
    toolBudget: 28,
    maxHistoryMessages: 120,
    // Model parameters: 0 everywhere means "unchanged from today's behaviour".
    numCtxOverride: 0,
    keepAliveSeconds: 0,
    temperature: 0,
    topP: 0,
    topK: 0,
    repeatPenalty: 0,
    compactAtFraction: 0.7,
    maxToolResultChars: 8_000,
    stepIdleTimeoutMs: 120_000,
    firstTokenTimeoutMs: 600_000,
    stepTotalTimeoutMs: 900_000,
    toolTimeoutMs: 120_000,
    stepRetries: 2,
  },
};

/**
 * Bounds for each performance dial: [minimum, maximum, allowUnlimited].
 *
 * `allowUnlimited` means 0 is a legal value with its own meaning ("no limit"),
 * rather than a number below the minimum. Shared with the Settings UI so the
 * form and the validator cannot drift apart.
 */
export const PERFORMANCE_BOUNDS: Record<
  keyof AssistantConfig["performance"],
  {
    min: number;
    max: number;
    allowUnlimited: boolean;
    /**
     * Keep the fractional part.
     *
     * Every dial here was a count or a millisecond budget, so the validator
     * floored everything — which silently turned a temperature of 0.2 into 0
     * and a repeat penalty of 1.1 into 1, i.e. into "no penalty". Sampling
     * dials are inherently fractional and have to opt out of that.
     */
    fractional?: boolean;
  }
> = {
  toolBudget: { min: 1, max: 200, allowUnlimited: false },
  maxHistoryMessages: { min: 2, max: 1_000, allowUnlimited: true },
  maxToolResultChars: { min: 500, max: 200_000, allowUnlimited: true },
  stepIdleTimeoutMs: { min: 5_000, max: 3_600_000, allowUnlimited: false },
  firstTokenTimeoutMs: { min: 5_000, max: 3_600_000, allowUnlimited: false },
  stepTotalTimeoutMs: { min: 10_000, max: 7_200_000, allowUnlimited: true },
  toolTimeoutMs: { min: 5_000, max: 3_600_000, allowUnlimited: false },
  stepRetries: { min: 0, max: 10, allowUnlimited: false },

  // ---- Model parameters -------------------------------------------------
  //
  // These were hard-coded or derived, and both choices had already cost real
  // debugging. `num_ctx` in particular is computed by `chooseContextWindow`
  // from the conversation's size in buckets, which is the right default and
  // the wrong thing to be unable to override: it drives KV-cache allocation
  // (measured on qwen3.5:2b — 8k → 2.47 GB resident, 64k → 3.53 GB,
  // 200k → 5.23 GB), so on a 48 GB box the difference between a window that
  // fits beside a 22 GB model and one that does not is not something to
  // discover by watching it swap.
  //
  // 0 means "leave it to the harness/model default" for every one of these,
  // so an untouched install behaves exactly as before.
  numCtxOverride: { min: 0, max: 1_000_000, allowUnlimited: true },
  keepAliveSeconds: { min: 0, max: 86_400, allowUnlimited: true },
  temperature: { min: 0, max: 2, allowUnlimited: false, fractional: true },
  topP: { min: 0, max: 1, allowUnlimited: false, fractional: true },
  topK: { min: 0, max: 500, allowUnlimited: true },
  repeatPenalty: { min: 0, max: 2, allowUnlimited: false, fractional: true },
  /**
   * Fraction of the context window at which the middle of the turn is
   * summarised instead of trimmed away. 0 = never compact (trim only).
   */
  compactAtFraction: { min: 0.3, max: 0.95, allowUnlimited: true, fractional: true },
};

export const PERFORMANCE_KEYS = Object.keys(PERFORMANCE_BOUNDS) as Array<
  keyof AssistantConfig["performance"]
>;

// The migration must run before CONFIG_DIR is read by anything, so it happens
// at import. See migrate.ts: it copies ~/.assistant to ~/.cullus once, leaving
// the original in place.
const migration = migrateLegacyConfigDir();
if (migration.migrated) {
  console.log(
    `Renamed to Cullus: copied ${migration.entries} item(s) from ${migration.from} to ${migration.to}. ` +
      `The old directory was left in place and is safe to delete once you are happy.`
  );
} else if (migration.error) {
  console.warn(`Could not migrate ~/.assistant: ${migration.error}. Starting on defaults.`);
}

export const CONFIG_DIR = CURRENT_DIR;
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

let cached: AssistantConfig | null = null;

/**
 * Expand a leading `~` and resolve to an absolute path.
 *
 * Tolerates a non-string because config.json is a file humans edit: a numeric or
 * null `vaultPath` used to reach here and kill the whole boot with
 * "input.trim is not a function", naming no field and no file.
 */
export function expandPath(input: unknown): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return trimmed;
  const expanded = trimmed.startsWith("~")
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
  return path.resolve(expanded);
}

function ensureConfigDir() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch (err: any) {
    console.warn(`Could not create ${CONFIG_DIR}: ${err.message}`);
  }
}

function applyEnvOverrides(config: AssistantConfig): AssistantConfig {
  const merged = { ...config };

  if (process.env.OBSIDIAN_VAULT_PATH) {
    merged.vaultPath = expandPath(process.env.OBSIDIAN_VAULT_PATH);
  }
  // CULLUS_ wins; ASSISTANT_ still works so an existing shell profile or service
  // definition keeps functioning after the rename.
  const model = process.env.CULLUS_MODEL ?? process.env.ASSISTANT_MODEL;
  if (model) merged.defaultModel = model;

  const port = process.env.CULLUS_PORT ?? process.env.ASSISTANT_PORT;
  if (port) {
    const parsed = parseInt(port, 10);
    if (!Number.isNaN(parsed)) merged.port = parsed;
  }

  return merged;
}

/** A plain object, not an array and not null. */
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce whatever is on disk into a valid config, field by field.
 *
 * config.json is hand-editable and half-filled configs are normal: a fresh
 * machine, a copied file, a key someone started typing. Every wrong-typed field
 * is REPAIRED to its default and named in a warning, so the app always boots and
 * the UI can fill the gaps in — rather than a single bad value stopping startup
 * with an opaque message.
 */
function sanitiseConfig(raw: unknown): { config: AssistantConfig; repaired: string[] } {
  const fromDisk = isPlainObject(raw) ? raw : {};
  const repaired: string[] = [];
  const next: AssistantConfig = {
    ...DEFAULTS,
    mcpReadOnly: {},
    mcpToolsDisabled: {},
    fixCommands: {},
    connections: {},
    customServers: {},
    vaultPaths: { ...DEFAULTS.vaultPaths },
    performance: { ...DEFAULTS.performance },
  };

  const note = (key: string, why: string) => repaired.push(`${key} (${why})`);

  // --- strings and paths ---
  if ("vaultPath" in fromDisk && fromDisk.vaultPath !== null) {
    const expanded = expandPath(fromDisk.vaultPath);
    if (expanded) next.vaultPath = expanded;
    else note("vaultPath", "not a usable path");
  }

  if (typeof fromDisk.defaultModel === "string" && fromDisk.defaultModel.trim()) {
    next.defaultModel = fromDisk.defaultModel.trim();
  } else if (fromDisk.defaultModel != null) {
    note("defaultModel", "not a string");
  }

  if (typeof fromDisk.activeSessionId === "string") next.activeSessionId = fromDisk.activeSessionId;

  // --- allowed paths ---
  if (Array.isArray(fromDisk.allowedPaths)) {
    next.allowedPaths = fromDisk.allowedPaths.map(expandPath).filter(Boolean);
    if (next.allowedPaths.length !== fromDisk.allowedPaths.length) {
      note("allowedPaths", "dropped entries that were not paths");
    }
  } else if (fromDisk.allowedPaths != null) {
    note("allowedPaths", "not an array");
  }

  // --- Unity tool tags ---
  // Every field has to be merged explicitly here; loadConfig does not spread the
  // file over the defaults. Adding this to the interface and to DEFAULTS was not
  // enough — the on-disk value was parsed, ignored, and the default silently won,
  // so editing config.json appeared to do nothing at all.
  //
  // An EMPTY array is meaningful ("no filter, send all 149 tools"), so it must
  // survive the merge rather than being treated as unset.
  if (Array.isArray(fromDisk.unityToolTags)) {
    const tags = fromDisk.unityToolTags.filter((t: unknown) => typeof t === "string" && t.trim());
    if (tags.length !== fromDisk.unityToolTags.length) {
      note("unityToolTags", "dropped entries that were not non-empty strings");
    }
    next.unityToolTags = tags.map((t: string) => t.trim());
  } else if (fromDisk.unityToolTags != null) {
    note("unityToolTags", "not an array");
  }

  // --- numbers ---
  const port = Number(fromDisk.port);
  if (Number.isFinite(port) && port > 0 && port < 65_536) next.port = Math.floor(port);
  else if (fromDisk.port != null) note("port", "not a valid port number");

  const context = Number(fromDisk.maxContextTokens);
  if (Number.isFinite(context) && context >= 2048) next.maxContextTokens = Math.floor(context);
  else if (fromDisk.maxContextTokens != null) note("maxContextTokens", "not a number >= 2048");

  if (typeof fromDisk.exitWhenLastClientDisconnects === "boolean") {
    next.exitWhenLastClientDisconnects = fromDisk.exitWhenLastClientDisconnects;
  } else if (fromDisk.exitWhenLastClientDisconnects != null) {
    note("exitWhenLastClientDisconnects", "not true/false");
  }

  const grace = Number(fromDisk.exitGraceSeconds);
  if (Number.isFinite(grace) && grace >= 1 && grace <= 3600) {
    next.exitGraceSeconds = Math.floor(grace);
  } else if (fromDisk.exitGraceSeconds != null) {
    note("exitGraceSeconds", "not a number between 1 and 3600");
  }

  // --- performance dials ---
  // Each is repaired independently: one bad value should cost you that dial, not
  // the whole block.
  if (isPlainObject(fromDisk.performance)) {
    for (const key of PERFORMANCE_KEYS) {
      const raw = (fromDisk.performance as any)[key];
      if (raw == null) continue;

      const bounds = PERFORMANCE_BOUNDS[key];
      const value = Number(raw);

      if (!Number.isFinite(value)) {
        note(`performance.${key}`, "not a number");
        continue;
      }
      if (bounds.allowUnlimited && value === 0) {
        next.performance[key] = 0;
        continue;
      }
      if (value < bounds.min || value > bounds.max) {
        note(
          `performance.${key}`,
          `outside ${bounds.min}–${bounds.max}${bounds.allowUnlimited ? " (or 0 for unlimited)" : ""}`
        );
        continue;
      }
      next.performance[key] = bounds.fractional ? value : Math.floor(value);
    }
  } else if (fromDisk.performance != null) {
    note("performance", "not an object");
  }

  // --- maps ---
  if (isPlainObject(fromDisk.mcpToolsDisabled)) {
    for (const [source, value] of Object.entries(fromDisk.mcpToolsDisabled)) {
      if (typeof value === "boolean") next.mcpToolsDisabled[source] = value;
      else note(`mcpToolsDisabled.${source}`, "not true/false");
    }
  } else if (fromDisk.mcpToolsDisabled != null) {
    note("mcpToolsDisabled", "not an object");
  }
  if (isPlainObject(fromDisk.mcpReadOnly)) {
    for (const [server, value] of Object.entries(fromDisk.mcpReadOnly)) {
      if (typeof value === "boolean") next.mcpReadOnly[server] = value;
      else note(`mcpReadOnly.${server}`, "not true/false");
    }
  } else if (fromDisk.mcpReadOnly != null) {
    note("mcpReadOnly", "not an object");
  }

  if (isPlainObject(fromDisk.fixCommands)) {
    for (const [root, entry] of Object.entries(fromDisk.fixCommands)) {
      if (!isPlainObject(entry)) {
        note(`fixCommands.${root}`, "not an object");
        continue;
      }
      const commands: { build?: string; verify?: string } = {};
      if (typeof entry.build === "string" && entry.build.trim()) commands.build = entry.build.trim();
      if (typeof entry.verify === "string" && entry.verify.trim()) commands.verify = entry.verify.trim();
      next.fixCommands[root] = commands;
    }
  } else if (fromDisk.fixCommands != null) {
    note("fixCommands", "not an object");
  }

  if (isPlainObject(fromDisk.connections)) {
    for (const [id, entry] of Object.entries(fromDisk.connections)) {
      if (!isPlainObject(entry)) {
        note(`connections.${id}`, "not an object");
        continue;
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (typeof value === "string") fields[key] = value;
        else note(`connections.${id}.${key}`, "not a string");
      }
      next.connections[id] = fields;
    }
  } else if (fromDisk.connections != null) {
    note("connections", "not an object");
  }

  if (isPlainObject(fromDisk.customServers)) {
    for (const [name, entry] of Object.entries(fromDisk.customServers)) {
      if (!isPlainObject(entry) || (entry.transport !== "stdio" && entry.transport !== "http")) {
        note(`customServers.${name}`, "needs transport \"stdio\" or \"http\"");
        continue;
      }
      next.customServers[name] = entry as CustomServerConfig;
    }
  } else if (fromDisk.customServers != null) {
    note("customServers", "not an object");
  }

  // --- fan-out ---
  if (fromDisk.vaultLockMigrated === true) next.vaultLockMigrated = true;

  if (isPlainObject(fromDisk.vaultPaths)) {
    for (const key of VAULT_PATH_KEYS) {
      const value = (fromDisk.vaultPaths as any)[key];
      if (typeof value === "string" && value.trim()) {
        // Vault-relative: strip leading slashes so "/x" and "x" mean the same,
        // and refuse traversal outright rather than resolving it later.
        const cleaned = value.trim().replace(/^\/+/, "");
        if (cleaned.split("/").includes("..")) note(`vaultPaths.${key}`, "contains a .. segment");
        else next.vaultPaths[key] = cleaned;
      } else if (value != null) {
        note(`vaultPaths.${key}`, "not a string");
      }
    }
  } else if (fromDisk.vaultPaths != null) {
    note("vaultPaths", "not an object");
  }

  if (isPlainObject(fromDisk.fanout)) {
    const workers = Number(fromDisk.fanout.workers);
    next.fanout = {
      enabled: fromDisk.fanout.enabled === true,
      workers: Number.isFinite(workers) ? Math.min(Math.max(Math.floor(workers), 1), 8) : DEFAULTS.fanout.workers,
      plannerModel:
        typeof fromDisk.fanout.plannerModel === "string" && fromDisk.fanout.plannerModel.trim()
          ? fromDisk.fanout.plannerModel.trim()
          : null,
    };
    if (!Number.isFinite(workers) && fromDisk.fanout.workers != null) {
      note("fanout.workers", "not a number");
    }
  } else if (fromDisk.fanout != null) {
    note("fanout", "not an object");
  }

  return { config: next, repaired };
}

/** Read config from disk (cached). Never throws — falls back to defaults. */
export function loadConfig(): AssistantConfig {
  if (cached) return cached;

  let fromDisk: Partial<AssistantConfig> = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch (err: any) {
      console.warn(
        `⚠️  ${CONFIG_PATH} is not valid JSON (${err.message}). Using defaults; ` +
          `fix or delete the file to silence this.`
      );
      fromDisk = {};
    }
  }

  const { config, repaired } = sanitiseConfig(fromDisk);

  if (repaired.length > 0) {
    console.warn(
      `⚠️  ${CONFIG_PATH}: using defaults for ${repaired.join(", ")}. ` +
        `Everything else was kept, and saving from the dashboard will rewrite the file correctly.`
    );
  }

  cached = applyEnvOverrides(config);
  return cached;
}

/** Merge a patch into the config and persist it. Returns the new config. */
export function saveConfig(patch: Partial<AssistantConfig>): AssistantConfig {
  // Run the patch through the same sanitiser, so a bad value from an API caller
  // cannot write a config that then fails to load.
  const { config: next } = sanitiseConfig({ ...loadConfig(), ...patch });

  cached = next;
  ensureConfigDir();

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`⚠️  Could not persist config to ${CONFIG_PATH}: ${err.message}`);
  }

  return next;
}

/**
 * Session-scoped "accept edits": the user has said, for this session only, that
 * mutating tools may run and read-only guards should stand aside.
 *
 * Lives here rather than in session.ts because both tools.ts and mcpManager.ts
 * consult the read-only guards and neither can import session.ts without a cycle
 * (session → secrets → config). Never persisted: waking up tomorrow with the
 * vault writable would be exactly the surprise the read-only default prevents.
 */
let editsAccepted = false;

export function setEditsAccepted(value: boolean): void {
  editsAccepted = value;
}

export function areEditsAccepted(): boolean {
  return editsAccepted;
}

/**
 * Clear a stored `obsidian-live: true` once, because it was never a decision.
 *
 * Saving the Obsidian connector used to write back whatever the mode happened to
 * be, so everyone ended up with the old read-only default persisted. Now that a
 * vault write asks for confirmation instead of being refused, that stale value
 * would silently turn every prompt back into a refusal. Runs exactly once, and a
 * lock the user sets deliberately afterwards is never touched.
 */
export function migrateVaultLock(): void {
  const config = loadConfig();
  if (config.vaultLockMigrated) return;

  const modes = { ...(config.mcpReadOnly ?? {}) };
  const had = modes["obsidian-live"] === true;
  delete modes["obsidian-live"];
  // The disk-reading server this key belonged to was removed long ago.
  delete modes.obsidian;

  saveConfig({ mcpReadOnly: modes, vaultLockMigrated: true });

  if (had) {
    console.log(
      "ℹ️  Cleared the old vault read-only lock. Vault writes now ask for confirmation " +
        "instead of being refused; re-lock it in Settings → MCP Servers if you prefer."
    );
  }
}

/** Absolute vault path, or null when unconfigured. */
export function getVaultPath(): string | null {
  return loadConfig().vaultPath;
}

/**
 * Whether the vault starts LOCKED (writes refused outright).
 *
 * False since vault writes became ask-first: the confirmation prompt is the
 * protection now, and a lock on top of it would only produce refusals where the
 * user asked to be asked. Flipping the 🔒 toggle still locks it hard.
 */
export const VAULT_READ_ONLY_BY_DEFAULT = false;

/**
 * Whether vault writes are currently forbidden.
 *
 * Lives here rather than in mcpServers.ts so that tools.ts can consult it
 * without creating an import cycle (tools → mcpServers → mcpManager → tools).
 * Every code path that mutates the vault MUST check this — the MCP server's own
 * `--read-only` flag only constrains that server's tools, not our local ones.
 */
export function isVaultReadOnly(): boolean {
  // Accept-edits mode is an explicit, session-scoped override.
  if (editsAccepted) return false;

  const modes = loadConfig().mcpReadOnly ?? {};
  // `obsidian` is the legacy key from the disk-reading server that used to sit
  // alongside the live one; honour it so an existing read-write choice survives.
  const preference = modes["obsidian-live"] ?? modes.obsidian;
  return typeof preference === "boolean" ? preference : VAULT_READ_ONLY_BY_DEFAULT;
}

/**
 * Tools whose path arguments are relative to the VAULT root rather than the
 * working directory: the Obsidian plugin's own tools, and our note writer.
 */
const VAULT_SCOPED_TOOL = /^(note_|vault_|periodic_note_|active_file_)|obsidian/i;

/** Tool names containing any of these verbs are treated as mutating. */
const MUTATING_VERB =
  /(write|create|delete|remove|move|rename|patch|update|edit|append|copy|mkdir|truncate|manage)/i;

/** Pull every string out of a tool-argument object, at any depth. */
function collectStrings(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 4) return found;
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, found, depth + 1);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, found, depth + 1);
  return found;
}

/**
 * Refuse a mutating tool call that targets the vault while it is read-only.
 *
 * This exists because the vault normally sits INSIDE a granted filesystem path
 * (e.g. the vault is under ~ and ~ is granted). The Obsidian server's own
 * --read-only flag only withholds *its* write tools, so the filesystem server's
 * write_file / edit_file / move_file could still write into the vault. Verified:
 * it did. The check therefore lives at the single dispatch chokepoint every MCP
 * tool call passes through, rather than per-server.
 *
 * Returns null when the call is allowed.
 */
export function guardVaultWrite(toolName: string, args: unknown) {
  // The 🔒 toggle is the hard lock: when it is on, a vault write is refused with
  // no prompt. When it is off, writes are permitted but must be *asked about* —
  // see targetsVault() and requiresApproval() in core/approval.ts.
  if (!isVaultReadOnly()) return null;

  if (writesToVaultByName(toolName)) {
    return vaultReadOnlyError(`${toolName} writing to the vault`);
  }

  const target = targetsVault(toolName, args);
  if (!target) return null;

  return vaultReadOnlyError(`${toolName} writing to "${target}" inside the vault`);
}

/**
 * Does this call write somewhere inside the vault? Returns the offending path.
 *
 * The one place that answers this question, because a vault write can arrive by
 * several routes: the vault server's own tools, the filesystem server (the vault
 * usually sits inside a granted directory), note_write, or a shell redirect.
 */
/**
 * Does this tool write to the vault by definition, whatever its arguments say?
 *
 * `note_write` takes `{title, content}` and computes the path itself, so scanning
 * arguments for something path-shaped found nothing and the write sailed past both
 * the approval prompt and the lock. A tool whose whole job is writing notes must
 * be judged by what it IS, not by what it was passed.
 */
export function writesToVaultByName(toolName: string): boolean {
  return VAULT_SCOPED_TOOL.test(toolName) && MUTATING_VERB.test(toolName);
}

export function targetsVault(toolName: string, args: unknown): string | null {
  const vaultPath = getVaultPath();
  if (!vaultPath) return null;
  if (!MUTATING_VERB.test(toolName)) return null;

  const root = path.resolve(vaultPath);
  const inside = (candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

  for (const candidate of collectStrings(args)) {
    if (!candidate || candidate.length < 2) continue;

    // Path-shaped enough to check: has a separator, is a home path, or is a bare
    // note filename. That last case matters because a note at the vault root is
    // addressed as "Ideas.md" with no slash at all, and requiring one let those
    // writes through unasked.
    const looksLikePath =
      candidate.includes("/") ||
      candidate.startsWith("~") ||
      (/\.(md|canvas|txt|markdown)$/i.test(candidate) && !/\s{2,}|\n/.test(candidate));
    if (!looksLikePath) continue;

    // 1. Absolute, or relative to the working directory.
    if (inside(path.resolve(expandPath(candidate)))) return candidate;

    // 2. Vault-RELATIVE, which is how the vault's own tools address notes.
    //    Without this, "_assistant/notes/x.md" resolved against process.cwd(),
    //    landed nowhere near the vault, and slipped past both the lock and the
    //    approval prompt — a vault write that nobody was asked about.
    //
    //    Only for tools that actually take vault-relative paths. `write_file
    //    {path: "README.md"}` means the working directory, and treating it as a
    //    vault note produced a prompt for an ordinary project file.
    if (VAULT_SCOPED_TOOL.test(toolName) && !path.isAbsolute(candidate) && !candidate.startsWith("~")) {
      const asVaultRelative = path.resolve(root, candidate.replace(/^\/+/, ""));
      if (inside(asVaultRelative)) {
        try {
          if (fs.existsSync(asVaultRelative) || fs.existsSync(path.dirname(asVaultRelative))) {
            return candidate;
          }
        } catch {
          /* unreadable: fall through rather than guess */
        }
      }
    }
  }

  return null;
}

/** Structured refusal for a write attempted while the vault is read-only. */
export function vaultReadOnlyError(operation: string) {
  return {
    error: true,
    readOnly: true,
    message: `The vault is locked read-only, so ${operation} is not permitted.`,
    actionRequired:
      "Do not try another tool to work around this, and do not use the shell to write files. " +
      "Tell the user the vault is locked and that they can unlock it with the Read-write button " +
      "next to obsidian-live in Settings → MCP Servers.",
  };
}

/**
 * Resolve the vault path for a tool call, or return a structured, actionable
 * error. Tools return this object rather than throwing so a small model gets a
 * correctable message instead of a crashed turn.
 */
export function requireVaultPath():
  | { ok: true; path: string }
  | { ok: false; error: string; actionRequired: string } {
  const vaultPath = getVaultPath();

  if (!vaultPath) {
    return {
      ok: false,
      error: "No Obsidian vault is configured.",
      actionRequired:
        "Ask the user to set one: type `/vault set <path>` in the chat, use the " +
        "Vault field in the sidebar, or set OBSIDIAN_VAULT_PATH. Do not guess a path.",
    };
  }

  if (!fs.existsSync(vaultPath)) {
    return {
      ok: false,
      error: `Configured vault path does not exist: ${vaultPath}`,
      actionRequired:
        "Ask the user to correct it with `/vault set <path>`. Do not create the directory.",
    };
  }

  return { ok: true, path: vaultPath };
}

/** Reset the in-memory cache. Used after external edits to the config file. */
export function invalidateConfigCache() {
  cached = null;
}

export { ensureConfigDir };
