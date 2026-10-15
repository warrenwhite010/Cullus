// "What is the highest-return thing I can do today, and what is it worth?"
//
// The honest version of that question needs two halves, and the reason this
// module exists is that neither half alone answers it:
//
//   1. What is actually actionable right now — a live signal, on a pair whose
//      spread and session pass, with room left in the risk budget. That is the
//      market scan.
//   2. What that kind of setup has historically been worth ON THIS PAIR WITH
//      THIS STRATEGY — measured out of sample, not asserted. That is the
//      backtest.
//
// Ranking on (1) alone ranks by how loud a signal is, which is uncorrelated
// with profit. Ranking on (2) alone recommends trades that cannot be taken.
// Expected value is the product, and it is the only number here worth reading.
//
// Every figure this module emits is an ESTIMATE built on a historical hit rate.
// It is not a forecast, and the plan says so in its own output rather than
// leaving the caller to remember it.

import type { StrategyParams } from "./params.js";

export interface MeasuredEdge {
  strategy: string;
  /** Out-of-sample expectancy in R, from a walk-forward split. */
  expectancyR: number;
  winRatePct: number;
  trades: number;
  profitFactor: number;
}

export interface PlanCandidate {
  instrument: string;
  direction: "long" | "short";
  strategy: string;
  /** 0-100 from strategy.ts conviction scoring. */
  conviction: number;
  consensusScore: number | null;
  /** Account-currency loss if the stop is hit. */
  riskAmount: number;
  /** Account-currency gain if the target is hit. */
  rewardAmount: number;
  units: number;
  stopPips: number;
  targetPips: number;
  spreadPips: number;
  /** Reasons this cannot be taken right now. A non-empty list means "not today". */
  blockers: string[];
  /** Measured out-of-sample performance of THIS strategy on THIS pair, if known. */
  measured: MeasuredEdge | null;
}

export interface RankedOpportunity extends PlanCandidate {
  rewardToRisk: number;
  /** The hit rate used, and where it came from. */
  winRatePctUsed: number;
  winRateBasis: string;
  /** Account-currency expected value of taking this trade once. */
  expectedValue: number;
  /** Expected value as a percentage of NAV. */
  expectedValuePctOfNav: number;
  /** The hit rate this trade needs merely to break even after costs. */
  breakEvenWinRatePct: number;
  rank: number;
  verdict: "take" | "consider" | "skip" | "blocked";
  why: string;
}

export interface DailyPlan {
  generatedAt: string;
  nav: number;
  currency: string;
  appetite: string;
  /** Risk budget still available today, in account currency. */
  riskBudgetRemaining: number;
  opportunities: RankedOpportunity[];
  /** The subset that fits inside the remaining risk budget, best first. */
  recommended: RankedOpportunity[];
  projection: {
    tradesPlanned: number;
    totalRiskDeployed: number;
    /** Sum of expected values — the realistic number. */
    expectedGain: number;
    expectedGainPctOfNav: number;
    /** Everything hits its target. Will not happen; included as the ceiling. */
    bestCase: number;
    /** Everything stops out. Plan for this one. */
    worstCase: number;
    basis: string;
  };
  warnings: string[];
  summary: string;
}

/**
 * The hit rate to price a candidate with, and an honest label for where it came from.
 *
 * Preference order is measured → conviction-adjusted prior. The prior is
 * deliberately pessimistic: an unmeasured setup is priced slightly BELOW its own
 * break-even rate, so an unknown pair never outranks a measured one on
 * optimism alone.
 */
function hitRate(
  candidate: PlanCandidate,
  rewardToRisk: number
): { pct: number; basis: string } {
  if (candidate.measured && candidate.measured.trades >= 12) {
    return {
      pct: candidate.measured.winRatePct,
      basis:
        `measured: ${candidate.measured.trades} out-of-sample ${candidate.strategy} trades on ` +
        `${candidate.instrument}`,
    };
  }

  const breakEven = rewardToRisk > 0 ? (1 / (1 + rewardToRisk)) * 100 : 100;
  // Conviction 50 → break-even. 100 → break-even + 8 points. 0 → −8.
  const adjustment = ((candidate.conviction - 50) / 50) * 8;
  return {
    pct: Math.max(5, Math.min(90, breakEven + adjustment - 2)),
    basis:
      candidate.measured
        ? `prior: only ${candidate.measured.trades} measured trades, too few to trust`
        : "prior: no measured history for this pair+strategy, priced near break-even",
  };
}

export function buildDailyPlan(
  candidates: PlanCandidate[],
  context: {
    nav: number;
    currency: string;
    params: StrategyParams;
    openRiskPct: number;
    /** Realised P/L so far today, in account currency. Negative is a loss. */
    realisedToday?: number;
  }
): DailyPlan {
  const { nav, params } = context;
  const warnings: string[] = [];

  const ranked: RankedOpportunity[] = candidates
    .map((candidate) => {
      const rewardToRisk =
        candidate.riskAmount > 0 ? candidate.rewardAmount / candidate.riskAmount : 0;
      const { pct, basis } = hitRate(candidate, rewardToRisk);
      const p = pct / 100;

      // Spread is already paid inside riskAmount/rewardAmount via the entry
      // price, so it is not deducted twice here. What is NOT in those figures
      // is that the target is further away than the stop, so a wider spread
      // hurts the win side more — that asymmetry is left to the backtest.
      const expectedValue = p * candidate.rewardAmount - (1 - p) * candidate.riskAmount;
      const breakEven = rewardToRisk > 0 ? (1 / (1 + rewardToRisk)) * 100 : 100;

      let verdict: RankedOpportunity["verdict"];
      let why: string;
      if (candidate.blockers.length > 0) {
        verdict = "blocked";
        why = candidate.blockers[0];
      } else if (expectedValue <= 0) {
        verdict = "skip";
        why =
          `Negative expectancy: needs a ${breakEven.toFixed(0)}% hit rate, priced at ` +
          `${pct.toFixed(0)}%.`;
      } else if (candidate.measured && candidate.measured.expectancyR > 0 && candidate.conviction >= 55) {
        verdict = "take";
        why =
          `Measured edge (${candidate.measured.expectancyR}R over ${candidate.measured.trades} ` +
          `trades) and strong live evidence (${candidate.conviction.toFixed(0)}).`;
      } else {
        verdict = "consider";
        why = candidate.measured
          ? `Positive expected value, but the evidence is thin (${basis}).`
          : `Positive expected value on a prior, not a measurement (${basis}).`;
      }

      return {
        ...candidate,
        rewardToRisk: Number(rewardToRisk.toFixed(2)),
        winRatePctUsed: Number(pct.toFixed(1)),
        winRateBasis: basis,
        expectedValue: Number(expectedValue.toFixed(2)),
        expectedValuePctOfNav: nav > 0 ? Number(((expectedValue / nav) * 100).toFixed(3)) : 0,
        breakEvenWinRatePct: Number(breakEven.toFixed(1)),
        rank: 0,
        verdict,
        why,
      };
    })
    .sort((a, b) => b.expectedValue - a.expectedValue)
    .map((opportunity, index) => ({ ...opportunity, rank: index + 1 }));

  // What is left of the risk budget after what is already open, and after any
  // loss already taken today. A day that is 1.5% down on a 2% daily stop has
  // half a percent of room, not a full budget.
  const ceilingPct = params.risk.maxOpenRiskPct;
  const lossTakenPct =
    context.realisedToday !== undefined && context.realisedToday < 0 && nav > 0
      ? (Math.abs(context.realisedToday) / nav) * 100
      : 0;
  const dailyRoomPct = Math.max(0, params.risk.maxDailyLossPct - lossTakenPct);
  const availablePct = Math.max(0, Math.min(ceilingPct - context.openRiskPct, dailyRoomPct));
  const riskBudgetRemaining = Number(((availablePct / 100) * nav).toFixed(2));

  if (lossTakenPct > 0) {
    warnings.push(
      `Already down ${lossTakenPct.toFixed(2)}% today against a ${params.risk.maxDailyLossPct}% ` +
        `daily stop, so the budget below is reduced accordingly.`
    );
  }
  if (availablePct <= 0) {
    warnings.push(
      "No risk budget left today: either open risk is at the ceiling or the daily loss stop is hit. " +
        "Nothing new should be opened."
    );
  }

  // Greedy fill by expected value, one trade per instrument, respecting the
  // per-currency cap the same way the order path does. Greedy is correct here:
  // these are not fungible slots, and an optimiser that swaps a high-EV trade
  // for two mediocre ones is optimising the wrong thing.
  const recommended: RankedOpportunity[] = [];
  const usedInstruments = new Set<string>();
  const currencyCount = new Map<string, number>();
  let deployed = 0;

  for (const opportunity of ranked) {
    if (opportunity.verdict === "blocked" || opportunity.verdict === "skip") continue;
    if (usedInstruments.has(opportunity.instrument)) continue;
    if (deployed + opportunity.riskAmount > riskBudgetRemaining) continue;

    const currencies = opportunity.instrument.split("_");
    const overCap = currencies.some(
      (currency) => (currencyCount.get(currency) ?? 0) >= params.risk.maxTradesPerCurrency
    );
    if (overCap) continue;

    recommended.push(opportunity);
    usedInstruments.add(opportunity.instrument);
    for (const currency of currencies) {
      currencyCount.set(currency, (currencyCount.get(currency) ?? 0) + 1);
    }
    deployed += opportunity.riskAmount;
  }

  const expectedGain = recommended.reduce((sum, o) => sum + o.expectedValue, 0);
  const bestCase = recommended.reduce((sum, o) => sum + o.rewardAmount, 0);
  const worstCase = recommended.reduce((sum, o) => sum + o.riskAmount, 0);

  const measuredCount = recommended.filter((o) => o.winRateBasis.startsWith("measured")).length;
  if (recommended.length > 0 && measuredCount === 0) {
    warnings.push(
      "No recommendation here is backed by a measured hit rate — every figure is a prior. " +
        "Run oanda_rank_instruments to replace the guesses with measurements."
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    nav,
    currency: context.currency,
    appetite: params.appetite,
    riskBudgetRemaining,
    opportunities: ranked,
    recommended,
    projection: {
      tradesPlanned: recommended.length,
      totalRiskDeployed: Number(deployed.toFixed(2)),
      expectedGain: Number(expectedGain.toFixed(2)),
      expectedGainPctOfNav: nav > 0 ? Number(((expectedGain / nav) * 100).toFixed(3)) : 0,
      bestCase: Number(bestCase.toFixed(2)),
      worstCase: Number((-worstCase).toFixed(2)),
      basis:
        `${measuredCount}/${recommended.length} priced from measured out-of-sample hit rates, ` +
        `the rest from break-even priors. Expected gain is the probability-weighted average of ` +
        `many days like this one, not a prediction about today.`,
    },
    warnings,
    summary: recommended.length
      ? `${recommended.length} trade(s) worth taking, risking ${deployed.toFixed(2)} ` +
        `${context.currency} for an expected ${expectedGain >= 0 ? "+" : ""}` +
        `${expectedGain.toFixed(2)} (best case +${bestCase.toFixed(2)}, worst case ` +
        `−${worstCase.toFixed(2)}).`
      : ranked.length
        ? `Nothing worth taking right now: ${ranked.filter((o) => o.verdict === "blocked").length} ` +
          `blocked, ${ranked.filter((o) => o.verdict === "skip").length} negative expectancy. ` +
          `A day with no trade is a normal result.`
        : "No signals at all on the watchlist right now.",
  };
}
