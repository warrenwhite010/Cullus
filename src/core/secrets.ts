// Secret storage.
//
// API tokens are never written to ~/.cullus/config.json, never returned by any
// HTTP endpoint, never sent to the browser, and never included in debug traces.
// Only booleans about their presence cross those boundaries.
//
// Resolution order, most to least preferred:
//
//   1. Environment variable   — nothing at rest; best for CI and one-off runs.
//   2. macOS Keychain         — encrypted at rest, unlocked with the login
//                               keychain, and readable via `security(1)` without
//                               ever passing the value on a command line.
//   3. ~/.cullus/secrets.json with mode 0600 — fallback for non-macOS. Plain
//                               text, so we warn once when it is used.
//   4. ~/.claude.json           — read-only discovery of tokens already
//                               configured for the Claude Code CLI's MCP
//                               servers, so a working `claude` setup needs no
//                               second copy of the same token. Never written.
//
// Writing to the Keychain uses `-w` on the argv of a short-lived `security`
// process. That is visible to `ps` for the lifetime of that call, which is the
// standard tradeoff for the tool; reads never expose the value that way.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";

const run = promisify(execFile);

const SECRETS_PATH = path.join(CONFIG_DIR, "secrets.json");
const KEYCHAIN_SERVICE = "cullus";

/** Where the Claude Code CLI keeps its MCP server definitions. */
const CLAUDE_CLI_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

export type SecretSource = "env" | "keychain" | "file" | "claude-cli" | "absent";

export interface SecretStatus {
  key: string;
  present: boolean;
  source: SecretSource;
  /** Safe to show a human: never the value itself. */
  preview: string | null;
}

/**
 * Environment variable names consulted for a given logical secret, in order.
 *
 * A list rather than one name because the same token travels under different
 * names in the wild: the GitHub MCP server wants GITHUB_PERSONAL_ACCESS_TOKEN,
 * while almost every shell profile and CI system exports GITHUB_TOKEN. Accepting
 * both is the difference between "already works" and "why is it not connected".
 */
const ENV_NAMES: Record<string, string[]> = {
  OBSIDIAN_API_KEY: ["OBSIDIAN_API_KEY"],
  BRAVE_SEARCH_API_KEY: ["BRAVE_SEARCH_API_KEY"],
  TAVILY_API_KEY: ["TAVILY_API_KEY"],
  GITHUB_TOKEN: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
  ETSY_API_KEY: ["ETSY_API_KEY"],
  // Etsy's own docs call this the shared secret; the MCP server reads it as the
  // client secret. Accept both so an existing export works either way.
  ETSY_CLIENT_SECRET: ["ETSY_SHARED_SECRET", "ETSY_CLIENT_SECRET"],
  // The Swift OandaVisualBot app reads these exact names from the environment,
  // so a shell that already runs the bot needs no extra setup here.
  OANDA_API_TOKEN: ["OANDA_API_TOKEN", "OANDA_TOKEN"],
  OANDA_ACCOUNT_ID: ["OANDA_ACCOUNT_ID", "OANDA_ACCOUNT"],
};

/** Every env/config name a logical secret may hide behind. */
function envNamesFor(key: string): string[] {
  return ENV_NAMES[key] ?? [key];
}

const isMac = process.platform === "darwin";
let warnedAboutPlaintext = false;

/**
 * A non-reversible hint that a human can compare against what they pasted,
 * e.g. `••••7f3a` — enough to confirm identity, useless if leaked.
 */
function preview(value: string): string {
  const tail = value.slice(-4);
  return `${"•".repeat(Math.max(4, Math.min(12, value.length - 4)))}${tail}`;
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

function keychainGet(key: string): string | null {
  if (!isMac) return null;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    );
    const trimmed = value.replace(/\n$/, "");
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Exit code 44 = not found. Anything else (locked keychain, no `security`)
    // is treated the same: fall through to the next source.
    return null;
  }
}

async function keychainSet(key: string, value: string): Promise<void> {
  await run(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", key, "-w", value],
    { timeout: 15_000 }
  );
}

async function keychainDelete(key: string): Promise<void> {
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key], {
      timeout: 10_000,
    });
  } catch {
    /* already absent */
  }
}

// ---------------------------------------------------------------------------
// 0600 file fallback
// ---------------------------------------------------------------------------

function readSecretsFile(): Record<string, string> {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  try {
    const stat = fs.statSync(SECRETS_PATH);
    // eslint-disable-next-line no-bitwise
    if ((stat.mode & 0o077) !== 0) {
      console.warn(
        `⚠️  ${SECRETS_PATH} is readable by other users. Fixing permissions to 0600.`
      );
      fs.chmodSync(SECRETS_PATH, 0o600);
    }
    const parsed = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSecretsFile(secrets: Record<string, string>): void {
  ensureConfigDir();
  // Create with 0600 from the outset rather than chmod-ing after the write,
  // which would leave a window where the file is world-readable.
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_PATH, 0o600);

  if (!warnedAboutPlaintext) {
    warnedAboutPlaintext = true;
    console.warn(
      `⚠️  Stored a secret in plain text at ${SECRETS_PATH} (mode 0600). ` +
        `${isMac ? "The Keychain was unavailable." : "Keychain storage is macOS-only."}`
    );
  }
}

// ---------------------------------------------------------------------------
// Claude Code CLI config (read-only discovery)
//
// The CLI stores MCP server definitions — including the Obsidian Local REST API
// token — in ~/.claude.json. Reading it means a vault already wired up for
// `claude` works here with no second copy of the token to paste or keep in sync.
// This source is never written to: it is consulted last, so anything stored in
// the Keychain, a 0600 file, or the environment still wins.
// ---------------------------------------------------------------------------

/**
 * Every `env` block from every MCP server the Claude CLI knows about: the
 * top-level `mcpServers`, plus each per-project `mcpServers`.
 */
function claudeCliMcpEnvs(): Array<Record<string, unknown>> {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(CLAUDE_CLI_CONFIG_PATH, "utf-8"));
  } catch {
    // Absent, unreadable or malformed: discovery is best-effort by design.
    return [];
  }

  const maps: any[] = [parsed?.mcpServers];
  for (const project of Object.values(parsed?.projects ?? {})) {
    maps.push((project as any)?.mcpServers);
  }

  const envs: Array<Record<string, unknown>> = [];
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const server of Object.values(map)) {
      const env = (server as any)?.env;
      if (env && typeof env === "object") envs.push(env as Record<string, unknown>);
    }
  }
  return envs;
}

/**
 * Value of an environment variable as configured for any Claude CLI MCP server,
 * e.g. `OBSIDIAN_BASE_URL`. Returns null when no server defines it.
 *
 * Exported so non-secret settings (base URL) can follow the same config the
 * token came from, rather than being guessed independently.
 */
/**
 * The stdio command the Claude CLI uses for a server whose name contains any of
 * `nameFragments`. Lets Cullus reuse a binary that is already installed
 * and authenticated instead of guessing at an npm package.
 */
export function getClaudeCliMcpCommand(
  nameFragments: string[]
): { command: string; args: string[] } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(CLAUDE_CLI_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }

  const maps: any[] = [parsed?.mcpServers];
  for (const project of Object.values(parsed?.projects ?? {})) {
    maps.push((project as any)?.mcpServers);
  }

  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [name, server] of Object.entries<any>(map)) {
      const lower = name.toLowerCase();
      if (!nameFragments.some((fragment) => lower.includes(fragment))) continue;
      if (server?.type && server.type !== "stdio") continue;
      if (typeof server?.command !== "string" || !server.command) continue;
      return { command: server.command, args: Array.isArray(server.args) ? server.args : [] };
    }
  }

  return null;
}

export interface ClaudeCliServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Whether its env carries something token-shaped. */
  hasToken: boolean;
}

/** Every MCP server the Claude CLI knows about, for the Import list. */
export function listClaudeCliMcpServers(): ClaudeCliServer[] {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(CLAUDE_CLI_CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }

  const maps: any[] = [parsed?.mcpServers];
  for (const project of Object.values(parsed?.projects ?? {})) {
    maps.push((project as any)?.mcpServers);
  }

  const found = new Map<string, ClaudeCliServer>();

  for (const map of maps) {
    if (!map || typeof map !== "object") continue;

    for (const [name, server] of Object.entries<any>(map)) {
      if (found.has(name)) continue;

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(server?.env ?? {})) {
        if (typeof value === "string") env[key] = value;
      }

      const isHttp = server?.type === "http" || server?.type === "sse" || Boolean(server?.url);

      found.set(name, {
        name,
        transport: isHttp ? "http" : "stdio",
        command: typeof server?.command === "string" ? server.command : undefined,
        args: Array.isArray(server?.args) ? server.args.map(String) : undefined,
        url: typeof server?.url === "string" ? server.url : undefined,
        env,
        hasToken: Object.keys(env).some((key) => /TOKEN|KEY|SECRET|PASSWORD/i.test(key)),
      });
    }
  }

  return Array.from(found.values());
}

export function getClaudeCliMcpEnv(envName: string): string | null {
  for (const env of claudeCliMcpEnvs()) {
    const value = env[envName];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SecretLocation {
  /** One line a human can read: where this value lives, or would live. */
  label: string;
  /** Copy-pasteable command or path that proves it, when there is one. */
  command: string | null;
  /** True when this backend encrypts at rest. */
  encrypted: boolean;
}

/**
 * Where a secret is (or would be) stored, in terms a human can verify.
 *
 * The Connect form shows this *before* the token is typed, so "securely stored"
 * is a checkable claim rather than a promise: the reader gets the keychain
 * service and account name and the exact `security` invocation that reads it
 * back. `source` is optional so the same helper describes the prospective
 * destination of a value that has not been entered yet.
 */
export function describeSecretLocation(key: string, source?: SecretSource): SecretLocation {
  const destination: SecretSource =
    source && source !== "absent" ? source : isMac ? "keychain" : "file";

  switch (destination) {
    case "keychain":
      return {
        label: `macOS Keychain — service "${KEYCHAIN_SERVICE}", account "${key}"`,
        command: `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${key} -w`,
        encrypted: true,
      };
    case "env":
      return {
        label: `Environment variable ${envNamesFor(key).join(" / ")}, exported by your shell`,
        command: null,
        encrypted: false,
      };
    case "file":
      return { label: `${SECRETS_PATH} (plain text, mode 0600)`, command: SECRETS_PATH, encrypted: false };
    case "claude-cli":
      return {
        label: `${CLAUDE_CLI_CONFIG_PATH} — the Claude CLI's own MCP config, read only`,
        command: CLAUDE_CLI_CONFIG_PATH,
        encrypted: false,
      };
    default:
      return { label: "Not stored anywhere yet", command: null, encrypted: false };
  }
}

/** Resolve a secret's value. Returns null when unset. Never log the result. */
export function getSecret(key: string): string | null {
  const names = envNamesFor(key);

  for (const name of names) {
    const fromEnv = process.env[name];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }

  const fromKeychain = keychainGet(key);
  if (fromKeychain) return fromKeychain;

  const fromFile = readSecretsFile()[key];
  if (fromFile && fromFile.trim()) return fromFile.trim();

  for (const name of names) {
    const discovered = getClaudeCliMcpEnv(name);
    if (discovered) return discovered;
  }

  return null;
}

/** Where a secret is coming from, and a safe preview. Never the value. */
export function getSecretStatus(key: string): SecretStatus {
  const names = envNamesFor(key);

  for (const name of names) {
    const fromEnv = process.env[name];
    if (fromEnv && fromEnv.trim()) {
      return { key, present: true, source: "env", preview: preview(fromEnv.trim()) };
    }
  }

  const fromKeychain = keychainGet(key);
  if (fromKeychain) {
    return { key, present: true, source: "keychain", preview: preview(fromKeychain) };
  }

  const fromFile = readSecretsFile()[key];
  if (fromFile && fromFile.trim()) {
    return { key, present: true, source: "file", preview: preview(fromFile.trim()) };
  }

  for (const name of names) {
    const fromClaudeCli = getClaudeCliMcpEnv(name);
    if (fromClaudeCli) {
      return { key, present: true, source: "claude-cli", preview: preview(fromClaudeCli) };
    }
  }

  return { key, present: false, source: "absent", preview: null };
}

/** Store a secret, preferring the Keychain. Returns where it landed. */
export async function setSecret(key: string, value: string): Promise<SecretSource> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Refusing to store an empty secret.");

  if (isMac) {
    try {
      await keychainSet(key, trimmed);
      // Remove any earlier plaintext copy now that the Keychain holds it.
      const secrets = readSecretsFile();
      if (key in secrets) {
        delete secrets[key];
        writeSecretsFile(secrets);
      }
      return "keychain";
    } catch (err: any) {
      console.warn(`⚠️  Keychain write failed (${err.message}); falling back to file.`);
    }
  }

  const secrets = readSecretsFile();
  secrets[key] = trimmed;
  writeSecretsFile(secrets);
  return "file";
}

/** Remove a secret from every writable location. */
export async function deleteSecret(key: string): Promise<void> {
  if (isMac) await keychainDelete(key);

  const secrets = readSecretsFile();
  if (key in secrets) {
    delete secrets[key];
    writeSecretsFile(secrets);
  }
}

/**
 * Strip anything that looks like a stored secret from a value bound for logs,
 * debug traces, or the browser. Defence in depth: nothing should be passing
 * secrets here in the first place.
 */
export function redactSecrets(input: unknown): unknown {
  const values = Object.keys(ENV_NAMES)
    .map((key) => getSecret(key))
    .filter((v): v is string => Boolean(v) && v!.length >= 8);

  if (values.length === 0) return input;

  const scrub = (text: string) =>
    values.reduce((acc, secret) => acc.split(secret).join("«redacted»"), text);

  if (typeof input === "string") return scrub(input);

  try {
    return JSON.parse(scrub(JSON.stringify(input)));
  } catch {
    return input;
  }
}

export { SECRETS_PATH, KEYCHAIN_SERVICE };
