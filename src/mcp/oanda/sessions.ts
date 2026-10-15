// Trading sessions, in real exchange time.
//
// The previous session check read `new Date().getHours()` and compared it to
// hardcoded numbers that assumed the machine was in New York. That is wrong three
// ways: it breaks on a laptop set to any other timezone, it drifts by an hour
// twice a year in each hemisphere (US, UK, AU and JP all switch on different
// dates, or not at all), and it cannot express an overlap.
//
// Everything here resolves through the IANA timezone database via Intl, so DST is
// handled by the platform rather than by arithmetic we would get wrong.

export type SessionName = "sydney" | "tokyo" | "london" | "newYork";

interface SessionDefinition {
  name: SessionName;
  label: string;
  timeZone: string;
  /** Local opening hour at that exchange, inclusive. */
  openHour: number;
  /** Local closing hour, exclusive. */
  closeHour: number;
}

/**
 * Session hours in each centre's own local time.
 *
 * Chosen to match where the liquidity actually is rather than the letter of any
 * exchange calendar: FX is OTC, so these are the hours during which that centre's
 * banks are quoting tight.
 */
const SESSIONS: SessionDefinition[] = [
  { name: "sydney", label: "Sydney", timeZone: "Australia/Sydney", openHour: 7, closeHour: 16 },
  { name: "tokyo", label: "Tokyo", timeZone: "Asia/Tokyo", openHour: 9, closeHour: 18 },
  { name: "london", label: "London", timeZone: "Europe/London", openHour: 8, closeHour: 17 },
  { name: "newYork", label: "New York", timeZone: "America/New_York", openHour: 8, closeHour: 17 },
];

const FX_TIME_ZONE = "America/New_York";

/** Hour, minute and weekday at a given instant in a named timezone. */
export function zonedParts(
  at: Date,
  timeZone: string
): { hour: number; minute: number; weekday: number; label: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Intl renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number.parseInt(get("hour"), 10) % 24;

  return {
    hour,
    minute: Number.parseInt(get("minute"), 10),
    weekday: Math.max(0, weekdays.indexOf(get("weekday"))),
    label: `${get("weekday")} ${get("hour")}:${get("minute")}`,
  };
}

export interface SessionState {
  open: SessionName[];
  /** Two centres quoting at once — the tightest spreads of the day. */
  overlap: string | null;
  /** True while the FX market is shut for the weekend. */
  weekendClosed: boolean;
  /** True in the minutes around 17:00 New York, when spreads widen for rollover. */
  rolloverWindow: boolean;
  newYorkTime: string;
  utcTime: string;
  notes: string[];
}

/**
 * Which centres are quoting right now, plus the two conditions that reliably cost
 * money regardless of signal quality: the weekend gap and the daily rollover.
 */
export function sessionState(at: Date = new Date(), rolloverPaddingMinutes = 15): SessionState {
  const open: SessionName[] = [];
  for (const session of SESSIONS) {
    const { hour, weekday } = zonedParts(at, session.timeZone);
    // Local weekdays only: a centre is not quoting on its own Saturday.
    if (weekday === 0 || weekday === 6) continue;
    if (hour >= session.openHour && hour < session.closeHour) open.push(session.name);
  }

  const ny = zonedParts(at, FX_TIME_ZONE);

  // The FX week runs Sunday 17:00 ET to Friday 17:00 ET.
  const weekendClosed =
    ny.weekday === 6 ||
    (ny.weekday === 5 && ny.hour >= 17) ||
    (ny.weekday === 0 && ny.hour < 17);

  // Rollover sits at 17:00 New York. Spreads can multiply several times over for
  // a few minutes, which turns an otherwise fine entry into a losing one.
  const minutesFromRollover = (ny.hour - 17) * 60 + ny.minute;
  const rolloverWindow = Math.abs(minutesFromRollover) <= rolloverPaddingMinutes;

  let overlap: string | null = null;
  if (open.includes("london") && open.includes("newYork")) overlap = "London–New York";
  else if (open.includes("tokyo") && open.includes("london")) overlap = "Tokyo–London";
  else if (open.includes("sydney") && open.includes("tokyo")) overlap = "Sydney–Tokyo";

  const notes: string[] = [];
  if (weekendClosed) notes.push("FX market closed for the weekend (Fri 17:00 – Sun 17:00 New York).");
  if (rolloverWindow) notes.push("Within the 17:00 New York rollover window — spreads widen sharply.");
  if (overlap === "London–New York") {
    notes.push("London–New York overlap: the deepest liquidity and tightest spreads of the day.");
  }
  if (open.length === 0 && !weekendClosed) {
    notes.push("No major centre is quoting — thin book, wider spreads, unreliable breakouts.");
  }

  return {
    open,
    overlap,
    weekendClosed,
    rolloverWindow,
    newYorkTime: ny.label,
    utcTime: at.toISOString(),
    notes,
  };
}

/**
 * Sessions each instrument actually trades well in.
 *
 * A pair is liquid when at least one of its own currencies' centres is open. The
 * old code approximated this with substring checks on the symbol and a single
 * hour range; this derives it from the currencies involved, so a new pair works
 * without a code change.
 */
export function preferredSessions(instrument: string): SessionName[] {
  const symbol = instrument.toUpperCase();
  if (/BTC|ETH|LTC|BCH/.test(symbol)) {
    return ["sydney", "tokyo", "london", "newYork"]; // continuous
  }

  const byCurrency: Record<string, SessionName[]> = {
    AUD: ["sydney"],
    NZD: ["sydney"],
    JPY: ["tokyo"],
    SGD: ["tokyo"],
    HKD: ["tokyo"],
    CNH: ["tokyo"],
    EUR: ["london"],
    GBP: ["london"],
    CHF: ["london"],
    SEK: ["london"],
    NOK: ["london"],
    USD: ["newYork"],
    CAD: ["newYork"],
    MXN: ["newYork"],
    XAU: ["london", "newYork"],
    XAG: ["london", "newYork"],
  };

  const currencies = symbol.split(/[_\-/]/);
  const sessions = new Set<SessionName>();
  for (const currency of currencies) {
    for (const session of byCurrency[currency] ?? []) sessions.add(session);
  }
  // Unknown symbol: fall back to the two deepest sessions rather than to "always".
  if (sessions.size === 0) return ["london", "newYork"];
  return [...sessions];
}

export interface SessionVerdict {
  tradeable: boolean;
  reason: string;
  /** Quality multiplier, 0–1.25. Higher during an overlap, lower in a thin book. */
  liquidityScore: number;
  state: SessionState;
  preferred: SessionName[];
}

/**
 * Should this instrument be traded at this instant?
 *
 * `liquidityScore` is deliberately separate from `tradeable`: a caller can trade
 * a merely-acceptable window at reduced size instead of treating the decision as
 * binary.
 */
export function evaluateSession(
  instrument: string,
  at: Date = new Date(),
  options: { enforce?: boolean; blockRollover?: boolean } = {}
): SessionVerdict {
  const state = sessionState(at);
  const preferred = preferredSessions(instrument);
  const isCrypto = /BTC|ETH|LTC|BCH/.test(instrument.toUpperCase());
  const enforce = options.enforce !== false;
  const blockRollover = options.blockRollover !== false;

  // The weekend gap applies to FX whatever the settings say: there is no market.
  if (state.weekendClosed && !isCrypto) {
    return {
      tradeable: false,
      reason: `FX is closed (${state.newYorkTime} New York). Reopens Sunday 17:00 New York.`,
      liquidityScore: 0,
      state,
      preferred,
    };
  }

  if (blockRollover && state.rolloverWindow && !isCrypto) {
    return {
      tradeable: false,
      reason: `Inside the 17:00 New York rollover window — spreads are at their worst. Wait ${
        15
      } minutes.`,
      liquidityScore: 0.2,
      state,
      preferred,
    };
  }

  // Crypto has no sessions to be inside or outside. Without this it falls through
  // to the "no preferred session open" branch every weekend and overnight — when
  // every FX centre is shut but crypto is still trading.
  if (isCrypto) {
    return {
      tradeable: true,
      reason: "Crypto trades continuously; session windows do not apply.",
      liquidityScore: state.open.length === 0 ? 0.7 : 1,
      state,
      preferred,
    };
  }

  const matching = preferred.filter((session) => state.open.includes(session));

  if (matching.length === 0) {
    return {
      tradeable: !enforce,
      reason: enforce
        ? `No preferred session open for ${instrument} (wants ${preferred.join(
            "/"
          )}; open: ${state.open.join("/") || "none"}).`
        : `Outside ${instrument}'s preferred sessions, but the window check is disabled.`,
      liquidityScore: 0.4,
      state,
      preferred,
    };
  }

  // Two of the pair's own centres quoting at once is the best it gets.
  let liquidityScore = 0.8 + Math.min(matching.length - 1, 1) * 0.2;
  if (state.overlap === "London–New York") liquidityScore = Math.min(1.25, liquidityScore + 0.25);

  return {
    tradeable: true,
    reason: `${matching.join(" + ")} open${state.overlap ? ` (${state.overlap} overlap)` : ""}.`,
    liquidityScore,
    state,
    preferred,
  };
}

/** Session windows for the day, for display. */
export function sessionSchedule(at: Date = new Date()): Array<{
  session: SessionName;
  label: string;
  timeZone: string;
  localWindow: string;
  currentlyOpen: boolean;
}> {
  const state = sessionState(at);
  return SESSIONS.map((session) => ({
    session: session.name,
    label: session.label,
    timeZone: session.timeZone,
    localWindow: `${String(session.openHour).padStart(2, "0")}:00–${String(
      session.closeHour
    ).padStart(2, "0")}:00 ${session.timeZone}`,
    currentlyOpen: state.open.includes(session.name),
  }));
}
