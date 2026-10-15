/**
 * The one thing that goes wrong with the Blender connector, and the only
 * sentence that fixes it.
 *
 * `mcp-for-blender` is two halves: a Python MCP server, which this harness
 * spawns and which always starts, and an addon inside Blender that listens on a
 * local socket. Every tool call goes server → socket → addon, so with Blender
 * closed, or open without the addon's server started, the connector looks
 * perfectly healthy — 31 tools advertised, a green dot, no connect error — and
 * every call fails with:
 *
 *     Failed to connect to Blender: [Errno 61] Connection refused
 *
 * That message names a TCP error on a port the caller never chose, which reads
 * as a broken install rather than as "press Start in Blender's sidebar". A model
 * handed it will reasonably conclude the capability is unavailable and stop
 * using it for the rest of the session, which is exactly the failure the Unity
 * guards were written to prevent.
 */

/** Does this result mean Blender's addon is not listening? */
export function isBlenderOffline(result: unknown): boolean {
  const text = typeof result === "string" ? result : safeJson(result);

  return (
    /failed to connect to blender/i.test(text) ||
    /errno 61|connection refused/i.test(text) ||
    /blender.*not (?:running|responding|reachable)/i.test(text) ||
    /addon.*not (?:installed|enabled|running)/i.test(text)
  );
}

/** What the caller has to do, in the order they have to do it. */
export function blenderOfflineAdvice(): string {
  return (
    "Blender itself is not answering — the MCP server started fine, but its addon inside " +
    "Blender is what actually executes these tools, and nothing is listening on its socket. " +
    "This is a setup step, not a bug in the call:\n" +
    "1. Open Blender (3.0 or newer).\n" +
    "2. If the addon is not installed yet, run `uvx mcp-for-blender install-addon`, then " +
    "enable it in Blender under Edit → Preferences → Add-ons.\n" +
    "3. In Blender's 3D viewport press N to open the sidebar, choose the MCP tab, and click " +
    "Start MCP Server.\n" +
    "Then re-issue this exact call. Do NOT conclude that Blender support is unavailable, and " +
    "do not look for another route to the same change — tell the user which of these steps is " +
    "outstanding, because only they can do it."
  );
}

/**
 * Attach the advice to an offline result, leaving anything else untouched.
 *
 * The original error is kept: it is the evidence, and a caller that only sees
 * advice cannot tell whether the advice applies.
 */
export function annotateBlenderResult(result: any): any {
  if (!isBlenderOffline(result)) return result;

  const note = blenderOfflineAdvice();

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const existing = typeof result.harnessNote === "string" ? `${result.harnessNote} ` : "";
    return { ...result, blenderOffline: true, harnessNote: `${existing}${note}` };
  }

  return { value: result, blenderOffline: true, harnessNote: note };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
