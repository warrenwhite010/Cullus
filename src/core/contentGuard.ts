// Cleaning up file content on its way to a write tool.
//
// Small models answer in chat formatting even when the destination is a file.
// Asked to update a `.json`, they produce:
//
//     ```json
//     { "port": 3000 }
//     ```
//
// and the fence goes into the file verbatim, so the JSON no longer parses. The
// next turn reads it back, sees corruption, and tries to "fix" it — usually by
// rewriting more of the file, from a state that is already wrong.
//
// Two guards, applied at the single tool-call chokepoint:
//
//   1. Strip a fence that wraps the WHOLE value, and only for file types where a
//      fence cannot be legitimate content. A `.md` note may genuinely be one code
//      block; a `.json` file never is.
//   2. Parse `.json` before it is written. A malformed write is refused and the
//      parser's own message goes back to the model, which is far more actionable
//      than discovering it on the next read.

/** Argument names that carry file content across the tools we route. */
const CONTENT_KEYS = new Set(["content", "text", "newText", "oldText", "body", "data"]);

/** Argument names that carry a destination path. */
const PATH_KEYS = ["path", "file_path", "filePath", "target", "destination"];

/**
 * Extensions where a wrapping fence is always an artefact, never the content.
 *
 * Deliberately a list of known formats rather than "anything that is not .md":
 * an unknown extension gets left alone, because guessing wrong corrupts a file
 * just as surely as the fence did.
 */
const FENCE_NEVER_VALID = new Set([
  "json", "jsonc", "json5",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "css", "scss", "less", "html", "htm", "xml", "svg",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "proto",
]);

export function extensionOf(filePath: string): string {
  const base = String(filePath ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function pathFrom(args: Record<string, any>): string {
  for (const key of PATH_KEYS) {
    if (typeof args?.[key] === "string") return args[key];
  }
  return "";
}

/**
 * Remove a code fence that wraps the entire string.
 *
 * Only a fence on both ends counts. A value that merely CONTAINS a fence is left
 * alone — that is a file which genuinely includes a code sample, and trimming
 * inside it would be the corruption we are trying to prevent.
 */
export function stripWrappingFence(value: string): { text: string; stripped: boolean } {
  const trimmed = value.trim();

  // ```lang\n … \n```   (the language tag is optional)
  const match = /^```[^\n`]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (match) return { text: match[1], stripped: true };

  // A single-line ```{ "a": 1 }``` — rarer, but the same mistake.
  const inline = /^```([^\n`]*)```$/.exec(trimmed);
  if (inline && inline[1].trim()) return { text: inline[1].trim(), stripped: true };

  return { text: value, stripped: false };
}

export interface GuardResult {
  args: Record<string, any>;
  /** Human-readable notes about what was cleaned, for the activity log. */
  cleaned: string[];
  /** Set when the write must not proceed. */
  refusal?: {
    error: true;
    message: string;
    actionRequired: string;
  };
}

/**
 * Clean and validate the arguments of a file-writing tool.
 *
 * Returns the arguments to actually dispatch, plus a refusal when the write would
 * produce a file that cannot be parsed.
 */
export function guardFileContent(toolName: string, rawArgs: any): GuardResult {
  const cleaned: string[] = [];

  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: rawArgs, cleaned };
  }

  const args: Record<string, any> = { ...rawArgs };
  const filePath = pathFrom(args);
  const extension = extensionOf(filePath);

  // Nothing here applies to a call that is not writing a file.
  if (!filePath) return { args, cleaned };

  const fenceIsNeverValid = FENCE_NEVER_VALID.has(extension);

  for (const key of Object.keys(args)) {
    if (!CONTENT_KEYS.has(key) || typeof args[key] !== "string") continue;
    if (!fenceIsNeverValid) continue;

    const { text, stripped } = stripWrappingFence(args[key]);
    if (stripped) {
      args[key] = text;
      cleaned.push(`removed a markdown code fence around "${key}"`);
    }
  }

  // Structured edits (edit_file) carry their content one level down.
  if (Array.isArray(args.edits) && fenceIsNeverValid) {
    args.edits = args.edits.map((edit: any) => {
      if (!edit || typeof edit !== "object") return edit;
      const next = { ...edit };
      for (const key of ["oldText", "newText"]) {
        if (typeof next[key] !== "string") continue;
        const { text, stripped } = stripWrappingFence(next[key]);
        if (stripped) {
          next[key] = text;
          cleaned.push(`removed a markdown code fence around an edit's "${key}"`);
        }
      }
      return next;
    });
  }

  // A whole-file JSON write is checkable before it lands. An `edits` array is
  // not — it is a fragment, and the result only exists after the server applies
  // it — so those get the fence strip and nothing more.
  const isWholeFileWrite = typeof args.content === "string" || typeof args.text === "string";

  if ((extension === "json" || extension === "jsonc") && isWholeFileWrite) {
    const body = (typeof args.content === "string" ? args.content : args.text) as string;

    if (body.trim()) {
      try {
        JSON.parse(body);
      } catch (err: any) {
        return {
          args,
          cleaned,
          refusal: {
            error: true,
            message:
              `Refusing to write ${filePath}: the content is not valid JSON. ` +
              `${err?.message ?? "Parse failed."}`,
            actionRequired:
              "The file was NOT modified, so nothing is broken. Send the corrected file as raw " +
              "JSON only — no markdown fences, no ``` markers, no commentary before or after, " +
              "no trailing commas, and double quotes on every key and string. If you are unsure " +
              "of the current contents, read the file again before rewriting it.",
          },
        };
      }
    }
  }

  return { args, cleaned };
}
