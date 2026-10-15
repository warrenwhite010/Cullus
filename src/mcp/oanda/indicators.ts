// Indicator maths shared by the live signal tool and the backtester.
//
// One implementation on purpose: a backtest that computes ATR differently from
// the live path is a backtest of a strategy nobody is running.

import type { Candle } from "./api.js";

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  // Seed with the first full SMA so the series does not inherit the noise of a
  // single opening print.
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i === period - 1) {
      prev = sum / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stdev(values: number[], period: number): number[] {
  const means = sma(values, period);
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const mean = means[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/** True range of each candle, using the previous close for the gap terms. */
export function trueRange(candles: Candle[]): number[] {
  return candles.map((candle, i) => {
    if (i === 0) return candle.high - candle.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
  });
}

/** Wilder's ATR — the volatility unit every stop, target and size derives from. */
export function atr(candles: Candle[], period = 14): number[] {
  const tr = trueRange(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Wilder ADX — trend *strength* without direction.
 *
 * The single cheapest filter available: mean-reversion entries taken while ADX
 * is high, and breakout entries taken while it is low, are the two ways a
 * signal set with a real edge still loses money.
 */
export function adx(candles: Candle[], period = 14): number[] {
  const len = candles.length;
  const out: number[] = new Array(len).fill(NaN);
  if (len < period * 2) return out;

  const tr = trueRange(candles);
  const plusDM: number[] = new Array(len).fill(0);
  const minusDM: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }

  const dx: number[] = new Array(len).fill(NaN);
  for (let i = period + 1; i < len; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plusDM[i];
    minusSum = minusSum - minusSum / period + minusDM[i];
    if (trSum === 0) continue;
    const plusDI = (100 * plusSum) / trSum;
    const minusDI = (100 * minusSum) / trSum;
    const denom = plusDI + minusDI;
    dx[i] = denom === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / denom;
  }

  let acc = 0;
  let counted = 0;
  for (let i = period + 1; i < len; i++) {
    if (Number.isNaN(dx[i])) continue;
    counted++;
    acc += dx[i];
    if (counted === period) {
      out[i] = acc / period;
    } else if (counted > period) {
      out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return out;
}

/** Highest high / lowest low over the previous `period` candles, excluding now. */
export function donchian(
  candles: Candle[],
  period: number
): { upper: number[]; lower: number[] } {
  const upper: number[] = new Array(candles.length).fill(NaN);
  const lower: number[] = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Rate of change of `values` over `period` bars, as a fraction. */
export function momentum(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period];
    if (past !== 0) out[i] = (values[i] - past) / past;
  }
  return out;
}

export function last(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return NaN;
}
