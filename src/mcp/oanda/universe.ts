// The tradeable universe: every instrument this account may actually trade.
//
// There is no hardcoded pair list in this file, and there must never be one.
// What a US-regulated account is permitted to trade is a regulatory question
// with a moving answer — OANDA's own /instruments response for THIS account is
// the only authority on it, and it already accounts for the account's
// jurisdiction, division and any instrument-level restriction.
//
// What this module adds on top of that raw list is the second half of the
// question: of the things you MAY trade, which are worth scanning? A pair whose
// spread eats a third of its daily range is permitted and untradeable, and
// telling those apart needs live prices, not a list.

import type { InstrumentSpec, OandaApi } from "./api.js";
import { atr } from "./indicators.js";
import type { StrategyParams } from "./params.js";

export interface UniverseEntry {
  instrument: string;
  displayName: string;
  /** CURRENCY, METAL, CFD — straight from OANDA. */
  type: string;
  /** True when this instrument is in params.instruments right now. */
  watched: boolean;
  /** True when a profile marks it disabled. */
  disabledByProfile: boolean;
  marginRatePct: number;
  minimumTradeSize: number;
  /** Annualised financing, as a percentage, for each side. */
  financingLongPct: number;
  financingShortPct: number;
  spreadPips: number | null;
  atrPips: number | null;
  /**
   * Spread as a fraction of ATR — the single number that decides whether a pair
   * is worth trading at all. Below ~0.10 is comfortable; above ~0.25 the cost
   * filter will reject nearly every signal anyway.
   */
  spreadAtrRatio: number | null;
  tradeable: boolean;
  /** 0-100. Cheap to trade and liquid scores high. Null when unpriced. */
  score: number | null;
  notes: string[];
}

export interface UniverseSweep {
  environment: string;
  total: number;
  byType: Record<string, number>;
  entries: UniverseEntry[];
  watchlist: string[];
  /** Instruments the sweep rates well that are not currently watched. */
  suggestedAdditions: string[];
  /** Watched instruments the sweep rates badly. */
  suggestedRemovals: string[];
  notes: string[];
}

/**
 * Score an instrument for "worth putting in the watchlist at all".
 *
 * Cost dominates. A pair can trend beautifully and still lose money if you pay
 * a quarter of the move to get in, so spread-to-ATR carries most of the weight
 * and everything else is a tiebreak.
 */
function scoreEntry(spreadAtrRatio: number | null, atrPips: number | null, params: StrategyParams): number | null {
  if (spreadAtrRatio === null || atrPips === null) return null;

  // 0.02 → ~100, 0.30 → ~0. Linear between, clamped.
  const costScore = Math.max(0, Math.min(100, ((0.3 - spreadAtrRatio) / 0.28) * 100));

  // Movement below the configured floor is unusable regardless of how cheap it
  // is: there is nothing to capture. Above ~4× the floor extra volatility stops
  // being a benefit and starts being slippage.
  const floor = params.entry.minAtrPips;
  const movement =
    atrPips < floor ? 0 : Math.max(0, Math.min(100, ((atrPips - floor) / (floor * 3)) * 100));

  return Number((costScore * 0.75 + movement * 0.25).toFixed(1));
}

/**
 * Sweep every instrument the account can trade and price each one.
 *
 * `priceDepth` candles are pulled per instrument to compute ATR. With ~70 FX
 * instruments on a US account this is ~70 candle requests, so it is a
 * deliberate, occasional operation — not something to put on a one-minute cron.
 */
export async function sweepUniverse(
  api: OandaApi,
  params: StrategyParams,
  options: { granularity?: string; priceDepth?: number; types?: string[]; limit?: number } = {}
): Promise<UniverseSweep> {
  const granularity = options.granularity ?? params.granularity;
  const depth = Math.max(options.priceDepth ?? 120, params.entry.atrPeriod + 5);
  const notes: string[] = [];

  const specs = await api.listInstruments();
  const wanted = options.types?.length
    ? specs.filter((spec) => options.types!.includes(spec.type))
    : specs;

  const byType: Record<string, number> = {};
  for (const spec of specs) byType[spec.type] = (byType[spec.type] ?? 0) + 1;

  // One pricing call for everything, rather than one per instrument. OANDA caps
  // the instruments parameter, so this is chunked.
  const quotes = new Map<string, { spread: number; tradeable: boolean; spreadPips: number }>();
  for (let i = 0; i < wanted.length; i += 20) {
    const chunk = wanted.slice(i, i + 20).map((spec) => spec.name);
    try {
      for (const quote of await api.pricing(chunk)) {
        quotes.set(quote.instrument, {
          spread: quote.spread,
          tradeable: quote.tradeable,
          spreadPips: quote.spreadPips,
        });
      }
    } catch (error) {
      notes.push(`Pricing failed for ${chunk.length} instruments: ${(error as Error).message}`);
    }
  }

  const capped = options.limit ? wanted.slice(0, options.limit) : wanted;
  if (options.limit && wanted.length > options.limit) {
    notes.push(`Priced the first ${options.limit} of ${wanted.length} instruments (limit).`);
  }

  const entries: UniverseEntry[] = [];
  for (const spec of capped) {
    const entry = await describeInstrument(api, spec, params, granularity, depth, quotes.get(spec.name), notes);
    entries.push(entry);
  }

  entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const watchlist = params.instruments ?? [];
  // A suggestion is only worth making when it is clearly better than what is
  // already there, so the bar is the watchlist's own median rather than a
  // constant someone has to justify.
  const watchedScores = entries.filter((e) => e.watched && e.score !== null).map((e) => e.score!);
  const bar = watchedScores.length
    ? watchedScores.sort((a, b) => a - b)[Math.floor(watchedScores.length / 2)]
    : 55;

  return {
    environment: api.environment,
    total: specs.length,
    byType,
    entries,
    watchlist,
    suggestedAdditions: entries
      .filter((e) => !e.watched && e.tradeable && (e.score ?? 0) > Math.max(bar, 55))
      .slice(0, 10)
      .map((e) => e.instrument),
    suggestedRemovals: entries
      .filter((e) => e.watched && e.score !== null && e.score < 35)
      .map((e) => e.instrument),
    notes,
  };
}

async function describeInstrument(
  api: OandaApi,
  spec: InstrumentSpec,
  params: StrategyParams,
  granularity: string,
  depth: number,
  quote: { spread: number; tradeable: boolean; spreadPips: number } | undefined,
  notes: string[]
): Promise<UniverseEntry> {
  const pip = Math.pow(10, spec.pipLocation);
  const entryNotes: string[] = [];

  let atrPips: number | null = null;
  try {
    const candles = (await api.candles(spec.name, granularity, depth)).filter((c) => c.complete);
    const series = atr(candles, params.entry.atrPeriod);
    const value = series[series.length - 1];
    if (Number.isFinite(value) && value > 0) atrPips = Number((value / pip).toFixed(1));
    else entryNotes.push("ATR unavailable: not enough complete candles.");
  } catch (error) {
    notes.push(`${spec.name}: candles unavailable (${(error as Error).message}).`);
    entryNotes.push("No candle history.");
  }

  const spreadPips = quote ? Number(quote.spreadPips.toFixed(2)) : null;
  const spreadAtrRatio =
    quote && atrPips !== null && atrPips > 0
      ? Number((quote.spread / (atrPips * pip)).toFixed(4))
      : null;

  if (spreadAtrRatio !== null && spreadAtrRatio > params.entry.maxSpreadAtrRatio) {
    entryNotes.push(
      `Spread is ${(spreadAtrRatio * 100).toFixed(0)}% of ATR, above the ` +
        `${(params.entry.maxSpreadAtrRatio * 100).toFixed(0)}% filter — signals here will be rejected.`
    );
  }
  if (atrPips !== null && atrPips < params.entry.minAtrPips) {
    entryNotes.push(`ATR ${atrPips} pips is below the ${params.entry.minAtrPips}-pip floor.`);
  }

  return {
    instrument: spec.name,
    displayName: spec.displayName,
    type: spec.type,
    watched: (params.instruments ?? []).includes(spec.name),
    disabledByProfile: Boolean(params.profiles?.[spec.name]?.disabled),
    marginRatePct: Number((spec.marginRate * 100).toFixed(2)),
    minimumTradeSize: spec.minimumTradeSize,
    financingLongPct: Number((spec.financingLongRate * 100).toFixed(3)),
    financingShortPct: Number((spec.financingShortRate * 100).toFixed(3)),
    spreadPips,
    atrPips,
    spreadAtrRatio,
    tradeable: quote?.tradeable ?? false,
    score: scoreEntry(spreadAtrRatio, atrPips, params),
    notes: entryNotes,
  };
}
