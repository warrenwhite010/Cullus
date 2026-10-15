// Ollama discovery helpers.
//
// Node 18+ ships a global fetch(), so there is no node-fetch dependency here.
// Nothing in this file invents model tags: if Ollama is unreachable or has no
// models pulled we say so, rather than offering a dropdown of models that do
// not exist.

import ollama from "ollama";

const OLLAMA_URL = process.env.OLLAMA_HOST || "http://localhost:11434";

/** Conservative context window when a model does not report one. */
export const FALLBACK_CONTEXT_LENGTH = 4096;

export interface OllamaHealth {
  running: boolean;
  url: string;
  models: string[];
  /** Human-readable reason plus the command that fixes it, when not healthy. */
  error?: string;
  hint?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Local model tags, newest first as Ollama reports them.
 * Returns an empty array when Ollama is down or has nothing pulled — callers
 * are expected to surface that state rather than paper over it.
 */
export async function getLocalOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}

/**
 * Model tags with their on-disk size, for the worker-dial memory estimate.
 *
 * Sizes matter because the fan-out dial is a memory decision: N workers on one
 * model load ONE copy of these bytes, while a second distinct model loads its own.
 */
export async function getModelSizes(): Promise<Array<{ name: string; size: number }>> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];

    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string; size?: number }> };
    return (data.models ?? [])
      .map((m) => ({ name: m.name ?? m.model ?? "", size: typeof m.size === "number" ? m.size : 0 }))
      .filter((m) => m.name);
  } catch {
    return [];
  }
}

/** Is Ollama reachable, and does it have anything to run? */
export async function getOllamaHealth(): Promise<OllamaHealth> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        running: false,
        url: OLLAMA_URL,
        models: [],
        error: `Ollama answered ${response.status} ${response.statusText}.`,
        hint: "Restart it with `ollama serve`.",
      };
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = (data.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((name): name is string => Boolean(name));

    if (models.length === 0) {
      return {
        running: true,
        url: OLLAMA_URL,
        models: [],
        error: "Ollama is running but no models are pulled.",
        hint: "Pull one, e.g. `ollama pull qwen3.5:9b`.",
      };
    }

    return { running: true, url: OLLAMA_URL, models };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      running: false,
      url: OLLAMA_URL,
      models: [],
      error: timedOut
        ? `Ollama at ${OLLAMA_URL} did not respond within 5s.`
        : `Cannot reach Ollama at ${OLLAMA_URL}.`,
      hint: "Start it with `ollama serve` (or open the Ollama app).",
    };
  }
}

/**
 * The model's advertised context window, used for the UI's context bar.
 * Ollama reports this under a family-prefixed key such as `qwen3.tcontext_length`,
 * so we scan for any `*.context_length` entry.
 */
export async function getModelContextLength(model: string): Promise<number> {
  try {
    const info: any = await ollama.show({ model });
    const modelInfo = info?.model_info ?? {};

    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith("context_length") && typeof value === "number" && value > 0) {
        return value;
      }
    }

    // `num_ctx` in the Modelfile parameters overrides the architecture default.
    const numCtx = String(info?.parameters ?? "").match(/num_ctx\s+(\d+)/);
    if (numCtx) return parseInt(numCtx[1], 10);

    return FALLBACK_CONTEXT_LENGTH;
  } catch {
    return FALLBACK_CONTEXT_LENGTH;
  }
}

export interface JsonAnswer<T> {
  ok: boolean;
  value?: T;
  /** Raw text when parsing or validation failed, for the report. */
  raw?: string;
  error?: string;
}

/**
 * Ask a model for ONE JSON object and nothing else.
 *
 * Deliberately not getAiResponse(): that carries the whole tool catalogue, the
 * conversation history and the session switches, all of which make a 2B model
 * worse at a narrow question like "which of these files matter". Here there are
 * no tools, no history, temperature 0, and a schema handed to Ollama's
 * structured-output support so the shape is constrained at generation time.
 *
 * `validate` is applied to the parsed object; a failure is retried ONCE with the
 * error text appended, which is where small models usually recover.
 */
export async function chatJson<T>(
  model: string,
  system: string,
  user: string,
  schema: any,
  validate?: (value: any) => string | null,
  signal?: AbortSignal
): Promise<JsonAnswer<T>> {
  let lastRaw = "";
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return { ok: false, error: "Cancelled." };

    const prompt =
      attempt === 1
        ? user
        : `${user}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON only.`;

    let raw = "";
    try {
      const response: any = await ollama.chat({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        // Newer Ollama constrains generation to a JSON Schema; older builds only
        // understand "json". Passing the schema and falling back covers both.
        format: schema ?? "json",
        stream: false,
        options: { temperature: 0 },
      });
      raw = String(response?.message?.content ?? "").trim();
    } catch (err: any) {
      if (/format/i.test(err?.message ?? "") && schema) {
        try {
          const response: any = await ollama.chat({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            format: "json",
            stream: false,
            options: { temperature: 0 },
          });
          raw = String(response?.message?.content ?? "").trim();
        } catch (retryErr: any) {
          return { ok: false, error: retryErr.message };
        }
      } else {
        return { ok: false, error: err.message };
      }
    }

    lastRaw = raw;

    // Models wrap JSON in prose or fences even when told not to; take the widest
    // brace-delimited span rather than failing the round over formatting.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const candidate = start !== -1 && end > start ? raw.slice(start, end + 1) : raw;

    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch (err: any) {
      lastError = `not valid JSON (${err.message})`;
      continue;
    }

    const problem = validate?.(parsed);
    if (problem) {
      lastError = problem;
      continue;
    }

    return { ok: true, value: parsed as T, raw };
  }

  return { ok: false, raw: lastRaw, error: lastError || "The model did not return usable JSON." };
}

/**
 * Pick a usable model: the caller's choice if it exists, else the configured
 * default, else the first available tag. Returns null when nothing is available.
 */
export async function resolveModel(
  requested: string | null | undefined,
  configuredDefault: string | null | undefined
): Promise<string | null> {
  const available = await getLocalOllamaModels();
  if (available.length === 0) return null;

  for (const candidate of [requested, configuredDefault]) {
    if (!candidate) continue;
    if (available.includes(candidate)) return candidate;
    // Tolerate a missing `:latest` suffix.
    const withLatest = candidate.includes(":") ? candidate : `${candidate}:latest`;
    if (available.includes(withLatest)) return withLatest;
  }

  return available[0];
}
