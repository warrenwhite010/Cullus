// The work checklist shown while the assistant is working.
//
// Two producers, one list:
//
//   - The /fix loop writes its phases here, so a repair shows the same
//     "▪ active / ☐ pending / ☑ done" shape as any other multi-step job.
//   - The model writes here through plan_tasks / complete_task during a normal
//     turn, which is the only way a small model's multi-step intent becomes
//     visible before it finishes (or gets lost).
//
// Persisted so a browser reload does not lose the plan mid-job. Cheap enough to
// write on every mutation: the list is capped at 12 items.

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";

const TASKS_PATH = path.join(CONFIG_DIR, "tasks.json");
const MAX_TASKS = 12;

export type TaskStatus = "pending" | "active" | "done" | "failed";

export interface ChecklistTask {
  id: string;
  /** Imperative form: "Build the patch module". */
  subject: string;
  /** Present continuous, shown while active: "Building the patch module". */
  activeForm?: string;
  status: TaskStatus;
  /** Where it came from, so /fix rounds and chat turns can be told apart. */
  origin: "fix" | "chat";
  startedAt?: number;
  endedAt?: number;
}

export const taskEvents = new EventEmitter();

let tasks: ChecklistTask[] = load();

function load(): ChecklistTask[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(TASKS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.slice(0, MAX_TASKS) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2), "utf-8");
  } catch {
    // A checklist that cannot be saved must never break the turn producing it.
  }
}

function changed(): void {
  persist();
  taskEvents.emit("changed", listTasks());
}

export function listTasks(): ChecklistTask[] {
  return tasks.map((task) => ({ ...task }));
}

/** Replace the whole list. Used when a new job starts. */
export function setTasks(
  items: Array<{ subject: string; activeForm?: string }>,
  origin: ChecklistTask["origin"] = "chat"
): ChecklistTask[] {
  tasks = items
    .filter((item) => item?.subject && typeof item.subject === "string")
    .slice(0, MAX_TASKS)
    .map((item, index) => ({
      id: `${index + 1}`,
      subject: item.subject.trim().slice(0, 120),
      activeForm: item.activeForm?.trim().slice(0, 120),
      status: "pending" as TaskStatus,
      origin,
    }));

  changed();
  return listTasks();
}

export function clearTasks(): void {
  tasks = [];
  changed();
}

// ---------------------------------------------------------------------------
// Single-task editing, for the person watching
// ---------------------------------------------------------------------------
//
// Everything above is driven by a producer: the model through
// plan_tasks/complete_task, the /fix loop through its phases. That made the
// checklist a display, and a display is the wrong thing when you can see the
// run going somewhere you did not want. The case that prompted these: a turn
// spent eight steps polling a compile it could not reach, with the panel
// showing one line — the truncated opening of the prompt — and no way to say
// "that step is wrong, do this instead".
//
// Ids are strings and `setTasks` numbers them from 1, so an added task takes
// the next free integer rather than `length + 1`: deleting task 2 of 3 and then
// adding one would otherwise collide with the existing task 3.

function nextId(): string {
  const used = new Set(tasks.map((t) => t.id));
  for (let n = 1; n <= MAX_TASKS + 1; n++) {
    if (!used.has(String(n))) return String(n);
  }
  return String(Date.now());
}

/** Append one task. Returns null when the list is already full. */
export function addTask(
  subject: string,
  options: { activeForm?: string; status?: TaskStatus; origin?: ChecklistTask["origin"] } = {}
): ChecklistTask | null {
  const trimmed = String(subject ?? "").trim();
  if (!trimmed) return null;
  if (tasks.length >= MAX_TASKS) return null;

  const task: ChecklistTask = {
    id: nextId(),
    subject: trimmed.slice(0, 120),
    activeForm: options.activeForm?.trim().slice(0, 120),
    status: options.status ?? "pending",
    origin: options.origin ?? "chat",
  };

  if (task.status === "active") task.startedAt = Date.now();

  tasks.push(task);
  changed();
  return { ...task };
}

/**
 * Edit one task's text and/or status. Returns null when the id is unknown.
 *
 * Status changes go through here rather than through `setTaskStatus` so the
 * timestamps stay consistent: a task moved back to `pending` by hand has not
 * started, and leaving a stale `startedAt` on it makes the elapsed figure in
 * the panel lie.
 */
export function updateTask(
  id: string,
  patch: { subject?: string; activeForm?: string; status?: TaskStatus }
): ChecklistTask | null {
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;

  if (typeof patch.subject === "string") {
    const trimmed = patch.subject.trim();
    if (trimmed) task.subject = trimmed.slice(0, 120);
  }

  if (typeof patch.activeForm === "string") {
    task.activeForm = patch.activeForm.trim().slice(0, 120) || undefined;
  }

  if (patch.status) {
    task.status = patch.status;
    if (patch.status === "active") {
      task.startedAt = Date.now();
      task.endedAt = undefined;
    } else if (patch.status === "pending") {
      task.startedAt = undefined;
      task.endedAt = undefined;
    } else {
      task.endedAt = Date.now();
    }
  }

  changed();
  return { ...task };
}

/** Remove one task. Returns false when the id is unknown. */
export function removeTask(id: string): boolean {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  if (tasks.length === before) return false;

  changed();
  return true;
}

/** Mark one task, by id or by exact subject. Returns false when not found. */
export function setTaskStatus(idOrSubject: string, status: TaskStatus): boolean {
  const task =
    tasks.find((t) => t.id === idOrSubject) ??
    tasks.find((t) => t.subject.toLowerCase() === String(idOrSubject).toLowerCase());

  if (!task) return false;

  task.status = status;
  if (status === "active") task.startedAt = Date.now();
  if (status === "done" || status === "failed") task.endedAt = Date.now();

  changed();
  return true;
}

/**
 * Advance the list: finish the active task and start the next pending one.
 * Small models forget to close items out, so the /fix loop drives this by phase
 * rather than trusting a model to keep the list honest.
 */
export function advanceTasks(finishStatus: TaskStatus = "done"): ChecklistTask | null {
  const active = tasks.find((t) => t.status === "active");
  if (active) {
    active.status = finishStatus;
    active.endedAt = Date.now();
  }

  const next = tasks.find((t) => t.status === "pending");
  if (next) {
    next.status = "active";
    next.startedAt = Date.now();
  }

  changed();
  return next ? { ...next } : null;
}

/** Start a named task, marking any other active one done. */
export function startTask(idOrSubject: string): boolean {
  const target =
    tasks.find((t) => t.id === idOrSubject) ??
    tasks.find((t) => t.subject.toLowerCase() === String(idOrSubject).toLowerCase());
  if (!target) return false;

  for (const task of tasks) {
    if (task.status === "active" && task !== target) {
      task.status = "done";
      task.endedAt = Date.now();
    }
  }

  target.status = "active";
  target.startedAt = Date.now();
  changed();
  return true;
}
