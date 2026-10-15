// Activity Monitor's memory figures, without Activity Monitor.
//
// This exists because of what this tool DOES to a machine. A local model is the
// single largest allocation on the box: num_ctx sizes the KV cache (measured on
// qwen3.5:2b: 8k → 2.47 GB resident, 200k → 5.23 GB), and a 22 GB model plus its
// cache on a 48 GB machine is a budget you want to watch rather than discover.
// The Performance panel already predicts what the next turn will cost; this says
// what the machine is actually doing right now.
//
// Cost, measured on this machine before building it: `vm_stat` is ~2.7 ms per
// call and `sysctl` the same. Polled every three seconds from an open browser
// tab that is roughly 0.09% of one core — far below the noise floor of the thing
// it is measuring. It is polled BY THE CLIENT rather than pushed on a server
// timer so that a headless server with no UI open spends nothing at all, and a
// backgrounded tab is throttled by the browser for free.
//
// macOS only, and honest about it: every figure here comes from Mach VM
// statistics with no Linux equivalent worth faking. Elsewhere `available` is
// false and the UI hides the panel rather than showing zeroes.

import { execFile } from "child_process";
import * as os from "os";

export interface MemorySnapshot {
  available: boolean;
  /** Why the numbers are missing, when they are. */
  reason?: string;
  /** Bytes of physical RAM. */
  total: number;
  /**
   * Activity Monitor's "Memory Used" — app + wired + compressed.
   *
   * Deliberately NOT total minus free: free memory on a healthy Mac is near zero
   * because the OS uses everything spare for cache, so "used" computed that way
   * always reads ~100% and tells you nothing.
   */
  used: number;
  /** Anonymous pages that are not purgeable. Activity Monitor's "App Memory". */
  app: number;
  /** Pages that cannot be compressed or paged out. */
  wired: number;
  /** Physical footprint of the memory compressor. */
  compressed: number;
  /** File-backed plus purgeable pages — reclaimable on demand. */
  cachedFiles: number;
  /** Bytes of swap in use, and the size of the swap file. */
  swapUsed: number;
  swapTotal: number;
  /**
   * The kernel's own pressure verdict, which is what colours Activity Monitor's
   * graph — not a ratio we invented. kern.memorystatus_vm_pressure_level:
   * 1 normal, 2 warning, 4 critical.
   */
  pressure: "normal" | "warning" | "critical" | "unknown";
}

const EMPTY: MemorySnapshot = {
  available: false,
  total: 0,
  used: 0,
  app: 0,
  wired: 0,
  compressed: 0,
  cachedFiles: 0,
  swapUsed: 0,
  swapTotal: 0,
  pressure: "unknown",
};

/**
 * How long a snapshot is reused.
 *
 * Two browser tabs polling every three seconds would otherwise spawn twice the
 * processes for numbers that cannot meaningfully differ. Shorter than the poll
 * interval so a single client still sees fresh data every time.
 */
const CACHE_MS = 1_500;

let cached: { at: number; snapshot: MemorySnapshot } | null = null;

/** Run a command with no shell, and never let it hang the request. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2_000, maxBuffer: 1 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

/**
 * Parse `vm_stat` output into a page map, plus the page size from its header.
 *
 * Exported for the verify script: the arithmetic below is the part worth testing
 * and it must be testable against a fixture rather than against whatever this
 * machine happens to be doing at the time.
 */
export function parseVmStat(output: string): { pageSize: number; pages: Record<string, number> } {
  // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
  const header = output.match(/page size of (\d+) bytes/);
  const pageSize = header ? Number(header[1]) : 4096;

  const pages: Record<string, number> = {};
  for (const line of output.split("\n")) {
    // Keys contain spaces and some are quoted ("Translation faults"). Values end
    // in a period.
    const match = line.match(/^"?([A-Za-z][^":]*?)"?:\s+(\d+)\.?\s*$/);
    if (match) pages[match[1].trim()] = Number(match[2]);
  }

  return { pageSize, pages };
}

/** `total = 6144.00M  used = 4419.06M  free = 1724.94M  (encrypted)` → bytes. */
export function parseSwapusage(output: string): { swapUsed: number; swapTotal: number } {
  const scale = (value: string, unit: string): number => {
    const n = Number(value);
    const multiplier = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
    return Math.round(n * multiplier);
  };

  const total = output.match(/total\s*=\s*([\d.]+)([KMG])/i);
  const used = output.match(/used\s*=\s*([\d.]+)([KMG])/i);

  return {
    swapTotal: total ? scale(total[1], total[2].toUpperCase()) : 0,
    swapUsed: used ? scale(used[1], used[2].toUpperCase()) : 0,
  };
}

/**
 * Assemble the Activity Monitor figures from raw page counts.
 *
 * The formulas, and why each is what it is:
 *   App Memory  = anonymous − purgeable. Anonymous pages are process memory with
 *                 no file behind them; the purgeable ones the OS may drop, and
 *                 Activity Monitor counts those under Cached Files instead.
 *   Wired       = pages the kernel cannot page out or compress.
 *   Compressed  = pages OCCUPIED BY the compressor, not pages stored IN it. The
 *                 second number is larger and is the uncompressed size — using it
 *                 overstates the footprint by roughly the compression ratio
 *                 (5.6× on the sample this was written against).
 *   Cached Files= file-backed + purgeable. Reclaimable, which is why it is shown
 *                 separately from used rather than added to it.
 */
export function computeSnapshot(
  pageSize: number,
  pages: Record<string, number>,
  swap: { swapUsed: number; swapTotal: number },
  pressureLevel: number,
  total: number
): MemorySnapshot {
  const bytes = (key: string) => (pages[key] ?? 0) * pageSize;

  const purgeable = bytes("Pages purgeable");
  const anonymous = bytes("Anonymous pages");
  const wired = bytes("Pages wired down");
  const compressed = bytes("Pages occupied by compressor");
  const fileBacked = bytes("File-backed pages");

  const app = Math.max(0, anonymous - purgeable);

  return {
    available: true,
    total,
    used: app + wired + compressed,
    app,
    wired,
    compressed,
    cachedFiles: fileBacked + purgeable,
    swapUsed: swap.swapUsed,
    swapTotal: swap.swapTotal,
    pressure:
      pressureLevel === 1
        ? "normal"
        : pressureLevel === 2
          ? "warning"
          : pressureLevel >= 4
            ? "critical"
            : "unknown",
  };
}

/**
 * The machine's current memory state, or `available: false`.
 *
 * Never throws: this feeds a status bar that polls on a timer, and an endpoint
 * that can fail is an endpoint that fills the console with noise for a readout
 * nobody is looking at.
 */
export async function readMemory(): Promise<MemorySnapshot> {
  if (process.platform !== "darwin") {
    return { ...EMPTY, reason: `memory figures are macOS-only (this is ${process.platform})` };
  }

  if (cached && Date.now() - cached.at < CACHE_MS) return cached.snapshot;

  try {
    // Pressure level is its own sysctl and is allowed to be missing — it is the
    // one figure that has varied across macOS versions. The rest is not
    // optional, so a failure there means no snapshot.
    const [vmStat, swapRaw, pressureRaw] = await Promise.all([
      run("/usr/bin/vm_stat", []),
      run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
      run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
    ]);

    const { pageSize, pages } = parseVmStat(vmStat);
    const snapshot = computeSnapshot(
      pageSize,
      pages,
      parseSwapusage(swapRaw),
      Number(String(pressureRaw).trim()) || 0,
      os.totalmem()
    );

    cached = { at: Date.now(), snapshot };
    return snapshot;
  } catch (err: any) {
    return { ...EMPTY, reason: String(err?.message ?? err).slice(0, 200) };
  }
}
