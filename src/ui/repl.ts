import prompts from "prompts";
import chalk from "chalk";
import { getOllamaHealth, resolveModel } from "../core/ollama.js";
import { renderBanner } from "./banner.js";
import { handleCommand } from "../core/commands.js";
import { loadConfig, saveConfig } from "../core/config.js";

// No hardcoded default — resolved from Ollama at startup.
let currentModel = "";

export async function handleModelCommand() {
  const health = await getOllamaHealth();

  if (!health.running) {
    console.log(chalk.hex("#FFB6C1")(`\n❌ ${health.error}\n   ${health.hint}\n`));
    return;
  }

  if (health.models.length === 0) {
    console.log(chalk.hex("#FFB6C1")(`\n⚠️ ${health.error}\n   ${health.hint}\n`));
    return;
  }

  console.log(
    chalk.hex("#87CEEB")(`\n🤖 Current active model: ${currentModel || "(none selected)"}`)
  );

  const selection = await prompts({
    type: "select",
    name: "selectedModel",
    message: "Select a local Ollama model to switch to:",
    choices: health.models.map((m) => ({ title: m, value: m })),
  });

  if (selection.selectedModel) {
    currentModel = selection.selectedModel;
    saveConfig({ defaultModel: currentModel });
    console.log(chalk.hex("#98FB98")(`\n✨ Model successfully switched to: ${currentModel}\n`));
  }
}

export async function startRepl() {
  renderBanner();

  const resolved = await resolveModel(null, loadConfig().defaultModel);
  if (resolved) {
    currentModel = resolved;
    console.log(chalk.hex("#98FB98")(`🤖 Using model: ${currentModel}\n`));
  } else {
    console.log(
      chalk.hex("#FFB6C1")(
        "⚠️ No Ollama models available. Chat will fail until you run:\n" +
          "   ollama pull qwen3.5:9b\n"
      )
    );
  }

  let activeSession = true;

  while (activeSession) {
    const response = await prompts({
      type: "text",
      name: "input",
      message: chalk.hex("#FF69B4").bold("assistant >"),
    });

    if (response.input === undefined) {
      console.log(chalk.hex("#DA70D6")("\n✨ Catch you later! Stay productive. ✨\n"));
      break;
    }

    const trimmed = response.input.trim();
    if (trimmed.length > 0) {
      activeSession = await handleCommand(trimmed, currentModel, handleModelCommand);
    }
  }
}