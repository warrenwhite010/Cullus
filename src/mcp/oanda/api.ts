// Minimal OANDA v20 REST client for the oanda-trading MCP server.
//
// Deliberately dependency-free (global fetch) and read-heavy: everything the
// model needs to *reason* about a market is a GET. The three write calls live at
// the bottom, behind an explicit `allowTrading` flag the server sets from its
// own environment — naming conventions alone are not a safety gate.

export type OandaEnvironment = "practice" | "live";

export interface Candle {
  /** RFC3339 open time. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** OANDA marks a forming candle incomplete; strategies must ignore those. */
  complete: boolean;
}

export interface InstrumentSpec {
  name: string;
  type: string;
  displayName: string;
  /**
   * Exponent of one pip: -4 for EUR_USD (0.0001), -2 for USD_JPY (0.01).
   *
   * This single number is why a stop expressed as "0.0020" is 20 pips on
   * EUR_USD and a fifth of a pip on USD_JPY. Anything that hardcodes a price
   * distance across instruments is mispricing risk by two orders of magnitude.
   */
  pipLocation: number;
  displayPrecision: number;
  minimumTradeSize: number;
  marginRate: number;
  tradeUnitsPrecision: number;
  /**
   * Annualised financing rate applied to a long position, as a fraction.
   *
   * Negative means holding long costs money. This is the charge that lands at
   * 17:00 New York every day a position is open, and it is the reason a small
   * scalp held overnight can finish underwater on a winning price move.
   */
  financingLongRate: number;
  /** Annualised financing rate applied to a short position, as a fraction. */
  financingShortRate: number;
  /**
   * Days of financing charged, per weekday (0 = Sunday).
   *
   * Not always 1: OANDA charges THREE days on one weekday — Wednesday for most
   * FX — to cover the weekend's value dates. A position held through that one
   * rollover pays triple, which is the "extra charge after 5pm" people notice
   * without knowing why it was that particular day.
   */
  financingDaysCharged: Record<number, number>;
}

export interface PriceQuote {
  instrument: string;
  time: string;
  bid: number;
  ask: number;
  mid: number;
  /** Ask − bid, in price units. */
  spread: number;
  spreadPips: number;
  tradeable: boolean;
}

export interface AccountSummary {
  id: string;
  currency: string;
  balance: number;
  nav: number;
  unrealizedPL: number;
  realizedPL: number;
  marginUsed: number;
  marginAvailable: number;
  marginCloseoutPercent: number;
  openTradeCount: number;
  openPositionCount: number;
  pendingOrderCount: number;
}

export interface OpenTrade {
  id: string;
  instrument: string;
  /** Signed: negative is short. */
  currentUnits: number;
  initialUnits: number;
  price: number;
  unrealizedPL: number;
  realizedPL: number;
  openTime: string;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  trailingStopDistance: number | null;
}

export interface PendingOrder {
  id: string;
  instrument: string;
  type: string;
  units: number;
  price: number | null;
  createTime: string;
}

/** One closed trade, reconstructed from the transaction stream. */
export interface ClosedTrade {
  tradeID: string;
  instrument: string;
  units: number;
  realizedPL: number;
  /** Financing (carry) paid or received while the trade was open. */
  financing: number;
  closeTime: string;
  /** Order type of the closing transaction, e.g. STOP_LOSS_ORDER. */
  closeReason: string;
}

export class OandaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "OandaError";
  }
}

const HOSTS: Record<OandaEnvironment, string> = {
  practice: "https://api-fxpractice.oanda.com/v3",
  live: "https://api-fxtrade.oanda.com/v3",
};

function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class OandaApi {
  private readonly base: string;
  private specCache = new Map<string, InstrumentSpec>();

  constructor(
    private readonly token: string,
    readonly environment: OandaEnvironment,
    readonly accountID: string,
    /** When false, every mutating method throws before touching the network. */
    private readonly allowTrading: boolean
  ) {
    this.base = HOSTS[environment];
  }

  get tradingEnabled(): boolean {
    return this.allowTrading;
  }

  private async request<T>(
    path: string,
    init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "RFC3339",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) {
      // OANDA returns a JSON errorMessage that is genuinely useful ("Insufficient
      // margin", "The units specified are invalid"); surface it verbatim rather
      // than collapsing everything to the status code.
      let detail = text.slice(0, 600);
      try {
        const parsed = JSON.parse(text);
        detail = parsed.errorMessage ?? parsed.rejectReason ?? detail;
      } catch {
        /* keep the raw body */
      }
      throw new OandaError(`OANDA ${response.status}: ${detail}`, response.status, text);
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private requireTrading(action: string): void {
    if (!this.allowTrading) {
      throw new Error(
        `${action} is blocked: this MCP server is running in read-only mode. ` +
          `Unlock it with the 🔒 toggle next to "oanda-trading" in Settings → Connections ` +
          `(or unset OANDA_TRADING_READ_ONLY) before asking for order placement again.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async accountSummary(): Promise<AccountSummary> {
    const { account } = await this.request<{ account: Record<string, string> }>(
      `/accounts/${this.accountID}/summary`
    );
    return {
      id: String(account.id),
      currency: String(account.currency),
      balance: num(account.balance),
      nav: num(account.NAV),
      unrealizedPL: num(account.unrealizedPL),
      realizedPL: num(account.pl),
      marginUsed: num(account.marginUsed),
      marginAvailable: num(account.marginAvailable),
      marginCloseoutPercent: num(account.marginCloseoutPercent),
      openTradeCount: num(account.openTradeCount),
      openPositionCount: num(account.openPositionCount),
      pendingOrderCount: num(account.pendingOrderCount),
    };
  }

  /**
   * Every instrument this account may trade, straight from OANDA.
   *
   * There is no hardcoded list anywhere in this codebase on purpose: what a US
   * account is permitted to trade is a regulatory question with a moving answer,
   * and the account's own /instruments response is the only authority on it.
   * Specs land in the same cache instrumentSpec() reads, so a sweep warms every
   * later per-instrument call for free.
   */
  async listInstruments(): Promise<InstrumentSpec[]> {
    const { instruments } = await this.request<{ instruments: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/instruments`
    );

    const specs = (instruments ?? []).map((raw) => this.parseSpec(raw));
    for (const spec of specs) this.specCache.set(spec.name, spec);
    return specs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async instrumentSpec(instrument: string): Promise<InstrumentSpec> {
    const cached = this.specCache.get(instrument);
    if (cached) return cached;

    const { instruments } = await this.request<{ instruments: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/instruments`,
      { query: { instruments: instrument } }
    );
    const raw = instruments?.[0];
    if (!raw) throw new Error(`Unknown instrument "${instrument}" for this account.`);

    const spec = this.parseSpec(raw);
    this.specCache.set(instrument, spec);
    return spec;
  }

  /** One raw /instruments entry → InstrumentSpec. Shared by the two readers above. */
  private parseSpec(raw: Record<string, any>): InstrumentSpec {
    // Financing is reported as a nested object with a per-weekday schedule. The
    // weekday names are spelled out, so map them to indices once here rather than
    // string-matching at every call site.
    const WEEKDAY_INDEX: Record<string, number> = {
      SUNDAY: 0,
      MONDAY: 1,
      TUESDAY: 2,
      WEDNESDAY: 3,
      THURSDAY: 4,
      FRIDAY: 5,
      SATURDAY: 6,
    };
    const daysCharged: Record<number, number> = {};
    for (const entry of raw.financing?.financingDaysOfWeek ?? []) {
      const index = WEEKDAY_INDEX[String(entry.dayOfWeek).toUpperCase()];
      if (index !== undefined) daysCharged[index] = num(entry.daysCharged, 1);
    }

    const spec: InstrumentSpec = {
      name: String(raw.name),
      type: String(raw.type),
      displayName: String(raw.displayName),
      pipLocation: num(raw.pipLocation, -4),
      displayPrecision: num(raw.displayPrecision, 5),
      minimumTradeSize: num(raw.minimumTradeSize, 1),
      marginRate: num(raw.marginRate, 0.02),
      tradeUnitsPrecision: num(raw.tradeUnitsPrecision, 0),
      financingLongRate: num(raw.financing?.longRate, 0),
      financingShortRate: num(raw.financing?.shortRate, 0),
      // Fall back to the standard FX schedule — 1 day, 3 on Wednesday — rather
      // than to zero, so a missing field understates nothing.
      financingDaysCharged:
        Object.keys(daysCharged).length > 0
          ? daysCharged
          : { 0: 0, 1: 1, 2: 1, 3: 3, 4: 1, 5: 1, 6: 0 },
    };
    return spec;
  }

  async candles(
    instrument: string,
    granularity: string,
    count: number,
    options: { from?: string; to?: string; price?: "M" | "B" | "A" } = {}
  ): Promise<Candle[]> {
    const { candles } = await this.request<{ candles: Array<Record<string, any>> }>(
      `/instruments/${instrument}/candles`,
      {
        query: {
          granularity,
          // `from`/`to` and `count` are mutually exclusive in the v20 API.
          count: options.from || options.to ? undefined : count,
          from: options.from,
          to: options.to,
          price: options.price ?? "M",
        },
      }
    );

    return (candles ?? []).map((candle) => {
      const ohlc = candle.mid ?? candle.bid ?? candle.ask ?? {};
      return {
        time: String(candle.time),
        open: num(ohlc.o),
        high: num(ohlc.h),
        low: num(ohlc.l),
        close: num(ohlc.c),
        volume: num(candle.volume),
        complete: Boolean(candle.complete),
      };
    });
  }

  /**
   * Candles in bulk, walking backwards from now.
   *
   * The API caps a single response at 5000 candles, which is nowhere near enough
   * history to say anything honest about a strategy on M5/M15. Paging by `to`
   * keeps the backtest window as long as the caller asks for.
   */
  async candleHistory(instrument: string, granularity: string, count: number): Promise<Candle[]> {
    const PAGE = 5000;
    let remaining = Math.max(1, count);
    let cursor: string | undefined;
    const pages: Candle[][] = [];

    while (remaining > 0) {
      const page = await this.candles(instrument, granularity, Math.min(PAGE, remaining), {
        to: cursor,
      });
      if (page.length === 0) break;
      pages.unshift(page);
      remaining -= page.length;
      cursor = page[0].time;
      if (page.length < Math.min(PAGE, remaining + page.length)) break;
    }

    // Pages can overlap on the boundary candle; de-duplicate by open time.
    const seen = new Set<string>();
    const merged: Candle[] = [];
    for (const candle of pages.flat()) {
      if (seen.has(candle.time)) continue;
      seen.add(candle.time);
      merged.push(candle);
    }
    return merged.slice(-count);
  }

  async pricing(instruments: string[]): Promise<PriceQuote[]> {
    const { prices } = await this.request<{ prices: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/pricing`,
      { query: { instruments: instruments.join(",") } }
    );

    const quotes: PriceQuote[] = [];
    for (const price of prices ?? []) {
      const bid = num(price.bids?.[0]?.price);
      const ask = num(price.asks?.[0]?.price);
      const spec = await this.instrumentSpec(String(price.instrument));
      const pip = Math.pow(10, spec.pipLocation);
      quotes.push({
        instrument: String(price.instrument),
        time: String(price.time),
        bid,
        ask,
        mid: (bid + ask) / 2,
        spread: ask - bid,
        spreadPips: pip > 0 ? (ask - bid) / pip : 0,
        tradeable: Boolean(price.tradeable),
      });
    }
    return quotes;
  }

  async openTrades(): Promise<OpenTrade[]> {
    const { trades } = await this.request<{ trades: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/openTrades`
    );
    return (trades ?? []).map((trade) => ({
      id: String(trade.id),
      instrument: String(trade.instrument),
      currentUnits: num(trade.currentUnits),
      initialUnits: num(trade.initialUnits),
      price: num(trade.price),
      unrealizedPL: num(trade.unrealizedPL),
      realizedPL: num(trade.realizedPL),
      openTime: String(trade.openTime),
      stopLossPrice: trade.stopLossOrder ? num(trade.stopLossOrder.price) : null,
      takeProfitPrice: trade.takeProfitOrder ? num(trade.takeProfitOrder.price) : null,
      trailingStopDistance: trade.trailingStopLossOrder
        ? num(trade.trailingStopLossOrder.distance)
        : null,
    }));
  }

  async pendingOrders(): Promise<PendingOrder[]> {
    const { orders } = await this.request<{ orders: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/pendingOrders`
    );
    return (orders ?? []).map((order) => ({
      id: String(order.id),
      instrument: String(order.instrument ?? ""),
      type: String(order.type),
      units: num(order.units),
      price: order.price === undefined ? null : num(order.price),
      createTime: String(order.createTime),
    }));
  }

  /**
   * Closed trades over the last `count` transactions.
   *
   * Read from the transaction stream rather than /trades?state=CLOSED because
   * only the transactions carry the *reason* a trade closed, which is the part
   * worth learning from: a book full of STOP_LOSS_ORDER closes and a book full
   * of TAKE_PROFIT_ORDER closes need opposite fixes.
   */
  async closedTrades(count = 200): Promise<ClosedTrade[]> {
    const summary = await this.request<{ lastTransactionID: string }>(
      `/accounts/${this.accountID}`
    );
    const last = Number.parseInt(summary.lastTransactionID ?? "0", 10) || 0;
    if (last === 0) return [];

    const from = Math.max(1, last - Math.max(count, 1) * 4);
    const { transactions } = await this.request<{ transactions: Array<Record<string, any>> }>(
      `/accounts/${this.accountID}/transactions/idrange`,
      { query: { from, to: last } }
    );

    const closed: ClosedTrade[] = [];
    for (const tx of transactions ?? []) {
      for (const closedTrade of tx.tradesClosed ?? []) {
        closed.push({
          tradeID: String(closedTrade.tradeID),
          instrument: String(tx.instrument ?? ""),
          units: num(closedTrade.units),
          realizedPL: num(closedTrade.realizedPL),
          financing: num(closedTrade.financing),
          closeTime: String(tx.time),
          closeReason: String(tx.type ?? "UNKNOWN"),
        });
      }
    }
    return closed.slice(-count);
  }

  // -------------------------------------------------------------------------
  // Writes — every one of these moves real money
  // -------------------------------------------------------------------------

  async createOrder(order: Record<string, unknown>): Promise<Record<string, any>> {
    this.requireTrading("Placing an order");
    return this.request(`/accounts/${this.accountID}/orders`, {
      method: "POST",
      body: { order },
    });
  }

  async closePosition(
    instrument: string,
    side: "long" | "short" | "both",
    units: number | "ALL"
  ): Promise<Record<string, any>> {
    this.requireTrading("Closing a position");
    const body: Record<string, string> = {};
    const amount = units === "ALL" ? "ALL" : String(Math.abs(units));
    if (side === "long" || side === "both") body.longUnits = amount;
    if (side === "short" || side === "both") body.shortUnits = amount;
    return this.request(`/accounts/${this.accountID}/positions/${instrument}/close`, {
      method: "PUT",
      body,
    });
  }

  /**
   * Close one trade by ID, fully or partially.
   *
   * Distinct from closePosition, which closes an instrument's whole net position
   * and applies FIFO server-side. Closing by ID is what you want when several
   * trades on the same pair were opened on different signals and only one of them
   * has stopped working — with FIFO enabled the broker may still close the oldest
   * first, so callers should check planFifoClose before relying on this.
   */
  async closeTrade(tradeID: string, units: number | "ALL" = "ALL"): Promise<Record<string, any>> {
    this.requireTrading("Closing a trade");
    return this.request(`/accounts/${this.accountID}/trades/${tradeID}/close`, {
      method: "PUT",
      body: { units: units === "ALL" ? "ALL" : String(Math.abs(units)) },
    });
  }

  async cancelOrder(orderID: string): Promise<Record<string, any>> {
    this.requireTrading("Cancelling an order");
    return this.request(`/accounts/${this.accountID}/orders/${orderID}/cancel`, {
      method: "PUT",
    });
  }

  async setTradeBrackets(
    tradeID: string,
    brackets: { stopLossPrice?: number; takeProfitPrice?: number; trailingDistance?: number },
    precision: number
  ): Promise<Record<string, any>> {
    this.requireTrading("Modifying a trade's brackets");
    const body: Record<string, unknown> = {};
    if (brackets.stopLossPrice !== undefined) {
      body.stopLoss = { price: brackets.stopLossPrice.toFixed(precision), timeInForce: "GTC" };
    }
    if (brackets.takeProfitPrice !== undefined) {
      body.takeProfit = { price: brackets.takeProfitPrice.toFixed(precision), timeInForce: "GTC" };
    }
    if (brackets.trailingDistance !== undefined) {
      body.trailingStopLoss = {
        distance: brackets.trailingDistance.toFixed(precision),
        timeInForce: "GTC",
      };
    }
    return this.request(`/accounts/${this.accountID}/trades/${tradeID}/orders`, {
      method: "PUT",
      body,
    });
  }
}
