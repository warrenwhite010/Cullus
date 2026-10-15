// FIFO compliance for US-regulated OANDA accounts.
//
// CFTC/NFA rules make a US forex account behave differently from the rest of the
// world in two ways that break naive bot logic:
//
//   1. NO HEDGING. You cannot hold a long and a short in the same instrument. An
//      order in the opposite direction REDUCES or CLOSES the existing position
//      instead of opening a second one. A bot that treats "short EUR_USD" as a
//      new position while already long will silently flatten the winner it was
//      trying to keep.
//
//   2. FIFO CLOSEOUT. When several trades are open on one instrument, they must
//      be closed oldest-first. Closing a specific newer trade by its trade ID is
//      rejected — OANDA returns FIFO_VIOLATION — which shows up as an order that
//      "did nothing" unless the rejection is read.
//
// The safe way to satisfy both is to hold at most one trade per instrument and to
// close through the *position* endpoint rather than by trade ID. Everything below
// enforces that, and explains itself when it refuses.

import type { OpenTrade } from "./api.js";

export interface FifoSettings {
  /** Master switch. On for any US account; harmless elsewhere. */
  enabled: boolean;
  /**
   * Allow an opposite-direction order to deliberately reduce or close a position.
   * Off by default: an accidental reduction reads as a mystery exit.
   */
  allowReducingOrders: boolean;
}

export const DEFAULT_FIFO: FifoSettings = { enabled: true, allowReducingOrders: false };

export interface FifoEntryCheck {
  allowed: boolean;
  /** True when this order would reduce/close rather than open. */
  wouldReduce: boolean;
  reasons: string[];
  /** What to do instead. */
  guidance: string[];
}

/** Net signed units held on an instrument. */
export function netPosition(instrument: string, openTrades: OpenTrade[]): number {
  return openTrades
    .filter((trade) => trade.instrument === instrument)
    .reduce((sum, trade) => sum + trade.currentUnits, 0);
}

/** Open trades on an instrument, oldest first — the order FIFO requires. */
export function fifoOrdered(instrument: string, openTrades: OpenTrade[]): OpenTrade[] {
  return openTrades
    .filter((trade) => trade.instrument === instrument)
    .sort((a, b) => a.openTime.localeCompare(b.openTime));
}

/**
 * Can this entry be placed on a FIFO account?
 *
 * Returns `wouldReduce` separately from `allowed` so a caller that genuinely
 * wants to scale out can opt in, while the strategy path — which never does —
 * gets a hard refusal with the reason.
 */
export function checkFifoEntry(
  instrument: string,
  direction: "long" | "short",
  openTrades: OpenTrade[],
  settings: FifoSettings = DEFAULT_FIFO
): FifoEntryCheck {
  if (!settings.enabled) {
    return { allowed: true, wouldReduce: false, reasons: [], guidance: [] };
  }

  const net = netPosition(instrument, openTrades);
  const existing = fifoOrdered(instrument, openTrades);

  if (net === 0) {
    return { allowed: true, wouldReduce: false, reasons: [], guidance: [] };
  }

  const heldLong = net > 0;
  const wantsLong = direction === "long";

  if (heldLong !== wantsLong) {
    // Opposite direction: on a netting/FIFO account this is a close, not a hedge.
    if (settings.allowReducingOrders) {
      return {
        allowed: true,
        wouldReduce: true,
        reasons: [
          `This ${direction} order will REDUCE the existing ${heldLong ? "long" : "short"} ` +
            `${Math.abs(net)} units of ${instrument} rather than open a new position — US FIFO ` +
            `accounts cannot hedge.`,
        ],
        guidance: [
          `If the intent was to exit, oanda_remove_position is clearer and FIFO-safe.`,
        ],
      };
    }
    return {
      allowed: false,
      wouldReduce: true,
      reasons: [
        `FIFO/no-hedge: ${instrument} is already ${heldLong ? "long" : "short"} ${Math.abs(net)} ` +
          `units. A ${direction} order would reduce or flatten that position, not open a new one.`,
      ],
      guidance: [
        `To reverse, close first with oanda_remove_position, then enter fresh.`,
        `To scale out deliberately, set fifo.allowReducingOrders or use oanda_remove_position with units.`,
      ],
    };
  }

  // Same direction: legal, but a second trade means the exit must be oldest-first
  // forever after, and it doubles exposure the risk layer already sized once.
  return {
    allowed: true,
    wouldReduce: false,
    reasons: [
      `Adding to an existing ${heldLong ? "long" : "short"} on ${instrument} ` +
        `(${existing.length} trade(s) open). Exits will be forced oldest-first.`,
    ],
    guidance: [
      `Keeping one trade per instrument is what makes FIFO a non-issue; ` +
        `risk.maxOpenTradesPerInstrument is clamped to 1 while FIFO is enabled.`,
    ],
  };
}

export interface FifoCloseplan {
  /** Trades to close, in the only legal order. */
  order: Array<{ tradeID: string; units: number; openTime: string }>;
  /** True when the caller asked to close a specific trade out of order. */
  violatesFifo: boolean;
  reasons: string[];
  /** The endpoint that is always FIFO-safe. */
  recommendation: string;
}

/**
 * How to close an instrument's exposure legally.
 *
 * The position-close endpoint (`PUT /positions/{instrument}/close`) applies FIFO
 * server-side, so it is always the right tool. This exists to catch the case
 * where something tries to close a newer trade by ID and to say why it will fail.
 */
export function planFifoClose(
  instrument: string,
  openTrades: OpenTrade[],
  requestedTradeID?: string
): FifoCloseplan {
  const ordered = fifoOrdered(instrument, openTrades);
  const order = ordered.map((trade) => ({
    tradeID: trade.id,
    units: trade.currentUnits,
    openTime: trade.openTime,
  }));

  if (!requestedTradeID) {
    return {
      order,
      violatesFifo: false,
      reasons: [],
      recommendation:
        "Close through the position endpoint (oanda_remove_position); it applies FIFO server-side.",
    };
  }

  const index = ordered.findIndex((trade) => trade.id === requestedTradeID);
  if (index <= 0) {
    return {
      order,
      violatesFifo: false,
      reasons:
        index === 0
          ? [`Trade ${requestedTradeID} is the oldest open trade on ${instrument}; closing it is legal.`]
          : [`Trade ${requestedTradeID} is not open on ${instrument}.`],
      recommendation: "oanda_remove_position is still the safer route.",
    };
  }

  return {
    order,
    violatesFifo: true,
    reasons: [
      `Closing trade ${requestedTradeID} would skip ${index} older trade(s) on ${instrument} ` +
        `(oldest is ${ordered[0].id}, opened ${ordered[0].openTime}). OANDA will reject this with ` +
        `FIFO_VIOLATION on a US account.`,
    ],
    recommendation:
      `Close ${ordered
        .slice(0, index + 1)
        .map((trade) => trade.id)
        .join(" → ")} in that order, or use oanda_remove_position to let the broker do it.`,
  };
}

/**
 * `positionFill` for a new order.
 *
 * REDUCE_FIRST is what a netting account needs: it makes the intent explicit
 * rather than relying on the account's DEFAULT behaviour, which differs between
 * hedging and non-hedging accounts and is therefore the wrong thing to assume.
 */
export function positionFillFor(settings: FifoSettings): string {
  return settings.enabled ? "REDUCE_FIRST" : "DEFAULT";
}
