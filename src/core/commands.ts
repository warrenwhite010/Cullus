import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import prompts from "prompts";
import { getAiResponse, getSessionUsage, resetSession, AssistantError } from "./provider.js";
import { renderBanner } from "../ui/banner.js";
import { mcpManager } from "./mcpManager.js";
import { loadConfig, saveConfig, expandPath } from "./config.js";
import { refreshFilesystemServer } from "./mcpServers.js";
import { runFix, loadRuns, revertRun } from "./fixLoop.js";
import { resolveTarget, listFixTargets, detectCommands } from "./projectTarget.js";
import { resolveModel } from "./ollama.js";
import { preflight, startUpgrade, startRevert, loadUpgradeRuns } from "./upgrade.js";

type CommandMode = "auto" | "manual";
let commandMode: CommandMode = "auto";

export function setCommandMode(mode: CommandMode) {
  commandMode = mode;
}

export function getCommandMode(): CommandMode {
  return commandMode;
}

export async function handleMcpCommand() {
  const activeServers = mcpManager.getConnectedServers();

  console.log(chalk.hex("#FFDAB9")("\n🔮 Active MCP Integrations:"));
  if (activeServers.length === 0) {
    console.log(chalk.hex("#FFB6C1")("   No active MCP servers connected."));
  } else {
    activeServers.forEach(server => {
      console.log(chalk.hex("#98FB98")(`   • ${server.charAt(0).toUpperCase() + server.slice(1)}`));
    });
  }
  console.log("");
}

export async function handlePathCommand(args: string[]) {
  const subAction = args[0];
  const targetPath = args.slice(1).join(" ");

  if (subAction === "add" && targetPath) {
    mcpManager.addAllowedPath(targetPath);
    await refreshFilesystemServer();
    console.log(chalk.hex("#98FB98")(`\n✅ Added allowed path and refreshed filesystem server: ${targetPath}\n`));
    return;
  }

  if (subAction === "remove" && targetPath) {
    mcpManager.removeAllowedPath(targetPath);
    await refreshFilesystemServer();
    console.log(chalk.hex("#FFB6C1")(`\n🗑️ Removed path and refreshed filesystem server: ${targetPath}\n`));
    return;
  }

  const paths = mcpManager.getAllowedPaths();
  console.log(chalk.hex("#FFDAB9")("\n📂 Configured Filesystem Paths:"));
  if (paths.length === 0) {
    console.log(chalk.hex("#FFB6C1")("   No paths currently authorized."));
  } else {
    paths.forEach((p, idx) => console.log(chalk.hex("#98FB98")(`   [${idx + 1}] ${p}`)));
  }

  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "Path management options:",
    choices: [
      { title: "Back / Exit", value: "exit" },
      { title: "Remove a path", value: "remove" },
    ],
  });

  if (action === "remove" && paths.length > 0) {
    const { selectedPath } = await prompts({
      type: "select",
      name: "selectedPath",
      message: "Select a path to remove:",
      choices: paths.map(p => ({ title: p, value: p })),
    });

    if (selectedPath) {
      mcpManager.removeAllowedPath(selectedPath);
      await refreshFilesystemServer();
      console.log(chalk.hex("#FFB6C1")(`\n🗑️ Removed path: ${selectedPath}\n`));
    }
  }
}

/**
 * `/fix` — run the repair loop from the terminal.
 *
 * Subcommands mirror the /vault shape: bare invocation repairs, `revert` undoes,
 * `runs` lists history, `set` overrides the build/verify commands for a project
 * whose language we guessed wrong.
 */
export async function handleFixCommand(args: string[], currentModel: string) {
  const sub = args[0];

  if (sub === "runs") {
    const runs = loadRuns();
    console.log(chalk.hex("#FFDAB9")("\n🔧 Recent /fix runs:"));
    if (runs.length === 0) console.log(chalk.hex("#FFB6C1")("   None yet."));
    for (const run of runs.slice(0, 10)) {
      const when = new Date(run.startedAt).toLocaleString();
      const colour = run.outcome === "kept" ? "#98FB98" : "#FFD700";
      console.log(chalk.hex(colour)(`   ${run.id}  ${run.outcome.padEnd(9)} ${run.label} — ${when}`));
      console.log(chalk.hex("#94A3B8")(`      ${run.summary}`));
    }
    console.log("");
    return;
  }

  if (sub === "revert") {
    const runId = args[1] ?? loadRuns()[0]?.id;
    if (!runId) {
      console.log(chalk.hex("#FFB6C1")("\n⚠️  No /fix run to revert.\n"));
      return;
    }
    const result = revertRun(runId);
    console.log(
      chalk.hex(result.ok ? "#98FB98" : "#FFB6C1")(`\n${result.ok ? "✅" : "⚠️ "} ${result.message}\n`)
    );
    return;
  }

  if (sub === "set") {
    const targetPath = args[1];
    const rest = args.slice(2).join(" ");
    const build = rest.match(/--build\s+"([^"]+)"/)?.[1];
    const verify = rest.match(/--verify\s+"([^"]+)"/)?.[1];

    if (!targetPath || (!build && !verify)) {
      console.log(
        chalk.hex("#FFB6C1")(
          '\n⚠️  Usage: /fix set <project path> --build "<cmd>" --verify "<cmd>"\n'
        )
      );
      return;
    }

    const resolved = resolveTarget(targetPath);
    if (!resolved.ok) {
      console.log(chalk.hex("#FFB6C1")(`\n⚠️  ${resolved.error}\n   ${resolved.actionRequired}\n`));
      return;
    }

    const config = loadConfig();
    const existing = config.fixCommands?.[resolved.target.root] ?? {};
    saveConfig({
      fixCommands: {
        ...(config.fixCommands ?? {}),
        [resolved.target.root]: {
          build: build ?? existing.build,
          verify: verify ?? existing.verify,
        },
      },
    });

    console.log(chalk.hex("#98FB98")(`\n✅ Commands set for ${resolved.target.root}.\n`));
    return;
  }

  if (sub === "targets") {
    console.log(chalk.hex("#FFDAB9")("\n🎯 Repairable targets:"));
    for (const target of listFixTargets()) {
      const commands = detectCommands(target.path);
      console.log(chalk.hex("#98FB98")(`   ${target.label}`));
      console.log(
        chalk.hex("#94A3B8")(
          `      ${target.path}\n      build: ${commands.build ?? "(none)"} · verify: ${
            commands.verify ?? "(none)"
          } · from ${commands.source}`
        )
      );
    }
    console.log("");
    return;
  }

  // Bare form: everything after an optional --target is the symptom.
  let targetPath: string | null = null;
  let symptomParts = args;

  if (args[0] === "--target") {
    targetPath = args[1] ?? null;
    symptomParts = args.slice(2);
  }

  const symptom = symptomParts.join(" ").trim();
  if (!symptom) {
    console.log(
      chalk.hex("#FFB6C1")(
        "\n⚠️  Describe what's wrong: /fix \"build fails: Cannot find name X\"\n" +
          "   Other forms: /fix --target <path> <symptom>, /fix runs, /fix revert [id], /fix targets\n"
      )
    );
    return;
  }

  const resolved = resolveTarget(targetPath);
  if (!resolved.ok) {
    console.log(chalk.hex("#FFB6C1")(`\n⚠️  ${resolved.error}\n   ${resolved.actionRequired}\n`));
    return;
  }

  const model = (await resolveModel(currentModel, loadConfig().defaultModel)) ?? currentModel;

  console.log(
    chalk.hex("#FFDAB9")(
      `\n🔧 Repairing ${resolved.target.label} with ${model}\n   ${resolved.target.root}\n`
    )
  );

  try {
    const report = await runFix({
      symptom,
      target: resolved.target,
      models: { locate: model, plan: model },
      onEvent: (event) => {
        const icon =
          event.status === "ok" ? "✅" : event.status === "fail" ? "❌" : event.status === "warn" ? "⚠️ " : "…";
        const colour =
          event.status === "ok" ? "#98FB98" : event.status === "fail" ? "#FFB6C1" : "#94A3B8";
        const round = event.round > 0 ? `[round ${event.round}] ` : "";
        console.log(chalk.hex(colour)(`   ${icon} ${round}${event.phase}: ${event.message}`));
      },
    });

    console.log(
      chalk.hex(report.outcome === "kept" ? "#98FB98" : "#FFD700")(`\n${report.summary}\n`)
    );
    if (report.touched.length > 0) {
      console.log(chalk.hex("#94A3B8")(`   Files touched: ${report.touched.join(", ")}\n`));
    }
  } catch (err: any) {
    console.log(chalk.hex("#FFB6C1")(`\n❌ ${err.message}\n`));
  }
}

/**
 * /upgrade — replace this install with the latest origin/main.
 *
 * Nothing here mutates the tree. It reports what preflight found, takes the
 * confirmation, and hands off to upgrade.ts, which arms the undo and then exits
 * the process so a detached script can safely replace the files we are running
 * from. See the header of upgrade.ts for why that indirection exists.
 */
export async function handleUpgradeCommand(args: string[]) {
  const sub = args[0];

  if (sub === "runs") {
    const runs = loadUpgradeRuns();
    if (runs.length === 0) {
      console.log(chalk.hex("#94A3B8")("\n   No upgrades recorded yet.\n"));
      return;
    }
    console.log(chalk.hex("#FFDAB9")("\n📦 Upgrade history:"));
    for (const run of runs) {
      const colour =
        run.outcome === "upgraded" ? "#98FB98" : run.outcome === "pending" ? "#94A3B8" : "#FFB6C1";
      console.log(
        chalk.hex(colour)(
          `   ${run.id}  ${run.outcome}  ${run.fromSha.slice(0, 7)} → ${run.toSha.slice(0, 7)}`
        )
      );
      console.log(chalk.hex("#94A3B8")(`      ${new Date(run.startedAt).toLocaleString()} · ${run.summary}`));
    }
    console.log("");
    return;
  }

  if (sub === "revert") {
    const result = startRevert(args[1]);
    // Only returns when it could not start; success exits the process.
    console.log(chalk.hex("#FFB6C1")(`\n⚠️  ${result.message}\n`));
    return;
  }

  const pre = preflight();

  if (!pre.ok) {
    console.log(chalk.hex("#FFB6C1")(`\n⚠️  ${pre.reason}`));
    if (pre.actionRequired) console.log(chalk.hex("#94A3B8")(`   ${pre.actionRequired}`));
    console.log("");
    return;
  }

  if (pre.current) {
    console.log(chalk.hex("#98FB98")(`\n✅ Already up to date with ${pre.upstream}.\n`));
    return;
  }

  const commits = pre.commits ?? [];
  console.log(
    chalk.hex("#FFDAB9")(`\n📦 ${commits.length} commit(s) behind ${pre.upstream}:`)
  );
  for (const line of commits.slice(0, 15)) console.log(chalk.hex("#94A3B8")(`   ${line}`));
  if (commits.length > 15) console.log(chalk.hex("#94A3B8")(`   … and ${commits.length - 15} more`));
  console.log("");

  if (sub === "--check" || sub === "check") {
    console.log(chalk.hex("#94A3B8")("   Nothing changed. Run /upgrade to apply.\n"));
    return;
  }

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Upgrade and restart?",
    initial: false,
  });
  if (!confirm) {
    console.log(chalk.hex("#94A3B8")("\n   Cancelled. Nothing changed.\n"));
    return;
  }

  console.log("");
  const result = startUpgrade(pre, { relaunch: true });
  // startUpgrade exits on success, so reaching here means it refused.
  console.log(chalk.hex("#FFB6C1")(`\n⚠️  ${result.message}\n`));
}

export async function handleCommand(command: string, currentModel: string, updateModelCallback: () => Promise<void>): Promise<boolean> {
  const parts = command.trim().split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);
  
  if (commandMode === "manual") {
    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: `Execute command: ${command}?`,
      initial: true,
    });
    if (!confirm) return true;
  }

  switch (cmd) {
    case "/exit":
    case "/quit":
      console.log(chalk.hex("#DA70D6")("\n✨ Goodbye! Have a wonderful coding session. ✨\n"));
      return false;
    case "/mcp":
      await handleMcpCommand();
      break;
    case "/path":
      await handlePathCommand(args);
      break;
    case "/clear":
      console.clear();
      renderBanner();
      break;
    case "/model":
      await updateModelCallback();
      break;
    case "/setmode":
      const mode = args[0] as CommandMode;
      if (mode === "auto" || mode === "manual") {
        commandMode = mode;
        console.log(chalk.hex("#98FB98")(`\n✅ Command mode set to: ${commandMode}\n`));
      } else {
        console.log(chalk.hex("#FFB6C1")(`\n⚠️ Invalid mode. Use /setmode [auto|manual]\n`));
      }
      break;
    case "/vault":
      await handleVaultCommand(args);
      break;
    case "/cron":
      await handleCronCommand(args);
      return true;
    case "/fix":
      await handleFixCommand(args, currentModel);
      break;
    case "/upgrade":
      await handleUpgradeCommand(args);
      break;
    case "/tokens":
      handleTokensCommand();
      break;
    case "/reset":
      resetSession();
      console.log(
        chalk.hex("#98FB98")("\n✅ Started a new chat. The previous one is still in the sidebar.\n")
      );
      break;
    case "/help":
      console.log(
        chalk.hex("#DDA0DD")(
          "\n📚 Commands: /mcp, /path, /vault [set <path>], /fix <symptom>, /upgrade [--check|runs|revert], /tokens, /model, /clear, /reset, /setmode [auto|manual], /exit\n"
        )
      );
      break;
    default:
      try {
        console.log(chalk.hex("#E6E6FA")(`\n🤖 [${currentModel}] Analyzing intent...`));
        const result = await getAiResponse(command, currentModel);

        console.log(chalk.hex("#F0FFFF")(`\n${result.content}\n`));

        for (const note of result.degraded) {
          console.log(chalk.hex("#FFD700")(`⚠️  ${note}`));
        }

        const { promptTokens, completionTokens, totalTokens, contextLength } = result.usage;
        const pct = contextLength ? Math.round((totalTokens / contextLength) * 100) : 0;
        console.log(
          chalk.hex("#94A3B8")(
            `⚡ ${totalTokens} tokens (${promptTokens} in / ${completionTokens} out) · ${pct}% of ${contextLength} context\n`
          )
        );
      } catch (error: any) {
        console.log(chalk.hex("#FFB6C1")(`\n❌ ${error.message || error}`));
        if (error instanceof AssistantError && error.hint) {
          console.log(chalk.hex("#FFD700")(`   Fix: ${error.hint}`));
        }
        console.log("");
      }
      break;
  }
  return true;
}

export async function handleVaultCommand(args: string[]) {
  const config = loadConfig();

  if (args[0] === "set") {
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      console.log(chalk.hex("#FFB6C1")("\n⚠️ Usage: /vault set <path>\n"));
      return;
    }

    const resolved = expandPath(target);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.hex("#FFB6C1")(`\n⚠️ That path does not exist: ${resolved}\n`));
      return;
    }

    saveConfig({ vaultPath: resolved });
    console.log(chalk.hex("#98FB98")(`\n✅ Vault set to: ${resolved}\n`));
    return;
  }

  if (args[0] === "clear") {
    saveConfig({ vaultPath: null });
    console.log(chalk.hex("#FFB6C1")("\n🗑️ Vault path cleared. Vault tools are now disabled.\n"));
    return;
  }

  if (!config.vaultPath) {
    console.log(
      chalk.hex("#FFB6C1")(
        "\n📓 No vault configured. Vault tools are disabled.\n   Set one with: /vault set <path>\n"
      )
    );
    return;
  }

  const exists = fs.existsSync(config.vaultPath);
  console.log(chalk.hex("#FFDAB9")(`\n📓 Vault: ${config.vaultPath}`));
  console.log(
    exists
      ? chalk.hex("#98FB98")("   Status: found\n")
      : chalk.hex("#FFB6C1")("   Status: MISSING — fix with /vault set <path>\n")
  );
}

export function handleTokensCommand() {
  const { promptTokens, completionTokens, totalTokens, turns } = getSessionUsage();

  console.log(chalk.hex("#FFDAB9")("\n⚡ Session token usage:"));
  console.log(chalk.hex("#98FB98")(`   Input:  ${promptTokens}`));
  console.log(chalk.hex("#98FB98")(`   Output: ${completionTokens}`));
  console.log(chalk.hex("#98FB98")(`   Total:  ${totalTokens} across ${turns} turn(s)\n`));
}
// ---------------------------------------------------------------------------
// /cron — scheduled jobs
// ---------------------------------------------------------------------------

/**
 * Two kinds of job, and the difference is the whole point:
 *
 *   prompt  — fires the model on a schedule.
 *   monitor — runs a cheap shell command first, hashes the output, and fires
 *             the model ONLY when that output changed.
 *
 * A monitor script must produce stable output. Anything with a clock in it
 * ("generated at 14:32") looks different on every tick and defeats the
 * suppression entirely — you are back to a model call every time.
 */
export async function handleCronCommand(args: string[]): Promise<void> {
  const { status, describeSchedule, validateSchedule, checkLifecycleSafety, reload } =
    await import("./cron.js");
  const { addJob, removeJob, setEnabled, listRuns, getJob } = await import("./cronStore.js");

  const sub = args[0];

  if (!sub || sub === "list") {
    const jobs = status();
    if (jobs.length === 0) {
      console.log(chalk.dim("\nNo scheduled jobs. Add one with:"));
      console.log(chalk.dim(`  /cron add "name" "*/15 * * * *" "prompt"`));
      console.log(chalk.dim(`  /cron monitor "name" "*/15 * * * *" "shell command" "prompt"\n`));
      return;
    }
    console.log("");
    for (const j of jobs) {
      const state = !j.enabled
        ? chalk.red("disabled")
        : j.lastStatus === "error"
          ? chalk.red("error")
          : j.lastStatus === "no_change"
            ? chalk.dim("no change")
            : chalk.green("ok");
      console.log(
        `${chalk.bold(j.name)} ${chalk.dim(`[${j.kind}]`)} ${state}` +
          (j.failureCount ? chalk.red(` ${j.failureCount} consecutive failures`) : "")
      );
      console.log(chalk.dim(`  ${j.schedule}  ${j.nextRun ? `next ${new Date(j.nextRun).toLocaleString()}` : "not armed"}`));
      console.log(chalk.dim(`  id ${j.id}`));
    }
    console.log("");
    return;
  }

  if (sub === "add" || sub === "monitor") {
    const isMonitor = sub === "monitor";
    // Quoted arguments: /cron add "name" "*/5 * * * *" "prompt"
    const quoted = args.join(" ").match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    const needed = isMonitor ? 4 : 3;
    if (quoted.length < needed) {
      console.log(chalk.red(`\n${sub} needs ${needed} quoted arguments.`));
      console.log(
        isMonitor
          ? chalk.dim(`  /cron monitor "oanda" "*/15 * * * *" "curl -s ... | jq .balance" "Tell me what changed."\n`)
          : chalk.dim(`  /cron add "digest" "0 9 * * *" "Summarise yesterday's activity."\n`)
      );
      return;
    }

    const [name, schedule] = quoted;
    const monitorScript = isMonitor ? quoted[2] : undefined;
    const prompt = isMonitor ? quoted[3] : quoted[2];

    const scheduleError = validateSchedule(schedule);
    if (scheduleError) {
      console.log(chalk.red(`\n${scheduleError}\n`));
      return;
    }
    const lifecycleError = checkLifecycleSafety(monitorScript);
    if (lifecycleError) {
      console.log(chalk.red(`\n${lifecycleError}\n`));
      return;
    }

    const job = addJob({
      name,
      schedule,
      prompt,
      kind: isMonitor ? "monitor" : "prompt",
      monitorScript,
    });
    reload();
    console.log(chalk.green(`\nScheduled "${name}" — ${describeSchedule(schedule)}`));
    if (isMonitor) {
      console.log(
        chalk.dim(
          "  Monitor mode: the model runs only when the script's output changes.\n" +
            "  Make sure that output is stable — no timestamps, sort your results."
        )
      );
    }
    console.log(chalk.dim(`  id ${job.id}\n`));
    return;
  }

  const id = args[1];
  if (!id) {
    console.log(chalk.red(`\n/cron ${sub} needs a job id. See /cron list.\n`));
    return;
  }

  if (sub === "remove" || sub === "rm") {
    console.log(removeJob(id) ? chalk.green("\nRemoved.\n") : chalk.red("\nNo job with that id.\n"));
    reload();
    return;
  }
  if (sub === "enable" || sub === "disable") {
    const on = sub === "enable";
    if (!setEnabled(id, on)) {
      console.log(chalk.red("\nNo job with that id.\n"));
      return;
    }
    reload();
    console.log(chalk.green(`\n${on ? "Enabled" : "Disabled"}.\n`));
    return;
  }
  if (sub === "runs") {
    const job = getJob(id);
    if (!job) {
      console.log(chalk.red("\nNo job with that id.\n"));
      return;
    }
    const runs = listRuns(id);
    console.log(chalk.bold(`\n${job.name}`));
    if (runs.length === 0) console.log(chalk.dim("  no recorded runs yet\n"));
    else {
      for (const r of runs) console.log(chalk.dim(`  ${r}`));
      console.log("");
    }
    return;
  }

  console.log(chalk.dim("\n/cron list | add | monitor | remove <id> | enable <id> | disable <id> | runs <id>\n"));
}
