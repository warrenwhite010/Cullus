/**
 * Images returned by a tool are written to disk and replaced by their path.
 *
 * Measured on a real run: `get_viewport_screenshot` came back as an MCP image
 * part carrying 130,784 characters of base64 — about 33,000 tokens, against a
 * per-result cap of 8,000, so what actually reached the model was a truncated
 * fragment of a PNG. The model's own report said it: "the image came back as raw
 * base64 that I could not visually parse in this environment, so I verified the
 * shape by measurement instead". It was right to fall back, and it should never
 * have had to — nothing downstream of that call could use those bytes.
 *
 * So the bytes go where bytes belong. The caller gets a path, the dimensions
 * where the tool reported them, and the file size; anything that can open a PNG
 * can open it, and the transcript costs one line instead of a third of a context
 * window. A vision-capable caller reads the file; a text-only local model at
 * least has something concrete to hand the user, which is strictly better than a
 * clipped base64 string.
 */

import fs from "fs";
import os from "os";
import path from "path";

/** Where diverted images land. One directory, easy to clear, easy to find. */
export function captureDirectory(): string {
  const root = process.env.CULLUS_CAPTURE_DIR
    ?? path.join(os.homedir(), ".cullus", "captures");

  fs.mkdirSync(root, { recursive: true });
  return root;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Base64 payloads smaller than this stay inline — a tiny icon is not a problem. */
const DIVERT_OVER_CHARS = 4_000;

export interface DivertedImages {
  result: any;
  /** Files written, in the order they appeared. */
  files: string[];
}

/**
 * Replace large image parts in an MCP result with a text part naming the file.
 *
 * Non-image results, and images small enough to be harmless, are returned
 * untouched and identically — callers rely on that to avoid rewriting every
 * result that passes through.
 */
export function divertImageContent(
  result: any,
  context: { tool: string; directory?: string }
): DivertedImages {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return { result, files: [] };
  }

  const hasLargeImage = result.content.some(
    (part: any) =>
      part?.type === "image" && typeof part?.data === "string" && part.data.length > DIVERT_OVER_CHARS
  );

  if (!hasLargeImage) return { result, files: [] };

  const directory = context.directory ?? captureDirectory();
  const files: string[] = [];

  const content = result.content.map((part: any) => {
    if (part?.type !== "image" || typeof part?.data !== "string" || part.data.length <= DIVERT_OVER_CHARS) {
      return part;
    }

    const mime = typeof part.mimeType === "string" ? part.mimeType : "image/png";
    const extension = EXTENSIONS[mime] ?? "bin";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTool = context.tool.replace(/[^a-z0-9_-]+/gi, "_");
    const file = path.join(directory, `${safeTool}-${stamp}-${files.length + 1}.${extension}`);

    try {
      fs.writeFileSync(file, Buffer.from(part.data, "base64"));
    } catch (error: any) {
      // Keep the original part rather than losing the image: a diversion that
      // fails must not also destroy the only copy of the bytes.
      return part;
    }

    files.push(file);
    const bytes = Buffer.byteLength(part.data, "base64");

    return {
      type: "text",
      text: JSON.stringify({
        image: file,
        mimeType: mime,
        bytes,
        note:
          `The image was written to ${file} instead of being returned inline — it was ` +
          `${part.data.length.toLocaleString()} characters of base64, which would have been ` +
          `truncated to a useless fragment. Open that path to look at it. If you cannot view ` +
          `images, do NOT guess at what it shows: verify by measurement instead (read the ` +
          `positions, sizes and counts you care about) and give the user the path so they can ` +
          `look for themselves.`,
      }),
    };
  });

  return { result: { ...result, content }, files };
}
