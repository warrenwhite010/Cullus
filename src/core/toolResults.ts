// The full text of tool results that were too big to put in the transcript.
//
// A tool result is re-sent on every later step AND every later turn, so one
// oversized read is a tax on the whole session — capping it at ingest is right.
// Capping it and throwing the rest away was not: the cap is head-only, so a
// 5.8KB source file read for a compiler error on line 100 arrived with line 100
// missing, and the model diagnosed the wrong error three times in a row off the
// half it could see. The advice attached to the cut ("narrow the call", "raise
// the limit in Settings") was no help either — one is vague and the other is a
// human action the model cannot take mid-turn.
//
// So: keep the whole thing here, hand the model an id, and let it read any part
// of it with `read_tool_result`. Memory-only and bounded — this is a within-turn
// affordance, not a cache.

const MAX_STORED = 24;

interface StoredResult {
  tool: string;
  text: string;
  at: number;
}

const store = new Map<string, StoredResult>();
let counter = 0;

/** Keep the full text and return the id the model can read it back with. */
export function stashToolResult(tool: string, text: string): string {
  const id = `res_${++counter}`;
  store.set(id, { tool, text, at: Date.now() });

  // Oldest out first. Map preserves insertion order, so the first key is the
  // oldest — no timestamps needed to evict.
  while (store.size > MAX_STORED) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }

  return id;
}

export interface ResultPage {
  resultId: string;
  tool: string;
  totalChars: number;
  offset: number;
  returnedChars: number;
  nextOffset: number | null;
  content: string;
}

/**
 * Read a window of a stored result.
 *
 * `nextOffset` is null at the end, so a model can page without arithmetic —
 * "call again with this number" until it stops coming.
 */
export function readToolResult(
  resultId: string,
  offset = 0,
  length = 6_000
): ResultPage | null {
  const stored = store.get(resultId);
  if (!stored) return null;

  const total = stored.text.length;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total));
  const size = Math.max(1, Math.min(Math.floor(length) || 6_000, 20_000));
  const content = stored.text.slice(start, start + size);
  const end = start + content.length;

  return {
    resultId,
    tool: stored.tool,
    totalChars: total,
    offset: start,
    returnedChars: content.length,
    nextOffset: end < total ? end : null,
    content,
  };
}

/** Ids currently readable, newest last. For the error path when one has aged out. */
export function listToolResults(): Array<{ resultId: string; tool: string; totalChars: number }> {
  return Array.from(store.entries()).map(([resultId, r]) => ({
    resultId,
    tool: r.tool,
    totalChars: r.text.length,
  }));
}

export function clearToolResults(): void {
  store.clear();
}
