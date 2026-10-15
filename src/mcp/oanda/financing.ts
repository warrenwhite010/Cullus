// Financing (carry) and the 17:00 New York rollover charge.
//
// OANDA applies financing once a day, at 17:00 New York, to every position open
// at that instant. Two properties of that make it worth modelling rather than
// ignoring:
//
//   1. It is charged on the FULL NOTIONAL, not on the profit. A 25,000-unit
//      EUR_USD position is ~$27,500 of notional; a −2% annual rate on it is about
//      $1.50 a day. Against a 2R target worth $100 that is noise — against a
//      scalp risking $50 with a 10-pip target it is a material share of the edge.
//
//   2. One weekday charges THREE days at once (Wednesday for most FX pairs) to
//      cover the weekend's value dates. A position held through that single
//      rollover pays triple. This is the "extra charge after 5pm" that appears
//      to come out of nowhere: it is the same mechanism, on the one day it is
//      tripled.
//
// Nothing here blocks a trade on its own. Carry is a cost to be priced against
// the expected move, and a strategy with real edge should usually pay it.

import type { InstrumentSpec, OpenTrade } from "./api.js";
import { zonedParts } from "./sessions.js";

const FX_TIME_ZONE = "America/New_York";

export interface RolloverTiming {
  /** Hours until the next 17:00 New York rollover. */
  hoursUntil: number;
  /** Days of financing the next rollover will charge. */
  daysCharged: number;
  /** True when the next rollover is the tripled one. */
  isTripleCharge: boolean;
  /** Weekday index the next rollover falls on. */
  weekday: number;
  description: string;
}

/**
 * When the next rollover lands and how many days it will charge.
 *
 * Resolved in New York time through the timezone database, so it is correct
 * across DST rather than drifting by an hour twice a year.
 */
export function nextRollover(spec: InstrumentSpec, at: Date = new Date()): RolloverTiming {
  const ny = zonedParts(at, FX_TIME_ZONE);
  const minutesNow = ny.hour * 60 + ny.minute;
  const rolloverMinutes = 17 * 60;

  // Before 17:00 the next rollover is today's; after it, tomorrow's.
  const beforeToday = minutesNow < rolloverMinutes;
  const minutesUntil = beforeToday
    ? rolloverMinutes - minutesNow
    : 24 * 60 - minutesNow + rolloverMinutes;
  const weekday = beforeToday ? ny.weekday : (ny.weekday + 1) % 7;

  const daysCharged = spec.financingDaysCharged[weekday] ?? 1;
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hoursUntil = Number((minutesUntil / 60).toFixed(2));

  return {
    hoursUntil,
    daysCharged,
    isTripleCharge: daysCharged >= 3,
    weekday,
    description:
      daysCharged === 0
        ? `Next rollover is ${names[weekday]} 17:00 New York and charges nothing (weekend).`
        : `Next rollover in ${hoursUntil}h (${names[weekday]} 17:00 New York), charging ` +
          `${daysCharged} day(s) of financing` +
          (daysCharged >= 3 ? " — the tripled weekend rollover." : "."),
  };
}

export interface CarryEstimate {
  instrument: string;
  direction: "long" | "short";
  units: number;
  notional: number;
  /** Annualised rate applied to this direction, as a fraction. */
  annualRate: number;
  /** Account-currency cost (negative) or credit (positive) for one charged day. */
  perDay: number;
  /** Cost or credit at the next rollover, including any tripling. */
  atNextRollover: number;
  /** As a fraction of the trade's risk, which is the only comparison that matters. */
  fractionOfRisk: number | null;
  rollover: RolloverTiming;
  /** True when holding this position through 17:00 costs money. */
  costsMoney: boolean;
  /**
   * False for a cross pair, where the base → account conversion is unknown
   * without a third rate and is assumed 1.0. The figure is then indicative.
   */
  conversionExact: boolean;
  summary: string;
}

/**
 * Value of one unit of an instrument's BASE currency in the account currency.
 *
 * Financing accrues on the base-currency notional — 20,000 units of AUD_JPY is
 * 20,000 AUD, not 20,000 × 98.5 of anything. Getting this wrong inflates the
 * estimate by the size of the quote price, which for a JPY cross is a factor of
 * about 150 and turns every carry check into a false alarm.
 *
 *   XXX_USD on a USD account → the price itself (1 EUR = 1.09 USD)
 *   USD_XXX on a USD account → 1 (the base already IS the account currency)
 *   cross pair               → unknown without a third rate; returns 1 and the
 *                              caller should treat the figure as indicative
 */
export function baseToAccountRate(
  instrument: string,
  price: number,
  accountCurrency = "USD"
): { rate: number; exact: boolean } {
  const [base, quote] = instrument.toUpperCase().split(/[_\-/]/);
  if (!base || !quote) return { rate: 1, exact: false };
  if (base === accountCurrency) return { rate: 1, exact: true };
  if (quote === accountCurrency) return { rate: price, exact: true };
  return { rate: 1, exact: false };
}

/**
 * Carry on a position, priced against its risk.
 *
 * `riskAmount` is optional but strongly worth passing: "financing is $1.47" means
 * nothing on its own, while "financing is 3% of what you are risking" is a
 * decision. Pass `accountCurrency` and `price` and the base-currency conversion
 * is derived; pass `baseToAccount` directly to override it.
 */
export function estimateCarry(input: {
  spec: InstrumentSpec;
  direction: "long" | "short";
  units: number;
  price: number;
  riskAmount?: number;
  accountCurrency?: string;
  /** Overrides the derived base → account rate. */
  baseToAccount?: number;
  at?: Date;
}): CarryEstimate {
  const { spec, direction, price } = input;
  const units = Math.abs(input.units);
  const at = input.at ?? new Date();

  const derived = baseToAccountRate(spec.name, price, input.accountCurrency ?? "USD");
  const rate = input.baseToAccount ?? derived.rate;

  const annualRate = direction === "long" ? spec.financingLongRate : spec.financingShortRate;
  const notional = units * rate;
  // OANDA divides the annual rate by 365, not 252: financing accrues on calendar
  // days, which is exactly why the weekend has to be charged somewhere.
  const perDay = (notional * annualRate) / 365;

  const rollover = nextRollover(spec, at);
  const atNextRollover = perDay * rollover.daysCharged;
  const fractionOfRisk =
    input.riskAmount && input.riskAmount > 0
      ? Number((Math.abs(atNextRollover) / input.riskAmount).toFixed(4))
      : null;

  const costsMoney = atNextRollover < 0;
  const magnitude = Math.abs(atNextRollover);

  let summary: string;
  if (rollover.daysCharged === 0) {
    summary = "No financing at the next rollover (weekend).";
  } else if (!costsMoney) {
    summary =
      `Holding ${direction} pays ${magnitude.toFixed(2)} at the next rollover ` +
      `(positive carry${rollover.isTripleCharge ? ", tripled" : ""}).`;
  } else {
    summary =
      `Holding ${direction} through 17:00 New York costs ${magnitude.toFixed(2)}` +
      (rollover.isTripleCharge ? " — TRIPLED weekend rollover" : "") +
      (fractionOfRisk !== null
        ? `, which is ${(fractionOfRisk * 100).toFixed(1)}% of the ${input.riskAmount!.toFixed(
            2
          )} at risk.`
        : ".");
  }

  return {
    instrument: spec.name,
    direction,
    units,
    notional: Number(notional.toFixed(2)),
    annualRate,
    perDay: Number(perDay.toFixed(4)),
    atNextRollover: Number(atNextRollover.toFixed(4)),
    fractionOfRisk,
    rollover,
    costsMoney,
    conversionExact: input.baseToAccount !== undefined ? true : derived.exact,
    summary: derived.exact || input.baseToAccount !== undefined
      ? summary
      : `${summary} (Indicative: ${spec.name} is a cross pair, so the base-currency conversion is assumed 1.0.)`,
  };
}

export interface CarryGateSettings {
  /**
   * Refuse an entry when the next rollover's financing would exceed this
   * fraction of the trade's risk. 0 disables the check.
   *
   * Default 0.10: a cost above a tenth of what you are risking is no longer a
   * rounding error, and on the tripled rollover it is often several times that.
   */
  maxCarryFractionOfRisk: number;
  /**
   * Refuse entries in the hours before the tripled rollover when carry is
   * negative. Opening a short-horizon trade an hour before a 3× charge is paying
   * three days of interest for one hour of exposure.
   */
  avoidTripleRolloverHours: number;
}

export const DEFAULT_CARRY_GATE: CarryGateSettings = {
  maxCarryFractionOfRisk: 0.1,
  avoidTripleRolloverHours: 2,
};

export interface CarryVerdict {
  ok: boolean;
  reasons: string[];
  estimate: CarryEstimate;
}

/**
 * Should carry stop this entry?
 *
 * Only ever blocks on cost relative to risk — never on the raw figure, and never
 * when carry is positive. A trade that earns its financing is a better trade,
 * not a worse one.
 */
export function checkCarry(
  estimate: CarryEstimate,
  settings: CarryGateSettings = DEFAULT_CARRY_GATE
): CarryVerdict {
  const reasons: string[] = [];

  if (!estimate.costsMoney) {
    return { ok: true, reasons: [estimate.summary], estimate };
  }

  if (
    settings.maxCarryFractionOfRisk > 0 &&
    estimate.fractionOfRisk !== null &&
    estimate.fractionOfRisk > settings.maxCarryFractionOfRisk
  ) {
    reasons.push(
      `Financing at the next rollover is ${(estimate.fractionOfRisk * 100).toFixed(1)}% of the ` +
        `trade's risk, above the ${(settings.maxCarryFractionOfRisk * 100).toFixed(0)}% limit` +
        (estimate.rollover.isTripleCharge ? " (tripled weekend rollover)" : "") +
        `. Either size for it or wait until after 17:00 New York.`
    );
  }

  if (
    settings.avoidTripleRolloverHours > 0 &&
    estimate.rollover.isTripleCharge &&
    estimate.rollover.hoursUntil <= settings.avoidTripleRolloverHours
  ) {
    reasons.push(
      `The tripled rollover is ${estimate.rollover.hoursUntil}h away and this position has ` +
        `negative carry — three days of financing for a few hours of exposure. Wait until after ` +
        `17:00 New York.`
    );
  }

  return { ok: reasons.length === 0, reasons: reasons.length ? reasons : [estimate.summary], estimate };
}

/** Carry across every open position, so the daily drag is one number. */
export function portfolioCarry(
  trades: OpenTrade[],
  specs: Map<string, InstrumentSpec>,
  at: Date = new Date(),
  accountCurrency = "USD"
): {
  totalAtNextRollover: number;
  totalPerDay: number;
  tripleRolloverAhead: boolean;
  positions: CarryEstimate[];
  summary: string;
} {
  const positions: CarryEstimate[] = [];

  for (const trade of trades) {
    const spec = specs.get(trade.instrument);
    if (!spec) continue;
    positions.push(
      estimateCarry({
        spec,
        direction: trade.currentUnits >= 0 ? "long" : "short",
        units: trade.currentUnits,
        price: trade.price,
        accountCurrency,
        at,
      })
    );
  }

  const totalAtNextRollover = positions.reduce((sum, entry) => sum + entry.atNextRollover, 0);
  const totalPerDay = positions.reduce((sum, entry) => sum + entry.perDay, 0);
  const tripleRolloverAhead = positions.some((entry) => entry.rollover.isTripleCharge);

  return {
    totalAtNextRollover: Number(totalAtNextRollover.toFixed(2)),
    totalPerDay: Number(totalPerDay.toFixed(2)),
    tripleRolloverAhead,
    positions,
    summary:
      positions.length === 0
        ? "No open positions, so no financing at the next rollover."
        : `${positions.length} position(s): ${
            totalAtNextRollover < 0 ? "costing" : "earning"
          } ${Math.abs(totalAtNextRollover).toFixed(2)} at the next rollover` +
          (tripleRolloverAhead ? " (tripled weekend charge)" : "") +
          `, ${Math.abs(totalPerDay).toFixed(2)}/day thereafter.`,
  };
}
