#!/usr/bin/env node
// src/index.ts — `cullus` entry point.

import { Command } from "commander";
import { mcpManager } from "./core/mcpManager.js";
import { localToolRegistry } from "./core/tools.js";
import { io, startWebServer } from "./core/server.js";
import { getOllamaHealth, resolveModel } from "./core/ollama.js";
import { OrchestratorEngine } from "./orchestrator.js";
import { PipelineQueueManager } from "./websocket/PipelineQueueManager.js";
import { loadConfig, saveConfig, migrateVaultLock, ensureConfigDir, CONFIG_PATH } from "./core/config.js";
import { registerRecipeTools } from "./core/recipes.js";
import {
  registerConfiguredServers,
  migrateCustomServerEnvSecrets,
  watchForUnityEditor,
} from "./core/mcpServers.js";
import { seedBuiltinSkills } from "./core/skills.js";
import { registerWebTools, activeSearchBackend } from "./core/webTools.js";
import { registerUnityTools } from "./core/unityTools.js";
import { registerUnityProbes } from "./core/unityProbes.js";
import * as fs from "fs";

const program = new Command();
const queueManager = new PipelineQueueManager(10);

// ===== QUEUE MANAGER EVENT LISTENERS =====
queueManager.on("queue-updated", (stats: any) => {
  io.emit("queue-status", {
    queued: stats.queued,
    processing: stats.processing,
    completed: stats.completed,
  });
});

queueManager.on("request-started", (requestId: string) => {
  io.emit("request-started", { requestId, timestamp: Date.now() });
});

queueManager.on("request-dropped", (requestId: string, reason: string) => {
  io.emit("request-dropped", { requestId, reason, timestamp: Date.now() });
});

// ===== STRUCTURED ORCHESTRATOR (opt-in) =====
//
// This is the schema-validated three-agent engine. It is separate from the
// simpler `send-pipeline` flow bound in core/server.ts — binding both to the
// same event is what previously made every pipeline run execute twice.
io.on("connection", (socket: any) => {
  socket.on(
    "send-orchestrated",
    async (data: {
      prompt: string;
      models?: { triageModel?: string; engineerModel?: string; managerModel?: string };
    }) => {
      const configuredDefault = loadConfig().defaultModel;

      const [analyzer, writer, documenter] = await Promise.all([
        resolveModel(data?.models?.triageModel, configuredDefault),
        resolveModel(data?.models?.engineerModel, configuredDefault),
        resolveModel(data?.models?.managerModel, configuredDefault),
      ]);

      if (!analyzer || !writer || !documenter) {
        socket.emit("assistant-error", {
          message: "No Ollama models are available, so the orchestrator cannot run.",
          hint: "Pull one with `ollama pull qwen3.5:9b`, then reload the dashboard.",
        });
        socket.emit("status", "Error");
        return;
      }

      const engine = new OrchestratorEngine({ analyzer, writer, documenter });

      engine.on("status", (message: string) => {
        io.emit("orchestrator-status", { message, timestamp: Date.now() });
      });
      engine.on("step-started", (stepData: any) => {
        io.emit("step-started", { ...stepData, timestamp: Date.now() });
      });
      engine.on("step-progress", (stepData: any) => {
        io.emit("step-progress", { ...stepData, timestamp: Date.now() });
      });
      engine.on("step-error", (stepData: any) => {
        io.emit("step-error", { ...stepData, timestamp: Date.now() });
      });
      engine.on("step-complete", (stepData: any) => {
        io.emit("step-complete", { ...stepData, timestamp: Date.now() });
        io.emit("pipeline-step-complete", {
          role: stepData.role,
          output:
            typeof stepData.output === "string"
              ? stepData.output
              : JSON.stringify(stepData.output, null, 2),
        });
      });
      engine.on("workflow-complete", (workflowData: any) => {
        io.emit("workflow-complete", { ...workflowData, timestamp: Date.now() });
        queueManager.markProcessingComplete();
      });

      try {
        await engine.runWorkflow(data.prompt);
        socket.emit("ai-response", { content: "Orchestrated workflow completed." });
        socket.emit("status", "Ready");
      } catch (err: any) {
        console.error("Workflow execution error:", err);
        socket.emit("assistant-error", {
          message: `Orchestrator failed: ${err.message}`,
          hint:
            "Structured mode requires models that reliably emit JSON. Smaller models often " +
            "can't; try the standard pipeline toggle instead.",
        });
        socket.emit("status", "Error");
      } finally {
        engine.removeAllListeners();
      }
    }
  );
});

async function bootstrapPaths() {
  const config = loadConfig();

  // Restore previously granted directories, then always include the cwd.
  for (const saved of config.allowedPaths) {
    if (fs.existsSync(saved)) mcpManager.addAllowedPath(saved);
  }
  mcpManager.addAllowedPath(process.cwd());

  saveConfig({ allowedPaths: mcpManager.getAllowedPaths() });

  // Deliberately does NOT start the filesystem server: it is part of the registry
  // now, so registerConfiguredServers() starts it with the correct read-only mode.
  // Starting it here as well spawned the subprocess twice on every boot.
}

async function initializeMcpServers() {
  console.log("Initializing MCP servers and internal capabilities...");

  // Before anything connects: retire the stale vault lock, so obsidian-live comes
  // up in the ask-first mode rather than silently refusing writes.
  migrateVaultLock();

  // Anything token-shaped left in config.json by an earlier version moves to the
  // Keychain before the servers that use it start.
  await migrateCustomServerEnvSecrets();

  // Every optional server (Obsidian, Etsy) is described in core/mcpServers.ts,
  // including its read-only mode. Servers whose prerequisites aren't met are
  // skipped with a printed reason rather than failing the boot.
  await registerConfiguredServers();

  // `unity mcp` connects with zero tools when no Editor is answering and never
  // says when that changes, so opening the project after Cullus started used to
  // cost the whole session's Unity support. Watches only while that is actually
  // the case.
  watchForUnityEditor();

  // Recipes are vault notes, so they load after the vault path is known.
  registerRecipeTools();

  // web_search + fetch_url. Keyless via DuckDuckGo; set BRAVE_SEARCH_API_KEY or
  // TAVILY_API_KEY to use a real API instead of scraping.
  registerWebTools();
  console.log(`🌐 Web search backend: ${activeSearchBackend()}`);

  // unity_symbol + unity_compile. Registered unconditionally: the tools detect a
  // missing editor themselves and say so, which is more useful than silently not
  // existing on a machine where Unity is installed somewhere unusual.
  registerUnityTools();

  // The scene probes: walkability, overlapping geometry, structural audit.
  // Separate from the tools above because they answer a different question —
  // not "what can the Editor do" but "is what we just built actually playable".
  // Every defect they exist to catch compiled and saved cleanly first.
  registerUnityProbes();

  mcpManager.registerInternalTool({
    name: "get_connected_mcp_servers",
    description: "Returns a list of all currently connected and active MCP servers.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: () => mcpManager.getConnectedServers(),
  });

  localToolRegistry.register({
    name: "get_current_directory_contents",
    description: "Lists files and folders present in the current working directory.",
    parameters: { type: "object", properties: {} },
    handler: () => {
      try {
        return { directory: process.cwd(), entries: fs.readdirSync(process.cwd()) };
      } catch (err: any) {
        return { error: true, message: err.message };
      }
    },
  });

  localToolRegistry.register({
    name: "get_system_uptime",
    description: "Returns system uptime information.",
    parameters: { type: "object", properties: {} },
    handler: () => ({ uptimeSeconds: Math.round(process.uptime()) }),
  });
}

program
  .name("assistant")
  .description("Cullus Ai assistant with Web UI, local tools, and MCP support")
  .version("1.0.0")
  .option("-p, --port <number>", "Web server port")
  .option("-m, --model <model>", "Ollama tag to use by default")
  .option("--no-open", "Start the server without opening a browser")
  .action(async (options) => {
    ensureConfigDir();
    seedBuiltinSkills();
    const config = loadConfig();

    // ---- Report Ollama state before anything else ----
    const health = await getOllamaHealth();
    if (!health.running) {
      console.error(`\n❌ ${health.error}`);
      console.error(`   ${health.hint}\n`);
      console.error("   Starting the web UI anyway — it will work once Ollama is up.\n");
    } else if (health.models.length === 0) {
      console.warn(`\n⚠️  ${health.error}`);
      console.warn(`   ${health.hint}\n`);
    } else {
      console.log(`✅ Ollama: ${health.models.length} model(s) available.`);
    }

    // ---- Resolve the default model dynamically; nothing is hardcoded ----
    const resolved = await resolveModel(options.model, config.defaultModel);
    if (resolved) {
      if (options.model && resolved !== options.model) {
        console.warn(
          `⚠️  "${options.model}" isn't pulled. Using "${resolved}" instead ` +
          `(available: ${health.models.join(", ")}).`
        );
      }
      // Same rule as --port: an explicit -m applies to this run only. Remember
      // the model only when we auto-resolved it, so the choice sticks without a
      // one-off flag quietly redefining the default.
      if (options.model) {
        console.log(`🤖 Model: ${resolved} (this run only; default stays ${config.defaultModel ?? "auto"})`);
      } else {
        if (resolved !== config.defaultModel) saveConfig({ defaultModel: resolved });
        console.log(`🤖 Default model: ${resolved}`);
      }
    }

    await bootstrapPaths();
    await initializeMcpServers();

    const portFromFlag = options.port ? parseInt(options.port, 10) : NaN;
    const usingPortFlag = !Number.isNaN(portFromFlag);
    const port = usingPortFlag ? portFromFlag : config.port;

    let activePort: number;
    try {
      activePort = await startWebServer(port);
    } catch (err: any) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(1);
    }

    // A one-off `--port` must NOT become the persistent default: otherwise a
    // single `assistant --port 3113` silently rewrites config and every later
    // bare `cullus` fights for a port the user never chose.
    if (usingPortFlag) {
      console.log(`🔌 Port ${activePort} (this run only; default stays ${config.port})`);
    }
    console.log(`⚙️  Config: ${CONFIG_PATH}`);

    if (options.open !== false) {
      try {
        const { default: open } = await import("open");
        await open(`http://localhost:${activePort}`);
      } catch (err: any) {
        console.warn(
          `⚠️  Could not open a browser automatically (${err.message}). ` +
          `Open http://localhost:${activePort} yourself.`
        );
      }
    }
  });

process.on("unhandledRejection", (reason: any) => {
  console.error(`\n⚠️  Unhandled rejection: ${reason?.message ?? reason}`);
});

program.parse();
