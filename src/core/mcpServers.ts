// Declarative registry of the optional MCP servers Cullus can manage.
//
// Each definition knows how to build its own spawn config from user config, and
// declares whether it supports a read-only mode. Keeping this in one place lets
// both startup (index.ts) and the live UI toggle (server.ts) reconfigure a
// server without duplicating argv-building logic.

import * as fs from "fs";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { mcpManager } from "./mcpManager.js";
import {
  loadConfig,
  saveConfig,
  expandPath,
  VAULT_READ_ONLY_BY_DEFAULT,
  type AssistantConfig,
  type CustomServerConfig,
} from "./config.js";
import {
  getClaudeCliMcpCommand,
  getClaudeCliMcpEnv,
  getSecret,
  setSecret,
  deleteSecret,
  listClaudeCliMcpServers,
} from "./secrets.js";

/**
 * MCP endpoint of the Obsidian Local REST API plugin.
 *
 * Precedence: explicit OBSIDIAN_API_URL, then whatever base URL the Claude CLI
 * is already using for its Obsidian server (so both clients follow one setting),
 * then the plugin's default HTTPS port. A bare base URL is normalised to the
 * `/mcp/` path the plugin serves Streamable HTTP on.
 */
export function obsidianMcpUrl(config = loadConfig()): string {
  const explicit = process.env.OBSIDIAN_API_URL;
  if (explicit) return explicit;

  const base =
    config.connections?.obsidian?.baseUrl ||
    getClaudeCliMcpEnv("OBSIDIAN_BASE_URL") ||
    "https://127.0.0.1:27124";
  const trimmed = base.replace(/\/+$/, "");
  return /\/mcp$/.test(trimmed) ? `${trimmed}/` : `${trimmed}/mcp/`;
}

/**
 * How to launch the GitHub MCP server.
 *
 * Prefers a command already working on this machine over one we hope exists:
 * an explicit env override, then a configured path, then whatever binary the
 * Claude CLI is using for its own GitHub server (this is how a corporate wrapper
 * like `gh-mcp-unity` gets picked up), and only then the public npm package.
 */
/**
 * The OANDA trading MCP server that ships inside this package.
 *
 * Resolved from this module's own location rather than the working directory, so
 * it keeps working when Cullus is npm-linked and invoked from anywhere.
 */
function oandaServerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "oanda", "server.js");
}

/** Env wins, then whatever Settings → Connections saved. */
function etsyServerPath(config = loadConfig()): string | null {
  const raw = process.env.ETSY_MCP_SERVER_PATH ?? config.connections?.etsy?.serverPath ?? "";
  return raw.trim() ? expandPath(raw.trim()) : null;
}

function githubServerCommand(config = loadConfig()): { command: string; args: string[] } {
  const explicit = process.env.GITHUB_MCP_COMMAND ?? config.connections?.github?.command;
  if (explicit) {
    const [command, ...args] = explicit.split(/\s+/);
    return { command, args };
  }

  const fromClaude = getClaudeCliMcpCommand(["github", "gh"]);
  if (fromClaude) return fromClaude;

  return { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
}

export interface SpawnConfig {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  bearerToken?: () => string | null;
  allowSelfSignedLocalhost?: boolean;
  clientEnforcedReadOnly?: boolean;
  priority?: number;
}

export interface McpServerDefinition {
  name: string;
  /** Human-readable purpose, shown in the UI. */
  description: string;
  /** Whether this server accepts a read-only mode we can toggle. */
  supportsReadOnly: boolean;
  /** Default to read-only when the user has expressed no preference. */
  readOnlyByDefault: boolean;
  /** Why the server can't start right now, or null when it can. */
  unavailableReason(config: AssistantConfig): string | null;
  build(config: AssistantConfig, readOnly: boolean): SpawnConfig;
}

/**
 * Absolute path to `uvx`, or null when it is not installed.
 *
 * The Blender MCP server ships as a Python package run through `uvx`, and `uv`
 * installs to ~/.local/bin (or ~/.cargo/bin on older installers), neither of
 * which is on the PATH a GUI-launched process inherits. Resolved explicitly for
 * the same reason as the Unity CLI.
 */
export function uvxPath(): string | null {
  const candidates = [
    path.join(process.env.HOME ?? "", ".local", "bin", "uvx"),
    path.join(process.env.HOME ?? "", ".cargo", "bin", "uvx"),
    "/opt/homebrew/bin/uvx",
    "/usr/local/bin/uvx",
  ];

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "uvx"));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable entry on PATH: keep looking */
    }
  }
  return null;
}

/**
 * Absolute path to the `unity` binary, or null when it is not installed.
 *
 * Resolved rather than shelling out to `which`: this is called on every render
 * of the connections panel. The Hub installs to ~/.unity/bin, which is only on
 * PATH for interactive shells — a GUI-launched Cullus inherits a login
 * environment that often does not have it, so the explicit path is checked too.
 */
export function unityCliPath(): string | null {
  const candidates = [
    path.join(process.env.HOME ?? "", ".unity", "bin", "unity"),
    "/opt/homebrew/bin/unity",
    "/usr/local/bin/unity",
  ];

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "unity"));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable entry on PATH: keep looking */
    }
  }
  return null;
}

/** One Editor command, as `unity command --json` describes it. */
export interface UnityCommand {
  name: string;
  description: string;
  tags: string[];
  parameters: {
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: unknown;
  }[];
}

/**
 * Every command the connected Editor offers, read once.
 *
 * `unity mcp` has no tag flag, so the filtering happens here. The data comes
 * from `unity command --json`, which talks to the same Pipeline server the MCP
 * server does — so if the MCP server can see a command, this can see it too.
 * That equivalence is also what makes this catalogue usable as a *discovery*
 * surface (`unity_commands`): it is not a hand-written list that can drift, it
 * is the same 149 commands the Editor is exposing right now.
 *
 * Cached for the process: the list changes only when the Editor loads different
 * packages, and the tag filter consults it once per tool per schema build.
 */
let unityCommandCache: UnityCommand[] | null = null;

/**
 * Why the last catalogue read came back empty, in the CLI's own words.
 *
 * `unity command --json` already diagnoses this precisely — "No Unity Editor
 * instances found with reachable Pipeline servers", plus the three things to
 * check — and it exits non-zero while printing that JSON to stdout. Throwing
 * that away and reporting "Still none" turns a solved diagnosis back into a
 * mystery, which is exactly what a connected-but-empty server does not need.
 */
let unityCatalogueError: string | null = null;

export function unityCatalogueReason(): string | null {
  unityCommandCatalogue();
  return unityCatalogueError;
}

/**
 * The two Unity modes, stated in full, because they are mutually exclusive.
 *
 * The Editor's MCP tools are served by a HTTP server running *inside* the
 * Editor, so they exist only while it is open. `unity_compile` runs the editor
 * binary in batch mode, which refuses a project the Editor already holds
 * (`Temp/UnityLockfile`). There is no configuration in which both are available,
 * and every surface that reports one of them missing was reporting half a fact:
 * "the Unity tools are gone" and "the Editor has this project open" are the same
 * sentence read from opposite ends.
 *
 * One function so the wording cannot drift between /doctor, /tools and the two
 * tools' own error paths. The count is live where we have it — quoting 149 from
 * a machine that is serving 62 would be a worse answer than none.
 */
export function unityModeTradeoff(): string {
  const count = unityCommandCatalogue().length;
  const editorTools = count > 0 ? `${count} Unity MCP tools` : "the Unity MCP tools";

  return (
    `Editor open → ${editorTools}, no unity_compile. ` +
    "Editor closed → unity_compile works, 0 Unity MCP tools. " +
    "They are mutually exclusive: batch mode cannot open a project the Editor is holding."
  );
}

export function unityCommandCatalogue(): UnityCommand[] {
  if (unityCommandCache) return unityCommandCache;

  const commands: UnityCommand[] = [];
  const cli = unityCliPath();
  if (!cli) {
    unityCatalogueError = "The Unity CLI is not installed (looked on PATH and in ~/.unity/bin).";
    return (unityCommandCache = commands);
  }

  unityCatalogueError = null;

  try {
    const raw = execFileSync(cli, ["command", "--detail", "full", "--json"], {
      encoding: "utf-8",
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024, // 149 commands with full schemas is ~325 KB.
    });
    for (const cmd of JSON.parse(raw)?.data?.commands ?? []) {
      if (!cmd?.name) continue;
      commands.push({
        name: String(cmd.name),
        description: String(cmd.description ?? ""),
        tags: Array.isArray(cmd.tags) ? cmd.tags.map(String) : [],
        parameters: (Array.isArray(cmd.parameters) ? cmd.parameters : []).map((p: any) => ({
          name: String(p?.name ?? ""),
          type: String(p?.type ?? "string"),
          description: String(p?.description ?? ""),
          required: Boolean(p?.required),
          ...(p?.default !== undefined ? { default: p.default } : {}),
        })),
      });
    }
  } catch (error: any) {
    // No Editor, or the CLI changed shape. An empty list means "no tag data",
    // and the filter below fails OPEN — better a large tool list than a Unity
    // connection that silently exposes nothing.
    //
    // The CLI exits non-zero here but still prints its diagnosis as JSON on
    // stdout, so read it off the thrown error rather than discarding it.
    try {
      const parsed = JSON.parse(String(error?.stdout ?? ""));
      const message = parsed?.errors?.[0]?.message;
      if (message) unityCatalogueError = String(message).trim();
    } catch {
      /* not JSON: fall through to the generic reason below */
    }
    unityCatalogueError ??= `The Unity CLI failed: ${String(error?.message ?? error).slice(0, 200)}`;
  }

  unityCommandCache = commands;
  return commands;
}

let unityTagCache: Map<string, string[]> | null = null;

function unityCommandTags(): Map<string, string[]> {
  if (!unityTagCache) {
    unityTagCache = new Map(unityCommandCatalogue().map((c) => [c.name, c.tags]));
  }
  return unityTagCache;
}

/** Forget the command list, so a newly-opened Editor is picked up without a restart. */
export function resetUnityTagCache(): void {
  unityCommandCache = null;
  unityTagCache = null;
  unityCatalogueError = null;
}

/**
 * Whether a Unity command is inside the configured tag set.
 *
 * Fails open in both directions that matter: an empty `unityToolTags` means the
 * user asked for everything, and a command we have no tag data for is exposed
 * rather than hidden. Hiding on missing data would turn one stale cache into a
 * Unity server that appears connected and offers nothing.
 */
export function unityToolAllowed(name: string, config: AssistantConfig): boolean {
  const wanted = config.unityToolTags;
  if (!Array.isArray(wanted) || wanted.length === 0) return true;

  const tags = unityCommandTags().get(name);
  if (!tags || tags.length === 0) return true;

  // Tags are hierarchical ("assets/import"), and a wanted tag matches its whole
  // subtree — the same rule `unity command --tag assets` uses.
  return tags.some((tag) => wanted.some((w) => tag === w || tag.startsWith(`${w}/`)));
}

/**
 * The subset of granted paths that actually exist right now.
 *
 * Checked at spawn time rather than at config load, because a path can be on a
 * volume that is mounted later — dropping it permanently from config on the
 * strength of one `existsSync` would be worse than advertising it.
 */
export function existingPaths(paths: string[]): string[] {
  return paths.filter((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

export const MCP_SERVER_DEFINITIONS: McpServerDefinition[] = [
  {
    name: "filesystem",
    description: "Read and write files in the directories you grant",
    supportsReadOnly: true,
    // Reading code is the common case; writing is the exception. Default safe.
    readOnlyByDefault: true,
    unavailableReason(config) {
      if (config.allowedPaths.length === 0) {
        return "No directories granted. Add one with the 📁 button or `/paths add <path>`.";
      }
      if (existingPaths(config.allowedPaths).length === 0) {
        return (
          `None of the ${config.allowedPaths.length} granted directories exist on disk: ` +
          `${config.allowedPaths.join(", ")}. Fix them with \`/paths\`.`
        );
      }
      return null;
    },
    build(config, readOnly) {
      // @modelcontextprotocol/server-filesystem has no read-only flag of its own,
      // so read-only is enforced client-side: mutating tools are withheld from the
      // model and refused at dispatch.
      //
      // Paths that do not exist are dropped rather than passed through. The
      // server takes its grant list verbatim and reports it back through
      // `list_allowed_directories`, so a stale entry becomes a confident lie
      // from one of our own tools. Measured: the config held
      // `~/Documents/Obsidian Vault` while the real directory is
      // `Obsidian_Vault`, the model trusted the listing over `ls`, and burnt
      // five tool steps proving the tool wrong. `/doctor` already warns about
      // this (checkAllowedPaths) — but a warning the model never sees does not
      // stop it acting on the bad list.
      return {
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          ...existingPaths(config.allowedPaths),
        ],
        clientEnforcedReadOnly: readOnly,
      };
    },
  },
  {
    name: "obsidian-live",
    description:
      "Your Obsidian vault over HTTPS: notes, search, active note, commands " +
      "(needs Obsidian running with the Local REST API plugin + token)",
    supportsReadOnly: true,
    // Unlocked by default, because the gate moved: a vault write now prompts for
    // confirmation in auto and manual mode instead of being withheld. Leaving this
    // read-only would mean refusals where the user asked for questions. The 🔒
    // toggle remains the hard lock for anyone who wants writes impossible.
    readOnlyByDefault: false,
    unavailableReason() {
      if (!getSecret("OBSIDIAN_API_KEY")) {
        return (
          "No API token found (checked env, Keychain, secrets file and ~/.claude.json). " +
          "Copy it from Obsidian → Settings → Local REST API with MCP, then paste it in " +
          "Cullus under Settings → Connections → Obsidian Vault → Connect."
        );
      }
      return null;
    },
    build(_config, readOnly) {
      // The plugin's own MCP server over Streamable HTTP — the ONLY way this app
      // reaches the vault. It talks to the RUNNING Obsidian app, so it sees the
      // active note and Obsidian's resolved link index, and it serves whichever
      // vault Obsidian has open rather than a configured path. Every request is
      // authenticated with the plugin's bearer token over local HTTPS.
      return {
        transport: "http",
        url: obsidianMcpUrl(),
        // Resolved per request: never held in this object, never serialised.
        bearerToken: () => getSecret("OBSIDIAN_API_KEY"),
        allowSelfSignedLocalhost: true,
        clientEnforcedReadOnly: readOnly,
      };
    },
  },
  {
    name: "github",
    description: "GitHub repositories, issues and pull requests (needs a personal access token)",
    supportsReadOnly: true,
    // Read-only here means "no writes to anyone's repository": the safer default
    // by a wide margin, since a bad write is public and hard to take back.
    readOnlyByDefault: true,
    unavailableReason(config) {
      if (getSecret("GITHUB_TOKEN")) return null;

      // A server command discovered from the Claude CLI (or set explicitly) may
      // carry its own auth — corporate wrappers usually do — so requiring a token
      // we manage would refuse to start something that already works.
      const explicit = process.env.GITHUB_MCP_COMMAND ?? config.connections?.github?.command;
      if (explicit || getClaudeCliMcpCommand(["github", "gh"])) return null;

      return (
        "No GitHub token found (checked GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN, GH_TOKEN, " +
        "the Keychain, the secrets file and ~/.claude.json) and no GitHub MCP command is " +
        "configured. Add a token in Settings → Connections."
      );
    },
    build(config, readOnly) {
      const { command, args } = githubServerCommand(config);
      const token = getSecret("GITHUB_TOKEN");

      return {
        command,
        args,
        // Both names are exported when we have a token: servers disagree about
        // which one they read. With no token, pass nothing rather than empty
        // strings, so a wrapper binary can fall back to its own credentials.
        env: token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token, GITHUB_TOKEN: token } : undefined,
        clientEnforcedReadOnly: readOnly,
      };
    },
  },
  {
    name: "etsy",
    description: "Etsy shop data (needs a locally built Etsy MCP server and an API keystring)",
    supportsReadOnly: false,
    readOnlyByDefault: false,
    unavailableReason(config) {
      // Configurable from Settings like every other connector. It used to be
      // env-only, so the panel dead-ended on "ETSY_MCP_SERVER_PATH is not set."
      // with nowhere to set it — the environment variable still wins, it is just
      // no longer the only way in.
      const target = etsyServerPath(config);

      if (!target) {
        return (
          "No Etsy MCP server configured. Etsy publishes no official one, so point " +
          "Cullus at a built server: Settings → Connections → Etsy → Connect, or export " +
          "ETSY_MCP_SERVER_PATH."
        );
      }
      if (!fs.existsSync(target)) {
        return `Server build not found at ${target}. Check the path, or rebuild that server.`;
      }
      if (!getSecret("ETSY_API_KEY")) {
        return (
          "No Etsy API keystring found (checked ETSY_API_KEY, the Keychain and the secrets " +
          "file). Add one in Settings → Connections → Etsy."
        );
      }
      return null;
    },
    build(config) {
      const secret = getSecret("ETSY_CLIENT_SECRET");

      return {
        command: "node",
        args: [etsyServerPath(config)!],
        env: {
          ETSY_API_KEY: getSecret("ETSY_API_KEY") ?? "",
          // Both names, because servers disagree about which they read.
          ...(secret ? { ETSY_CLIENT_SECRET: secret, ETSY_SHARED_SECRET: secret } : {}),
        },
      };
    },
  },
  {
    name: "blender",
    description:
      "A running Blender: objects, materials, scene inspection, Python execution, Poly Haven " +
      "and Sketchfab assets, and GLB/FBX export (needs uvx, plus Blender with the mcp-for-blender " +
      "addon and its socket server started)",
    supportsReadOnly: false,
    readOnlyByDefault: false,
    unavailableReason() {
      if (!uvxPath()) {
        return (
          "uvx not found (looked on PATH, ~/.local/bin and ~/.cargo/bin). Install uv with " +
          "`curl -fsSL https://astral.sh/uv/install.sh | sh`, then install the Blender addon " +
          "with `uvx mcp-for-blender install-addon`."
        );
      }

      // Deliberately NOT probing for a running Blender or its socket. Same
      // reasoning as Unity: this runs on every render of the connections panel,
      // the answer changes the moment somebody opens Blender, and the server's
      // own tools report a missing addon far better than a port scan would.
      return null;
    },
    build() {
      return {
        command: uvxPath()!,
        args: ["mcp-for-blender"],
        // Blender's addon talks over a local socket, so the server itself needs
        // nothing but a clean stdio pair for JSON-RPC.
        env: { PYTHONUNBUFFERED: "1" },
      };
    },
  },
  {
    name: "unity",
    description:
      "The running Unity Editor: scenes, GameObjects, assets, tests and builds " +
      "(needs the Unity CLI, plus an Editor open on a project with com.unity.pipeline)",
    supportsReadOnly: false,
    readOnlyByDefault: false,
    unavailableReason() {
      const cli = unityCliPath();
      if (!cli) {
        return (
          "Unity CLI not found (looked on PATH and in ~/.unity/bin). Install it with " +
          "`curl -fsSL https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh | bash`, " +
          "or `brew install unity-cli`."
        );
      }
      // Deliberately NOT probing for a running Editor here. This runs on every
      // render of the connections panel, and finding an Editor means scanning
      // processes and port files — too slow to do on a paint, and the answer
      // changes the moment someone opens Unity. The tool list is empty until an
      // Editor connects, which is self-explanatory once you know to expect it.
      return null;
    },
    build(config) {
      // Re-read on every connect: the Editor may have opened, or opened a
      // different project, since the last time we asked.
      resetUnityTagCache();

      return {
        toolFilter: (name: string) => unityToolAllowed(name, config),
        command: unityCliPath()!,
        // `unity mcp` writes its "MCP server started (stdio)" banner to stderr,
        // so stdout is clean JSON-RPC with or without these flags — checked on
        // 1.0.0-beta.5 by discarding each stream in turn. They stay as a hedge
        // against that moving, and `--non-interactive` is the one that earns its
        // place: a prompt on a pipe nobody is watching would hang the spawn.
        args: ["mcp", "--no-banner", "--quiet"],
        env: { UNITY_NO_BANNER: "1", UNITY_NON_INTERACTIVE: "1" },
      };
    },
  },
  {
    name: "oanda-trading",
    description:
      "OANDA trading desk: account and risk state, live signal scan across your watchlist, " +
      "risk-based position sizing, walk-forward backtests, and (when unlocked) order placement",
    supportsReadOnly: true,
    // Locked by default and deliberately so. Everything analytical — scanning,
    // sizing, backtesting, reviewing the trade book — works read-only; the only
    // tools this hides are the four that move money. Unlocking is a decision
    // someone should make on purpose, with the 🔒 toggle.
    readOnlyByDefault: true,
    unavailableReason(config) {
      const built = oandaServerPath();
      if (!fs.existsSync(built)) {
        return `Server not built at ${built}. Run \`npm run build\`.`;
      }
      if (!getSecret("OANDA_API_TOKEN")) {
        return (
          "No OANDA API token found (checked OANDA_API_TOKEN, the Keychain and the secrets " +
          "file). Create one in the OANDA web portal under Manage API Access, then add it in " +
          "Settings → Connections → OANDA."
        );
      }
      if (!getSecret("OANDA_ACCOUNT_ID") && !config.connections?.oanda?.accountID) {
        return (
          "No OANDA account ID configured. It looks like 001-004-1234567-001 and is shown on " +
          "your account page; add it in Settings → Connections → OANDA."
        );
      }
      return null;
    },
    build(config, readOnly) {
      // "live" has to be asked for by name: defaulting to the practice host means
      // a misconfiguration costs nothing.
      const environment =
        (process.env.OANDA_ENVIRONMENT ?? config.connections?.oanda?.environment) === "live"
          ? "live"
          : "practice";

      return {
        command: process.execPath,
        args: [oandaServerPath()],
        env: {
          OANDA_API_TOKEN: getSecret("OANDA_API_TOKEN") ?? "",
          OANDA_ACCOUNT_ID:
            getSecret("OANDA_ACCOUNT_ID") ?? config.connections?.oanda?.accountID ?? "",
          OANDA_ENVIRONMENT: environment,
          // Enforced twice on purpose: the client withholds the mutating tools,
          // and the server itself refuses to place an order. Either alone would
          // be one bug away from a filled trade nobody asked for.
          OANDA_TRADING_READ_ONLY: readOnly ? "1" : "0",
          // Expanded here: the field accepts `~/...` like every other path in
          // Settings, and the server resolves the value literally.
          ...(config.connections?.oanda?.paramsPath
            ? { OANDA_BOT_PARAMS_PATH: expandPath(config.connections.oanda.paramsPath) }
            : {}),
        },
        clientEnforcedReadOnly: readOnly,
      };
    },
  },
];

/** Names that cannot be reused by a user-added server. */
export const BUILTIN_SERVER_NAMES = MCP_SERVER_DEFINITIONS.map((d) => d.name);

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Turn a user-added server config into a definition indistinguishable from a
 * built-in one, so read-only toggles, connection state, tool routing and the
 * Connections table all work without special cases.
 */
function customDefinition(name: string, custom: CustomServerConfig): McpServerDefinition {
  return {
    name,
    description:
      custom.label ??
      (custom.transport === "http" ? `Custom HTTP MCP server (${custom.url})` : `Custom MCP server (${custom.command})`),
    supportsReadOnly: true,
    // Someone else's server, added by hand: start it withholding writes.
    readOnlyByDefault: custom.readOnly ?? true,
    unavailableReason() {
      if (custom.transport === "stdio") {
        if (!custom.command) return "No command configured. Edit it in Settings → Connections.";
        for (const [name, secretKey] of Object.entries(custom.envSecrets ?? {})) {
          if (!getSecret(secretKey)) {
            return `No value stored for ${name}. Re-enter it in Settings → Connections.`;
          }
        }
        return null;
      }
      if (!custom.url) return "No URL configured. Edit it in Settings → Connections.";
      try {
        new URL(custom.url);
      } catch {
        return `"${custom.url}" is not a valid URL.`;
      }
      if (custom.tokenSecret && !getSecret(custom.tokenSecret)) {
        return "No token stored for this server. Add it in Settings → Connections.";
      }
      return null;
    },
    build(_config, readOnly) {
      if (custom.transport === "http") {
        return {
          transport: "http",
          url: custom.url!,
          bearerToken: custom.tokenSecret ? () => getSecret(custom.tokenSecret!) : undefined,
          allowSelfSignedLocalhost: custom.allowSelfSigned === true,
          clientEnforcedReadOnly: readOnly,
        };
      }
      // Token-shaped variables live in the Keychain, keyed by name, and are only
      // materialised here — in the child process's environment — at spawn time.
      const env: Record<string, string> = { ...(custom.env ?? {}) };
      for (const [name, secretKey] of Object.entries(custom.envSecrets ?? {})) {
        const value = getSecret(secretKey);
        if (value) env[name] = value;
      }

      return {
        command: custom.command!,
        args: custom.args ?? [],
        env: Object.keys(env).length > 0 ? env : undefined,
        clientEnforcedReadOnly: readOnly,
      };
    },
  };
}

/**
 * Every server Cullus can manage: the built-ins plus whatever the user
 * added. A function rather than a constant because the second half is config, and
 * config changes while the process runs.
 */
export function getServerDefinitions(config = loadConfig()): McpServerDefinition[] {
  const custom = Object.entries(config.customServers ?? {})
    .filter(([name]) => !BUILTIN_SERVER_NAMES.includes(name))
    .map(([name, entry]) => customDefinition(name, entry));

  return [...MCP_SERVER_DEFINITIONS, ...custom];
}

/** Is this a user-added server (i.e. removable)? */
export function isCustomServer(name: string, config = loadConfig()): boolean {
  return Boolean(config.customServers?.[name]) && !BUILTIN_SERVER_NAMES.includes(name);
}

export interface CustomServerInput extends CustomServerConfig {
  name: string;
  /** Plain token; stored via secrets.ts and never persisted to config. */
  token?: string;
}

/**
 * Validate a user-added server. Returns the config to persist, or every reason it
 * was refused — the UI shows these instead of a generic failure.
 */
export function validateCustomServer(
  input: CustomServerInput
): { ok: true; name: string; config: CustomServerConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = String(input.name ?? "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) {
    errors.push("Name must be 2-32 characters: lowercase letters, digits, dash or underscore.");
  }
  if (BUILTIN_SERVER_NAMES.includes(name)) {
    errors.push(`"${name}" is a built-in server. Pick a different name.`);
  }

  const transport = input.transport === "http" ? "http" : "stdio";
  const config: CustomServerConfig = {
    transport,
    label: input.label?.trim() || undefined,
    type: input.type ?? (transport === "http" ? "Web" : "Local"),
    readOnly: input.readOnly !== false,
  };

  if (transport === "stdio") {
    if (!input.command?.trim()) errors.push("A stdio server needs a command.");
    config.command = input.command?.trim();
    config.args = (input.args ?? []).map((a) => String(a)).filter(Boolean);
    config.env = input.env && typeof input.env === "object" ? input.env : undefined;
  } else {
    const raw = input.url?.trim() ?? "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      errors.push(`"${raw || "(empty)"}" is not a valid URL.`);
    }

    if (parsed) {
      // Same rule the transport enforces: a self-signed exception is only ever
      // acceptable for loopback, so refuse it here rather than at connect time.
      if (input.allowSelfSigned && !LOOPBACK_HOSTS.includes(parsed.hostname)) {
        errors.push(
          `Self-signed certificates are only accepted for localhost, not "${parsed.hostname}".`
        );
      }
      config.url = parsed.toString();
      config.allowSelfSigned =
        input.allowSelfSigned === true && LOOPBACK_HOSTS.includes(parsed.hostname);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, name, config };
}

/** Secret key used for a custom server's bearer token. */
export function customTokenKey(name: string): string {
  return `MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

/**
 * Environment variable names that carry a credential.
 *
 * Deliberately generous: a false positive costs one extra Keychain entry, while
 * a false negative writes somebody's token into config.json in plain text.
 */
const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION/i;

/** Secret key used for one token-shaped env var of a custom server. */
export function customEnvSecretKey(server: string, envName: string): string {
  const slug = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `MCP_${slug(server)}_ENV_${slug(envName)}`;
}

/**
 * Split a stdio server's environment into the part that is safe to persist and
 * the part that has to go to the Keychain, writing the latter as it goes.
 *
 * Called on every save, so a server edited to add a token gets the same
 * treatment as one created with it.
 */
async function storeEnvSecrets(
  server: string,
  env: Record<string, string> | undefined
): Promise<{ env: Record<string, string>; envSecrets: Record<string, string>; stored: string[] }> {
  const plain: Record<string, string> = {};
  const envSecrets: Record<string, string> = {};
  const stored: string[] = [];

  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || !value.trim()) continue;

    if (!SECRET_ENV_NAME.test(name)) {
      plain[name] = value;
      continue;
    }

    const key = customEnvSecretKey(server, name);
    await setSecret(key, value.trim());
    envSecrets[name] = key;
    stored.push(name);
  }

  return { env: plain, envSecrets, stored };
}

/**
 * One-time repair for servers added before env secrets were split out: anything
 * token-shaped still sitting in config.json is moved to the Keychain and erased
 * from the file. Runs at startup, and is a no-op once there is nothing to move.
 */
export async function migrateCustomServerEnvSecrets(): Promise<void> {
  const config = loadConfig();
  const servers = config.customServers ?? {};
  const next: Record<string, CustomServerConfig> = {};
  const moved: string[] = [];

  for (const [name, custom] of Object.entries(servers)) {
    const exposed = Object.keys(custom.env ?? {}).filter((key) => SECRET_ENV_NAME.test(key));
    if (custom.transport !== "stdio" || exposed.length === 0) {
      next[name] = custom;
      continue;
    }

    const { env, envSecrets, stored } = await storeEnvSecrets(name, custom.env);
    next[name] = {
      ...custom,
      env: Object.keys(env).length > 0 ? env : undefined,
      envSecrets: { ...(custom.envSecrets ?? {}), ...envSecrets },
    };
    moved.push(...stored.map((key) => `${name}.${key}`));
  }

  if (moved.length === 0) return;

  saveConfig({ customServers: next });
  console.log(
    `🔐 Moved ${moved.length} credential(s) out of config.json into the Keychain: ${moved.join(", ")}.`
  );
}

export function getServerDefinition(name: string): McpServerDefinition | undefined {
  return getServerDefinitions().find((d) => d.name === name);
}

/** Current read-only state for a server: user preference, else its default. */
export function isReadOnly(name: string, config = loadConfig()): boolean {
  const definition = getServerDefinition(name);
  if (!definition?.supportsReadOnly) return false;

  const preference = config.mcpReadOnly?.[name];
  return typeof preference === "boolean" ? preference : definition.readOnlyByDefault;
}

/**
 * (Re)start a server with the given read-only mode and persist the preference.
 * Throws when prerequisites are missing, so the caller can report why.
 */
export async function setServerReadOnly(name: string, readOnly: boolean): Promise<void> {
  const definition = getServerDefinition(name);
  if (!definition) throw new Error(`Unknown MCP server: ${name}`);
  if (!definition.supportsReadOnly) {
    throw new Error(`${name} does not support a read-only mode.`);
  }

  const config = loadConfig();
  const blocked = definition.unavailableReason(config);
  if (blocked) throw new Error(blocked);

  // Only persist a DELIBERATE choice. Reconnect paths call this with the current
  // effective mode just to restart a server, and writing that back turned the
  // then-current default into a stored preference — which later silently defeated
  // the change of default. Saving nothing when it matches the default keeps the
  // config a record of decisions, not of history.
  const next = { ...(config.mcpReadOnly ?? {}) };
  if (readOnly === definition.readOnlyByDefault) delete next[name];
  else next[name] = readOnly;
  saveConfig({ mcpReadOnly: next });

  // Mode is an argv flag, so switching means respawning the subprocess.
  await mcpManager.registerServer(name, definition.build(loadConfig(), readOnly));

  if (!mcpManager.getConnectedServers().includes(name)) {
    throw new Error(
      `${name} failed to restart in ${readOnly ? "read-only" : "read-write"} mode. ` +
        `Check the terminal running \`assistant\`.`
    );
  }
}

/**
 * Re-spawn one server and re-read its tool list.
 *
 * A server's tools are captured once, at connect. That is fine for a server
 * whose capabilities are fixed, and wrong for Unity: `unity mcp` connects
 * happily with no Editor running and advertises zero tools, so starting Cullus
 * before opening the project leaves a server that reports "connected" for the
 * rest of the session while offering nothing. The symptom is a tool list with
 * two Unity entries in it — the local pair — and 149 missing.
 *
 * Reconnecting is the whole fix, and it is cheap enough to be a button.
 */
export async function reconnectServer(name: string): Promise<{ tools: number; reason?: string }> {
  const definition = getServerDefinition(name);
  if (!definition) throw new Error(`Unknown MCP server: ${name}`);

  const config = loadConfig();
  const blocked = definition.unavailableReason(config);
  if (blocked) throw new Error(blocked);

  await mcpManager.registerServer(name, definition.build(config, isReadOnly(name, config)));

  if (!mcpManager.getConnectedServers().includes(name)) {
    throw new Error(`${name} did not come back up. Check the terminal running \`assistant\`.`);
  }

  let tools = 0;
  for (const server of mcpManager.getToolServerMap().values()) if (server === name) tools++;

  // Came back up and still offers nothing. For Unity that is not a failure of
  // the reconnect — it is a report that no Editor is answering — and the CLI
  // knows exactly why. Say so, instead of leaving the user to guess.
  if (tools === 0 && name === "unity") {
    return { tools, reason: unityCatalogueReason() ?? undefined };
  }

  return { tools };
}

/** How many tools the named server is currently contributing. */
function toolCountFor(name: string): number {
  let count = 0;
  for (const server of mcpManager.getToolServerMap().values()) if (server === name) count++;
  return count;
}

/**
 * Is a Pipeline server answering right now?
 *
 * `unity pipeline list --json` is the same probe /doctor uses. Deliberately
 * async (`execFile`, not `execFileSync`): this runs on a timer inside the web
 * server, and the synchronous variant would stall every open session for the
 * duration of the call.
 *
 * The port file under <project>/Library/Pipeline would be cheaper still, but it
 * contains an eval token, and a background poller that reads a credential it has
 * no use for is not a trade worth making for a few milliseconds.
 */
function unityEditorReachable(): Promise<boolean> {
  const cli = unityCliPath();
  if (!cli) return Promise.resolve(false);

  return new Promise((resolve) => {
    execFile(
      cli,
      ["pipeline", "list", "--json"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        // A non-zero exit still prints usable JSON, so read stdout either way.
        if (error && !stdout) return resolve(false);
        try {
          const data = JSON.parse(stdout)?.data;
          const rows = Array.isArray(data) ? data : (data?.instances ?? []);
          resolve(rows.some((r: any) => r?.isRunning && r?.pipelineServer?.isReachable));
        } catch {
          resolve(false);
        }
      }
    );
  });
}

let unityWatchTimer: NodeJS.Timeout | null = null;
let unityWatchBusy = false;

/**
 * Pick up a Unity Editor that opened after we did.
 *
 * The tool list is captured once, at connect, and `unity mcp` advertises zero
 * tools when no Editor is answering — and it does NOT declare the
 * `tools.listChanged` capability (verified against 1.0.0-beta.5: its
 * `initialize` reply is `{"tools":{}}`), so it will never tell us they arrived.
 * Starting Cullus before opening the project therefore left the server reporting
 * "connected" with nothing behind it for the rest of the session.
 *
 * That is not a cosmetic gap. Measured: with the Editor open but its 149 tools
 * unread, a model asked to inspect a scene fell back to `grep`-ing the YAML —
 * fifteen shell calls and 203% of the context window to answer what
 * `get_scene_hierarchy` and `get_component_properties` return in one, because
 * they were not in the list it was handed.
 *
 * The reconnect button fixes it, but only for someone who already knows all of
 * the above. So: poll, and only in the state that is actually broken —
 * connected AND contributing nothing. A healthy Unity connection costs nothing
 * here, and a machine with no Editor pays one short subprocess per interval.
 */
export function watchForUnityEditor(intervalMs = 30_000): void {
  if (unityWatchTimer) return;

  unityWatchTimer = setInterval(() => {
    void (async () => {
      // Overlapping ticks would stack subprocesses on a slow probe.
      if (unityWatchBusy) return;
      if (!mcpManager.getConnectedServers().includes("unity")) return;
      if (toolCountFor("unity") > 0) return;

      unityWatchBusy = true;
      try {
        if (!(await unityEditorReachable())) return;

        const { tools } = await reconnectServer("unity");
        if (tools > 0) {
          console.log(`🔌 Unity Editor detected — reconnected, ${tools} tools now available.`);
        }
      } catch (err: any) {
        // A failed probe is not worth interrupting anyone over; the next tick
        // tries again and the reconnect button still works.
        console.warn(`⚠️  Unity auto-reconnect failed: ${err?.message ?? err}`);
      } finally {
        unityWatchBusy = false;
      }
    })();
  }, intervalMs);

  // Never hold the process open for this.
  unityWatchTimer.unref?.();
}

/**
 * Re-spawn the filesystem server after the granted directory list changes.
 *
 * Goes through the registry rather than building argv locally, so the read-only
 * mode is applied on every refresh. Building it by hand elsewhere silently
 * dropped the read-only flag.
 */
export async function refreshFilesystemServer(): Promise<void> {
  const definition = getServerDefinition("filesystem")!;
  const config = loadConfig();

  if (definition.unavailableReason(config)) {
    await mcpManager.unregisterServer("filesystem");
    return;
  }

  await mcpManager.registerServer(
    "filesystem",
    definition.build(config, isReadOnly("filesystem", config))
  );
}

/** Start every server whose prerequisites are met. Never throws. */
export async function registerConfiguredServers(): Promise<void> {
  const config = loadConfig();

  for (const definition of getServerDefinitions(config)) {
    const blocked = definition.unavailableReason(config);

    if (blocked) {
      console.log(`ℹ️  MCP "${definition.name}" not started — ${blocked}`);
      continue;
    }

    const readOnly = isReadOnly(definition.name, config);

    try {
      await mcpManager.registerServer(definition.name, definition.build(config, readOnly));
      const mode = definition.supportsReadOnly
        ? readOnly
          ? " (read-only)"
          : " (read-write)"
        : "";
      console.log(`🔌 MCP "${definition.name}" started${mode}.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to start MCP "${definition.name}": ${err.message}`);
    }
  }
}

/**
 * Add or update a user server, then connect it. Returns why it could not be
 * saved, or the state after connecting — Add means added, not "restart to see it".
 */
export async function saveCustomServer(
  input: CustomServerInput
): Promise<{ ok: boolean; message: string; errors?: string[]; name?: string }> {
  const validated = validateCustomServer(input);
  if (!validated.ok) {
    return { ok: false, message: "That server could not be saved.", errors: validated.errors };
  }

  const { name, config } = validated;

  // A token goes to the Keychain, never into config.json.
  if (input.token?.trim()) {
    const key = customTokenKey(name);
    await setSecret(key, input.token.trim());
    config.tokenSecret = key;
  } else if (input.tokenSecret) {
    config.tokenSecret = input.tokenSecret;
  }

  // Same rule for anything token-shaped in a stdio server's environment: the
  // name stays in config.json, the value goes to the Keychain.
  if (config.transport === "stdio") {
    const existing = loadConfig().customServers?.[name];
    const { env, envSecrets } = await storeEnvSecrets(name, config.env);
    config.env = Object.keys(env).length > 0 ? env : undefined;

    // Keep references for variables this save did not mention, so editing the
    // command does not silently drop a token entered earlier.
    const inherited = Object.fromEntries(
      Object.entries(existing?.envSecrets ?? {}).filter(([key]) => !(key in env)),
    );
    const merged = { ...inherited, ...envSecrets };
    config.envSecrets = Object.keys(merged).length > 0 ? merged : undefined;
  }

  const current = loadConfig();
  saveConfig({ customServers: { ...(current.customServers ?? {}), [name]: config } });

  const definition = getServerDefinition(name);
  const blocked = definition?.unavailableReason(loadConfig());
  if (blocked) return { ok: true, name, message: `Saved, but not started: ${blocked}` };

  try {
    await setServerReadOnly(name, isReadOnly(name));
    return { ok: true, name, message: `${name} connected.` };
  } catch (err: any) {
    // Prefer the transport's own error over the generic restart failure: "Invalid
    // or expired token" is actionable, "failed to restart" is not.
    const cause = mcpManager.getLastError(name) ?? err.message;
    return { ok: true, name, message: `Saved, but ${name} could not connect: ${cause}` };
  }
}

/** Disconnect and forget a user server. Built-ins are refused. */
export async function removeCustomServer(
  name: string
): Promise<{ ok: boolean; message: string }> {
  const config = loadConfig();
  if (!isCustomServer(name, config)) {
    return { ok: false, message: `"${name}" is not a user-added server.` };
  }

  // forget, not just unregister: a deleted server must stop being listed at all.
  await mcpManager.forgetServer(name);

  const remaining = { ...(config.customServers ?? {}) };
  delete remaining[name];

  const modes = { ...(config.mcpReadOnly ?? {}) };
  delete modes[name];

  // Removing the server removes its credentials: leaving orphaned Keychain
  // entries behind for a server nobody can see is worse than a slow delete.
  const entry = config.customServers?.[name];
  for (const key of [entry?.tokenSecret, ...Object.values(entry?.envSecrets ?? {})]) {
    if (key) await deleteSecret(key);
  }

  saveConfig({ customServers: remaining, mcpReadOnly: modes });
  return { ok: true, message: `${name} removed.` };
}

/**
 * Servers configured for the Claude Code CLI that are not registered here yet.
 *
 * Importing beats retyping: these entries are known-good on this machine, which is
 * how the Obsidian token and the GitHub binary were already picked up.
 */
export function discoverImportableServers(): Array<{
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  hasToken: boolean;
}> {
  const known = new Set(getServerDefinitions().map((d) => d.name));
  return listClaudeCliMcpServers()
    .filter((server) => !known.has(server.name))
    .map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      hasToken: server.hasToken,
    }));
}

/** Server status enriched with mode info, for the UI. */
export function getServersWithMode() {
  const config = loadConfig();
  const connected = mcpManager.getConnectedServers();
  const statuses = mcpManager.getServersStatus();
  const seen = new Set(statuses.map((s) => s.name));

  const rows = statuses.map((status) => {
    const definition = getServerDefinition(status.name);
    return {
      name: status.name,
      connected: status.connected,
      description: definition?.description ?? "",
      supportsReadOnly: definition?.supportsReadOnly ?? false,
      readOnly: isReadOnly(status.name, config),
      unavailableReason: definition?.unavailableReason(config) ?? null,
      custom: isCustomServer(status.name, config),
      lastError: status.connected ? null : mcpManager.getLastError(status.name),
    };
  });

  // Surface known-but-not-started servers so the UI can explain the gap.
  for (const definition of getServerDefinitions(config)) {
    if (seen.has(definition.name)) continue;
    rows.push({
      name: definition.name,
      connected: connected.includes(definition.name),
      description: definition.description,
      supportsReadOnly: definition.supportsReadOnly,
      readOnly: isReadOnly(definition.name, config),
      unavailableReason: definition.unavailableReason(config),
      custom: isCustomServer(definition.name, config),
      lastError: mcpManager.getLastError(definition.name),
    });
  }

  return rows;
}
