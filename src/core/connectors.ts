// Connectors: one declarative description of everything that can be "connected".
//
// The Settings → Connections table (Connector | Type | Status) renders straight
// from this list, and the Connect form is generated from each connector's fields.
// The point is that adding a connector means adding an entry here — not touching
// the UI, the secrets layer and the MCP registry separately and hoping they agree.
//
// Secret-typed fields go through core/secrets.ts (Keychain, else 0600 file) and
// are never returned to the browser. Plain fields land in config.connections,
// which is safe to serialise.

import { loadConfig, saveConfig } from "./config.js";
import {
  deleteSecret,
  describeSecretLocation,
  getSecret,
  getSecretStatus,
  setSecret,
  type SecretStatus,
} from "./secrets.js";
import {
  getServersWithMode,
  reconnectServer,
  getServerDefinitions,
  isCustomServer,
  customTokenKey,
} from "./mcpServers.js";

export type ConnectorType = "Database" | "Web" | "Local";

export interface ConnectorField {
  key: string;
  label: string;
  placeholder?: string;
  /** Stored via secrets.ts and never read back to the browser. */
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  type: ConnectorType;
  /** Where to get the credential, shown under the form. */
  where?: string;
  /** MCP server this connector configures, when it has one. */
  server?: string;
  fields: ConnectorField[];
}

export const CONNECTORS: ConnectorDefinition[] = [
  {
    id: "obsidian",
    name: "Obsidian Vault",
    type: "Database",
    server: "obsidian-live",
    where: "Obsidian → Settings → Local REST API with MCP",
    fields: [
      {
        key: "baseUrl",
        label: "HTTPS address",
        placeholder: "https://127.0.0.1:27124",
        help: "The plugin's local HTTPS endpoint. The /mcp/ path is added automatically.",
      },
      { key: "OBSIDIAN_API_KEY", label: "API token", secret: true, required: true },
      {
        key: "vaultPath",
        label: "Vault folder (optional)",
        placeholder: "/path/to/vault",
        help: "Only used by the read-only guard, to recognise writes aimed at your notes.",
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    type: "Web",
    server: "github",
    where: "github.com → Settings → Developer settings → Personal access tokens",
    fields: [
      { key: "GITHUB_TOKEN", label: "Personal access token", secret: true, required: true },
      { key: "email", label: "Email (optional)", placeholder: "you@example.com" },
      {
        key: "command",
        label: "Server command (optional)",
        placeholder: "npx -y @modelcontextprotocol/server-github",
        help: "Leave blank to reuse whatever GitHub MCP server the Claude CLI is already configured with.",
      },
    ],
  },
  {
    id: "brave",
    name: "Brave Search",
    type: "Web",
    where: "api-dashboard.search.brave.com",
    fields: [{ key: "BRAVE_SEARCH_API_KEY", label: "API token", secret: true, required: true }],
  },
  {
    id: "tavily",
    name: "Tavily",
    type: "Web",
    where: "app.tavily.com",
    fields: [{ key: "TAVILY_API_KEY", label: "API token", secret: true, required: true }],
  },
  {
    id: "etsy",
    name: "Etsy",
    type: "Web",
    server: "etsy",
    where: "etsy.com/developers → your app, for the keystring and shared secret",
    fields: [
      {
        key: "serverPath",
        label: "Server entry point",
        placeholder: "/path/to/etsy-mcp-server/build/index.js",
        required: true,
        help:
          "Etsy has no official MCP server, so this points at a built one on your machine — " +
          "the .js file you would pass to `node`. Overridden by ETSY_MCP_SERVER_PATH.",
      },
      { key: "ETSY_API_KEY", label: "API keystring", secret: true, required: true },
      {
        key: "ETSY_CLIENT_SECRET",
        label: "Shared secret",
        secret: true,
        help: "Also accepted as ETSY_SHARED_SECRET. Only needed for authenticated endpoints.",
      },
    ],
  },
  {
    id: "oanda",
    name: "OANDA",
    type: "Web",
    server: "oanda-trading",
    where: "OANDA web portal → Manage API Access, for the token; your account page for the ID",
    fields: [
      { key: "OANDA_API_TOKEN", label: "API token", secret: true, required: true },
      {
        key: "accountID",
        label: "Account ID",
        placeholder: "001-004-1234567-001",
        required: true,
        help: "Shown on your OANDA account page. Practice and live accounts have different IDs.",
      },
      {
        key: "environment",
        label: "Environment",
        placeholder: "practice",
        help:
          "`practice` (default) or `live`. Anything other than the exact word `live` is treated " +
          "as practice, so a typo cannot point this at real money.",
      },
      {
        key: "paramsPath",
        label: "Shared parameter file (optional)",
        placeholder: "~/.cullus/oanda-bot.json",
        help:
          "The strategy parameters the OandaVisualBot app reads each cycle. Leave blank for the " +
          "default; set it only if the app runs with OANDA_BOT_PARAMS_PATH pointing elsewhere.",
      },
    ],
  },
  {
    id: "filesystem",
    name: "Filesystem",
    type: "Local",
    server: "filesystem",
    where: "Directories the model may read, and write to when set to read-write",
    fields: [],
  },
];

export interface ConnectorStatus {
  id: string;
  name: string;
  type: ConnectorType;
  where?: string;
  server?: string;
  /** connected | configured | not-configured | unavailable */
  state: "connected" | "configured" | "not-configured" | "unavailable";
  detail: string;
  /** Field metadata plus, for secrets, presence and a masked preview only. */
  fields: Array<
    ConnectorField & {
      present?: boolean;
      preview?: string | null;
      source?: string;
      value?: string;
      /** Where this credential is (or would be) kept, and how to verify it. */
      storage?: { label: string; command: string | null; encrypted: boolean };
      /** False for env-provided values, which this app must not overwrite. */
      removable?: boolean;
    }
  >;
  readOnly?: boolean;
  supportsReadOnly?: boolean;
  /** User-added, so it can be removed. */
  custom?: boolean;
}

/**
 * Every user-added MCP server as a connector row, so anything added from the UI
 * appears in the same table as the shipped integrations.
 */
function customConnectors(): ConnectorDefinition[] {
  const config = loadConfig();

  return Object.entries(config.customServers ?? {}).map(([name, custom]) => {
    // Credentials are editable from here, so Connections is the one place any
    // token is entered. Structure — command, args, URL — still belongs to the
    // Add form, which is the thing that knows about transports.
    const fields: ConnectorField[] = [];

    if (custom.transport === "http") {
      fields.push({
        key: custom.tokenSecret ?? customTokenKey(name),
        label: "Bearer token",
        secret: true,
        help: "Sent as an Authorization header. Leave blank if the endpoint needs no token.",
      });
    } else {
      for (const [envName, secretKey] of Object.entries(custom.envSecrets ?? {})) {
        fields.push({
          key: secretKey,
          label: envName,
          secret: true,
          required: true,
          help: `Passed to the server process as ${envName}.`,
        });
      }
    }

    return {
      id: `server:${name}`,
      name: custom.label || name,
      type: custom.type ?? (custom.transport === "http" ? "Web" : "Local"),
      server: name,
      where:
        custom.transport === "http"
          ? `${custom.url} — added by you`
          : `${[custom.command, ...(custom.args ?? [])].join(" ")} — added by you`,
      fields,
    };
  });
}

/** Everything the Connections tab needs, with no secret values in it. */
export function describeConnectors(): ConnectorStatus[] {
  const config = loadConfig();
  const servers = getServersWithMode();

  return [...CONNECTORS, ...customConnectors()].map((connector) => {
    const server = connector.server ? servers.find((s) => s.name === connector.server) : undefined;
    const stored = config.connections?.[connector.id] ?? {};

    const fields = connector.fields.map((field) => {
      if (field.secret) {
        const status: SecretStatus = getSecretStatus(field.key);
        return {
          ...field,
          present: status.present,
          preview: status.preview,
          source: status.source,
          storage: describeSecretLocation(field.key, status.source),
          // env vars belong to the shell, and ~/.claude.json to the Claude CLI:
          // this app can show them but has no business deleting either.
          removable:
            status.present && status.source !== "env" && status.source !== "claude-cli",
        };
      }
      // The vault path predates config.connections, so read it from its own home.
      const value =
        field.key === "vaultPath" ? config.vaultPath ?? "" : stored[field.key] ?? "";
      return { ...field, value };
    });

    const requiredSecretsPresent = connector.fields
      .filter((f) => f.secret && f.required)
      .every((f) => Boolean(getSecret(f.key)));

    let state: ConnectorStatus["state"];
    let detail: string;

    if (server) {
      if (server.connected) {
        state = "connected";
        detail = server.readOnly ? "Connected (read-only)" : "Connected (read-write)";
      } else if (server.unavailableReason) {
        state = requiredSecretsPresent ? "unavailable" : "not-configured";
        detail = server.unavailableReason;
      } else if (server.lastError) {
        state = "unavailable";
        detail = server.lastError;
      } else {
        state = "configured";
        detail = "Configured, not connected yet.";
      }
    } else {
      state = requiredSecretsPresent ? "configured" : "not-configured";
      detail = requiredSecretsPresent ? "Token stored" : "No token stored";
    }

    return {
      id: connector.id,
      name: connector.name,
      type: connector.type,
      where: connector.where,
      server: connector.server,
      state,
      detail,
      fields,
      readOnly: server?.readOnly,
      supportsReadOnly: server?.supportsReadOnly,
      custom: connector.server ? isCustomServer(connector.server, config) : false,
    };
  });
}

export interface SaveResult {
  ok: boolean;
  message: string;
  /** Where each secret landed, for the confirmation line. */
  stored?: string[];
}

/**
 * Apply a Connect form. Secrets go to the Keychain; everything else to config.
 * The connector's MCP server is then restarted so the change takes effect without
 * a restart of the whole app.
 */
export async function saveConnector(
  id: string,
  values: Record<string, unknown>
): Promise<SaveResult> {
  const connector = [...CONNECTORS, ...customConnectors()].find((c) => c.id === id);
  if (!connector) return { ok: false, message: `Unknown connector "${id}".` };

  const stored: string[] = [];
  const plain: Record<string, string> = { ...(loadConfig().connections?.[id] ?? {}) };

  for (const field of connector.fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === null) continue;

    const value = String(raw).trim();

    if (field.secret) {
      // An empty box means "leave the existing token alone", not "delete it" —
      // the form never shows the current value, so blank is the normal state.
      if (!value) continue;

      const status = getSecretStatus(field.key);
      if (status.source === "env") {
        return {
          ok: false,
          message: `${field.label} is set by an environment variable, which takes precedence. Unset it in your shell first.`,
        };
      }

      const where = await setSecret(field.key, value);
      stored.push(`${field.label} → ${describeSecretLocation(field.key, where).label}`);

      // A token typed against a user-added HTTP server needs the reference
      // recorded, or the server has no idea a token exists.
      if (id.startsWith("server:") && field.key === customTokenKey(id.slice(7))) {
        const servers = loadConfig().customServers ?? {};
        const entry = servers[id.slice(7)];
        if (entry && entry.tokenSecret !== field.key) {
          saveConfig({
            customServers: { ...servers, [id.slice(7)]: { ...entry, tokenSecret: field.key } },
          });
        }
      }
      continue;
    }

    if (field.key === "vaultPath") {
      saveConfig({ vaultPath: value || null });
      continue;
    }

    if (value) plain[field.key] = value;
    else delete plain[field.key];
  }

  saveConfig({ connections: { ...(loadConfig().connections ?? {}), [id]: plain } });

  // Restart the dependent server so Connect means connected, not "connected next
  // time you restart".
  let serverNote = "";
  if (connector.server) {
    const definition = getServerDefinitions().find((d) => d.name === connector.server);
    const blocked = definition?.unavailableReason(loadConfig());

    if (blocked) {
      serverNote = ` ${connector.server} still cannot start: ${blocked}`;
    } else {
      try {
        // reconnectServer, not setServerReadOnly: this is a restart, not a mode
        // change. setServerReadOnly refuses any server that has no read-only mode
        // to set — which made Connect fail on Etsy with "etsy does not support a
        // read-only mode" before it ever tried to spawn the process.
        await reconnectServer(connector.server);
        serverNote = ` ${connector.server} reconnected.`;
      } catch (err: any) {
        serverNote = ` ${connector.server} failed to start: ${err.message}`;
      }
    }
  }

  return {
    ok: true,
    message: `${connector.name} saved.${stored.length ? ` ${stored.join("; ")}.` : ""}${serverNote}`,
    stored,
  };
}

/**
 * Forget one credential belonging to a connector, and restart its server so the
 * change is real rather than pending. Refuses keys the connector does not
 * declare, so this cannot be used to delete arbitrary secrets.
 */
export async function removeConnectorSecret(
  id: string,
  key: string
): Promise<SaveResult> {
  const connector = [...CONNECTORS, ...customConnectors()].find((c) => c.id === id);
  if (!connector) return { ok: false, message: `Unknown connector "${id}".` };

  const field = connector.fields.find((f) => f.key === key && f.secret);
  if (!field) return { ok: false, message: `"${key}" is not a credential of ${connector.name}.` };

  const status = getSecretStatus(key);
  if (status.source === "env") {
    return {
      ok: false,
      message: `${field.label} comes from an environment variable. Unset it in your shell instead.`,
    };
  }
  if (status.source === "claude-cli") {
    return {
      ok: false,
      message: `${field.label} comes from ~/.claude.json, which belongs to the Claude CLI. Remove it there.`,
    };
  }

  await deleteSecret(key);

  let serverNote = "";
  if (connector.server) {
    const definition = getServerDefinitions().find((d) => d.name === connector.server);
    const blocked = definition?.unavailableReason(loadConfig());
    if (blocked) {
      serverNote = ` ${connector.server} is now unavailable: ${blocked}`;
    } else {
      try {
        await reconnectServer(connector.server);
        serverNote = ` ${connector.server} restarted.`;
      } catch (err: any) {
        serverNote = ` ${connector.server} failed to restart: ${err.message}`;
      }
    }
  }

  return { ok: true, message: `${field.label} removed from ${connector.name}.${serverNote}` };
}
