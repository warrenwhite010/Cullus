import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as os from "os";
import { getVaultPath, isVaultReadOnly, vaultReadOnlyError } from "./config.js";
import { setTasks, startTask, setTaskStatus, listTasks } from "./tasks.js";
import { writeVaultNote, vaultPathFor, resolveInVault } from "./vaultStore.js";
import { listSkills, writeSkill } from "./skills.js";
import { askUser, type InquiryOption } from "./inquiry.js";
import { readToolResult, listToolResults } from "./toolResults.js";

export interface CLIPlatformTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<any> | any;
}

class ToolRegistry {
  private tools: Map<string, CLIPlatformTool> = new Map();

  public register(tool: CLIPlatformTool) {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): CLIPlatformTool | undefined {
    return this.tools.get(name);
  }

  /** Drop a tool, so a recipe note that was deleted stops being callable. */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  public getAllSchemas() {
    const schemas: any[] = [];
    for (const [name, tool] of this.tools.entries()) {
      schemas.push({
        type: "function",
        function: {
          name: tool.name,
          description: `[Local Utility] ${tool.description}`,
          parameters: tool.parameters,
        },
      });
    }
    return schemas;
  }
}

export const localToolRegistry = new ToolRegistry();

// ---------------------------------------------------------------------------
// Vault access is owned entirely by the `obsidian-live` MCP server: the Local
// REST API plugin, reached over authenticated local HTTPS.
//
// This file used to also register list_vault_directories / create_vault_note /
// read_vault_note. They were retired for two reasons:
//
//   1. Safety. Read-only mode withholds the vault server's write tools, but
//      these local tools had no such notion, so a model simply fell back to them
//      and wrote to the vault anyway. Read-only was cosmetic.
//   2. Reliability. They duplicated the plugin's own note tools, and small
//      models pick badly when handed two routes to the same goal.
//
// The read-only guard on execute_shell_command below stays, because a shell is
// the widest write path of all and the vault server cannot police it.
//
// resolveInsideVault is retained: the shell guard relies on knowing the vault
// root, and it documents the containment rule for anything added here later.
// ---------------------------------------------------------------------------

/** Reject paths that try to escape the vault via `..` or an absolute prefix. */
export function resolveInsideVault(
  vaultRoot: string,
  relative: string
): { ok: true; path: string } | { ok: false; error: string; actionRequired: string } {
  const resolved = path.resolve(vaultRoot, relative ?? "");
  const normalisedRoot = path.resolve(vaultRoot);

  if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + path.sep)) {
    return {
      ok: false,
      error: `Path "${relative}" resolves outside the vault.`,
      actionRequired:
        "Use a path relative to the vault root, with no leading slash and no `..` segments.",
    };
  }

  return { ok: true, path: resolved };
}

// Register a system shell execution tool
localToolRegistry.register({
  name: "execute_shell_command",
  description: "Execute a safe terminal shell command (like mkdir, ls, etc.) in the current workspace.",
  parameters: {
    type: "object",
    properties: {
      command: { 
        type: "string", 
        description: "The exact terminal command to execute (e.g., 'mkdir Test')" 
      },
    },
    required: ["command"],
  },
  handler: (args) => {
    if (!args?.command || typeof args.command !== "string") {
      return {
        error: true,
        message: "command is required and must be a string.",
        actionRequired: 'Call execute_shell_command again with {"command": "<the command>"}.',
      };
    }

    // A shell is the widest write path there is, so it must respect read-only
    // too. This blocks commands that name the vault while writes are forbidden.
    // It is a guard, not a sandbox — see the note on execute_shell_command.
    const vaultPath = getVaultPath();
    if (vaultPath && isVaultReadOnly()) {
      const command = args.command;
      const namesVault =
        command.includes(vaultPath) ||
        command.includes(vaultPath.replace(os.homedir(), "~")) ||
        command.includes(path.basename(vaultPath));
      const mutates =
        />|>>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bsed\s+-i|\btruncate\b|\bdd\b|\bln\b|\bchmod\b|\bchown\b/.test(
          command
        );

      if (namesVault && mutates) {
        return vaultReadOnlyError("writing to the vault via the shell");
      }
    }

    try {
      const output = execSync(args.command, {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      // Be explicit about an empty result: a bare "(no output)" alongside
      // success:true reads as "worked" and sends small models into a retry loop.
      if (!output || output.trim() === "") {
        return {
          success: true,
          command: args.command,
          output: "",
          note: "The command exited 0 but printed nothing. It produced no data to work with.",
          actionRequired:
            "Do not re-run a variation of this command hoping for output. Use a different " +
            "command, a different tool, or tell the user this information isn't available here.",
        };
      }

      return { success: true, command: args.command, output };
    } catch (error: any) {
      // Non-zero exit is information, not a crash — hand stderr back to the model.
      return {
        error: true,
        message: error.message,
        stderr: String(error.stderr ?? "").slice(0, 2000),
        stdout: String(error.stdout ?? "").slice(0, 2000),
        actionRequired:
          "The command failed. Read stderr, then either correct it or report the problem " +
          "to the user. Do not re-run the same command unchanged.",
      };
    }
  },
});
// ---------------------------------------------------------------------------
// The work checklist.
//
// Small models routinely announce a five-step plan and then lose it after step
// two. These tools make the plan a real object the user can watch: the list is
// rendered live in the sidebar, so a dropped step is visible rather than silent.
// Deliberately two tiny tools rather than one general one — a 2B model handles
// "write the list" and "tick an item" far better than a single tool with a mode
// argument.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Asking the user, without ending the turn.
//
// The alternative the model reaches for otherwise is to write the question as
// its final answer and stop — which throws away the tool loop and makes the user
// restate context. Registered as a normal tool so it works mid-loop, and so a
// question is answerable by picking rather than by typing prose the model then
// has to parse.
// ---------------------------------------------------------------------------

localToolRegistry.register({
  name: "ask_user",
  description:
    "Ask the user a question and wait for their answer, without ending your turn. Use " +
    "this the moment you need a decision only they can make — which of several " +
    "approaches to take, which file or account to act on, whether to spend real money. " +
    "Give 2-5 concrete options where you can; they are shown as a list the user picks " +
    "from with the arrow keys, and they can also type a different answer. Prefer this " +
    "over ending your reply with an open question. Do not use it for things you can " +
    "determine yourself with other tools.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question, in one sentence. Say what the choice affects.",
      },
      options: {
        type: "array",
        description:
          "The choices, best first. Each is either a string, or " +
          '{"label":"...","description":"what happens if picked"}.',
        items: { type: "string" },
      },
      multiSelect: {
        type: "boolean",
        description: "True if several options may be chosen at once. Default false.",
      },
    },
    required: ["question"],
  },
  handler: async (args) => {
    const question = typeof args?.question === "string" ? args.question.trim() : "";
    if (!question) {
      return {
        error: true,
        message: "question is required.",
        actionRequired:
          'Call ask_user again with {"question":"...","options":["first","second"]}.',
      };
    }

    // Both shapes accepted: small models emit a bare string array far more
    // reliably than an array of objects, and rejecting that costs a whole step.
    const options: InquiryOption[] = (Array.isArray(args?.options) ? args.options : [])
      .map((option: any) => {
        if (typeof option === "string") return { label: option.trim() };
        if (option && typeof option.label === "string") {
          return {
            label: option.label.trim(),
            description:
              typeof option.description === "string" ? option.description.trim() : undefined,
          };
        }
        return null;
      })
      .filter((option: InquiryOption | null): option is InquiryOption =>
        Boolean(option && option.label)
      )
      .slice(0, 10);

    const outcome = await askUser(question, options, {
      multiSelect: args?.multiSelect === true,
    });

    // "Nobody answered" must not read as "the user said no". Spell out what to
    // do instead, or the model stalls re-asking the same question.
    if (outcome.unanswered) {
      return {
        answered: false,
        reason: outcome.reason ?? "no answer",
        actionRequired:
          "Do not ask again. Choose the most reasonable option yourself, continue the work, " +
          "and state plainly in your final answer which assumption you made.",
      };
    }

    return {
      answered: true,
      question,
      chosen: outcome.chosen,
      text: outcome.text,
      actionRequired:
        "Act on this answer now — do not confirm it back to the user or ask a follow-up " +
        "unless the answer left something genuinely undecided.",
    };
  },
});

localToolRegistry.register({
  name: "plan_tasks",
  description:
    "Write the checklist of steps you are about to do, in order. Call this once, " +
    "before starting multi-step work, then call complete_task as each step finishes.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Short imperative steps, e.g. ['Read the config', 'Fix the URL'].",
        items: { type: "string" },
      },
    },
    required: ["steps"],
  },
  handler: (args) => {
    const raw = Array.isArray(args?.steps) ? args.steps : [];
    const steps = raw
      .map((step: any) => (typeof step === "string" ? step : step?.subject))
      .filter((step: any): step is string => typeof step === "string" && step.trim().length > 0)
      .map((step: string) => ({ subject: step.trim() }));

    if (steps.length === 0) {
      return {
        error: true,
        message: "steps must be a non-empty array of strings.",
        actionRequired: 'Call plan_tasks again with {"steps":["first step","second step"]}.',
      };
    }

    const tasks = setTasks(steps, "chat");
    if (tasks[0]) startTask(tasks[0].id);

    return { ok: true, tasks: listTasks().map((t) => ({ id: t.id, subject: t.subject, status: t.status })) };
  },
});

localToolRegistry.register({
  name: "complete_task",
  description:
    "Mark one checklist step finished (or failed) and start the next one. Use the id " +
    "or the exact text returned by plan_tasks.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The step's id or its exact text." },
      failed: { type: "boolean", description: "True if the step could not be completed." },
    },
    required: ["task"],
  },
  handler: (args) => {
    const target = typeof args?.task === "string" ? args.task.trim() : "";
    if (!target) {
      return {
        error: true,
        message: "task is required.",
        actionRequired: 'Call complete_task again with {"task":"<id or exact step text>"}.',
      };
    }

    const found = setTaskStatus(target, args?.failed ? "failed" : "done");
    if (!found) {
      return {
        error: true,
        message: `No checklist step matches "${target}".`,
        currentTasks: listTasks().map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
        actionRequired: "Use one of the ids listed in currentTasks, or call plan_tasks to start a new list.",
      };
    }

    const next = listTasks().find((t) => t.status === "pending");
    if (next) startTask(next.id);

    return {
      ok: true,
      next: next ? { id: next.id, subject: next.subject } : null,
      tasks: listTasks().map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
    };
  },
});

// ---------------------------------------------------------------------------
// Skills: capturing a method so it can be run again.
//
// A note records what happened; a skill changes what happens next, because the
// file becomes a slash command and steers a later conversation. That difference
// is why skill_write always asks before writing, even outside the vault, and why
// it refuses to overwrite without being told to.
// ---------------------------------------------------------------------------

localToolRegistry.register({
  name: "list_skills",
  description:
    "List every skill currently available, with its description. Call this before " +
    "writing a new skill, to check whether one already covers the same method.",
  parameters: { type: "object", properties: {} },
  handler: () => ({
    skills: listSkills().map((skill) => ({
      name: skill.name,
      description: skill.description,
      command: `/${skill.name}`,
      source: skill.source ?? (skill.builtin ? "builtin" : "file"),
    })),
  }),
});

localToolRegistry.register({
  name: "skill_write",
  description:
    "Save a reusable method as a skill, making it runnable as a slash command from " +
    "the next message onward. Use this to capture a method that would work again on a " +
    "different subject — not to record a fact, which is what note_write is for. The " +
    "user is asked to confirm before the file is written.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short kebab-case name, which becomes the slash command, e.g. 'check-before-assuming'.",
      },
      description: {
        type: "string",
        description: "One line saying when to reach for this skill. Shown in the command menu.",
      },
      prompt: {
        type: "string",
        description:
          "The skill body: numbered, imperative steps a reader can execute. The user's " +
          "input is appended to the end of this, so finish with a line introducing it.",
      },
      overwrite: {
        type: "boolean",
        description: "Replace an existing skill of the same name. Defaults to false.",
      },
    },
    required: ["name", "description", "prompt"],
  },
  handler: (args) => {
    const result = writeSkill(
      typeof args?.name === "string" ? args.name : "",
      typeof args?.description === "string" ? args.description : "",
      typeof args?.prompt === "string" ? args.prompt : "",
      { overwrite: args?.overwrite === true }
    );

    if (!result.ok) {
      return { error: true, message: result.error, actionRequired: result.actionRequired };
    }

    const slug = String(args.name).trim().toLowerCase().replace(/\s+/g, "-");
    return {
      success: true,
      path: result.path,
      command: `/${slug}`,
      note:
        `Saved to ${result.path}. Tell the user it now runs as /${slug}, and that they can ` +
        `edit it ${result.where === "vault" ? "in their vault like any other note" : "in that file"}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Writing notes into the vault.
//
// This is the assistant's durable memory: what it worked out, what it was told,
// what it decided. It goes into the vault rather than a hidden JSON file so it is
// searchable, linkable and editable in Obsidian like any other note.
//
// The approval gate lives in the inference loop, not here — a vault write asks for
// confirmation in auto and manual mode before this handler ever runs. See
// requiresApproval() in core/approval.ts. Keeping the question there means one
// prompt per call, whatever the route into the vault.
// ---------------------------------------------------------------------------

localToolRegistry.register({
  name: "note_write",
  description:
    "Save a note into the user's Obsidian vault. Use this to record what you learned, " +
    "decided, or were told, so it survives this conversation. The user is asked to " +
    "confirm before the file is written.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Short note title, used as the filename. Goes in the configured notes folder.",
      },
      content: { type: "string", description: "The note body, in markdown." },
      path: {
        type: "string",
        description:
          "Optional explicit vault-relative path, e.g. 'Projects/Torq.md'. Overrides title.",
      },
      append: {
        type: "boolean",
        description: "Append to the note instead of replacing it, when it already exists.",
      },
    },
    required: ["content"],
  },
  handler: (args) => {
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) {
      return {
        error: true,
        message: "content is required.",
        actionRequired: 'Call note_write again with {"title": "...", "content": "<markdown>"}.',
      };
    }

    // An explicit path wins; otherwise the note goes in the configured folder.
    let relative = typeof args?.path === "string" && args.path.trim() ? args.path.trim() : null;

    if (!relative) {
      const folder = vaultPathFor("notes");
      const title = typeof args?.title === "string" && args.title.trim() ? args.title.trim() : "";

      if (!folder && !title) {
        return {
          error: true,
          message: "No notes folder is configured and no path or title was given.",
          actionRequired:
            "Ask the user to set a notes folder in Settings → Vault, or call again with an " +
            "explicit vault-relative path.",
        };
      }

      // Filesystem-safe, but still recognisable in a file list.
      const slug =
        (title || `note-${new Date().toISOString().slice(0, 10)}`)
          .replace(/[\\/:*?"<>|]/g, "-")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80) || "note";

      relative = folder ? `${folder}/${slug}.md` : `${slug}.md`;
    }

    const check = resolveInVault(relative);
    if (!check.ok) {
      return {
        error: true,
        message: check.error,
        actionRequired: "Use a path inside the vault, with no .. segments.",
      };
    }

    const result = writeVaultNote(relative, content, { append: args?.append === true });

    if (!result.ok) return { error: true, message: result.error, actionRequired: result.actionRequired };

    return {
      success: true,
      path: result.path,
      bytes: result.bytes,
      appended: args?.append === true,
      note: `Saved to the vault at ${result.path}. Tell the user where it went.`,
    };
  },
});

// ---------------------------------------------------------------------------
// The named memory folders: drafts, briefs, personal, tasks.
//
// note_write can already reach any of these with an explicit path, but a model
// only files things where it has an obvious affordance to. Four narrow tools with
// names that say when to use them get used; one general tool with a path argument
// does not.
//
// Each is inert until its folder is set in Settings → Vault memory. That is
// deliberate: an unset folder means "I do not want this", and the right response
// is to say so, not to invent a location in someone's vault.
// ---------------------------------------------------------------------------

/** Filesystem-safe, still recognisable in a file list. */
function slugForFilename(value: string, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** Today in the machine's own timezone — a daily note dated in UTC is wrong by teatime. */
function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

function writeIntoRole(options: {
  key: "drafts" | "briefs" | "personal" | "tasks";
  label: string;
  filename: string;
  content: string;
  append: boolean;
}) {
  const folder = vaultPathFor(options.key);
  if (!folder) {
    return {
      error: true,
      message: `No ${options.key} folder is configured, so there is nowhere to file this.`,
      actionRequired:
        `Ask the user to set ${options.label} in Settings → Vault memory, or use note_write ` +
        `with an explicit path instead.`,
    };
  }

  const relative = `${folder}/${options.filename}`;
  const check = resolveInVault(relative);
  if (!check.ok) {
    return { error: true, message: check.error, actionRequired: "Use a path inside the vault." };
  }

  const result = writeVaultNote(relative, options.content, { append: options.append });
  if (!result.ok) {
    return { error: true, message: result.error, actionRequired: result.actionRequired };
  }

  return {
    success: true,
    path: result.path,
    bytes: result.bytes,
    appended: options.append,
    note: `Saved to ${result.path}. Tell the user where it went.`,
  };
}

localToolRegistry.register({
  name: "draft_write",
  description:
    "Save unfinished writing — an email, a message, a document in progress — into the user's " +
    "drafts folder so it can be picked up later. Use this for anything the user will edit and " +
    "send themselves, rather than a finished note.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title, used as the filename." },
      content: { type: "string", description: "The draft body, in markdown." },
      append: { type: "boolean", description: "Add to an existing draft of the same name." },
    },
    required: ["title", "content"],
  },
  handler: (args) => {
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) {
      return { error: true, message: "content is required.", actionRequired: "Call again with the draft body." };
    }
    return writeIntoRole({
      key: "drafts",
      label: "Drafts",
      filename: `${slugForFilename(args?.title, `draft-${localToday()}`)}.md`,
      content,
      append: args?.append === true,
    });
  },
});

localToolRegistry.register({
  name: "brief_write",
  description:
    "Append to the daily brief: what happened, what was decided, what is outstanding. One note " +
    "per day. Use at the end of a working session, or when the user asks for the day to be " +
    "written up.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The entry, in markdown. A few bullets is normal." },
      date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
    },
    required: ["content"],
  },
  handler: (args) => {
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) {
      return { error: true, message: "content is required.", actionRequired: "Call again with the entry body." };
    }

    const raw = typeof args?.date === "string" ? args.date.trim() : "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localToday();

    // Always append: a second call on the same day must add to the day, not
    // replace what the morning already recorded.
    return writeIntoRole({
      key: "briefs",
      label: "Briefs",
      filename: `${date}.md`,
      content,
      append: true,
    });
  },
});

localToolRegistry.register({
  name: "profile_update",
  description:
    "Record a durable fact about the user — how they work, what they prefer, their role, tools, " +
    "or people they work with — in their profile. This note is injected into every future " +
    "conversation, so record only what stays true beyond today. Never record secrets.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The fact, in markdown. One or two lines. Write it as a standing statement, e.g. " +
          "'- Prefers the fix before the explanation.'",
      },
      replace: {
        type: "boolean",
        description:
          "Rewrite the profile note instead of appending. Only when correcting something wrong.",
      },
    },
    required: ["content"],
  },
  handler: (args) => {
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) {
      return { error: true, message: "content is required.", actionRequired: "Call again with the fact." };
    }
    return writeIntoRole({
      key: "personal",
      label: "Personal",
      filename: "profile.md",
      content,
      append: args?.replace !== true,
    });
  },
});

localToolRegistry.register({
  name: "task_write",
  description:
    "Record or update the open tasks for a project, one note per project. Use when the user " +
    "commits to doing something, or when a piece of work is finished and the note should say so.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name, used as the filename." },
      content: {
        type: "string",
        description: "Markdown checklist, e.g. '- [ ] Chase the SEC ticket'.",
      },
      replace: {
        type: "boolean",
        description: "Rewrite the project note instead of appending. Use when restating the whole list.",
      },
    },
    required: ["project", "content"],
  },
  handler: (args) => {
    const content = typeof args?.content === "string" ? args.content : "";
    const project = typeof args?.project === "string" ? args.project.trim() : "";
    if (!content.trim() || !project) {
      return {
        error: true,
        message: "project and content are both required.",
        actionRequired: 'Call again with {"project": "...", "content": "- [ ] ..."}.',
      };
    }
    return writeIntoRole({
      key: "tasks",
      label: "Tasks",
      filename: `${slugForFilename(project, "tasks")}.md`,
      content,
      append: args?.replace !== true,
    });
  },
});

// ---------------------------------------------------------------------------
// Reading past the truncation cap.
//
// Tool results are capped before they enter the transcript, because every one of
// them is re-sent on every later step. The cap used to keep the head and discard
// the rest, which cost a real session an hour: a source file was read to diagnose
// an error on line 100, arrived with line 100 cut off, and the model diagnosed
// the visible half — three times, since each re-read truncated identically. The
// full text is now kept in memory and addressable, so needing the rest is a tool
// call rather than a request for the user to go and change a setting.
// ---------------------------------------------------------------------------

localToolRegistry.register({
  name: "read_tool_result",
  description:
    "Read the rest of a result YOU HAVE ALREADY RECEIVED that came back with " +
    "\"truncated\": true. It carries a resultId; pass that id here with an offset to read " +
    "the omitted middle, and follow nextOffset until it is null. Use this instead of " +
    "re-running the original call: the text is already here, and re-reading a large file " +
    "truncates it exactly the same way again. This tool cannot fetch anything new — if you " +
    "have not yet made a call that returned a resultId, there is nothing for it to read, " +
    "and no id you invent will work.",
  parameters: {
    type: "object",
    properties: {
      resultId: {
        type: "string",
        description: 'The id from the truncated result, e.g. "res_3".',
      },
      offset: {
        type: "number",
        description:
          "Character position to start from. 0 is the beginning; the truncation notice " +
          "tells you where the omitted middle starts.",
      },
      length: {
        type: "number",
        description: "How many characters to return. Default 6000, maximum 20000.",
      },
    },
    required: ["resultId"],
  },
  handler: (args) => {
    const resultId = typeof args?.resultId === "string" ? args.resultId.trim() : "";
    if (!resultId) {
      return {
        error: true,
        message: "resultId is required.",
        available: listToolResults(),
        actionRequired: 'Call again with {"resultId":"res_1","offset":0}.',
      };
    }

    const page = readToolResult(resultId, Number(args?.offset) || 0, Number(args?.length) || 6_000);

    if (!page) {
      const available = listToolResults();

      // Nothing stored at all is a different mistake from a stale id, and it is
      // the common one: measured on three separate runs, two models opened the
      // turn by calling this tool with an invented id — "res_1", "placeholder",
      // "read_text_file", "disc_throw_file" — before they had called anything
      // that could produce a result. "Only the most recent results are kept"
      // reads, to a model in that position, as "your id expired", so it guesses
      // another one. Nine of those calls in one session produced nothing.
      if (available.length === 0) {
        return {
          error: true,
          message:
            `There are no stored tool results yet, so "${resultId}" cannot exist — this turn ` +
            `has not produced a truncated result to page through.`,
          available,
          actionRequired:
            "Do not guess another id. This tool only reads back a result you have ALREADY " +
            "received with \"truncated\": true and a resultId in it. Call the tool that " +
            "actually produces the data you want first — read_text_file to read a file, " +
            "get_scene_hierarchy to inspect a scene, unity_commands to find a command — and " +
            "come back here only if what it returns says it was truncated.",
        };
      }

      return {
        error: true,
        message: `No stored result "${resultId}". Only the most recent results are kept.`,
        available,
        actionRequired:
          "Pick a resultId from `available` — those are the only ones that exist — or re-run " +
          "the original call if the result you want has aged out. Do not invent an id.",
      };
    }

    return page;
  },
});

// ---------------------------------------------------------------------------
// Waiting on purpose.
//
// Some work is not finished when the call that started it returns — a compile
// kicked off in an editor, a job queued elsewhere. Without a way to wait, the
// only way to express "check again shortly" was `sleep 45` through the shell,
// which burns a tool step and reads like the model has lost the plot.
// ---------------------------------------------------------------------------

localToolRegistry.register({
  name: "wait",
  description:
    "Pause for a few seconds before continuing, when you are waiting for something " +
    "outside this process to finish — a compile, a background job, a file to appear. " +
    "Follow it with the call that checks whether the thing is done. Do not use it to " +
    "pad out a turn: if there is nothing to wait for, carry on.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "How long to wait. Default 5, maximum 60.",
      },
      reason: {
        type: "string",
        description: "What you are waiting for, shown to the user while it waits.",
      },
    },
  },
  handler: async (args) => {
    const requested = Number(args?.seconds);
    const seconds = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 5, 60));
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";

    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    return {
      ok: true,
      waitedSeconds: seconds,
      reason: reason || undefined,
      actionRequired:
        "Now check whether the thing you were waiting for has happened. If it has not, " +
        "and nothing about the situation has changed, say so rather than waiting again.",
    };
  },
});
