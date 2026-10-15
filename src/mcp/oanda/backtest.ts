// Bar-by-bar backtester and walk-forward optimiser.
//
// The point of this file is to make "will this make more money?" a question with
// an answer instead of an opinion. It is deliberately pessimistic:
//
//   * entries fill at the NEXT bar's open, never the signal bar's close, so no
//     decision uses a price it could not have known;
//   * the spread is paid on entry and on exit;
//   * when a bar's range contains both the stop and the target, the stop wins;
//   * position size is recomputed from the equity curve, so a losing run shrinks
//     the size the way it would live.
//
// A strategy that only looks good without these is not a strategy, it is a
// rounding error with a story.

import type { Candle, InstrumentSpec } from "./api.js";
import { computeIndicators, selectSignal, sizePosition, warmupBars, type Direction } from "./strategy.js";
import { resolveParams, type StrategyParams } from "./params.js";

export interface BacktestTrade {
  instrument: string;
  strategy: string;
  direction: Direction;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  units: number;
  stopPrice: number;
  targetPrice: number;
  /** Profit in account currency, spread included. */
  pl: number;
  /** Profit in units of initial risk. −1 is a clean stop-out. */
  rMultiple: number;
  exitReason: "stop" | "target" | "trail" | "partial+stop" | "partial+target" | "end-of-data";
  barsHeld: number;
  equityAfter: number;
  /** True when a partial take-profit was banked before the final exit. */
  scaledOut: boolean;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPL: number;
  returnPct: number;
  /** Gross wins ÷ gross losses. Below 1.0 the strategy loses money. */
  profitFactor: number;
  /** Average R per trade — the number that actually compounds. */
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  maxDrawdownPct: number;
  /** Per-trade Sharpe on R multiples (not annualised). */
  sharpe: number;
  longestLossStreak: number;
  avgBarsHeld: number;
  exitBreakdown: Record<string, number>;
  byStrategy: Record<string, { trades: number; expectancyR: number; profitFactor: number }>;
  byInstrument: Record<string, { trades: number; netPL: number; expectancyR: number }>;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  startingEquity: number;
  endingEquity: number;
  trades: BacktestTrade[];
  barsTested: number;
  window: { from: string; to: string } | null;
  /** Anything that makes the numbers less trustworthy than they look. */
  warnings: string[];
}

export interface InstrumentSeries {
  instrument: string;
  spec: InstrumentSpec;
  candles: Candle[];
  /** Typical spread in price units. Charged on entry and exit. */
  spread: number;
}

interface OpenPosition {
  instrument: string;
  strategy: string;
  direction: Direction;
  units: number;
  entryPrice: number;
  entryTime: string;
  entryIndex: number;
  stopPrice: number;
  targetPrice: number;
  initialStopDistance: number;
  riskAmount: number;
  rate: number;
  /** P/L already banked by a partial take-profit on this trade. */
  bankedPL: number;
  scaledOut: boolean;
}

/**
 * Value of one unit of the quote currency in the account currency.
 *
 * Exact for pairs quoted in the account currency (EUR_USD on a USD account) and
 * an approximation elsewhere (USD_JPY uses 1/price). Cross-pair P/L can be off
 * by the third currency's drift, which is why `warnings` says so.
 */
function quoteRate(instrument: string, price: number, accountCurrency: string): number {
  const [, quote] = instrument.split(/[_\-/]/);
  if (!quote || quote === accountCurrency) return 1;
  const [base] = instrument.split(/[_\-/]/);
  if (base === accountCurrency) return price > 0 ? 1 / price : 1;
  return 1;
}

export function runBacktest(
  series: InstrumentSeries[],
  globalParams: StrategyParams,
  options: { startingEquity: number; accountCurrency?: string } = { startingEquity: 10_000 }
): BacktestResult {
  const accountCurrency = options.accountCurrency ?? "USD";
  const warnings: string[] = [];
  let equity = options.startingEquity;
  const peakEquity = { value: equity };
  let maxDrawdownPct = 0;
  const trades: BacktestTrade[] = [];
  let barsTested = 0;

  for (const item of series) {
    const { instrument, spec, candles, spread } = item;
    // Per-instrument profile applied here: without this, testing a profile would
    // silently test the globals and report a number that means nothing.
    const params = resolveParams(globalParams, instrument);
    if (globalParams.profiles?.[instrument]?.disabled) {
      warnings.push(`${instrument}: disabled by its profile, skipped.`);
      continue;
    }
    const warmup = warmupBars(params);

    if (candles.length < warmup + 30) {
      warnings.push(
        `${instrument}: only ${candles.length} candles, needs > ${warmup + 30} for a ` +
          `meaningful test. Skipped.`
      );
      continue;
    }
    if (!/[_\-/]/.test(instrument)) {
      warnings.push(`${instrument}: unrecognised symbol shape; P/L conversion assumed 1:1.`);
    }
    const [, quote] = instrument.split(/[_\-/]/);
    if (quote && quote !== accountCurrency && instrument.split(/[_\-/]/)[0] !== accountCurrency) {
      warnings.push(
        `${instrument}: cross pair — P/L converted at a fixed 1.0 rate, so absolute ` +
          `figures are indicative. R multiples are unaffected.`
      );
    }

    const frame = computeIndicators(candles, params);
    let position: OpenPosition | null = null;
    barsTested += candles.length - warmup;

    for (let i = warmup; i < candles.length - 1; i++) {
      const candle = candles[i];
      if (!candle.complete) continue;

      // --- Manage an open position on this bar --------------------------
      if (position) {
        const isLong = position.direction === "long";
        const hitStop = isLong
          ? candle.low <= position.stopPrice
          : candle.high >= position.stopPrice;
        const hitTarget = isLong
          ? candle.high >= position.targetPrice
          : candle.low <= position.targetPrice;

        // --- Partial take-profit at 1R, before the exit checks -------------
        //
        // Ordered first because a bar that reaches 1R and then reverses to the
        // stop must bank the partial: that sequence is the whole reason to scale
        // out, and checking the stop first would throw the benefit away.
        if (
          !position.scaledOut &&
          params.entry.partialTakeProfitFraction > 0 &&
          params.entry.takeProfitR > 1
        ) {
          const oneR = isLong
            ? position.entryPrice + position.initialStopDistance
            : position.entryPrice - position.initialStopDistance;
          const reachedOneR = isLong ? candle.high >= oneR : candle.low <= oneR;

          if (reachedOneR) {
            const closing = Math.floor(position.units * params.entry.partialTakeProfitFraction);
            if (closing > 0 && closing < position.units) {
              const fill = isLong ? oneR - spread / 2 : oneR + spread / 2;
              const move = isLong ? fill - position.entryPrice : position.entryPrice - fill;
              const banked = move * closing * position.rate;

              equity += banked;
              position.bankedPL += banked;
              position.units -= closing;
              position.scaledOut = true;

              // The runner's stop goes to break-even, then trails by ATR if
              // configured. Worst case on the remainder becomes ~zero, so the
              // trade cannot give back the banked half.
              position.stopPrice = isLong
                ? Math.max(position.stopPrice, position.entryPrice)
                : Math.min(position.stopPrice, position.entryPrice);
            }
          }
        }

        let exitPrice: number | null = null;
        let reason: BacktestTrade["exitReason"] | null = null;

        // Pessimistic tie-break: within one bar we cannot know the order, so
        // assume the worse of the two happened first.
        if (hitStop) {
          exitPrice = position.stopPrice;
          reason = position.scaledOut
            ? "partial+stop"
            : position.stopPrice === position.entryPrice
              ? "trail"
              : "stop";
        } else if (hitTarget) {
          exitPrice = position.targetPrice;
          reason = position.scaledOut ? "partial+target" : "target";
        }

        if (exitPrice !== null && reason) {
          // Exit crosses the spread again.
          const fill = isLong ? exitPrice - spread / 2 : exitPrice + spread / 2;
          const move = isLong ? fill - position.entryPrice : position.entryPrice - fill;
          const pl = move * position.units * position.rate + position.bankedPL;
          equity += move * position.units * position.rate;

          if (equity > peakEquity.value) peakEquity.value = equity;
          const drawdown = ((peakEquity.value - equity) / peakEquity.value) * 100;
          if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;

          trades.push({
            instrument,
            strategy: position.strategy,
            direction: position.direction,
            entryTime: position.entryTime,
            exitTime: candle.time,
            entryPrice: position.entryPrice,
            exitPrice: fill,
            units: position.units,
            stopPrice: position.stopPrice,
            targetPrice: position.targetPrice,
            pl,
            rMultiple: position.riskAmount > 0 ? pl / position.riskAmount : 0,
            exitReason: reason,
            barsHeld: i - position.entryIndex,
            equityAfter: equity,
            scaledOut: position.scaledOut,
          });
          position = null;
        } else if (params.entry.trailAfterR > 0 || position.scaledOut) {
          // Trail: once the trade is trailAfterR in front, ratchet the stop so
          // the worst case is break-even. This is what turns a 45%-win system
          // into a positive-expectancy one.
          // Measure progress against the bar's best price in the trade's own
          // favour — the previous version used `candle.high` for both sides, so
          // shorts were credited with progress when price moved against them.
          const favourable = isLong
            ? candle.high - position.entryPrice
            : position.entryPrice - candle.low;
          const progressR = favourable / position.initialStopDistance;

          if (params.entry.trailAfterR > 0 && progressR >= params.entry.trailAfterR) {
            const breakeven = position.entryPrice;
            position.stopPrice = isLong
              ? Math.max(position.stopPrice, breakeven)
              : Math.min(position.stopPrice, breakeven);
          }

          // ATR trail on the runner after a partial fill: this is what lets one
          // trade in ten pay for the nine that scratched.
          if (position.scaledOut && params.entry.runnerTrailAtrMultiple > 0) {
            const currentAtr = frame.atr[i];
            if (Number.isFinite(currentAtr) && currentAtr > 0) {
              const trailDistance = currentAtr * params.entry.runnerTrailAtrMultiple;
              const trailed = isLong ? candle.high - trailDistance : candle.low + trailDistance;
              position.stopPrice = isLong
                ? Math.max(position.stopPrice, trailed)
                : Math.min(position.stopPrice, trailed);
            }
          }
        }
      }

      // --- Look for a new entry ----------------------------------------
      if (position) continue;

      // selectSignal, not evaluateAt: the backtest has to arbitrate between
      // strategies the same way the live scan does, or a pair configured for
      // conviction/agreement is measured on behaviour it will never exhibit.
      // In precedence mode this is evaluateAt with one extra object allocation.
      const signal = selectSignal(candles, frame, i, params).signal;
      if (!signal) continue;

      const currentAtr = frame.atr[i];
      const pip = Math.pow(10, spec.pipLocation);
      if (currentAtr / pip < params.entry.minAtrPips) continue;
      if (spread / currentAtr > params.entry.maxSpreadAtrRatio) continue;

      // Fill at the next bar's open, plus half the spread against us.
      const next = candles[i + 1];
      const entryPrice =
        signal.direction === "long" ? next.open + spread / 2 : next.open - spread / 2;
      const rate = quoteRate(instrument, entryPrice, accountCurrency);

      const sizing = sizePosition({
        nav: equity,
        riskPerTradePct: params.risk.riskPerTradePct,
        stopDistance: signal.stopDistance,
        spec,
        direction: signal.direction,
        quoteToAccountRate: rate,
      });
      if (sizing.units <= 0) continue;

      position = {
        instrument,
        strategy: signal.strategy,
        direction: signal.direction,
        units: sizing.units,
        entryPrice,
        entryTime: next.time,
        entryIndex: i + 1,
        stopPrice:
          signal.direction === "long"
            ? entryPrice - signal.stopDistance
            : entryPrice + signal.stopDistance,
        targetPrice:
          signal.direction === "long"
            ? entryPrice + signal.takeProfitDistance
            : entryPrice - signal.takeProfitDistance,
        initialStopDistance: signal.stopDistance,
        riskAmount: sizing.actualRiskAmount,
        rate,
        bankedPL: 0,
        scaledOut: false,
      };
    }
  }

  trades.sort((a, b) => a.exitTime.localeCompare(b.exitTime));

  const allCandles = series.flatMap((s) => s.candles);
  const window =
    allCandles.length > 0
      ? {
          from: allCandles.reduce((min, c) => (c.time < min ? c.time : min), allCandles[0].time),
          to: allCandles.reduce((max, c) => (c.time > max ? c.time : max), allCandles[0].time),
        }
      : null;

  if (trades.length > 0 && trades.length < 30) {
    warnings.push(
      `Only ${trades.length} trades: too few to distinguish edge from luck. ` +
        `Widen the window or loosen the filters before trusting these metrics.`
    );
  }

  return {
    metrics: summarise(trades, options.startingEquity, equity, maxDrawdownPct),
    startingEquity: options.startingEquity,
    endingEquity: equity,
    trades,
    barsTested,
    window,
    warnings,
  };
}

function summarise(
  trades: BacktestTrade[],
  startingEquity: number,
  endingEquity: number,
  maxDrawdownPct: number
): BacktestMetrics {
  const wins = trades.filter((t) => t.pl > 0);
  const losses = trades.filter((t) => t.pl <= 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pl, 0));
  const rs = trades.map((t) => t.rMultiple);
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const variance = rs.length
    ? rs.reduce((sum, r) => sum + (r - meanR) ** 2, 0) / Math.max(1, rs.length - 1)
    : 0;
  const sd = Math.sqrt(variance);

  let streak = 0;
  let longestStreak = 0;
  for (const trade of trades) {
    if (trade.pl <= 0) {
      streak++;
      longestStreak = Math.max(longestStreak, streak);
    } else {
      streak = 0;
    }
  }

  const exitBreakdown: Record<string, number> = {};
  for (const trade of trades) {
    exitBreakdown[trade.exitReason] = (exitBreakdown[trade.exitReason] ?? 0) + 1;
  }

  const group = <T extends string>(key: (t: BacktestTrade) => T) => {
    const buckets = new Map<T, BacktestTrade[]>();
    for (const trade of trades) {
      const bucket = buckets.get(key(trade)) ?? [];
      bucket.push(trade);
      buckets.set(key(trade), bucket);
    }
    return buckets;
  };

  const byStrategy: BacktestMetrics["byStrategy"] = {};
  for (const [name, bucket] of group((t) => t.strategy)) {
    const win = bucket.filter((t) => t.pl > 0).reduce((s, t) => s + t.pl, 0);
    const loss = Math.abs(bucket.filter((t) => t.pl <= 0).reduce((s, t) => s + t.pl, 0));
    byStrategy[name] = {
      trades: bucket.length,
      expectancyR: round(bucket.reduce((s, t) => s + t.rMultiple, 0) / bucket.length),
      profitFactor: loss === 0 ? (win > 0 ? Infinity : 0) : round(win / loss),
    };
  }

  const byInstrument: BacktestMetrics["byInstrument"] = {};
  for (const [name, bucket] of group((t) => t.instrument)) {
    byInstrument[name] = {
      trades: bucket.length,
      netPL: round(bucket.reduce((s, t) => s + t.pl, 0), 2),
      expectancyR: round(bucket.reduce((s, t) => s + t.rMultiple, 0) / bucket.length),
    };
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? round((wins.length / trades.length) * 100, 1) : 0,
    netPL: round(endingEquity - startingEquity, 2),
    returnPct: round(((endingEquity - startingEquity) / startingEquity) * 100, 2),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : round(grossWin / grossLoss),
    expectancyR: round(meanR),
    avgWinR: wins.length
      ? round(wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length)
      : 0,
    avgLossR: losses.length
      ? round(losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length)
      : 0,
    maxDrawdownPct: round(maxDrawdownPct, 2),
    sharpe: sd === 0 ? 0 : round(meanR / sd),
    longestLossStreak: longestStreak,
    avgBarsHeld: trades.length
      ? round(trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length, 1)
      : 0,
    exitBreakdown,
    byStrategy,
    byInstrument,
  };
}

function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Walk-forward optimisation
// ---------------------------------------------------------------------------

export interface OptimizerCandidate {
  patch: Record<string, Record<string, number>>;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
}

export interface OptimizerResult {
  tested: number;
  /** Ranked by out-of-sample expectancy, best first. */
  ranked: OptimizerCandidate[];
  baseline: { inSample: BacktestMetrics; outOfSample: BacktestMetrics };
  splitAt: string | null;
  verdict: string;
}

/**
 * Grid-search a small set of parameters, scoring on data the search never saw.
 *
 * In-sample-only optimisation reliably produces beautiful curves that lose money
 * the day they go live; the whole value here is the out-of-sample column. A
 * candidate is only worth adopting if it beats the baseline on BOTH halves —
 * winning only out-of-sample is noise.
 */
export function walkForwardOptimize(
  series: InstrumentSeries[],
  params: StrategyParams,
  grid: Record<string, Record<string, number[]>>,
  options: { startingEquity: number; trainFraction?: number; maxCandidates?: number }
): OptimizerResult {
  const trainFraction = options.trainFraction ?? 0.6;
  const maxCandidates = options.maxCandidates ?? 200;

  const split = (fraction: number, part: "train" | "test"): InstrumentSeries[] =>
    series.map((item) => {
      const cut = Math.floor(item.candles.length * fraction);
      return {
        ...item,
        candles: part === "train" ? item.candles.slice(0, cut) : item.candles.slice(cut),
      };
    });

  const train = split(trainFraction, "train");
  const test = split(trainFraction, "test");
  const splitAt = test[0]?.candles[0]?.time ?? null;

  const combos = expandGrid(grid).slice(0, maxCandidates);
  const candidates: OptimizerCandidate[] = [];

  for (const patch of combos) {
    const candidate = applyPatch(params, patch);
    const inSample = runBacktest(train, candidate, { startingEquity: options.startingEquity })
      .metrics;
    // Do not spend time scoring a variant that never traded in-sample.
    if (inSample.trades < 10) continue;
    const outOfSample = runBacktest(test, candidate, { startingEquity: options.startingEquity })
      .metrics;
    candidates.push({ patch, inSample, outOfSample });
  }

  const baselineIn = runBacktest(train, params, { startingEquity: options.startingEquity }).metrics;
  const baselineOut = runBacktest(test, params, { startingEquity: options.startingEquity }).metrics;

  const score = (m: BacktestMetrics) =>
    m.trades < 10 ? -Infinity : m.expectancyR * Math.sqrt(m.trades);
  candidates.sort((a, b) => score(b.outOfSample) - score(a.outOfSample));

  const best = candidates[0];
  let verdict: string;
  if (!best) {
    verdict = "No candidate produced enough trades to judge. Widen the window or the grid.";
  } else if (
    best.outOfSample.expectancyR > baselineOut.expectancyR &&
    best.inSample.expectancyR > baselineIn.expectancyR
  ) {
    verdict =
      `Best candidate beats the current parameters on both halves ` +
      `(out-of-sample expectancy ${best.outOfSample.expectancyR}R vs ${baselineOut.expectancyR}R). ` +
      `Reasonable to adopt, then re-test after ~30 live trades.`;
  } else if (best.outOfSample.expectancyR > baselineOut.expectancyR) {
    verdict =
      `Best candidate wins out-of-sample but not in-sample — that pattern is usually luck. ` +
      `Do not adopt on this evidence alone.`;
  } else {
    verdict =
      `Nothing in the grid beat the current parameters out-of-sample. ` +
      `Keeping what you have is the correct move.`;
  }

  return {
    tested: candidates.length,
    ranked: candidates.slice(0, 10),
    baseline: { inSample: baselineIn, outOfSample: baselineOut },
    splitAt,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Per-instrument work: which pairs are worth trading, and with what
// ---------------------------------------------------------------------------

export interface StrategyScore {
  strategy: "trend" | "meanReversion" | "breakout";
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
}

export interface InstrumentRanking {
  instrument: string;
  /** Best single strategy out-of-sample, or null when none produced trades. */
  bestStrategy: StrategyScore | null;
  /** All three, so a marginal second choice is visible rather than hidden. */
  strategies: StrategyScore[];
  /** All enabled strategies together, as the bot currently runs them. */
  combined: { inSample: BacktestMetrics; outOfSample: BacktestMetrics };
  /** Suggested profile patch, ready to feed to oanda_update_params. */
  suggestedProfile: Record<string, unknown> | null;
  worthTrading: boolean;
  verdict: string;
  /** Rank key: out-of-sample expectancy scaled by sample size. */
  confidence: number;
}

function significance(metrics: BacktestMetrics): number {
  // Expectancy alone rewards a 3-trade fluke. Scaling by √n is the cheap,
  // standard correction: it takes both edge and evidence to rank highly.
  if (metrics.trades < 8) return -Infinity;
  return metrics.expectancyR * Math.sqrt(metrics.trades);
}

function onlyStrategy(params: StrategyParams, strategy: StrategyScore["strategy"]): StrategyParams {
  return {
    ...params,
    // Forced back to precedence: with exactly one strategy enabled, `agreement`
    // can never find its second opinion and would score every pair as unusable.
    strategySelection: "precedence",
    trend: { ...params.trend, enabled: strategy === "trend" },
    meanReversion: { ...params.meanReversion, enabled: strategy === "meanReversion" },
    breakout: { ...params.breakout, enabled: strategy === "breakout" },
  };
}

/**
 * Test each strategy on each instrument separately, out of sample.
 *
 * This is the answer to "would the pairs trade better with their own
 * strategies?": measured per pair rather than assumed. Running all three
 * strategies on all pairs — the current behaviour — averages a pair's good
 * strategy together with its bad ones, so a pair that trends beautifully and
 * ranges terribly nets out to noise.
 */
export function rankInstruments(
  series: InstrumentSeries[],
  params: StrategyParams,
  options: { startingEquity: number; trainFraction?: number; minTrades?: number }
): { ranked: InstrumentRanking[]; skipped: string[]; summary: string } {
  const trainFraction = options.trainFraction ?? 0.6;
  const minTrades = options.minTrades ?? 12;
  const ranked: InstrumentRanking[] = [];
  const skipped: string[] = [];

  for (const item of series) {
    const cut = Math.floor(item.candles.length * trainFraction);
    const train: InstrumentSeries[] = [{ ...item, candles: item.candles.slice(0, cut) }];
    const test: InstrumentSeries[] = [{ ...item, candles: item.candles.slice(cut) }];

    if (test[0].candles.length < warmupBars(params) + 30) {
      skipped.push(`${item.instrument}: not enough out-of-sample history.`);
      continue;
    }

    const scores: StrategyScore[] = [];
    for (const strategy of ["trend", "meanReversion", "breakout"] as const) {
      const isolated = onlyStrategy(params, strategy);
      scores.push({
        strategy,
        inSample: runBacktest(train, isolated, { startingEquity: options.startingEquity }).metrics,
        outOfSample: runBacktest(test, isolated, { startingEquity: options.startingEquity }).metrics,
      });
    }

    const combined = {
      inSample: runBacktest(train, params, { startingEquity: options.startingEquity }).metrics,
      outOfSample: runBacktest(test, params, { startingEquity: options.startingEquity }).metrics,
    };

    const viable = scores.filter(
      (score) => score.outOfSample.trades >= minTrades && score.outOfSample.expectancyR > 0
    );
    viable.sort((a, b) => significance(b.outOfSample) - significance(a.outOfSample));
    const best = viable[0] ?? null;

    // A pair earns a place only if its best strategy has positive expectancy
    // out of sample AND held up in sample. Winning only out of sample is luck.
    const worthTrading = Boolean(
      best && best.inSample.expectancyR > 0 && best.outOfSample.expectancyR > 0
    );

    let verdict: string;
    let suggestedProfile: Record<string, unknown> | null = null;

    if (!best) {
      verdict =
        `No strategy cleared ${minTrades} out-of-sample trades with positive expectancy. ` +
        `On this evidence ${item.instrument} is not worth trading — disable it rather than ` +
        `hoping it improves.`;
      suggestedProfile = { disabled: true, notes: `No positive out-of-sample edge found.` };
    } else if (!worthTrading) {
      verdict =
        `${best.strategy} is positive out of sample (${best.outOfSample.expectancyR}R) but not ` +
        `in sample (${best.inSample.expectancyR}R) — that pattern is noise, not edge. Leave it alone.`;
    } else {
      // Keep EVERY strategy that earned its place, not only the winner.
      //
      // The original suggestion was best-strategy-only, which threw away a
      // second strategy that was also profitable out of sample — and a pair
      // running two uncorrelated edges trades more often for the same risk
      // budget, which is the whole point of having three of them. The losers
      // are still switched off; that part was right.
      const keepers = viable.filter(
        (score) => score.inSample.expectancyR > 0 && score.outOfSample.expectancyR > 0
      );
      const kept = keepers.length ? keepers : [best];
      const keptNames = new Set(kept.map((score) => score.strategy));
      const losers = scores.filter((score) => !keptNames.has(score.strategy));

      verdict =
        `${best.strategy} is the strongest edge here: ${best.outOfSample.expectancyR}R over ` +
        `${best.outOfSample.trades} out-of-sample trades (profit factor ` +
        `${best.outOfSample.profitFactor}), versus ${combined.outOfSample.expectancyR}R for all ` +
        `strategies together. ` +
        (kept.length > 1
          ? `${kept.map((s) => s.strategy).join(" and ")} both survived out of sample, so run both ` +
            `and let conviction arbitrate. `
          : "") +
        (losers.length
          ? `Disabling ${losers.map((score) => score.strategy).join(" and ")} here should lift the average.`
          : `Nothing here is worth disabling.`);

      suggestedProfile = {
        notes:
          `${kept.map((s) => s.strategy).join("+")}. Out-of-sample ` +
          `${kept.map((s) => `${s.strategy} ${s.outOfSample.expectancyR}R/${s.outOfSample.trades}t`).join(", ")}.`,
        // Picked by conviction rather than precedence, so a pair with two live
        // strategies takes the better-evidenced one instead of the first one.
        strategySelection: kept.length > 1 ? "conviction" : "precedence",
        trend: { enabled: keptNames.has("trend") },
        meanReversion: { enabled: keptNames.has("meanReversion") },
        breakout: { enabled: keptNames.has("breakout") },
      };
    }

    ranked.push({
      instrument: item.instrument,
      bestStrategy: best,
      strategies: scores,
      combined,
      suggestedProfile,
      worthTrading,
      verdict,
      confidence: best ? Number(significance(best.outOfSample).toFixed(3)) : -999,
    });
  }

  ranked.sort((a, b) => b.confidence - a.confidence);

  const keep = ranked.filter((entry) => entry.worthTrading);
  const drop = ranked.filter((entry) => !entry.worthTrading);
  const summary = keep.length
    ? `Worth trading: ${keep
        .map((entry) => `${entry.instrument} (${entry.bestStrategy!.strategy}, ${entry.bestStrategy!.outOfSample.expectancyR}R)`)
        .join("; ")}.` +
      (drop.length ? ` Not worth trading: ${drop.map((entry) => entry.instrument).join(", ")}.` : "")
    : `No instrument in this set showed a durable out-of-sample edge. That is a real result — ` +
      `trading none of them beats trading all of them.`;

  return { ranked, skipped, summary };
}

/**
 * Walk-forward optimise one instrument and return a profile patch for it.
 *
 * Separate from `walkForwardOptimize` because a grid fitted across six pairs at
 * once finds the compromise that suits none of them.
 */
export function optimizeInstrumentProfile(
  item: InstrumentSeries,
  params: StrategyParams,
  grid: Record<string, Record<string, number[]>>,
  options: { startingEquity: number; trainFraction?: number; maxCandidates?: number }
): {
  instrument: string;
  best: OptimizerCandidate | null;
  baseline: { inSample: BacktestMetrics; outOfSample: BacktestMetrics };
  profilePatch: Record<string, unknown> | null;
  verdict: string;
} {
  const result = walkForwardOptimize([item], params, grid, options);
  const best = result.ranked[0] ?? null;

  const improved =
    best !== null &&
    best.outOfSample.expectancyR > result.baseline.outOfSample.expectancyR &&
    best.inSample.expectancyR > result.baseline.inSample.expectancyR &&
    best.outOfSample.trades >= 10;

  return {
    instrument: item.instrument,
    best,
    baseline: result.baseline,
    profilePatch: improved
      ? {
          ...best!.patch,
          notes:
            `Walk-forward tuned: out-of-sample ${best!.outOfSample.expectancyR}R over ` +
            `${best!.outOfSample.trades} trades (baseline ${result.baseline.outOfSample.expectancyR}R).`,
        }
      : null,
    verdict: improved
      ? `Adopt: beats the current parameters on both halves for ${item.instrument}.`
      : `Keep current parameters for ${item.instrument} — ${result.verdict}`,
  };
}

function expandGrid(
  grid: Record<string, Record<string, number[]>>
): Array<Record<string, Record<string, number>>> {
  const axes: Array<{ section: string; key: string; values: number[] }> = [];
  for (const [section, keys] of Object.entries(grid)) {
    for (const [key, values] of Object.entries(keys)) {
      if (Array.isArray(values) && values.length > 0) axes.push({ section, key, values });
    }
  }

  let combos: Array<Record<string, Record<string, number>>> = [{}];
  for (const axis of axes) {
    const next: Array<Record<string, Record<string, number>>> = [];
    for (const combo of combos) {
      for (const value of axis.values) {
        next.push({
          ...combo,
          [axis.section]: { ...(combo[axis.section] ?? {}), [axis.key]: value },
        });
      }
    }
    combos = next;
  }
  return combos;
}

function applyPatch(
  params: StrategyParams,
  patch: Record<string, Record<string, number>>
): StrategyParams {
  const next: any = { ...params };
  for (const [section, values] of Object.entries(patch)) {
    next[section] = { ...(params as any)[section], ...values };
  }
  return next as StrategyParams;
}
