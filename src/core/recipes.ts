// Shell recipes: commands you keep re-typing, defined as vault notes.
//
// A note in the configured recipes folder becomes a callable tool:
//
//     ---
//     description: rebuild and restart the assistant
//     command: npm start
//     ---
//     Anything below the frontmatter is for you, not the runner.
//
// The safety property that makes this worth having, and the reason it is not just
// `execute_shell_command` with extra steps: **the model chooses which recipe to
// run, never what the command is.** The command string comes from a file you
// wrote. A model can pick the wrong recipe; it cannot compose `rm -rf` and it
// cannot smuggle arguments, because there is no interpolation at all.
//
// No arguments in v1 on purpose. `{{arg}}` substitution would put model-generated
// text into a shell string, which is the one thing this design exists to avoid.

import { execSync } from "child_process";
import { vaultPathFor, resolveInVault, listVaultNotes, writeVaultNote } from "./vaultStore.js";
import { localToolRegistry } from "./tools.js";
import { logActivity } from "./activity.js";
import * as fs from "fs";

export interface Recipe {
  /** Tool name suffix: `recipe_<slug>`. */
  slug: string;
  name: string;
  description: string;
  command: string;
  vaultPath: string;
}

export interface BrokenRecipe {
  vaultPath: string;
  reason: string;
}

/** Commands too dangerous to accept even from a note the user wrote by hand. */
const REFUSED = /\brm\s+-rf\s+\/(\s|$)|\bmkfs\b|\bdd\s+if=.*of=\/dev\/(disk|sd)|:\(\)\{.*\};:/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Parse one recipe note. Returns the reason when it cannot be used. */
export function parseRecipe(
  absolute: string,
  vaultPath: string,
  name: string
): { recipe?: Recipe; broken?: BrokenRecipe } {
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, "utf-8");
  } catch (err: any) {
    return { broken: { vaultPath, reason: `could not be read (${err.message})` } };
  }

  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    return { broken: { vaultPath, reason: "has no frontmatter block" } };
  }

  const field = (key: string): string | null => {
    const match = frontmatter[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
  };

  const command = field("command");
  if (!command) {
    return { broken: { vaultPath, reason: "has no `command:` line in its frontmatter" } };
  }
  if (REFUSED.test(command)) {
    return { broken: { vaultPath, reason: "contains a command this tool refuses to run" } };
  }

  const slug = slugify(name);
  if (!slug) return { broken: { vaultPath, reason: "has a name with no usable characters" } };

  return {
    recipe: {
      slug,
      name,
      description: field("description") ?? `Run: ${command}`,
      command,
      vaultPath,
    },
  };
}

export interface RecipeScan {
  recipes: Recipe[];
  broken: BrokenRecipe[];
}

/** Every recipe note in the configured folder. */
export function scanRecipes(): RecipeScan {
  const folder = vaultPathFor("recipes");
  if (!folder) return { recipes: [], broken: [] };

  const recipes: Recipe[] = [];
  const broken: BrokenRecipe[] = [];

  for (const entry of listVaultNotes(folder)) {
    const relative = `${folder}/${entry}`;
    const resolved = resolveInVault(relative);
    if (!resolved.ok) continue;

    const parsed = parseRecipe(resolved.absolute, relative, entry.replace(/\.md$/, ""));
    if (parsed.recipe) recipes.push(parsed.recipe);
    else if (parsed.broken) broken.push(parsed.broken);
  }

  return { recipes, broken };
}

export interface CreateRecipeResult {
  ok: boolean;
  error?: string;
  toolName?: string;
  vaultPath?: string;
}

/**
 * Write a new recipe note and register it immediately.
 *
 * Exists so adding a tool is one command rather than "create a note, remember the
 * two frontmatter keys, get the folder right, reload". Everything is validated
 * here rather than at call time, because a recipe that silently fails to register
 * is indistinguishable from one that was never created.
 */
export function createRecipe(
  name: string,
  description: string,
  command: string
): CreateRecipeResult {
  const folder = vaultPathFor("recipes");
  if (!folder) {
    return {
      ok: false,
      error:
        "No recipes folder configured. Set one in Settings → Vault memory (for example " +
        "`_assistant/recipes`), then try again.",
    };
  }

  const slug = slugify(name);
  if (!slug) return { ok: false, error: "The name needs at least one letter or digit." };
  if (!description.trim()) {
    return {
      ok: false,
      error: "A description is required — it is what the model reads when deciding to use this.",
    };
  }
  if (!command.trim()) return { ok: false, error: "A command is required." };

  // Same refusal list the runner uses. Catching it now means the note is never
  // written, rather than sitting in the vault as a permanently broken recipe.
  if (REFUSED.test(command)) {
    return { ok: false, error: `Refusing to create a recipe for "${command}".` };
  }

  // Frontmatter is YAML: a colon or a leading quote in an unquoted scalar breaks
  // the whole block, and the failure shows up later as "no recipes found".
  const quote = (value: string) => JSON.stringify(value.trim());

  const relative = `${folder}/${slug}.md`;
  const existing = resolveInVault(relative);
  if (existing.ok && fs.existsSync(existing.absolute)) {
    return {
      ok: false,
      error: `${relative} already exists. Pick another name, or edit that note directly.`,
    };
  }

  const body =
    `---\n` +
    `description: ${quote(description)}\n` +
    `command: ${quote(command)}\n` +
    `---\n\n` +
    `Created from /newtool. Editing this note changes the tool; deleting it removes the tool.\n\n` +
    `The model chooses whether to run this, never what the command says.\n`;

  const written = writeVaultNote(relative, body);
  if (!written.ok) return { ok: false, error: written.error };

  // Register now, so the tool is callable in the very next message.
  const scan = registerRecipeTools();
  const created = scan.recipes.find((r) => r.slug === slug);
  if (!created) {
    const why = scan.broken.find((b) => b.vaultPath === relative)?.reason;
    return { ok: false, error: why ?? `Wrote ${relative}, but it did not register as a recipe.` };
  }

  return { ok: true, toolName: `recipe_${slug}`, vaultPath: relative };
}

/** Tool names registered on the last pass, so a removed note stops being callable. */
let registered: string[] = [];

/**
 * Register one tool per recipe. Safe to call repeatedly — the UI refreshes after
 * the recipes folder changes.
 */
export function registerRecipeTools(): RecipeScan {
  const scan = scanRecipes();

  for (const name of registered) localToolRegistry.unregister(name);
  registered = [];

  for (const recipe of scan.recipes) {
    const toolName = `recipe_${recipe.slug}`;

    localToolRegistry.register({
      name: toolName,
      description:
        `${recipe.description} — runs the fixed command \`${recipe.command}\` ` +
        `defined in ${recipe.vaultPath}. Takes no arguments.`,
      parameters: { type: "object", properties: {} },
      handler: () => {
        logActivity({
          kind: "command",
          status: "running",
          label: recipe.command,
          summary: `recipe ${recipe.name}`,
        });

        try {
          const output = execSync(recipe.command, {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          });

          logActivity({
            kind: "command",
            status: "ok",
            label: recipe.command,
            summary: `recipe ${recipe.name} finished`,
            detail: output,
          });

          return {
            success: true,
            recipe: recipe.name,
            command: recipe.command,
            output: output.trim() || "(the command printed nothing)",
          };
        } catch (error: any) {
          logActivity({
            kind: "command",
            status: "fail",
            label: recipe.command,
            summary: `recipe ${recipe.name} failed`,
            detail: `${error.message}\n${error.stderr ?? ""}`,
          });

          return {
            error: true,
            recipe: recipe.name,
            command: recipe.command,
            message: error.message,
            stderr: String(error.stderr ?? "").slice(0, 2000),
            actionRequired:
              `The recipe failed. Report the error to the user — do NOT try to run a modified ` +
              `version of the command, because the recipe's text is the user's, not yours.`,
          };
        }
      },
    });

    registered.push(toolName);
  }

  // Broken notes are reported, never skipped in silence: a recipe that vanished
  // because of a typo in its frontmatter is worse than one that errors loudly.
  for (const bad of scan.broken) {
    console.warn(`⚠️  Recipe ${bad.vaultPath} ${bad.reason}.`);
    logActivity({
      kind: "server",
      status: "warn",
      label: `recipe ignored: ${bad.vaultPath}`,
      summary: bad.reason,
    });
  }

  if (scan.recipes.length > 0) {
    console.log(
      `🍳 ${scan.recipes.length} recipe(s) from the vault: ${scan.recipes.map((r) => `recipe_${r.slug}`).join(", ")}`
    );
  }

  return scan;
}
