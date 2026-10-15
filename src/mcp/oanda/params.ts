// The single parameter set that the strategies, the backtester and the live
// Swift bot all read.
//
// It lives in one JSON file on disk (default ~/.cullus/oanda-bot.json) so the
// model can tune the running bot: MCP writes the file, the Swift app re-reads it
// each cycle. Keep this schema in step with
// OandaVisualBot/Utilities/StrategyParameters.swift.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RiskParams {
  /** Fraction of NAV risked on one trade, in percent. 0.5 = half a percent. */
  riskPerTradePct: number;
  /** Ceiling on the sum of open risk, in percent of NAV. */
  maxOpenRiskPct: number;
  /** Stop opening trades once the day is this far down, in percent of NAV. */
  maxDailyLossPct: number;
  maxOpenTradesPerInstrument: number;
  /**
   * How many open trades may share a single currency (EUR_USD, EUR_JPY and
   * EUR_GBP are one bet on EUR wearing three hats).
   */
  maxTradesPerCurrency: number;
  /** Refuse new risk above this margin utilisation, in percent. */
  maxMarginUtilizationPct: number;
}

export interface EntryParams {
  atrPeriod: number;
  /** Stop distance = stopAtrMultiple × ATR. */
  stopAtrMultiple: number;
  /** Take-profit distance as a multiple of the stop distance (the R multiple). */
  takeProfitR: number;
  /** Move the stop to break-even + trail once the trade is this many R up. 0 = never. */
  trailAfterR: number;
  /** Reject an entry when the spread exceeds this fraction of ATR. */
  maxSpreadAtrRatio: number;
  /** Skip instruments this quiet: the spread eats the whole move. */
  minAtrPips: number;
  /**
   * Close this fraction of the position at 1R and let the rest run. 0 = off.
   *
   * The usual argument for this is psychological: banking half at 1R turns the
   * "was up 1R, stopped out at −1R" trade into a small win. The arithmetic is
   * less kind — it caps the winners that pay for the losers without making the
   * losers smaller — and it measured worse than off in every configuration
   * tested here. Off by default; verify on your own pairs before enabling.
   */
  partialTakeProfitFraction: number;
  /** After the partial fill, trail the remainder by this × ATR. 0 = keep the fixed stop. */
  runnerTrailAtrMultiple: number;
}

export interface FifoParams {
  /**
   * US-regulated accounts cannot hedge and must close oldest-first. Defaults on:
   * enabling it on a non-US account only costs the ability to hold two opposing
   * trades, which no strategy here wants anyway.
   */
  enabled: boolean;
  /** Permit an opposite-direction order that reduces or closes a position. */
  allowReducingOrders: boolean;
}

export interface SessionParams {
  /** Restrict entries to the sessions each instrument actually trades well in. */
  enforce: boolean;
  /** Refuse entries in the minutes around 17:00 New York, when spreads blow out. */
  blockRollover: boolean;
  /** Scale position size by the session's liquidity score (0.4–1.25). */
  scaleSizeByLiquidity: boolean;
}

export interface CarryParams {
  /**
   * Price financing against the trade's risk before entering.
   *
   * Separate from `sessions.blockRollover`, which is about the SPREAD widening
   * around 17:00 New York. This is about the CHARGE applied at 17:00 to every
   * position open at that instant — a different cost with a different fix.
   */
  enabled: boolean;
  /**
   * Refuse an entry when the next rollover's financing exceeds this fraction of
   * the trade's risk. 0 disables the check.
   */
  maxCarryFractionOfRisk: number;
  /**
   * Refuse negative-carry entries within this many hours of the TRIPLED rollover
   * (Wednesday for most FX). Paying three days of interest for two hours of
   * exposure is the specific mistake this prevents.
   */
  avoidTripleRolloverHours: number;
}

export interface ConsensusParams {
  /** Require a multi-timeframe consensus score before entering. */
  enabled: boolean;
  /** Timeframes to poll, coarsest last. The primary timeframe is `granularity`. */
  timeframes: string[];
  /** Minimum absolute score (0–100) needed to take a trade. */
  minScore: number;
  /** Refuse when a higher timeframe's trend points the other way. */
  requireHigherTimeframeAlignment: boolean;
}

export interface TrendParams {
  enabled: boolean;
  smaFast: number;
  smaSlow: number;
  /** Only take trend entries when ADX is at least this strong. */
  adxMin: number;
}

export interface MeanReversionParams {
  enabled: boolean;
  rsiPeriod: number;
  rsiBuyBelow: number;
  rsiSellAbove: number;
  /** Only fade when ADX is below this: never fade a strong trend. */
  adxMax: number;
  /** Require the pullback to be with the higher-timeframe trend (SMA slow). */
  requireTrendAlignment: boolean;
}

export interface BreakoutParams {
  enabled: boolean;
  /** Donchian lookback in candles. */
  lookback: number;
  adxMin: number;
}

/**
 * A per-instrument override of any section below.
 *
 * This is what makes "EUR_USD trades trend, USD_JPY only fades, GBP_JPY is not
 * worth trading at all" expressible. Without it, one ADX threshold and one stop
 * multiple are applied to every pair, which is the wrong default: majors trend,
 * crosses range, and their ATRs differ by an order of magnitude.
 *
 * Produce these with `oanda_rank_instruments` / `oanda_optimize` rather than by
 * hand — a profile fitted by eye is curve-fitting with extra steps.
 */
export interface InstrumentProfile {
  /** Why this profile exists: the out-of-sample number that justified it. */
  notes?: string;
  /** Stop trading this pair without removing its history and settings. */
  disabled?: boolean;
  granularity?: string;
  /** Override how this one pair arbitrates between its enabled strategies. */
  strategySelection?: StrategySelection;
  entry?: Partial<EntryParams>;
  carry?: Partial<CarryParams>;
  trend?: Partial<TrendParams>;
  meanReversion?: Partial<MeanReversionParams>;
  breakout?: Partial<BreakoutParams>;
  consensus?: Partial<ConsensusParams>;
  /** Multiply the base risk for this pair. Capped to [0.25, 1.5] on load. */
  riskMultiplier?: number;
}

/**
 * How to choose between strategies when more than one fires on the same bar.
 *
 * `precedence` is the original behaviour: breakout, then trend, then mean
 * reversion, first match wins. It is deterministic and it is why enabling three
 * strategies on a pair never felt like three strategies — mean reversion only
 * ever spoke when the other two were silent.
 *
 * `conviction` evaluates every enabled strategy in isolation and takes the one
 * with the strongest supporting evidence, so a pair genuinely runs its whole
 * enabled set. `agreement` goes further and requires two strategies to point the
 * same way, which trades far less often for a better hit rate.
 */
export type StrategySelection = "precedence" | "conviction" | "agreement";

/** Named risk appetites. Each one moves a coordinated group of parameters. */
export type RiskAppetite = "conservative" | "balanced" | "aggressive" | "max";

export interface AutopilotParams {
  /** Master switch. Nothing scheduled acts on the account while this is false. */
  enabled: boolean;
  /**
   * `managed` protects capital by itself and queues new risk for a human.
   * `full` also opens positions and places limit orders unattended.
   */
  mode: "managed" | "full";
  /**
   * Live trading requires this AND an OANDA_ENVIRONMENT of "live" AND an
   * unexpired `armedUntil`. Three switches because one of them will eventually
   * be flipped by accident and none of them alone should be enough.
   */
  allowLive: boolean;
  /** ISO timestamp. Past or missing means full mode is disarmed, whatever else says. */
  armedUntil?: string;
  /** Hard ceiling on positions opened unattended in one UTC day. */
  maxNewTradesPerDay: number;
  /** Hard ceiling on actions — entries, closes, bracket moves — in one run. */
  maxActionsPerRun: number;
  /** Stop opening anything once realised+unrealised P/L is this far down on the day, in % of NAV. */
  dailyLossStopPct: number;
  /** Move the stop to break-even automatically once a trade is this many R up. 0 = never. */
  breakEvenAtR: number;
  /** Trail the stop by this × ATR once break-even is set. 0 = leave it parked. */
  trailAtrMultiple: number;
  /** Close a trade whose entry signal has since inverted on the primary timeframe. */
  closeOnSignalInvalidation: boolean;
  /** Minimum consensus score for an unattended entry. Deliberately above the manual floor. */
  minConsensusScore: number;
}

export interface StrategyParams {
  version: number;
  /** Free-text note the model can leave for its future self. */
  notes: string;
  granularity: string;
  instruments: string[];
  risk: RiskParams;
  entry: EntryParams;
  trend: TrendParams;
  meanReversion: MeanReversionParams;
  breakout: BreakoutParams;
  fifo: FifoParams;
  sessions: SessionParams;
  carry: CarryParams;
  consensus: ConsensusParams;
  /** Per-instrument overrides, keyed by instrument. */
  profiles: Record<string, InstrumentProfile>;
  /** Restrict entries to each instrument's liquid hours. */
  enforceLiquidityWindow: boolean;
  /** How to pick when several enabled strategies fire on the same bar. */
  strategySelection: StrategySelection;
  /** The named risk appetite last applied, for display and for /aggression. */
  appetite: RiskAppetite;
  autopilot: AutopilotParams;
}

/**
 * Defaults chosen to be survivable rather than exciting: half a percent of risk
 * per trade, a 1.5×ATR stop, 2R target, and filters that refuse to trade when
 * the spread is a large fraction of the expected move.
 */
export const DEFAULT_PARAMS: StrategyParams = {
  version: 1,
  notes: "Defaults. Run oanda_backtest before changing anything here.",
  granularity: "M15",
  instruments: ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CHF", "EUR_JPY"],
  risk: {
    riskPerTradePct: 0.5,
    maxOpenRiskPct: 3,
    maxDailyLossPct: 2,
    maxOpenTradesPerInstrument: 1,
    maxTradesPerCurrency: 2,
    maxMarginUtilizationPct: 40,
  },
  entry: {
    atrPeriod: 14,
    stopAtrMultiple: 1.5,
    takeProfitR: 2,
    trailAfterR: 0,
    maxSpreadAtrRatio: 0.15,
    minAtrPips: 3,
    // Both of the following default to OFF, against the usual advice, because on
    // the data available at build time they measurably reduced expectancy:
    // scaling out at 1R took the average from ~0.16R to ~0.02R, since it caps the
    // winners that pay for the losers without shrinking the losers. Turning the
    // break-even trail off scored better too (~0.16R vs ~0.11R) — a stop parked at
    // entry converts would-be winners into scratches.
    //
    // That test was on synthetic series with no autocorrelation, which is the
    // least favourable case for both features. Real trending pairs may differ, so
    // the machinery is here and fully backtested: run oanda_backtest with
    // paramPatch on YOUR pairs before enabling either.
    partialTakeProfitFraction: 0,
    runnerTrailAtrMultiple: 2,
  },
  trend: { enabled: true, smaFast: 20, smaSlow: 50, adxMin: 20 },
  meanReversion: {
    enabled: true,
    rsiPeriod: 14,
    rsiBuyBelow: 30,
    rsiSellAbove: 70,
    adxMax: 25,
    requireTrendAlignment: true,
  },
  breakout: { enabled: true, lookback: 40, adxMin: 18 },
  // Defaults to on: this ships to a US account, where hedging is not allowed and
  // out-of-order closes are rejected.
  fifo: { enabled: true, allowReducingOrders: false },
  sessions: { enforce: true, blockRollover: true, scaleSizeByLiquidity: true },
  carry: { enabled: true, maxCarryFractionOfRisk: 0.1, avoidTripleRolloverHours: 2 },
  consensus: {
    enabled: true,
    timeframes: ["M15", "H1", "H4"],
    minScore: 35,
    requireHigherTimeframeAlignment: true,
  },
  profiles: {},
  enforceLiquidityWindow: true,
  // Precedence, not conviction, as the GLOBAL default — deliberately.
  //
  // Conviction is the better rule, but flipping it on globally would silently
  // change what every already-configured pair does, and invalidate every
  // backtest number anyone has written down. So the upgrade is per pair and
  // earned: oanda_rank_instruments sets conviction on a pair when it measures
  // two strategies surviving out of sample, and oanda_update_pair_strategy
  // sets it when you ask for more than one strategy by hand.
  strategySelection: "precedence",
  appetite: "balanced",
  autopilot: {
    enabled: false,
    mode: "managed",
    allowLive: false,
    maxNewTradesPerDay: 4,
    maxActionsPerRun: 6,
    dailyLossStopPct: 2,
    breakEvenAtR: 1,
    trailAtrMultiple: 2,
    closeOnSignalInvalidation: true,
    // Above consensus.minScore (35) on purpose: a trade nobody is watching
    // should clear a higher bar than one you chose to take.
    minConsensusScore: 50,
  },
};

/**
 * The passive↔aggressive dial, as four coordinated parameter sets.
 *
 * Every field here is a risk lever, and they have to move together: doubling
 * risk per trade while leaving the open-risk ceiling alone just means the third
 * trade is refused. Strategy thresholds move too — an aggressive setting is
 * mostly a decision to accept weaker evidence, not only to bet more on it.
 */
export const APPETITE_PRESETS: Record<
  RiskAppetite,
  {
    summary: string;
    risk: Partial<RiskParams>;
    entry: Partial<EntryParams>;
    consensus: Partial<ConsensusParams>;
  }
> = {
  conservative: {
    summary:
      "0.25% a trade, 1.5% open, strong evidence only. Expect few trades and shallow drawdowns.",
    risk: {
      riskPerTradePct: 0.25,
      maxOpenRiskPct: 1.5,
      maxDailyLossPct: 1.5,
      maxTradesPerCurrency: 1,
      maxMarginUtilizationPct: 20,
    },
    entry: { stopAtrMultiple: 2, takeProfitR: 2.5, maxSpreadAtrRatio: 0.1, trailAfterR: 0 },
    consensus: { enabled: true, minScore: 55, requireHigherTimeframeAlignment: true },
  },
  balanced: {
    summary: "0.5% a trade, 3% open. The shipped defaults — survivable rather than exciting.",
    risk: {
      riskPerTradePct: 0.5,
      maxOpenRiskPct: 3,
      maxDailyLossPct: 2,
      maxTradesPerCurrency: 2,
      maxMarginUtilizationPct: 40,
    },
    entry: { stopAtrMultiple: 1.5, takeProfitR: 2, maxSpreadAtrRatio: 0.15, trailAfterR: 0 },
    consensus: { enabled: true, minScore: 35, requireHigherTimeframeAlignment: true },
  },
  aggressive: {
    summary:
      "1% a trade, 5% open, weaker evidence accepted. More trades, materially deeper drawdowns.",
    risk: {
      riskPerTradePct: 1,
      maxOpenRiskPct: 5,
      maxDailyLossPct: 3,
      maxTradesPerCurrency: 3,
      maxMarginUtilizationPct: 55,
    },
    entry: { stopAtrMultiple: 1.3, takeProfitR: 1.8, maxSpreadAtrRatio: 0.2, trailAfterR: 1 },
    consensus: { enabled: true, minScore: 25, requireHigherTimeframeAlignment: false },
  },
  max: {
    summary:
      "2% a trade, 8% open, higher-timeframe veto off. This is the edge of the validator; " +
      "four bad trades is a 8% day.",
    risk: {
      riskPerTradePct: 2,
      maxOpenRiskPct: 8,
      maxDailyLossPct: 5,
      maxTradesPerCurrency: 3,
      maxMarginUtilizationPct: 70,
    },
    entry: { stopAtrMultiple: 1.2, takeProfitR: 1.6, maxSpreadAtrRatio: 0.25, trailAfterR: 1 },
    consensus: { enabled: true, minScore: 20, requireHigherTimeframeAlignment: false },
  },
};

/** Apply a named appetite over a parameter set. Per-pair profiles are untouched. */
export function applyAppetite(params: StrategyParams, level: RiskAppetite): StrategyParams {
  const preset = APPETITE_PRESETS[level];
  const next = mergeParams(params, {
    appetite: level,
    risk: preset.risk,
    entry: preset.entry,
    consensus: preset.consensus,
  });

  // The autopilot's evidence bar has to move with the manual one, or a
  // conservative appetite ends up with unattended trades taken on WEAKER
  // evidence than the ones taken by hand — the exact inversion validateParams
  // rejects. Raised to match, never lowered: turning the dial down should not
  // quietly relax a limit the user set on the autopilot itself.
  const floor = next.consensus.minScore;
  if (next.autopilot && next.autopilot.minConsensusScore < floor) {
    next.autopilot = { ...next.autopilot, minConsensusScore: floor };
  }

  // Same reasoning for the loss stop: an appetite that tightens the daily loss
  // limit must tighten the autopilot's own brake, which is meant to engage first.
  if (next.autopilot && next.autopilot.dailyLossStopPct > next.risk.maxDailyLossPct) {
    next.autopilot = { ...next.autopilot, dailyLossStopPct: next.risk.maxDailyLossPct };
  }

  return next;
}

/**
 * Effective parameters for one instrument: the globals with its profile applied.
 *
 * Every read of a parameter in a per-instrument context must go through here, or
 * the profile silently does nothing.
 */
export function resolveParams(params: StrategyParams, instrument: string): StrategyParams {
  const profile = params.profiles?.[instrument];
  if (!profile) return params;

  const resolved: StrategyParams = {
    ...params,
    granularity: profile.granularity ?? params.granularity,
    strategySelection: profile.strategySelection ?? params.strategySelection,
    entry: { ...params.entry, ...(profile.entry ?? {}) },
    carry: { ...params.carry, ...(profile.carry ?? {}) },
    trend: { ...params.trend, ...(profile.trend ?? {}) },
    meanReversion: { ...params.meanReversion, ...(profile.meanReversion ?? {}) },
    breakout: { ...params.breakout, ...(profile.breakout ?? {}) },
    consensus: { ...params.consensus, ...(profile.consensus ?? {}) },
  };

  if (profile.riskMultiplier !== undefined) {
    const multiplier = Math.min(Math.max(profile.riskMultiplier, 0.25), 1.5);
    resolved.risk = {
      ...params.risk,
      riskPerTradePct: params.risk.riskPerTradePct * multiplier,
    };
  }

  return resolved;
}

/** Instruments to trade: the watchlist minus anything a profile disabled. */
export function activeInstruments(params: StrategyParams): string[] {
  return params.instruments.filter((instrument) => !params.profiles?.[instrument]?.disabled);
}

export function paramsPath(): string {
  return (
    process.env.OANDA_BOT_PARAMS_PATH ||
    path.join(os.homedir(), ".assistant", "oanda-bot.json")
  );
}

/** Deep-merge a partial parameter object over the defaults. */
export function mergeParams(base: StrategyParams, patch: any): StrategyParams {
  if (!patch || typeof patch !== "object") return base;
  const merged: any = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;

    // `profiles` needs one more level of merging than everything else: a patch
    // that tunes EUR_USD's takeProfitR must not erase EUR_USD's trend settings,
    // and must not erase GBP_USD's profile entirely.
    if (key === "profiles" && typeof value === "object" && !Array.isArray(value)) {
      const profiles: Record<string, InstrumentProfile> = { ...(base.profiles ?? {}) };
      for (const [instrument, profile] of Object.entries(value as Record<string, any>)) {
        if (profile === null) {
          delete profiles[instrument];
          continue;
        }
        const existing = profiles[instrument] ?? {};
        profiles[instrument] = {
          ...existing,
          ...profile,
          entry: { ...(existing.entry ?? {}), ...(profile.entry ?? {}) },
          carry: { ...(existing.carry ?? {}), ...(profile.carry ?? {}) },
          trend: { ...(existing.trend ?? {}), ...(profile.trend ?? {}) },
          meanReversion: { ...(existing.meanReversion ?? {}), ...(profile.meanReversion ?? {}) },
          breakout: { ...(existing.breakout ?? {}), ...(profile.breakout ?? {}) },
          consensus: { ...(existing.consensus ?? {}), ...(profile.consensus ?? {}) },
        };
      }
      merged.profiles = profiles;
      continue;
    }

    const current = (base as any)[key];
    if (current && typeof current === "object" && !Array.isArray(current)) {
      merged[key] = { ...current, ...(value as object) };
    } else {
      merged[key] = value;
    }
  }
  return merged as StrategyParams;
}

export function loadParams(): StrategyParams {
  const file = paramsPath();
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_PARAMS };
    return mergeParams(DEFAULT_PARAMS, JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch (error) {
    // A malformed file must not silently become "trade with no limits": fall
    // back to the conservative defaults and say so.
    process.stderr.write(
      `[oanda-trading] ${file} is unreadable (${(error as Error).message}); using defaults.\n`
    );
    return { ...DEFAULT_PARAMS };
  }
}

export function saveParams(params: StrategyParams): string {
  const file = paramsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(params, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/**
 * Reject parameter sets that would blow the account up regardless of edge.
 *
 * These are not opinions about strategy, they are arithmetic: 25% risk per trade
 * is ruin in four losses, and a take-profit below 0.3R cannot pay for its own
 * spread.
 */
export function validateParams(params: StrategyParams): string[] {
  const problems: string[] = [];
  const { risk, entry } = params;

  if (risk.riskPerTradePct <= 0 || risk.riskPerTradePct > 2) {
    problems.push(
      `risk.riskPerTradePct must be in (0, 2]; got ${risk.riskPerTradePct}. ` +
        `Above 2% of NAV per trade, a normal losing streak is an account-ending one.`
    );
  }
  if (risk.maxOpenRiskPct < risk.riskPerTradePct) {
    problems.push("risk.maxOpenRiskPct cannot be smaller than risk.riskPerTradePct.");
  }
  if (risk.maxOpenRiskPct > 10) {
    problems.push(`risk.maxOpenRiskPct must be ≤ 10; got ${risk.maxOpenRiskPct}.`);
  }
  if (risk.maxDailyLossPct <= 0 || risk.maxDailyLossPct > 10) {
    problems.push(`risk.maxDailyLossPct must be in (0, 10]; got ${risk.maxDailyLossPct}.`);
  }
  if (risk.maxMarginUtilizationPct <= 0 || risk.maxMarginUtilizationPct > 80) {
    problems.push("risk.maxMarginUtilizationPct must be in (0, 80].");
  }
  if (entry.stopAtrMultiple < 0.3) {
    problems.push(
      `entry.stopAtrMultiple must be ≥ 0.3; got ${entry.stopAtrMultiple}. ` +
        `A stop inside normal noise is a guaranteed stop-out.`
    );
  }
  if (entry.takeProfitR < 0.3) {
    problems.push(`entry.takeProfitR must be ≥ 0.3; got ${entry.takeProfitR}.`);
  }
  if (entry.atrPeriod < 2) problems.push("entry.atrPeriod must be ≥ 2.");
  if (entry.maxSpreadAtrRatio <= 0 || entry.maxSpreadAtrRatio > 1) {
    problems.push("entry.maxSpreadAtrRatio must be in (0, 1].");
  }
  if (!params.instruments?.length) problems.push("instruments must not be empty.");

  if (entry.partialTakeProfitFraction < 0 || entry.partialTakeProfitFraction >= 1) {
    problems.push(
      `entry.partialTakeProfitFraction must be in [0, 1); got ${entry.partialTakeProfitFraction}. ` +
        `1.0 would close the whole position at 1R, which is just takeProfitR = 1.`
    );
  }

  // FIFO accounts cannot hold two trades per instrument and close them in any
  // order they like, so allowing more than one is a rejected order waiting to
  // happen rather than a configuration choice.
  if (params.fifo?.enabled && risk.maxOpenTradesPerInstrument > 1) {
    problems.push(
      `fifo.enabled with risk.maxOpenTradesPerInstrument = ${risk.maxOpenTradesPerInstrument}: ` +
        `a US account must close oldest-first, so a second trade on the same instrument cannot be ` +
        `exited independently. Set it to 1, or disable FIFO if this is not a US account.`
    );
  }

  if (params.carry?.enabled) {
    if (params.carry.maxCarryFractionOfRisk < 0 || params.carry.maxCarryFractionOfRisk > 2) {
      problems.push(
        `carry.maxCarryFractionOfRisk must be in [0, 2]; got ${params.carry.maxCarryFractionOfRisk}. ` +
          `Above 1.0 the financing would exceed the whole risk budget, which is never worth paying.`
      );
    }
    if (params.carry.avoidTripleRolloverHours < 0 || params.carry.avoidTripleRolloverHours > 24) {
      problems.push("carry.avoidTripleRolloverHours must be in [0, 24].");
    }
  }

  const consensus = params.consensus;
  if (consensus?.enabled) {
    if (!consensus.timeframes?.length) {
      problems.push("consensus.enabled requires at least one entry in consensus.timeframes.");
    }
    if (consensus.minScore < 0 || consensus.minScore > 100) {
      problems.push(`consensus.minScore must be in [0, 100]; got ${consensus.minScore}.`);
    }
  }

  for (const [instrument, profile] of Object.entries(params.profiles ?? {})) {
    if (!params.instruments.includes(instrument)) {
      problems.push(
        `profiles["${instrument}"] has no matching entry in instruments, so it will never apply.`
      );
    }
    if (profile.riskMultiplier !== undefined && (profile.riskMultiplier <= 0 || profile.riskMultiplier > 1.5)) {
      problems.push(
        `profiles["${instrument}"].riskMultiplier must be in (0, 1.5]; got ${profile.riskMultiplier}.`
      );
    }
    if (profile.entry?.stopAtrMultiple !== undefined && profile.entry.stopAtrMultiple < 0.3) {
      problems.push(`profiles["${instrument}"].entry.stopAtrMultiple must be ≥ 0.3.`);
    }
    if (
      profile.trend?.enabled === false &&
      profile.meanReversion?.enabled === false &&
      profile.breakout?.enabled === false &&
      !profile.disabled
    ) {
      problems.push(
        `profiles["${instrument}"] disables every strategy but is not marked disabled. It will ` +
          `be scanned on every cycle and can never produce a signal; set disabled: true instead.`
      );
    }
  }

  const auto = params.autopilot;
  if (auto) {
    if (auto.maxNewTradesPerDay < 0 || auto.maxNewTradesPerDay > 20) {
      problems.push(`autopilot.maxNewTradesPerDay must be in [0, 20]; got ${auto.maxNewTradesPerDay}.`);
    }
    if (auto.maxActionsPerRun < 1 || auto.maxActionsPerRun > 25) {
      problems.push(`autopilot.maxActionsPerRun must be in [1, 25]; got ${auto.maxActionsPerRun}.`);
    }
    if (auto.dailyLossStopPct <= 0 || auto.dailyLossStopPct > 10) {
      problems.push(`autopilot.dailyLossStopPct must be in (0, 10]; got ${auto.dailyLossStopPct}.`);
    }
    if (auto.minConsensusScore < 0 || auto.minConsensusScore > 100) {
      problems.push(`autopilot.minConsensusScore must be in [0, 100].`);
    }
    // The unattended path should never be the loose one. Catching this here
    // means the inversion is reported when the config is written, not
    // discovered later from a trade nobody would have taken by hand.
    if (params.consensus?.enabled && auto.minConsensusScore < params.consensus.minScore) {
      problems.push(
        `autopilot.minConsensusScore (${auto.minConsensusScore}) is below consensus.minScore ` +
          `(${params.consensus.minScore}): unattended entries would clear a LOWER bar than manual ones.`
      );
    }
    if (auto.mode === "full" && auto.dailyLossStopPct > params.risk.maxDailyLossPct) {
      problems.push(
        `autopilot.dailyLossStopPct (${auto.dailyLossStopPct}) exceeds risk.maxDailyLossPct ` +
          `(${params.risk.maxDailyLossPct}), so the autopilot's own brake never engages first.`
      );
    }
  }

  return problems;
}

/**
 * Is the autopilot allowed to open new risk right now, and if not, why not?
 *
 * Every caller that is about to place an order unattended goes through this.
 * It is deliberately a pure function of (params, environment, clock) so the
 * answer can be shown in a report without touching the account.
 */
export function autopilotGate(
  params: StrategyParams,
  environment: string,
  now = new Date()
): { allowed: boolean; mode: "managed" | "full"; reasons: string[] } {
  const auto = params.autopilot ?? DEFAULT_PARAMS.autopilot;
  const reasons: string[] = [];

  if (!auto.enabled) reasons.push("autopilot.enabled is false.");
  if (auto.mode !== "full") {
    reasons.push(`autopilot.mode is "${auto.mode}": new entries are queued, not placed.`);
  }

  const armed = auto.armedUntil ? new Date(auto.armedUntil) : null;
  if (!armed || Number.isNaN(armed.getTime())) {
    reasons.push("autopilot is not armed. Arm it for a bounded window before it may open trades.");
  } else if (armed.getTime() <= now.getTime()) {
    reasons.push(`autopilot arming expired at ${armed.toISOString()}.`);
  }

  // The live gate is separate from, and stricter than, the arming gate: arming
  // is about "for the next few hours", allowLive is about "with real money at
  // all". A practice account needs only the first.
  if (environment === "live" && !auto.allowLive) {
    reasons.push("this is a LIVE account and autopilot.allowLive is false.");
  }

  return { allowed: reasons.length === 0, mode: auto.mode, reasons };
}
