// Chat sessions.
//
// The previous design kept ONE conversation in ~/.cullus/scratchpad.json, so
// starting a new topic meant destroying the old one — `/reset` deleted history
// outright. Here each conversation is its own file under ~/.cullus/sessions/,
// the active one is remembered in config, and switching is non-destructive.
//
// provider.ts owns the message array; this module owns where it lives, what it's
// called, and which one is current. Titles are derived from the first user
// message so the sidebar list is readable without anyone naming anything.

import * as fs from "fs";
import * as path from "path";
import { CONFIG_DIR, ensureConfigDir, loadConfig, saveConfig } from "./config.js";

export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

export interface SessionUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Ollama-shaped message array, system prompt included. */
  history: any[];
  usage: SessionUsageTotals;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
  active: boolean;
}

const EMPTY_USAGE: SessionUsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  turns: 0,
};

function sessionPath(id: string): string {
  // Ids are generated here, but a hostile id must never escape the directory.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

function ensureDir(): void {
  ensureConfigDir();
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  } catch (err: any) {
    console.warn(`⚠️  Could not create ${SESSIONS_DIR}: ${err.message}`);
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function readSession(id: string): StoredSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(id), "utf-8"));
    if (!parsed?.id) return null;
    return {
      id: parsed.id,
      title: parsed.title ?? "Untitled chat",
      createdAt: parsed.createdAt ?? Date.now(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? Date.now(),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      usage: { ...EMPTY_USAGE, ...(parsed.usage ?? {}) },
    };
  } catch {
    return null;
  }
}

export function writeSession(session: StoredSession): void {
  ensureDir();
  try {
    fs.writeFileSync(
      sessionPath(session.id),
      JSON.stringify({ ...session, updatedAt: Date.now() }, null, 2),
      "utf-8"
    );
  } catch (err: any) {
    console.warn(`⚠️  Could not save session ${session.id}: ${err.message}`);
  }
}

export function createSession(title = "New chat"): StoredSession {
  const session: StoredSession = {
    id: newId(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    usage: { ...EMPTY_USAGE },
  };

  writeSession(session);
  saveConfig({ activeSessionId: session.id });
  return session;
}

/** The current session, creating one on first use. */
export function getActiveSession(): StoredSession {
  const id = loadConfig().activeSessionId;
  if (id) {
    const existing = readSession(id);
    if (existing) return existing;
  }
  return createSession();
}

export function activateSession(id: string): StoredSession | null {
  const session = readSession(id);
  if (!session) return null;
  saveConfig({ activeSessionId: id });
  return session;
}

export function listSessions(): SessionSummary[] {
  ensureDir();
  const activeId = loadConfig().activeSessionId;
  const rows: SessionSummary[] = [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return rows;
  }

  for (const entry of entries) {
    const session = readSession(entry.replace(/\.json$/, ""));
    if (!session) continue;
    rows.push({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      // The system prompt is not a message anyone sent.
      messages: session.history.filter((m) => m?.role !== "system").length,
      active: session.id === activeId,
    });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function renameSession(id: string, title: string): boolean {
  const session = readSession(id);
  if (!session) return false;
  session.title = title.trim().slice(0, 80) || session.title;
  writeSession(session);
  return true;
}

export function deleteSession(id: string): boolean {
  const session = readSession(id);
  if (!session) return false;

  try {
    fs.unlinkSync(sessionPath(id));
  } catch {
    return false;
  }

  // Deleting the active session must leave a valid active one behind.
  if (loadConfig().activeSessionId === id) {
    const next = listSessions()[0];
    if (next) saveConfig({ activeSessionId: next.id });
    else createSession();
  }

  return true;
}

/**
 * Persist a turn's result into the active session.
 *
 * Titles are set from the first real user message, truncated — good enough to
 * scan a sidebar, and nobody has to name a chat before starting it.
 */
export function saveTurn(history: any[], usage: SessionUsageTotals): StoredSession {
  const session = getActiveSession();
  session.history = history;
  session.usage = usage;

  if (session.title === "New chat") {
    const firstUser = history.find((m) => m?.role === "user" && typeof m.content === "string");
    if (firstUser) {
      session.title = String(firstUser.content).replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    }
  }

  writeSession(session);
  return session;
}
