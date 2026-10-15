// Connects scheduled jobs to the agent.
//
// Kept separate from cron.ts on purpose. cron.ts owns scheduling, monitor
// hashing and the guards, and knows nothing about models — which is why its
// tests run without one. This file is the single seam where a fired job becomes
// a model turn.
//
// Why a scheduled turn is not just "call getAiResponse":
//
//   A 3am job has no human attached. Two subsystems in this codebase already
//   account for that — approval.ts approves when no handler is registered, and
//   inquiry.ts refuses to block on a question nobody will answer. Both name
//   "cron" in their comments. This file is what finally uses that.
//
// So the contract for a scheduled run is: never prompt, never block, always
// terminate. A job that hangs waiting for input is a job that silently stops
// running forever.

import { getAiResponse } from "./provider.js";
import { loadConfig } from "./config.js";
import { resolveModel } from "./ollama.js";
import { setJobRunner } from "./cron.js";
import type { CronJob } from "./cronStore.js";

/** A scheduled turn that has not finished in this long is abandoned. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Build the prompt for a fired job.
 *
 * For a monitor job the diff block comes first, because it is the thing that
 * happened — the job's own prompt is the standing instruction for what to do
 * about it.
 */
function buildPrompt(job: CronJob, contextBlock?: string): string {
  if (!contextBlock) return job.prompt;
  return [
    contextBlock,
    "",
    "---",
    "",
    job.prompt,
  ].join("\n");
}

export function registerCronRunner(): void {
  setJobRunner(async (job, contextBlock) => {
    const cfg = loadConfig();
    const model = await resolveModel(cfg.defaultModel, cfg.defaultModel);
    if (!model) {
      // No Ollama model available. Fail loudly in the run record rather than
      // throwing — the scheduler counts this toward the auto-disable streak, so
      // a machine with Ollama stopped does not retry forever in silence.
      throw new Error("no Ollama model available for the scheduled run");
    }
    const prompt = buildPrompt(job, contextBlock);

    // A scheduled run must terminate. Without this an agent stuck in a tool
    // retry loop holds its in-flight slot forever and the job never fires
    // again — the failure mode is silence, which is the hardest kind to notice.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

    const toolCalls: string[] = [];
    try {
      const result = await getAiResponse(
        prompt,
        model,
        controller.signal,
        (toolName) => {
          toolCalls.push(toolName);
        }
      );

      // The run record is what you read later to find out what happened at 3am,
      // so it carries the inputs as well as the answer.
      return [
        `# ${job.name}`,
        "",
        `- ran: ${new Date().toISOString()}`,
        `- model: ${model}`,
        `- schedule: \`${job.schedule}\``,
        toolCalls.length ? `- tools: ${toolCalls.join(", ")}` : "- tools: none",
        "",
        contextBlock ? "## What changed\n\n" + contextBlock + "\n" : "",
        "## Result",
        "",
        result.content ?? "(no content)",
      ]
        .filter(Boolean)
        .join("\n");
    } finally {
      clearTimeout(timer);
    }
  });
}
