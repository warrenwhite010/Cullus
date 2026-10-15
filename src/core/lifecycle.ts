// Graceful shutdown.
//
// Before this, the process had no signal handling at all — only an
// unhandledRejection hook. Ctrl-C, `launchctl stop`, or a `systemctl restart`
// killed it instantly, which costs you three things:
//
//   1. A scheduled job mid-run dies with no record. Its output file is never
//      written, and jobs.json still says it is running, so the next tick skips
//      it as "already in flight" — the job silently stops firing forever.
//   2. MCP servers are left with a dangling connection.
//   3. A jobs.json write interrupted between the temp file and the rename
//      leaves the lock directory behind. The stale-lock sweep clears it after
//      30s, but nothing scheduled runs until then.
//
// The order below matters and is the whole design:
//
//   stop the ticker  -> no NEW job can start
//   stop the server  -> no new HTTP or socket work arrives
//   drain in-flight  -> jobs already running get a bounded chance to finish
//   close MCP        -> clean disconnect
//   exit
//
// If draining exceeds the grace period we exit anyway. A shutdown that hangs is
// worse than one that abandons a job, because a service manager will SIGKILL it
// and you lose the clean-up entirely.

import type { Server } from "http";

/** How long to let in-flight work finish before exiting regardless. */
const GRACE_MS = 15_000;
/** How often to re-check whether the drain has completed. */
const POLL_MS = 250;

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

async function drainJobs(deadline: number): Promise<{ drained: boolean; remaining: number }> {
  const { inFlightCount } = await import("./cron.js");
  // Check BEFORE looking at the clock. The common case is nothing running, and
  // an expired deadline should not turn that into a reported failure.
  for (;;) {
    const remaining = inFlightCount();
    if (remaining === 0) return { drained: true, remaining: 0 };
    if (Date.now() >= deadline) return { drained: false, remaining };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Wire SIGTERM and SIGINT to an ordered shutdown.
 *
 * A second signal exits immediately. Someone pressing Ctrl-C twice means it,
 * and making them wait through a drain they are trying to skip is hostile.
 */
export function installShutdownHandlers(server: Server): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n${signal} again — exiting now.`);
      process.exit(130);
    }
    shuttingDown = true;
    const deadline = Date.now() + GRACE_MS;
    console.log(`\n${signal} received. Shutting down…`);

    // 1. No new scheduled jobs.
    try {
      const { stop, inFlightCount } = await import("./cron.js");
      stop();
      const running = inFlightCount();
      if (running > 0) console.log(`   waiting for ${running} scheduled job(s) to finish…`);
    } catch {
      /* cron may never have started */
    }

    // 2. No new connections. Existing responses are allowed to complete.
    //
    // server.close() only fires once every socket is idle, and the dashboard
    // holds a socket.io connection open for as long as the tab is. Closing
    // socket.io first, then destroying whatever is left, is what actually lets
    // close() finish -- without it every shutdown burned the full grace period
    // waiting on a connection that was never going to close itself.
    try {
      const { io } = await import("./server.js");
      (io as any)?.close?.();
    } catch {
      /* socket.io may not be initialised */
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      server.close(done);
      // Belt and braces: any socket still lingering after a beat gets dropped.
      setTimeout(() => {
        server.closeAllConnections?.();
        done();
      }, 1_000);
    });

    // 3. Let running jobs finish, bounded.
    const { drained, remaining } = await drainJobs(deadline);
    if (!drained) {
      console.log(`   ${remaining} job(s) still running after ${GRACE_MS / 1000}s — exiting anyway.`);
    }

    // 4. Disconnect MCP servers.
    try {
      const { mcpManager } = await import("./mcpManager.js");
      await (mcpManager as any)?.closeAll?.();
    } catch {
      /* best effort — never block exit on a disconnect */
    }

    console.log("   done.");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
