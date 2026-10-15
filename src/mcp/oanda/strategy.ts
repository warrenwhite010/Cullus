// Signal generation and risk-based position sizing.
//
// Every entry decision the bot can make is expressed here, as a pure function of
// (candles, params) — no network, no clock, no account state. That is what makes
// the backtest and the live path the same strategy instead of two cousins.

import type { Candle, InstrumentSpec } from "./api.js";
import { adx, atr, donchian, rsi, sma } from "./indicators.js";
import type { StrategyParams } from "./params.js";

export type Direction = "long" | "short";

export interface Signal {
  direction: Direction;
  strategy: "trend" | "meanReversion" | "breakout";
  /** Why, in one sentence, with the numbers that drove it. */
  reason: string;
  /** Price distance from entry to stop. Never zero. */
  stopDistance: number;
  /** Price distance from entry to target. */
  takeProfitDistance: number;
  atr: number;
  adx: number;
}

/** Indicator values at one bar, precomputed once per series. */
export interface IndicatorFrame {
  atr: number[];
  adx: number[];
  rsi: number[];
  smaFast: number[];
  smaSlow: number[];
  donchianUpper: number[];
  donchianLower: number[];
}

export function computeIndicators(candles: Candle[], params: StrategyParams): IndicatorFrame {
  const closes = candles.map((candle) => candle.close);
  const channel = donchian(candles, params.breakout.lookback);
  return {
    atr: atr(candles, params.entry.atrPeriod),
    adx: adx(candles, 14),
    rsi: rsi(closes, params.meanReversion.rsiPeriod),
    smaFast: sma(closes, params.trend.smaFast),
    smaSlow: sma(closes, params.trend.smaSlow),
    donchianUpper: channel.upper,
    donchianLower: channel.lower,
  };
}

/** How many candles of history must exist before any signal is meaningful. */
export function warmupBars(params: StrategyParams): number {
  return (
    Math.max(
      params.trend.smaSlow,
      params.trend.smaFast,
      params.breakout.lookback,
      params.entry.atrPeriod,
      params.meanReversion.rsiPeriod,
      28 // ADX needs 2× its period
    ) + 2
  );
}

/**
 * Evaluate every enabled strategy at bar `i` and return the first signal.
 *
 * Order is deliberate: breakout, then trend, then mean reversion. A breakout bar
 * is also a bar where price sits far from its mean, and taking the fade there is
 * the classic way to be run over.
 */
export function evaluateAt(
  candles: Candle[],
  frame: IndicatorFrame,
  i: number,
  params: StrategyParams
): Signal | null {
  const candle = candles[i];
  const currentAtr = frame.atr[i];
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

  const stopDistance = currentAtr * params.entry.stopAtrMultiple;
  const takeProfitDistance = stopDistance * params.entry.takeProfitR;
  const strength = Number.isFinite(frame.adx[i]) ? frame.adx[i] : 0;
  const price = candle.close;

  const build = (
    direction: Direction,
    strategy: Signal["strategy"],
    reason: string
  ): Signal => ({
    direction,
    strategy,
    reason,
    stopDistance,
    takeProfitDistance,
    atr: currentAtr,
    adx: strength,
  });

  // --- Breakout: price closing outside a channel it has respected -----------
  if (params.breakout.enabled) {
    const upper = frame.donchianUpper[i];
    const lower = frame.donchianLower[i];
    if (Number.isFinite(upper) && strength >= params.breakout.adxMin) {
      if (price > upper) {
        return build(
          "long",
          "breakout",
          `Close ${price.toFixed(5)} broke the ${params.breakout.lookback}-bar high ` +
            `${upper.toFixed(5)} with ADX ${strength.toFixed(1)}.`
        );
      }
      if (price < lower) {
        return build(
          "short",
          "breakout",
          `Close ${price.toFixed(5)} broke the ${params.breakout.lookback}-bar low ` +
            `${lower.toFixed(5)} with ADX ${strength.toFixed(1)}.`
        );
      }
    }
  }

  // --- Trend: fast/slow SMA agreement, confirmed by ADX --------------------
  if (params.trend.enabled) {
    const fast = frame.smaFast[i];
    const slow = frame.smaSlow[i];
    const prevFast = frame.smaFast[i - 1];
    const prevSlow = frame.smaSlow[i - 1];
    if (
      Number.isFinite(fast) &&
      Number.isFinite(slow) &&
      Number.isFinite(prevFast) &&
      Number.isFinite(prevSlow) &&
      strength >= params.trend.adxMin
    ) {
      // Cross, not merely "above": holding a stale side is what turns a trend
      // filter into a lagging buy-high generator.
      if (prevFast <= prevSlow && fast > slow) {
        return build(
          "long",
          "trend",
          `SMA${params.trend.smaFast} crossed above SMA${params.trend.smaSlow} ` +
            `with ADX ${strength.toFixed(1)}.`
        );
      }
      if (prevFast >= prevSlow && fast < slow) {
        return build(
          "short",
          "trend",
          `SMA${params.trend.smaFast} crossed below SMA${params.trend.smaSlow} ` +
            `with ADX ${strength.toFixed(1)}.`
        );
      }
    }
  }

  // --- Mean reversion: fade an extreme, but only in a quiet market ---------
  if (params.meanReversion.enabled) {
    const value = frame.rsi[i];
    const slow = frame.smaSlow[i];
    if (Number.isFinite(value) && strength <= params.meanReversion.adxMax) {
      const alignedLong =
        !params.meanReversion.requireTrendAlignment || !Number.isFinite(slow) || price > slow;
      const alignedShort =
        !params.meanReversion.requireTrendAlignment || !Number.isFinite(slow) || price < slow;

      if (value < params.meanReversion.rsiBuyBelow && alignedLong) {
        return build(
          "long",
          "meanReversion",
          `RSI ${value.toFixed(1)} below ${params.meanReversion.rsiBuyBelow} ` +
            `with ADX ${strength.toFixed(1)}${
              params.meanReversion.requireTrendAlignment ? " and price above SMA slow" : ""
            }.`
        );
      }
      if (value > params.meanReversion.rsiSellAbove && alignedShort) {
        return build(
          "short",
          "meanReversion",
          `RSI ${value.toFixed(1)} above ${params.meanReversion.rsiSellAbove} ` +
            `with ADX ${strength.toFixed(1)}${
              params.meanReversion.requireTrendAlignment ? " and price below SMA slow" : ""
            }.`
        );
      }
    }
  }

  return null;
}

/**
 * Every enabled strategy's opinion at bar `i`, not just the first one.
 *
 * evaluateAt stops at its first hit, which is correct for a single-position
 * backtest and wrong for the question "what does this pair have to say right
 * now". Each strategy is evaluated with the other two switched off, so the
 * precedence order cannot silence anything. The cost is two extra passes over
 * precomputed indicator arrays — no network, no recomputation.
 */
export function evaluateAll(
  candles: Candle[],
  frame: IndicatorFrame,
  i: number,
  params: StrategyParams
): Signal[] {
  const signals: Signal[] = [];

  for (const strategy of ["breakout", "trend", "meanReversion"] as const) {
    if (!params[strategy].enabled) continue;

    const isolated: StrategyParams = {
      ...params,
      breakout: { ...params.breakout, enabled: strategy === "breakout" },
      trend: { ...params.trend, enabled: strategy === "trend" },
      meanReversion: { ...params.meanReversion, enabled: strategy === "meanReversion" },
    };

    const signal = evaluateAt(candles, frame, i, isolated);
    if (signal) signals.push(signal);
  }

  return signals;
}

/**
 * How strong the evidence behind one signal is, 0–100.
 *
 * Each strategy is scored against what IT considers evidence, because the
 * things are not comparable raw: ADX 40 is a superb trend signal and a reason
 * to refuse a mean-reversion one. Scores are deliberately coarse — this picks
 * between two live signals, it does not pretend to be a probability.
 */
export function conviction(
  signal: Signal,
  candles: Candle[],
  frame: IndicatorFrame,
  i: number,
  params: StrategyParams
): number {
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  const atrNow = frame.atr[i];
  if (!Number.isFinite(atrNow) || atrNow <= 0) return 0;

  const price = candles[i].close;
  const adxValue = Number.isFinite(frame.adx[i]) ? frame.adx[i] : 0;

  if (signal.strategy === "breakout") {
    const edge =
      signal.direction === "long" ? frame.donchianUpper[i] : frame.donchianLower[i];
    // How far beyond the channel the close sits, in ATR. Half an ATR clear of
    // the line is a decisive break; a tick over it is noise wearing a signal's hat.
    const beyond = Number.isFinite(edge) ? Math.abs(price - edge) / atrNow : 0;
    const strength = (adxValue - params.breakout.adxMin) / 20;
    return clamp(45 + beyond * 70 + strength * 25);
  }

  if (signal.strategy === "trend") {
    const separation = Math.abs(frame.smaFast[i] - frame.smaSlow[i]) / atrNow;
    const strength = (adxValue - params.trend.adxMin) / 20;
    return clamp(40 + separation * 45 + strength * 30);
  }

  // Mean reversion: distance past the RSI threshold, rewarded for a quiet tape.
  const rsiValue = frame.rsi[i];
  const past =
    signal.direction === "long"
      ? params.meanReversion.rsiBuyBelow - rsiValue
      : rsiValue - params.meanReversion.rsiSellAbove;
  const quiet = (params.meanReversion.adxMax - adxValue) / params.meanReversion.adxMax;
  return clamp(35 + Math.max(0, past) * 2.5 + Math.max(0, quiet) * 30);
}

export interface StrategyChoice {
  /** The signal to act on, or null when nothing qualified. */
  signal: Signal | null;
  /** Every signal that fired, strongest first, each with its conviction. */
  candidates: Array<{ signal: Signal; conviction: number }>;
  /** Which rule picked, so a scan row can explain itself. */
  selection: StrategyParams["strategySelection"];
  /** Why this one, or why none. */
  reason: string;
}

/**
 * Pick one signal from everything the pair's enabled strategies produced.
 *
 * This is the function that makes "several strategies on one pair" mean
 * something. Under `precedence` it reproduces the old first-match behaviour
 * exactly, so an existing configuration keeps its existing results.
 */
export function selectSignal(
  candles: Candle[],
  frame: IndicatorFrame,
  i: number,
  params: StrategyParams
): StrategyChoice {
  const mode = params.strategySelection ?? "precedence";

  if (mode === "precedence") {
    const signal = evaluateAt(candles, frame, i, params);
    return {
      signal,
      candidates: signal ? [{ signal, conviction: conviction(signal, candles, frame, i, params) }] : [],
      selection: mode,
      reason: signal
        ? `${signal.strategy} fired first in precedence order.`
        : "No enabled strategy produced a signal.",
    };
  }

  const candidates = evaluateAll(candles, frame, i, params)
    .map((signal) => ({ signal, conviction: conviction(signal, candles, frame, i, params) }))
    .sort((a, b) => b.conviction - a.conviction);

  if (candidates.length === 0) {
    return { signal: null, candidates, selection: mode, reason: "No enabled strategy produced a signal." };
  }

  if (mode === "agreement") {
    const best = candidates[0];
    const seconds = candidates.filter(
      (c) => c !== best && c.signal.direction === best.signal.direction
    );
    if (seconds.length === 0) {
      return {
        signal: null,
        candidates,
        selection: mode,
        reason:
          `Only ${best.signal.strategy} fired ${best.signal.direction}; agreement mode needs a ` +
          `second strategy pointing the same way.`,
      };
    }
    return {
      signal: best.signal,
      candidates,
      selection: mode,
      reason:
        `${best.signal.strategy} (${best.conviction.toFixed(0)}) and ` +
        `${seconds.map((s) => s.signal.strategy).join(", ")} all point ${best.signal.direction}.`,
    };
  }

  // Conviction mode. A pair of opposing signals is a genuine disagreement, and
  // taking the marginally stronger side of one is how you get chopped up — so
  // a near-tie between opposite directions is treated as no signal.
  const best = candidates[0];
  const opposed = candidates.find((c) => c.signal.direction !== best.signal.direction);
  if (opposed && best.conviction - opposed.conviction < 15) {
    return {
      signal: null,
      candidates,
      selection: mode,
      reason:
        `${best.signal.strategy} says ${best.signal.direction} (${best.conviction.toFixed(0)}) but ` +
        `${opposed.signal.strategy} says ${opposed.signal.direction} ` +
        `(${opposed.conviction.toFixed(0)}) — too close to call.`,
    };
  }

  return {
    signal: best.signal,
    candidates,
    selection: mode,
    reason:
      `${best.signal.strategy} had the strongest evidence (${best.conviction.toFixed(0)})` +
      (candidates.length > 1
        ? ` over ${candidates.slice(1).map((c) => `${c.signal.strategy} ${c.conviction.toFixed(0)}`).join(", ")}.`
        : "."),
  };
}

export interface CostCheck {
  ok: boolean;
  reason: string;
  spreadPips: number;
  atrPips: number;
  spreadAtrRatio: number;
}

/**
 * Would the round-trip cost eat the trade?
 *
 * Spread is paid on entry and exit, so a 1-pip spread against a 6-pip expected
 * move is a third of the edge gone. This check is why a "profitable" signal set
 * can still lose: it filters the bars where the market is not worth trading.
 */
export function checkCost(
  spread: number,
  currentAtr: number,
  spec: InstrumentSpec,
  params: StrategyParams
): CostCheck {
  const pip = Math.pow(10, spec.pipLocation);
  const spreadPips = spread / pip;
  const atrPips = currentAtr / pip;
  const ratio = currentAtr > 0 ? spread / currentAtr : Infinity;

  if (atrPips < params.entry.minAtrPips) {
    return {
      ok: false,
      reason: `ATR ${atrPips.toFixed(1)} pips is below the ${params.entry.minAtrPips}-pip floor: too quiet to pay for costs.`,
      spreadPips,
      atrPips,
      spreadAtrRatio: ratio,
    };
  }
  if (ratio > params.entry.maxSpreadAtrRatio) {
    return {
      ok: false,
      reason:
        `Spread ${spreadPips.toFixed(1)} pips is ${(ratio * 100).toFixed(0)}% of ATR ` +
        `(limit ${(params.entry.maxSpreadAtrRatio * 100).toFixed(0)}%).`,
      spreadPips,
      atrPips,
      spreadAtrRatio: ratio,
    };
  }
  return {
    ok: true,
    reason: `Spread ${spreadPips.toFixed(1)} pips vs ATR ${atrPips.toFixed(1)} pips — acceptable.`,
    spreadPips,
    atrPips,
    spreadAtrRatio: ratio,
  };
}

export interface SizingResult {
  units: number;
  /** Signed for the requested direction: negative units are a short at OANDA. */
  signedUnits: number;
  riskAmount: number;
  actualRiskAmount: number;
  stopDistance: number;
  stopPips: number;
  valuePerUnitPerPrice: number;
  notes: string[];
}

/**
 * Risk-based position size: units such that a stop-out costs `riskPerTradePct`
 * of NAV, and no more.
 *
 * This is the one calculation that decides whether a strategy with an edge makes
 * money. Fixed unit counts — the bot's previous `units: 500` for every symbol —
 * risk wildly different amounts per trade, so the size is largest exactly when
 * volatility is highest.
 *
 * `quoteToAccountRate` converts one unit of the quote currency into the account
 * currency (1.0 when they match, e.g. any XXX_USD pair on a USD account).
 */
export function sizePosition(input: {
  nav: number;
  riskPerTradePct: number;
  stopDistance: number;
  spec: InstrumentSpec;
  direction: Direction;
  quoteToAccountRate: number;
  marginAvailable?: number;
  entryPrice?: number;
  maxMarginUtilizationPct?: number;
}): SizingResult {
  const notes: string[] = [];
  const riskAmount = (input.nav * input.riskPerTradePct) / 100;
  const pip = Math.pow(10, input.spec.pipLocation);

  if (input.stopDistance <= 0) {
    return {
      units: 0,
      signedUnits: 0,
      riskAmount,
      actualRiskAmount: 0,
      stopDistance: input.stopDistance,
      stopPips: 0,
      valuePerUnitPerPrice: input.quoteToAccountRate,
      notes: ["Stop distance is zero or negative: refusing to size a position with no stop."],
    };
  }

  // Loss on a stop-out = units × stopDistance × (quote → account rate).
  const lossPerUnit = input.stopDistance * input.quoteToAccountRate;
  let units = Math.floor(riskAmount / lossPerUnit);

  const precision = input.spec.tradeUnitsPrecision;
  if (precision === 0) units = Math.floor(units);

  if (units < input.spec.minimumTradeSize) {
    notes.push(
      `Risk budget ${riskAmount.toFixed(2)} only supports ${units} units, below the ` +
        `${input.spec.minimumTradeSize}-unit minimum for ${input.spec.name}. ` +
        `Taking this trade would risk more than ${input.riskPerTradePct}% of NAV — skip it.`
    );
    units = 0;
  }

  // Margin is a second, independent ceiling: passing the risk test does not mean
  // the broker will let the order through.
  if (units > 0 && input.marginAvailable !== undefined && input.entryPrice) {
    const cap = (input.maxMarginUtilizationPct ?? 100) / 100;
    const marginPerUnit = input.entryPrice * input.spec.marginRate * input.quoteToAccountRate;
    const affordable = Math.floor((input.marginAvailable * cap) / Math.max(marginPerUnit, 1e-9));
    if (affordable < units) {
      notes.push(
        `Margin-capped from ${units} to ${affordable} units ` +
          `(${input.marginAvailable.toFixed(2)} available, ${(cap * 100).toFixed(0)}% utilisation limit).`
      );
      units = Math.max(0, affordable);
    }
  }

  return {
    units,
    signedUnits: input.direction === "long" ? units : -units,
    riskAmount,
    actualRiskAmount: units * lossPerUnit,
    stopDistance: input.stopDistance,
    stopPips: input.stopDistance / pip,
    valuePerUnitPerPrice: input.quoteToAccountRate,
    notes,
  };
}

/**
 * The currencies an instrument exposes you to.
 *
 * Used to stop the bot holding EUR_USD long, EUR_JPY long and EUR_GBP long and
 * calling it three diversified positions when it is one leveraged EUR bet.
 */
export function currenciesOf(instrument: string): string[] {
  const parts = instrument.split(/[_\-/]/);
  return parts.length === 2 ? parts : [instrument];
}

/** Instrument-specific liquid hours, in the machine's local timezone. */
export function isInLiquidityWindow(instrument: string, now: Date): boolean {
  const hour = now.getHours();
  const day = now.getDay();

  // Crypto trades continuously.
  if (instrument.includes("-") || /BTC|ETH|LTC|BCH/.test(instrument)) return true;

  // Forex is shut from Friday evening to Sunday evening.
  if (day === 6) return false;
  if (day === 5 && hour >= 17) return false;
  if (day === 0 && hour < 17) return false;

  if (/JPY|AUD|NZD|SGD|HKD/.test(instrument)) {
    return hour >= 19 || hour <= 4; // Asia / Pacific
  }
  if (instrument.includes("EUR_GBP")) {
    return hour >= 3 && hour <= 12; // European session
  }
  return hour >= 3 && hour <= 16; // London through the New York overlap
}
