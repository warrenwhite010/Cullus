// Multi-timeframe consensus scoring.
//
// A single strategy firing on a single timeframe is one opinion. This combines
// several, on several timeframes, into a signed score and a verdict — so the
// answer to "does this trade look good?" is a number with its reasoning attached
// rather than a yes.
//
// The reason this is worth its complexity: the most reliable way to lose money
// with a decent signal is to take it against the higher timeframe. A 15-minute
// RSI buy inside an H4 downtrend has a materially worse expectancy than the same
// signal with H4 pointing up, and no amount of stop tuning fixes it.
//
// Scores are signed: positive is long, negative is short, and the magnitude is
// confidence on a 0–100 scale.

import type { Candle } from "./api.js";
import { adx, atr, donchian, rsi, sma } from "./indicators.js";
import { computeIndicators, evaluateAt, type Signal } from "./strategy.js";
import type { StrategyParams } from "./params.js";

export interface TimeframeView {
  timeframe: string;
  /** Weight this timeframe carried in the final score. */
  weight: number;
  trend: "up" | "down" | "flat";
  /** −100..100 contribution before weighting. */
  score: number;
  adx: number;
  rsi: number;
  atrPips: number;
  close: number;
  smaFast: number;
  smaSlow: number;
  /** Position within the Donchian channel, 0 (at lows) to 1 (at highs). */
  channelPosition: number;
  reasons: string[];
}

export interface StrategyVote {
  strategy: string;
  direction: "long" | "short" | "none";
  reason: string;
}

export interface ConsensusResult {
  instrument: string;
  /** −100..100. Sign is the direction, magnitude is confidence. */
  score: number;
  direction: "long" | "short" | "none";
  /** Fraction of timeframes agreeing with the score's direction, 0–1. */
  agreement: number;
  verdict: "take" | "lean" | "wait" | "avoid";
  /** One-line human summary. */
  summary: string;
  timeframes: TimeframeView[];
  strategyVotes: StrategyVote[];
  /** Everything arguing against acting, in priority order. */
  cautions: string[];
  /** The primary-timeframe signal, when one fired. */
  primarySignal: Signal | null;
  higherTimeframeAligned: boolean;
}

/**
 * Score one timeframe.
 *
 * Four independent reads, deliberately not four flavours of the same thing:
 * where price sits against its moving averages (direction), how strong that is
 * (ADX), whether momentum is stretched (RSI), and where price sits in its recent
 * range (channel position). They can disagree, and the disagreement is the point.
 */
export function scoreTimeframe(
  timeframe: string,
  candles: Candle[],
  params: StrategyParams,
  pipSize: number,
  weight: number
): TimeframeView | null {
  const complete = candles.filter((candle) => candle.complete);
  if (complete.length < Math.max(params.trend.smaSlow, 30) + 2) return null;

  const closes = complete.map((candle) => candle.close);
  const i = complete.length - 1;
  const fast = sma(closes, params.trend.smaFast)[i];
  const slow = sma(closes, params.trend.smaSlow)[i];
  const strength = adx(complete, 14)[i] ?? 0;
  const momentum = rsi(closes, params.meanReversion.rsiPeriod)[i] ?? 50;
  const volatility = atr(complete, params.entry.atrPeriod)[i] ?? 0;
  const channel = donchian(complete, Math.min(params.breakout.lookback, complete.length - 2));
  const close = closes[i];

  const upper = channel.upper[i];
  const lower = channel.lower[i];
  const channelPosition =
    Number.isFinite(upper) && Number.isFinite(lower) && upper > lower
      ? Math.min(1, Math.max(0, (close - lower) / (upper - lower)))
      : 0.5;

  const reasons: string[] = [];
  let score = 0;

  // 1. Structure: price against the two moving averages. Worth the most, because
  //    it is the thing the higher timeframe is being consulted about.
  if (Number.isFinite(fast) && Number.isFinite(slow)) {
    if (close > fast && fast > slow) {
      score += 40;
      reasons.push("Price above both SMAs, fast above slow — clean uptrend structure.");
    } else if (close < fast && fast < slow) {
      score -= 40;
      reasons.push("Price below both SMAs, fast below slow — clean downtrend structure.");
    } else if (close > slow) {
      score += 15;
      reasons.push("Above the slow SMA but structure is mixed.");
    } else if (close < slow) {
      score -= 15;
      reasons.push("Below the slow SMA but structure is mixed.");
    }
  }

  // 2. Strength: ADX scales whatever direction structure found. A strong reading
  //    in a flat structure adds nothing, which is correct.
  const strengthFactor = Math.min(strength / 30, 1.5);
  if (strength >= 25) {
    score *= 1 + (strengthFactor - 1) * 0.4;
    reasons.push(`ADX ${strength.toFixed(1)} confirms a trending market.`);
  } else if (strength < 15) {
    score *= 0.6;
    reasons.push(`ADX ${strength.toFixed(1)} — ranging; directional reads are unreliable here.`);
  }

  // 3. Momentum extremes: a stretched RSI argues against chasing, not for fading.
  //    Reducing the score is the honest treatment; flipping it would be a
  //    mean-reversion bet dressed up as consensus.
  if (momentum > 75 && score > 0) {
    score *= 0.7;
    reasons.push(`RSI ${momentum.toFixed(1)} is overbought — poor place to buy into.`);
  } else if (momentum < 25 && score < 0) {
    score *= 0.7;
    reasons.push(`RSI ${momentum.toFixed(1)} is oversold — poor place to sell into.`);
  }

  // 4. Range position: buying at the top of the channel is worse than buying
  //    after a pullback within the same trend.
  if (score > 0 && channelPosition > 0.9) {
    score *= 0.8;
    reasons.push("At the top of its recent range — entry is late.");
  } else if (score < 0 && channelPosition < 0.1) {
    score *= 0.8;
    reasons.push("At the bottom of its recent range — entry is late.");
  }

  score = Math.max(-100, Math.min(100, score));

  return {
    timeframe,
    weight,
    trend: score > 12 ? "up" : score < -12 ? "down" : "flat",
    score: Math.round(score),
    adx: Number(strength.toFixed(1)),
    rsi: Number(momentum.toFixed(1)),
    atrPips: Number((volatility / pipSize).toFixed(1)),
    close,
    smaFast: fast,
    smaSlow: slow,
    channelPosition: Number(channelPosition.toFixed(2)),
    reasons,
  };
}

/**
 * Weight per timeframe: coarser gets more say.
 *
 * The primary (first) timeframe decides *when*; the higher ones decide *whether*.
 * Weighting them equally would let a 15-minute wiggle outvote the daily trend.
 */
function weightFor(index: number, total: number): number {
  return 1 + index * (total > 1 ? 1 / (total - 1) : 0);
}

export function buildConsensus(input: {
  instrument: string;
  pipSize: number;
  params: StrategyParams;
  /** Candles per timeframe, primary first. */
  byTimeframe: Array<{ timeframe: string; candles: Candle[] }>;
}): ConsensusResult {
  const { instrument, pipSize, params, byTimeframe } = input;
  const views: TimeframeView[] = [];

  byTimeframe.forEach((entry, index) => {
    const view = scoreTimeframe(
      entry.timeframe,
      entry.candles,
      params,
      pipSize,
      weightFor(index, byTimeframe.length)
    );
    if (view) views.push(view);
  });

  const cautions: string[] = [];
  if (views.length === 0) {
    return {
      instrument,
      score: 0,
      direction: "none",
      agreement: 0,
      verdict: "wait",
      summary: `Not enough history on any requested timeframe for ${instrument}.`,
      timeframes: [],
      strategyVotes: [],
      cautions: ["No timeframe had enough complete candles to score."],
      primarySignal: null,
      higherTimeframeAligned: false,
    };
  }

  const totalWeight = views.reduce((sum, view) => sum + view.weight, 0);
  const weighted = views.reduce((sum, view) => sum + view.score * view.weight, 0) / totalWeight;
  const score = Math.round(Math.max(-100, Math.min(100, weighted)));
  const direction: "long" | "short" | "none" = score > 0 ? "long" : score < 0 ? "short" : "none";

  const agreeing = views.filter((view) =>
    direction === "long" ? view.score > 0 : direction === "short" ? view.score < 0 : false
  ).length;
  const agreement = views.length > 0 ? agreeing / views.length : 0;

  // Strategy votes on the primary timeframe: what the bot itself would do.
  const primary = byTimeframe[0];
  const primaryComplete = primary.candles.filter((candle) => candle.complete);
  const strategyVotes: StrategyVote[] = [];
  let primarySignal: Signal | null = null;

  if (primaryComplete.length > Math.max(params.trend.smaSlow, params.breakout.lookback) + 3) {
    const frame = computeIndicators(primaryComplete, params);
    const index = primaryComplete.length - 1;

    for (const [key, enabled] of [
      ["trend", params.trend.enabled],
      ["meanReversion", params.meanReversion.enabled],
      ["breakout", params.breakout.enabled],
    ] as Array<[string, boolean]>) {
      if (!enabled) {
        strategyVotes.push({ strategy: key, direction: "none", reason: "Disabled for this instrument." });
        continue;
      }
      // Isolate one strategy at a time so each gets its own vote instead of
      // being shadowed by the evaluation order.
      const isolated: StrategyParams = {
        ...params,
        trend: { ...params.trend, enabled: key === "trend" },
        meanReversion: { ...params.meanReversion, enabled: key === "meanReversion" },
        breakout: { ...params.breakout, enabled: key === "breakout" },
      };
      const signal = evaluateAt(primaryComplete, computeIndicators(primaryComplete, isolated), index, isolated);
      strategyVotes.push({
        strategy: key,
        direction: signal?.direction ?? "none",
        reason: signal?.reason ?? "No setup on the current bar.",
      });
      if (signal && !primarySignal) primarySignal = signal;
    }
    void frame;
  }

  // Higher-timeframe alignment: does anything coarser than the primary disagree?
  const higher = views.slice(1);
  const higherTimeframeAligned =
    direction === "none"
      ? false
      : higher.length === 0 ||
        higher.every((view) =>
          direction === "long" ? view.score >= -12 : view.score <= 12
        );

  if (!higherTimeframeAligned && direction !== "none") {
    const opposed = higher
      .filter((view) => (direction === "long" ? view.score < -12 : view.score > 12))
      .map((view) => `${view.timeframe} (${view.score})`);
    cautions.push(
      `Higher timeframe disagrees: ${opposed.join(", ")}. Taking a ${direction} here is fighting ` +
        `the dominant trend, which is where most of the losing trades come from.`
    );
  }

  const votesWith = strategyVotes.filter((vote) => vote.direction === direction).length;
  const votesAgainst = strategyVotes.filter(
    (vote) => vote.direction !== "none" && vote.direction !== direction
  ).length;

  if (votesAgainst > 0) {
    cautions.push(`${votesAgainst} strategy vote(s) point the other way.`);
  }
  if (votesWith === 0 && direction !== "none") {
    cautions.push("No strategy has an actual entry trigger on this bar — the bias exists, the setup does not.");
  }
  if (agreement < 0.6 && direction !== "none") {
    cautions.push(`Only ${Math.round(agreement * 100)}% of timeframes agree.`);
  }
  const flatCount = views.filter((view) => view.trend === "flat").length;
  if (flatCount === views.length) {
    cautions.push("Every timeframe reads flat — no directional edge to trade.");
  }

  // The verdict combines conviction, agreement and whether a trigger exists.
  const magnitude = Math.abs(score);
  let verdict: ConsensusResult["verdict"];
  if (direction === "none" || magnitude < 15) {
    verdict = "wait";
  } else if (!higherTimeframeAligned && params.consensus.requireHigherTimeframeAlignment) {
    verdict = "avoid";
  } else if (magnitude >= params.consensus.minScore && agreement >= 0.6 && votesWith > 0) {
    verdict = "take";
  } else if (magnitude >= params.consensus.minScore && agreement >= 0.6) {
    verdict = "lean";
  } else {
    verdict = "wait";
  }

  const summary =
    verdict === "take"
      ? `${instrument}: ${direction} looks good — score ${score}, ${Math.round(
          agreement * 100
        )}% timeframe agreement, ${votesWith} strategy trigger(s).`
      : verdict === "lean"
        ? `${instrument}: ${direction} bias at score ${score}, but no strategy has a trigger yet. Watch, do not chase.`
        : verdict === "avoid"
          ? `${instrument}: do not take ${direction} — the higher timeframe is against it.`
          : `${instrument}: no consensus (score ${score}). Nothing worth trading here right now.`;

  return {
    instrument,
    score,
    direction,
    agreement: Number(agreement.toFixed(2)),
    verdict,
    summary,
    timeframes: views,
    strategyVotes,
    cautions,
    primarySignal,
    higherTimeframeAligned,
  };
}
