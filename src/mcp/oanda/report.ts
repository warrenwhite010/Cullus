// Period performance: what the account actually did, and what to change.
//
// oanda_trade_review already answers "how did the book do" across the last N
// closed trades. This module answers the two questions that one leaves open:
//
//   • Over a WINDOW rather than a count — "today" and "this week" are the units
//     people actually review in, and a trade count crosses those boundaries at
//     an arbitrary point.
//   • Per PAIR and per STRATEGY, with a verdict attached — keep, adjust, or
//     stop. A report that ends in numbers leaves the reader to invent the
//     conclusion, which is the step most likely to go wrong.
//
// A verdict here is always hedged by sample size, because on a week of trading
// almost nothing is significant. Saying "three losses is not evidence" is more
// useful than ranking three pairs by a number that is mostly noise.

import type { ClosedTrade, OpenTrade } from "./api.js";
import type { StrategyParams } from "./params.js";

export interface PeriodBucket {
  key: string;
  trades: number;
  wins: number;
  netPL: number;
  grossWin: number;
  grossLoss: number;
  financing: number;
  winRatePct: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  /** keep | adjust | stop | watch — always paired with a sample-size caveat. */
  verdict: "keep" | "adjust" | "stop" | "watch";
  recommendation: string;
}

export interface PeriodReport {
  from: string;
  to: string;
  label: string;
  currency: string;
  closedTrades: number;
  netPL: number;
  grossWin: number;
  grossLoss: number;
  financingPaid: number;
  winRatePct: number;
  profitFactor: number | null;
  bestTrade: { instrument: string; pl: number } | null;
  worstTrade: { instrument: string; pl: number } | null;
  exitBreakdown: Record<string, number>;
  byInstrument: PeriodBucket[];
  /** Only populated when trades can be attributed to a strategy — see `attribution`. */
  byStrategy: PeriodBucket[];
  attribution: string;
  openNow: Array<{
    instrument: string;
    direction: string;
    unrealizedPL: number;
    ageHours: number;
    hasStop: boolean;
  }>;
  headline: string;
  actions: string[];
  caveats: string[];
}

function emptyBucket(key: string): PeriodBucket {
  return {
    key,
    trades: 0,
    wins: 0,
    netPL: 0,
    grossWin: 0,
    grossLoss: 0,
    financing: 0,
    winRatePct: 0,
    profitFactor: null,
    avgWin: 0,
    avgLoss: 0,
    verdict: "watch",
    recommendation: "",
  };
}

/**
 * Turn raw sums into a verdict.
 *
 * The sample-size gate comes first and overrides everything. Ten trades cannot
 * distinguish a 40% strategy from a 60% one, so any verdict stronger than
 * "watch" on a small sample would be manufactured confidence.
 */
function judge(bucket: PeriodBucket, params: StrategyParams): PeriodBucket {
  const { trades, netPL } = bucket;

  bucket.winRatePct = trades ? Number(((bucket.wins / trades) * 100).toFixed(1)) : 0;
  bucket.profitFactor =
    bucket.grossLoss > 0 ? Number((bucket.grossWin / bucket.grossLoss).toFixed(2)) : null;
  bucket.avgWin = bucket.wins ? Number((bucket.grossWin / bucket.wins).toFixed(2)) : 0;
  bucket.avgLoss =
    trades - bucket.wins > 0 ? Number((bucket.grossLoss / (trades - bucket.wins)).toFixed(2)) : 0;
  bucket.netPL = Number(netPL.toFixed(2));
  bucket.grossWin = Number(bucket.grossWin.toFixed(2));
  bucket.grossLoss = Number(bucket.grossLoss.toFixed(2));
  bucket.financing = Number(bucket.financing.toFixed(2));

  if (trades < 8) {
    bucket.verdict = "watch";
    bucket.recommendation =
      `${trades} trade(s) — far too few to judge. Change nothing on this evidence; ` +
      `${netPL >= 0 ? "a profit" : "a loss"} this size is inside normal variance.`;
    return bucket;
  }

  if (netPL > 0 && (bucket.profitFactor ?? 0) >= 1.3) {
    bucket.verdict = "keep";
    bucket.recommendation =
      `Working: profit factor ${bucket.profitFactor} over ${trades} trades. Leave the ` +
      `parameters alone; if anything, this is the candidate for a higher riskMultiplier.`;
    return bucket;
  }

  if (netPL <= 0 && trades >= 20 && (bucket.profitFactor ?? 0) < 0.8) {
    bucket.verdict = "stop";
    bucket.recommendation =
      `Losing with a real sample (${trades} trades, profit factor ${bucket.profitFactor}). ` +
      `Disable it and re-test with oanda_rank_instruments rather than tuning it live.`;
    return bucket;
  }

  bucket.verdict = "adjust";
  // Name the specific asymmetry rather than saying "needs work": the shape of
  // the loss says which parameter is wrong.
  if (bucket.avgLoss > bucket.avgWin * 1.3 && bucket.winRatePct > 50) {
    bucket.recommendation =
      `Wins often (${bucket.winRatePct}%) but loses more per loss (${bucket.avgLoss} vs ` +
      `${bucket.avgWin}). Targets are too close relative to stops — raise entry.takeProfitR ` +
      `(currently ${params.entry.takeProfitR}).`;
  } else if (bucket.winRatePct < 35) {
    bucket.recommendation =
      `Hit rate ${bucket.winRatePct}% is low even for a trend system. Stops are probably inside ` +
      `noise — test a larger entry.stopAtrMultiple (currently ${params.entry.stopAtrMultiple}).`;
  } else {
    bucket.recommendation =
      `Marginal: ${bucket.netPL} over ${trades} trades. Re-optimise this one specifically with ` +
      `oanda_optimize before deciding.`;
  }
  return bucket;
}

/**
 * Attribute a closed trade to a strategy.
 *
 * OANDA does not store the strategy that opened a trade — it stores fills. The
 * per-pair profile is the only link available after the fact, so attribution is
 * only possible where a pair runs exactly ONE strategy. This is stated in the
 * report rather than fudged: a guessed attribution would make the per-strategy
 * table look authoritative while being invented.
 */
function strategyOf(instrument: string, params: StrategyParams): string | null {
  const resolvedTrend = params.profiles?.[instrument]?.trend?.enabled ?? params.trend.enabled;
  const resolvedMean =
    params.profiles?.[instrument]?.meanReversion?.enabled ?? params.meanReversion.enabled;
  const resolvedBreak = params.profiles?.[instrument]?.breakout?.enabled ?? params.breakout.enabled;

  const enabled = [
    resolvedTrend ? "trend" : null,
    resolvedMean ? "meanReversion" : null,
    resolvedBreak ? "breakout" : null,
  ].filter(Boolean) as string[];

  return enabled.length === 1 ? enabled[0] : null;
}

export function buildPeriodReport(options: {
  closed: ClosedTrade[];
  open: OpenTrade[];
  params: StrategyParams;
  currency: string;
  from: Date;
  to: Date;
  label: string;
}): PeriodReport {
  const { params, currency, from, to, label } = options;

  const closed = options.closed.filter((trade) => {
    const time = new Date(trade.closeTime).getTime();
    return time >= from.getTime() && time <= to.getTime();
  });

  const byInstrument = new Map<string, PeriodBucket>();
  const byStrategy = new Map<string, PeriodBucket>();
  const exitBreakdown: Record<string, number> = {};
  let grossWin = 0;
  let grossLoss = 0;
  let financing = 0;
  let best: { instrument: string; pl: number } | null = null;
  let worst: { instrument: string; pl: number } | null = null;
  let unattributed = 0;

  for (const trade of closed) {
    const won = trade.realizedPL > 0;
    if (won) grossWin += trade.realizedPL;
    else grossLoss += Math.abs(trade.realizedPL);
    financing += trade.financing;
    exitBreakdown[trade.closeReason] = (exitBreakdown[trade.closeReason] ?? 0) + 1;

    if (!best || trade.realizedPL > best.pl) best = { instrument: trade.instrument, pl: trade.realizedPL };
    if (!worst || trade.realizedPL < worst.pl) worst = { instrument: trade.instrument, pl: trade.realizedPL };

    const add = (map: Map<string, PeriodBucket>, key: string) => {
      const bucket = map.get(key) ?? emptyBucket(key);
      bucket.trades++;
      if (won) bucket.wins++;
      bucket.netPL += trade.realizedPL;
      if (won) bucket.grossWin += trade.realizedPL;
      else bucket.grossLoss += Math.abs(trade.realizedPL);
      bucket.financing += trade.financing;
      map.set(key, bucket);
    };

    add(byInstrument, trade.instrument);
    const strategy = strategyOf(trade.instrument, params);
    if (strategy) add(byStrategy, strategy);
    else unattributed++;
  }

  const netPL = grossWin - grossLoss;
  const wins = closed.filter((t) => t.realizedPL > 0).length;
  const now = Date.now();

  const actions: string[] = [];
  const caveats: string[] = [];

  const instrumentBuckets = [...byInstrument.values()]
    .map((bucket) => judge(bucket, params))
    .sort((a, b) => a.netPL - b.netPL);
  const strategyBuckets = [...byStrategy.values()]
    .map((bucket) => judge(bucket, params))
    .sort((a, b) => a.netPL - b.netPL);

  for (const bucket of instrumentBuckets) {
    if (bucket.verdict === "stop") {
      actions.push(
        `Disable ${bucket.key}: oanda_set_pair_strategy with disabled: true. ${bucket.recommendation}`
      );
    } else if (bucket.verdict === "adjust") {
      actions.push(`${bucket.key}: ${bucket.recommendation}`);
    }
  }
  const keepers = instrumentBuckets.filter((b) => b.verdict === "keep");
  if (keepers.length) {
    actions.push(
      `Keep unchanged: ${keepers.map((b) => `${b.key} (${b.netPL >= 0 ? "+" : ""}${b.netPL})`).join(", ")}.`
    );
  }

  if (closed.length === 0) {
    actions.push(
      "No trades closed in this window. If that is unexpected, check oanda_market_scan for " +
        "blockers — the filters may be rejecting everything."
    );
  }
  if (closed.length > 0 && closed.length < 10) {
    caveats.push(
      `${closed.length} closed trade(s) is not a sample. Treat every verdict below as provisional.`
    );
  }
  if (unattributed > 0) {
    caveats.push(
      `${unattributed} trade(s) could not be attributed to a strategy: their pair runs more than ` +
        `one, and OANDA does not record which one opened the trade.`
    );
  }
  if (financing < -Math.abs(grossWin) * 0.1 && grossWin > 0) {
    actions.push(
      `Financing cost ${financing.toFixed(2)} ${currency} is eating over 10% of gross profit — ` +
        `holding periods are long for this edge. Consider a shorter granularity or enabling carry checks.`
    );
  }

  const stops = exitBreakdown.STOP_LOSS_ORDER ?? 0;
  if (closed.length >= 10 && stops > closed.length * 0.6) {
    actions.push(
      `${stops}/${closed.length} exits were stop-outs. Test a wider entry.stopAtrMultiple with ` +
        `oanda_backtest before changing it live.`
    );
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label,
    currency,
    closedTrades: closed.length,
    netPL: Number(netPL.toFixed(2)),
    grossWin: Number(grossWin.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    financingPaid: Number(financing.toFixed(2)),
    winRatePct: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
    bestTrade: best,
    worstTrade: worst,
    exitBreakdown,
    byInstrument: instrumentBuckets,
    byStrategy: strategyBuckets,
    attribution:
      unattributed === 0 && strategyBuckets.length
        ? "Every closed trade was attributed to a strategy via its pair's profile."
        : "Per-strategy figures cover only pairs running a single strategy; see caveats.",
    openNow: options.open.map((trade) => ({
      instrument: trade.instrument,
      direction: trade.currentUnits > 0 ? "long" : "short",
      unrealizedPL: Number(trade.unrealizedPL.toFixed(2)),
      ageHours: Number(((now - new Date(trade.openTime).getTime()) / 3_600_000).toFixed(1)),
      hasStop: trade.stopLossPrice !== null,
    })),
    headline:
      closed.length === 0
        ? `${label}: no trades closed.`
        : `${label}: ${netPL >= 0 ? "+" : ""}${netPL.toFixed(2)} ${currency} over ` +
          `${closed.length} closed trade(s), ${((wins / closed.length) * 100).toFixed(0)}% win rate` +
          (grossLoss > 0 ? `, profit factor ${(grossWin / grossLoss).toFixed(2)}` : "") +
          `.`,
    actions,
    caveats,
  };
}
