import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fetch as undiciFetch, Agent } from "undici";
import { localToolRegistry } from "./tools.js";
import { guardVaultWrite, areEditsAccepted, loadConfig } from "./config.js";
import { logActivity } from "./activity.js";
import { guardFileContent } from "./contentGuard.js";
import { guardVaultPath } from "./vaultPath.js";
import {
  UNITY_CODE_TOOLS,
  annotateCompileResult,
  annotatePlayModeRefusal,
  assetRefreshCall,
  attachNote,
  condenseUnityConsole,
  describeCodeTimeout,
  isTimeoutResult,
  isTransientUnityError,
  judgeFrameSamples,
  needsAssetRefresh,
  normaliseUnityTimeout,
} from "./unityRuntime.js";
import { annotateBlenderResult } from "./blenderRuntime.js";
import { divertImageContent } from "./imageResults.js";

interface ServerConfig {
  /** stdio (default): spawn a subprocess. http: Streamable HTTP endpoint. */
  transport?: "stdio" | "http";

  /** stdio only */
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  /** http only */
  url?: string;
  /**
   * Resolved lazily so a token is never held in the config object, never
   * serialised, and never reachable from a stored structure.
   */
  bearerToken?: () => string | null;
  /**
   * Accept a self-signed certificate. Only honoured for loopback URLs — the
   * Obsidian plugin serves HTTPS on 127.0.0.1 with its own cert.
   */
  allowSelfSignedLocalhost?: boolean;

  /**
   * The server has no read-only flag of its own, so read-only is enforced here
   * by withholding its mutating tools and refusing them at dispatch.
   */
  clientEnforcedReadOnly?: boolean;
  /**
   * Narrow a large server down to the tools worth paying for.
   *
   * Return false to withhold a tool entirely — it never reaches the model's
   * schema and is refused at dispatch, exactly like the read-only withholding
   * above. Added for Unity, whose 149 Editor commands cost ~25,000 tokens of
   * schema per turn against ~1,900 for every other server combined.
   *
   * Called for each tool on every schema build, so it must be cheap and
   * synchronous. Cache anything expensive in the definition that supplies it.
   */
  toolFilter?: (toolName: string) => boolean;
  /**
   * Who keeps the plain tool name when two servers offer the same one.
   * LOWER wins. Without this, ownership depended on registration order — and
   * that order differs between code paths, so `list_directory` could mean the
   * filesystem or the vault depending on how the app booted.
   */
  priority?: number;
}

/** Default priorities by server name; anything unlisted sorts last. */
const SERVER_PRIORITY: Record<string, number> = {
  filesystem: 10,
  "obsidian-live": 15,
  github: 25,
  etsy: 30,
};

function priorityOf(name: string, config?: ServerConfig): number {
  return config?.priority ?? SERVER_PRIORITY[name] ?? 50;
}

interface InternalTool {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => any;
}

export class MCPManager {
  private clients: Map<string, Client> = new Map();
  private internalTools: Map<string, InternalTool> = new Map();
  private allowedPaths: Set<string> = new Set();
  private configs: Map<string, ServerConfig> = new Map(); // Added to track configs for toggling

  /**
   * Why each server last failed to connect.
   *
   * Without this the reason lived only in the terminal, so the dashboard fell
   * back to "Configured but not connected — restart `cullus`", which is wrong
   * advice when the truth is "Invalid or expired token". Same class of problem as
   * a green dot next to an unauthenticated server.
   */
  private lastErrors: Map<string, string> = new Map();

  /** Why this server is not connected, when it tried and failed. */
  public getLastError(name: string): string | null {
    return this.lastErrors.get(name) ?? null;
  }

  /**
   * Every MCP tool the model can call, keyed by the name it is EXPOSED under.
   *
   * When two servers offer the same tool name, the second is exposed under a
   * server-prefixed alias (`obsidian_list_directory`) rather than being dropped.
   * Dropping it silently removed a real capability; aliasing keeps both reachable
   * and keeps names unique, which is what small models actually need.
   *
   * `actualName` is what we send back to the server, which knows nothing of the
   * alias.
   */
  private toolRoutes: Map<
    string,
    { client: Client; server: string; actualName: string; description: string; schema: any }
  > = new Map();

  /** Aliased tools: exposedName -> {original, server, shadowedBy}. */
  private aliases: Map<string, { original: string; server: string; shadowedBy: string }> =
    new Map();

  public registerInternalTool(tool: InternalTool) {
    this.internalTools.set(tool.name, tool);
  }

  public addAllowedPath(dirPath: string) {
    this.allowedPaths.add(dirPath);
  }

  public removeAllowedPath(dirPath: string) {
    this.allowedPaths.delete(dirPath);
  }

  public getAllowedPaths(): string[] {
    return Array.from(this.allowedPaths);
  }

  public async unregisterServer(name: string) {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch (e) {
        // Ignore close errors
      }
      this.clients.delete(name);

      for (const [exposedName, route] of this.toolRoutes.entries()) {
        if (route.server === name) this.toolRoutes.delete(exposedName);
      }
      for (const [exposedName, alias] of this.aliases.entries()) {
        // Drop this server's aliases, and any alias that only existed because
        // this server owned the primary name.
        if (alias.server === name || alias.shadowedBy === name) {
          this.aliases.delete(exposedName);
        }
      }
    }
  }

  public async registerServer(name: string, config: ServerConfig) {
    this.configs.set(name, config); // Store configuration for reconnection
    await this.unregisterServer(name);

    try {
      const transport =
        config.transport === "http"
          ? this.buildHttpTransport(name, config)
          : this.buildStdioTransport(config);

      const client = new Client(
        { name: `cullus-${name}`, version: "1.0.0" },
        { capabilities: {} }
      );

      await client.connect(transport);
      this.clients.set(name, client);
      this.lastErrors.delete(name);
      logActivity({ kind: "server", status: "ok", label: `${name} connected` });

      const myPriority = priorityOf(name, config);
      const toolsResult = await client.listTools();

      for (const tool of toolsResult.tools) {
        const incumbent = this.toolRoutes.get(tool.name);

        // No clash: take the plain name.
        if (!incumbent || incumbent.server === name) {
          this.setRoute(tool.name, {
            client,
            server: name,
            actualName: tool.name,
            description: tool.description ?? "",
            schema: tool.inputSchema,
          });
          continue;
        }

        // Clash: priority decides who holds the plain name, so the outcome is the
        // same regardless of which server connected first.
        const incumbentPriority = priorityOf(incumbent.server, this.configs.get(incumbent.server));

        if (myPriority < incumbentPriority) {
          // Newcomer outranks the incumbent: demote the incumbent to its alias.
          const incumbentAlias = `${incumbent.server}_${tool.name}`;
          if (!this.toolRoutes.has(incumbentAlias)) {
            this.setRoute(incumbentAlias, incumbent);
            this.aliases.set(incumbentAlias, {
              original: tool.name,
              server: incumbent.server,
              shadowedBy: name,
            });
          }
          this.aliases.delete(tool.name);

          this.setRoute(tool.name, {
            client,
            server: name,
            actualName: tool.name,
            description: tool.description ?? "",
            schema: tool.inputSchema,
          });

          console.log(
            `↔️  "${tool.name}" is offered by "${incumbent.server}" and "${name}". ` +
              `"${name}" takes the plain name; the other is available as "${incumbentAlias}".`
          );
          continue;
        }

        // Incumbent keeps the plain name; this one gets an alias.
        const alias = `${name}_${tool.name}`;
        if (this.toolRoutes.has(alias)) {
          console.warn(
            `⚠️  Skipping "${tool.name}" from "${name}": both it and "${alias}" are taken.`
          );
          continue;
        }

        this.setRoute(alias, {
          client,
          server: name,
          actualName: tool.name,
          description: tool.description ?? "",
          schema: tool.inputSchema,
        });
        this.aliases.set(alias, {
          original: tool.name,
          server: name,
          shadowedBy: incumbent.server,
        });

        console.log(
          `↔️  "${tool.name}" is offered by "${incumbent.server}" and "${name}". ` +
            `Available as "${alias}" so both remain callable.`
        );
      }
    } catch (error: any) {
      console.error(`Failed to connect to MCP server: ${name}`, error);
      // Node's fetch throws `TypeError: fetch failed` and puts the thing you
      // actually need — ECONNREFUSED, ENOTFOUND, a TLS failure — in `cause`.
      // Reporting only `message` told the user "fetch failed", which is true
      // and useless. Walk the cause chain so the reason names the port that
      // refused the connection.
      const causes: string[] = [];
      for (let e: any = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
        const part = String(e?.message ?? e).trim();
        if (part && !causes.includes(part)) causes.push(part);
      }
      const reason = causes.join(": ").slice(0, 400);
      this.lastErrors.set(name, reason);
      logActivity({ kind: "server", status: "fail", label: `${name} failed to connect`, summary: reason });
    }
  }

  private buildStdioTransport(config: ServerConfig) {
    if (!config.command) {
      throw new Error("stdio transport requires a `command`.");
    }

    const cleanEnv = config.env
      ? (Object.fromEntries(
          Object.entries({ ...process.env, ...config.env }).filter(([_, v]) => v !== undefined)
        ) as Record<string, string>)
      : undefined;

    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: cleanEnv,
    });
  }

  /**
   * Streamable HTTP transport, used by the Obsidian Local REST API plugin's
   * built-in MCP server.
   *
   * Two things are deliberate here:
   *
   *  - The bearer token is resolved per request via `config.bearerToken()`, so it
   *    is never stored on the config object, never serialised, and picks up a
   *    rotated token without a restart.
   *  - The self-signed certificate exception is applied through a dedicated
   *    undici Agent passed to this transport's own fetch. It does NOT touch the
   *    global agent, so nothing else in the process becomes willing to accept a
   *    bad certificate. It is also refused for anything that is not loopback.
   */
  private buildHttpTransport(name: string, config: ServerConfig) {
    if (!config.url) {
      throw new Error("http transport requires a `url`.");
    }

    const url = new URL(config.url);
    const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);

    if (config.allowSelfSignedLocalhost && !isLoopback) {
      throw new Error(
        `Refusing to accept a self-signed certificate for non-loopback host "${url.hostname}".`
      );
    }

    const agent =
      config.allowSelfSignedLocalhost && isLoopback
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;

    const scopedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const token = config.bearerToken?.() ?? null;
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      if (token) headers.set("Authorization", `Bearer ${token}`);

      const response = (await undiciFetch(input as any, {
        ...(init as any),
        headers,
        ...(agent ? { dispatcher: agent } : {}),
      })) as unknown as Response;

      // Remember the session the server assigned, for diagnostics and for the
      // session-recovery test to be able to target it.
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionIds.set(name, sessionId);

      return response;
    };

    return new StreamableHTTPClientTransport(url, { fetch: scopedFetch });
  }

  /**
   * Tool names that mutate, for servers whose read-only mode we enforce here.
   *
   * `close` and `cancel` are here because of oanda_close_trade: it realises a
   * position's P/L at market and matched none of the other fragments, so it was
   * offered to the model — and callable — with the trading server locked. A
   * read-only mode that still closes trades is not a read-only mode.
   */
  private static readonly MUTATING_TOOL =
    /(write|create|delete|remove|move|rename|patch|update|edit|append|copy|mkdir|truncate|manage|close|cancel)/i;

  /**
   * True when this tool must be withheld because its server is in a
   * client-enforced read-only mode (the server has no flag of its own).
   */
  /**
   * True when the server's own filter excludes this tool.
   *
   * Kept separate from the read-only check because the two answer different
   * questions: read-only asks "may the model change things", this asks "is this
   * tool worth its share of the context window". A tool can be withheld by
   * either, and "accept edits" must not override this one.
   */
  private isWithheldByFilter(server: string, actualName: string): boolean {
    const filter = this.configs.get(server)?.toolFilter;
    if (!filter) return false;

    try {
      return !filter(actualName);
    } catch {
      // A throwing filter must not silently hide the whole server. Expose the
      // tool and let the model deal with it.
      return false;
    }
  }

  private isWithheldByReadOnly(server: string, actualName: string): boolean {
    // "Accept edits" is an explicit, session-scoped instruction to stand down.
    // Without this, the mode would only silence the prompts while still hiding
    // every write tool — a mode that says "edits accepted" and then cannot edit.
    if (areEditsAccepted()) return false;

    const config = this.configs.get(server);
    if (!config?.clientEnforcedReadOnly) return false;
    return MCPManager.MUTATING_TOOL.test(actualName);
  }

  private setRoute(
    exposedName: string,
    route: { client: Client; server: string; actualName: string; description: string; schema: any }
  ) {
    this.toolRoutes.set(exposedName, route);
  }

  /**
   * Tools exposed under a server-prefixed alias because another server already
   * claimed the plain name. Both are callable; nothing is dropped.
   */
  public getToolAliases(): Array<{
    exposedAs: string;
    original: string;
    server: string;
    shadowedBy: string;
  }> {
    return Array.from(this.aliases.entries()).map(([exposedAs, alias]) => ({
      exposedAs,
      ...alias,
    }));
  }

  /**
   * Deprecated. Use `refreshFilesystemServer` from core/mcpServers.ts, which goes
   * through the registry and therefore preserves the read-only mode. Building the
   * argv here bypassed that.
   */
  public async refreshFilesystemServer() {
    throw new Error(
      "mcpManager.refreshFilesystemServer() is retired — import refreshFilesystemServer from core/mcpServers.js instead."
    );
  }

  /**
   * Is this tool source switched off?
   *
   * Withholding rather than refusing, for the same reason as read-only above: a
   * tool the model cannot see is one it cannot try to work around. The saving is
   * the point — every schema here is sent on every request, so a disabled source
   * stops costing context immediately rather than at call time.
   */
  private isSourceDisabled(source: string): boolean {
    return loadConfig().mcpToolsDisabled?.[source] === true;
  }

  public async getAllOllamaTools(): Promise<any[]> {
    const localDisabled = this.isSourceDisabled("local");
    const allTools = localDisabled ? [] : localToolRegistry.getAllSchemas();
    const localNames = new Set<string>(
      allTools.map((t: any) => t?.function?.name).filter(Boolean)
    );

    for (const [exposedName, route] of this.toolRoutes.entries()) {
      // A local tool of the same name wins: it is the one callTool dispatches to.
      if (localNames.has(exposedName)) continue;

      // Withhold, don't merely refuse: a tool the model cannot see is one it
      // cannot try to work around.
      if (this.isWithheldByReadOnly(route.server, route.actualName)) continue;

      // Outside the server's configured tool set (Unity's tag filter).
      if (this.isWithheldByFilter(route.server, route.actualName)) continue;

      // Whole source switched off in Settings or the tools popup.
      if (this.isSourceDisabled(route.server)) continue;

      const alias = this.aliases.get(exposedName);
      const description = alias
        ? `[Server: ${route.server}] ${route.description} ` +
          `(same name as "${alias.original}" from "${alias.shadowedBy}"; this one targets ${route.server})`
        : `[Server: ${route.server}] ${route.description}`;

      allTools.push({
        type: "function",
        function: { name: exposedName, description, parameters: route.schema },
      });
    }

    return allTools;
  }

  public async callTool(toolName: string, args: any): Promise<any> {
    // Single chokepoint for every tool call, so the vault read-only rule cannot
    // be sidestepped by reaching the vault through a different server. The
    // filesystem server's write_file could otherwise write straight into a vault
    // that sits inside a granted directory.
    const blocked = guardVaultWrite(toolName, args);
    if (blocked) return blocked;

    // Obsidian addresses notes by path including the extension, and models pass
    // the path the user said out loud: "…/overview", not "…/overview.md". The
    // vault API then creates an extensionless file beside the real note — a write
    // that succeeds, reads back, and is invisible in Obsidian and its search. Add
    // the extension before dispatch. See vaultPath.ts.
    const pathFixed = guardVaultPath(toolName, args);
    if (pathFixed.changed.length > 0) {
      logActivity({
        kind: "tool",
        status: "ok",
        label: toolName,
        summary: `vault path completed: ${pathFixed.changed.join(", ")}`,
        detail:
          "Obsidian only recognises notes with a file extension. Without this the write " +
          "would have created a separate extensionless file that Obsidian does not display.",
      });
    }
    args = pathFixed.args;

    // Small models write chat formatting into files: a ```json fence around the
    // content lands in the file verbatim and the JSON stops parsing. Strip that
    // here, and refuse a malformed JSON write outright rather than corrupting a
    // file the next turn will then try to repair from a broken state.
    const guarded = guardFileContent(toolName, args);
    if (guarded.refusal) {
      logActivity({
        kind: "tool",
        status: "warn",
        label: toolName,
        summary: "refused: content is not valid JSON",
        detail: guarded.refusal.message,
      });
      return guarded.refusal;
    }
    if (guarded.cleaned.length > 0) {
      logActivity({
        kind: "tool",
        status: "ok",
        label: toolName,
        summary: guarded.cleaned.join("; "),
      });
    }
    args = guarded.args;

    const localTool = localToolRegistry.get(toolName);
    if (localTool) {
      return localTool.handler(args);
    }

    if (this.internalTools.has(toolName)) {
      const tool = this.internalTools.get(toolName)!;
      return tool.handler(args);
    }

    const route = this.toolRoutes.get(toolName);
    if (!route) {
      throw new Error(`Tool ${toolName} not found on any active internal registry or MCP server.`);
    }

    // Belt and braces: the tool is withheld from the list, but refuse it here too
    // in case a model calls a name it remembers from earlier in the conversation.
    if (this.isWithheldByReadOnly(route.server, route.actualName)) {
      return {
        error: true,
        readOnly: true,
        message: `"${toolName}" is unavailable because "${route.server}" is in read-only mode.`,
        actionRequired:
          `Do not attempt another route to the same change. Tell the user that "${route.server}" ` +
          `is read-only and that they can switch it with the Read-write button in the sidebar.`,
      };
    }

    // Same belt and braces for the tag filter. The message names the setting,
    // because "that tool does not exist" would be a lie — it exists and is
    // reachable, it is just outside the set this session chose to pay for.
    if (this.isWithheldByFilter(route.server, route.actualName)) {
      return {
        error: true,
        filtered: true,
        message: `"${toolName}" is not in the enabled tool set for "${route.server}".`,
        actionRequired:
          `Do not look for another way to do the same thing. Tell the user that "${toolName}" ` +
          `is outside the enabled Unity tags, and that they can widen "unityToolTags" in ` +
          `~/.cullus/config.json.`,
      };
    }

    // Unity's own foot-guns, handled once here rather than in every caller.
    // See unityRuntime.ts for what each of these cost when it was not handled.
    const isUnity = route.server === "unity";
    let refreshedAssets = false;

    if (isUnity) {
      const timeoutFix = normaliseUnityTimeout(route.actualName, args);
      args = timeoutFix.args;
      if (timeoutFix.note) {
        logActivity({
          kind: "tool",
          status: "warn",
          label: toolName,
          summary: "timeout argument rescaled to milliseconds",
          detail: timeoutFix.note,
        });
      }

      // A compile has to see the files on disk. An automated caller writes most
      // of them by routes the Editor's file watcher never hears about.
      if (needsAssetRefresh(route.actualName)) {
        const refresh = assetRefreshCall();
        const refreshRoute = this.toolRoutes.get(refresh.name);
        if (refreshRoute) {
          try {
            await refreshRoute.client.callTool({
              name: refreshRoute.actualName,
              arguments: refresh.arguments,
            });
            refreshedAssets = true;
          } catch {
            // A refresh that fails is not worth failing the compile over: the
            // annotation below then says the weaker of its two things.
          }
        }
      }
    }

    // Send the server its own name for the tool, not the alias we exposed.
    try {
      const rawResult = await route.client.callTool({ name: route.actualName, arguments: args });

      // Images out of the transcript and onto disk, whatever the server. A
      // screenshot inline is 33,000 tokens against an 8,000-character cap, so
      // what arrives is a truncated PNG nobody can use. See imageResults.
      const diverted = divertImageContent(rawResult, { tool: route.actualName });
      if (diverted.files.length > 0) {
        logActivity({
          kind: "tool",
          status: "ok",
          label: route.actualName,
          summary: `image saved to ${diverted.files[0]}`,
          detail: "Returned as a path rather than inline base64, which the result cap truncates.",
        });
      }
      const raw = diverted.result;

      if (isUnity) return await this.afterUnityCall(route.actualName, args, raw, refreshedAssets);

      // Blender's tools all run inside Blender, so "connection refused" means a
      // setup step is outstanding rather than a broken call. See blenderRuntime.
      if (route.server === "blender") return annotateBlenderResult(raw);

      return raw;
    } catch (error: any) {
      // The Editor drops its listener for a second or two after a domain reload,
      // and the resulting "Network error" is indistinguishable from a dead
      // Editor. One retry tells them apart.
      if (isUnity && isTransientUnityError(error)) {
        logActivity({
          kind: "server",
          status: "warn",
          label: "unity reloading",
          summary: `retrying ${toolName} once after a domain reload`,
        });

        await new Promise((resolve) => setTimeout(resolve, 1800));

        const raw = await route.client.callTool({ name: route.actualName, arguments: args });
        return await this.afterUnityCall(route.actualName, args, raw, refreshedAssets);
      }

      if (!MCPManager.isDeadSession(error)) throw error;

      // The server forgot our session — Obsidian restarted, the plugin reloaded,
      // or it expired. The spec's answer is to start a new session, and until we
      // did, EVERY vault call failed with "Session not found" until `cullus`
      // itself was restarted. From the chat side that looked like the vault being
      // unreadable, and the model would confabulate reasons for it.
      const config = this.configs.get(route.server);
      if (!config) throw error;

      logActivity({
        kind: "server",
        status: "warn",
        label: `${route.server} session expired`,
        summary: "reconnecting and retrying the call once",
      });
      console.log(`♻️  ${route.server}: session gone; reconnecting and retrying ${toolName}.`);

      await this.registerServer(route.server, config);

      // Re-resolve: reconnecting rebuilds the routes, so the old client object is
      // stale even though the tool name is the same.
      const fresh = this.toolRoutes.get(toolName);
      if (!fresh) {
        throw new Error(
          `${route.server} reconnected but no longer offers "${toolName}". ` +
            `Its tool list may have changed.`
        );
      }

      return await fresh.client.callTool({ name: fresh.actualName, arguments: args });
    }
  }

  /**
   * Everything the Unity surface will not tell a caller about its own result.
   *
   * Three jobs, all of them about the difference between what a command reports
   * and what the caller is reasoning about:
   *
   *  - `editor_play` reports that play mode was entered. It does not report that
   *    the game is frozen solid because the Editor lost focus, which is the
   *    normal state for an automated caller and makes every subsequent
   *    observation a still photograph. This samples the frame counter and says
   *    so, in the result, where it cannot be missed.
   *  - a timed-out `eval` reports a failure for code that is already running.
   *  - `recompile` answers "up_to_date" for both success and never-saw-it.
   */
  private async afterUnityCall(
    actualName: string,
    args: any,
    result: any,
    refreshedAssets: boolean
  ): Promise<any> {
    if (UNITY_CODE_TOOLS.has(actualName) && isTimeoutResult(result)) {
      return describeCodeTimeout(actualName, args);
    }

    const condensed = condenseUnityConsole(actualName, result);
    let next = condensed.note ? attachNote(condensed.result, condensed.note) : condensed.result;

    next = annotateCompileResult(actualName, next, refreshedAssets);
    next = annotatePlayModeRefusal(next);

    if (actualName === "editor_play") {
      const verdict = await this.sampleFrameCount();
      next = attachNote(next, verdict.message);

      if (!verdict.ticking) {
        logActivity({
          kind: "tool",
          status: "warn",
          label: "editor_play",
          summary: "play mode entered but the game is not ticking",
          detail: verdict.message,
        });
      }
    }

    return next;
  }

  /**
   * Read Time.frameCount twice, a beat apart, and judge whether the game loop is
   * running. Failure to sample is reported as "unknown", never as "fine".
   */
  private async sampleFrameCount(): Promise<ReturnType<typeof judgeFrameSamples>> {
    const route = this.toolRoutes.get("eval");
    if (!route) return judgeFrameSamples([]);

    const read = async (): Promise<number | null> => {
      try {
        const raw: any = await route.client.callTool({
          name: route.actualName,
          arguments: { code: "return Time.frameCount.ToString();", timeout: 15000 },
        });

        const text = JSON.stringify(raw);
        const match = text.match(/"result\\?":\\?"(\d+)\\?"/) ?? text.match(/(\d{1,12})/);
        return match ? Number(match[1]) : null;
      } catch {
        return null;
      }
    };

    const first = await read();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await read();

    return judgeFrameSamples([first, second].filter((n): n is number => n !== null));
  }

  /**
   * Is this error the server telling us our session is gone?
   *
   * The plugin answers `{"error": "Session not found"}` with HTTP 404, which the
   * SDK surfaces as StreamableHTTPError with `code: 404`. Matched on both, since
   * the message is the only thing guaranteed across server implementations.
   */
  private static isDeadSession(error: any): boolean {
    if (!error) return false;
    if (error.code === 404) return true;
    return /session not found|session (has )?expired|no valid session/i.test(
      String(error?.message ?? error)
    );
  }

  /**
   * The Streamable HTTP session id each server handed us.
   *
   * Captured from the `mcp-session-id` response header because the SDK keeps it
   * private, and diagnosing a "Session not found" failure is impossible without
   * knowing which session the client thinks it holds.
   */
  private sessionIds: Map<string, string> = new Map();

  public getSessionId(name: string): string | null {
    return this.sessionIds.get(name) ?? null;
  }

  /** Which server owns each exposed tool name, for relevance filtering. */
  public getToolServerMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [exposedName, route] of this.toolRoutes.entries()) {
      map.set(exposedName, route.server);
    }
    return map;
  }

  public getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Unregister a server AND forget how to start it.
   *
   * unregisterServer() deliberately keeps the spawn config so the UI's
   * connect/disconnect toggle can bring a server back. That is wrong for a server
   * the user deleted: without this, a removed server kept appearing in the status
   * list as a permanently disconnected ghost row.
   */
  public async forgetServer(name: string): Promise<void> {
    await this.unregisterServer(name);
    this.configs.delete(name);
  }

  public async disconnectServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.close();
      this.clients.delete(name);
      console.log(`🔌 MCP Server '${name}' disconnected.`);
    }
  }

  public async reconnectServer(name: string): Promise<void> {
    const config = this.configs.get(name);
    if (config) {
      await this.registerServer(name, config);
      console.log(`🔌 MCP Server '${name}' reconnected.`);
    }
  }

  public getServersStatus() {
    const statuses: Array<{ name: string; connected: boolean }> = [];
    for (const [name] of this.configs.entries()) {
      statuses.push({
        name,
        connected: this.clients.has(name),
      });
    }
    return statuses;
  }
}

export const mcpManager = new MCPManager();