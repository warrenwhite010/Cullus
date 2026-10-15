import { getAiResponse, AssistantError, type AiResult, type TokenUsage } from "./provider.js";
import { resolveModel } from "./ollama.js";
import { loadConfig } from "./config.js";

interface PipelineConfig {
  triageModel: string;
  engineerModel: string;
  managerModel: string;
}

/**
 * Three-stage pipeline: triage → engineer → manager.
 *
 * A stage that fails does not kill the run. Its error is reported as that
 * stage's output and the previous context is carried forward, so a small model
 * fumbling one step still produces a usable result from the others.
 */
export async function runAgentPipeline(
  userQuery: string,
  config: PipelineConfig,
  onStepFinished: (role: string, output: string) => void
): Promise<AiResult> {
  const configuredDefault = loadConfig().defaultModel;

  const pipeline = [
    {
      roleName: "Triage & Validator",
      systemPrompt:
        "You are a strict architectural triage analyst. Inspect the request, scope required files, and output a concise execution plan. Do NOT implement code or call tools.",
      model: config?.triageModel,
    },
    {
      roleName: "Systems Engineer",
      systemPrompt:
        "You are a rigorous backend execution engineer. You have full access to terminal command execution and file manipulation tools. Execute the plan step-by-step using precise actions.",
      model: config?.engineerModel,
    },
    {
      roleName: "Engineering Manager",
      systemPrompt: `You are a technical director reviewing executed artifacts.

      FORMATTING CONSTRAINTS (ADHD-Optimized):
      - Start immediately with the answer or next action. Zero introductory text.
      - Number multi-step procedures (max 5 per block).
      - Eliminate all pleasantries, recaps, and closing phrases.
      - End with exactly one clear, actionable next step.`,
      model: config?.managerModel,
    },
  ];

  const totals: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextLength: 0,
    steps: 0,
    peakPromptTokens: 0,
  };
  const degraded: string[] = [];

  let currentContext = userQuery;
  let lastGoodOutput = "";
  let succeeded = 0;

  for (const step of pipeline) {
    const model = await resolveModel(step.model, configuredDefault);

    if (!model) {
      throw new AssistantError(
        "No Ollama models are available, so the pipeline cannot run.",
        "Pull one with `ollama pull qwen3.5:9b`, then reload the dashboard."
      );
    }

    if (step.model && model !== step.model) {
      degraded.push(`${step.roleName}: "${step.model}" isn't available — used "${model}" instead.`);
    }

    onStepFinished(step.roleName, "Working...");

    const prefixedPrompt = `[Pipeline Role: ${step.roleName}] \nInstructions: ${step.systemPrompt}\n\nInput Data / Request:\n${currentContext}`;

    try {
      const result = await getAiResponse(prefixedPrompt, model);

      totals.promptTokens += result.usage.promptTokens;
      totals.completionTokens += result.usage.completionTokens;
      totals.totalTokens = totals.promptTokens + totals.completionTokens;
      totals.contextLength = Math.max(totals.contextLength, result.usage.contextLength);
      totals.steps += result.usage.steps;
      // Max, not sum — see peakPromptTokens on TokenUsage.
      totals.peakPromptTokens = Math.max(totals.peakPromptTokens, result.usage.peakPromptTokens);
      degraded.push(...result.degraded.map((d) => `${step.roleName}: ${d}`));

      currentContext = result.content;
      lastGoodOutput = result.content;
      succeeded++;

      onStepFinished(step.roleName, result.content);
    } catch (err: any) {
      const hint = err instanceof AssistantError && err.hint ? `\nFix: ${err.hint}` : "";
      const message = `⚠️ ${step.roleName} failed: ${err.message}${hint}`;

      degraded.push(`${step.roleName} failed: ${err.message}`);
      onStepFinished(step.roleName, message);

      // Carry the previous stage's output forward so later stages still have input.
      currentContext = lastGoodOutput || userQuery;
    }
  }

  if (succeeded === 0) {
    throw new AssistantError(
      "All three pipeline stages failed.",
      "Check that Ollama is running and the selected models are pulled (`ollama list`)."
    );
  }

  return {
    content: currentContext,
    usage: totals,
    degraded,
  };
}
