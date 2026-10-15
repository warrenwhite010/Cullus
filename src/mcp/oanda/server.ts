#!/usr/bin/env node
// oanda-trading MCP server.
//
// Gives the model the tools a discretionary trader would actually want: what the
// account looks like, what every watched instrument is doing right now, what
// size a trade should be, whether the idea survived a walk-forward test, and
// what the last hundred closed trades say about which strategy is working.
//
// Two safety properties are structural rather than advisory:
//   1. Order placement is refused outright unless OANDA_TRADING_READ_ONLY is
//      off — the check lives in OandaApi, below every tool.
//   2. Every order tool requires `confirm: true`, so a stray call cannot fill.
//
// Environment: OANDA_API_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENVIRONMENT
// (practice|live), OANDA_TRADING_READ_ONLY (1 = reads only),
// OANDA_BOT_PARAMS_PATH (shared parameter file).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { OandaApi, type OandaEnvironment, type OpenTrade } from "./api.js";
import {
  optimizeInstrumentProfile,
  rankInstruments,
  runBacktest,
  walkForwardOptimize,
  type InstrumentSeries,
} from "./backtest.js";
import { buildConsensus } from "./consensus.js";
import { checkFifoEntry, netPosition, planFifoClose, positionFillFor } from "./fifo.js";
import { checkCarry, estimateCarry, nextRollover, portfolioCarry } from "./financing.js";
import { atr, adx, last, rsi, sma } from "./indicators.js";
import {
  activeInstruments,
  APPETITE_PRESETS,
  applyAppetite,
  autopilotGate,
  DEFAULT_PARAMS,
  loadParams,
  mergeParams,
  paramsPath,
  resolveParams,
  saveParams,
  validateParams,
  type StrategyParams,
} from "./params.js";
import { buildDailyPlan, type MeasuredEdge, type PlanCandidate } from "./dailyplan.js";
import { buildPeriodReport } from "./report.js";
import { sweepUniverse } from "./universe.js";
import { researchInstrument } from "./research.js";
import { evaluateSession, sessionSchedule, sessionState } from "./sessions.js";
import {
  checkCost,
  computeIndicators,
  currenciesOf,
  evaluateAt,
  selectSignal,
  sizePosition,
  warmupBars,
} from "./strategy.js";

const token = process.env.OANDA_API_TOKEN ?? "";
const accountID = process.env.OANDA_ACCOUNT_ID ?? "";
const environment: OandaEnvironment =
  process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice";
const readOnly = process.env.OANDA_TRADING_READ_ONLY === "1";

if (!token || !accountID) {
  process.stderr.write(
    "[oanda-trading] OANDA_API_TOKEN and OANDA_ACCOUNT_ID must both be set.\n"
  );
  process.exit(1);
}

const api = new OandaApi(token, environment, accountID, !readOnly);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "oanda_status",
    description:
      "Account and risk snapshot: NAV, balance, margin, open trades with their unrealised P/L " +
      "and brackets, how much risk is currently open versus the configured ceiling, and whether " +
      "this server is allowed to trade. Start here before any other trading question.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oanda_market_scan",
    description:
      "What the bot would do right now, per instrument: live bid/ask/spread, ATR and ADX, the " +
      "signal each enabled strategy produces, whether the spread-versus-volatility cost filter " +
      "passes, whether the session window is open, and the risk-based position size the signal " +
      "would get. This is the main analysis tool — use it instead of guessing from candles.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: {
          type: "array",
          items: { type: "string" },
          description: "Defaults to the instruments in the shared parameter file.",
        },
        granularity: { type: "string", description: "Candle size, e.g. M5, M15, H1. Default: from params." },
        includeNoSignal: {
          type: "boolean",
          description: "Include instruments with no signal (default true) — the reasons are useful.",
        },
      },
    },
  },
  {
    name: "oanda_candles",
    description:
      "Historical candles for one instrument with indicators attached (ATR, ADX, RSI, fast/slow " +
      "SMA). Use for ad-hoc analysis; prefer oanda_market_scan for trade decisions.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        granularity: { type: "string", description: "Default M15." },
        count: { type: "number", description: "Candles to return, max 500 in the response." },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_position_size",
    description:
      "Convert a risk budget into units: given an instrument and a stop distance (in pips or as " +
      "an ATR multiple), returns the unit count whose stop-out costs exactly the configured " +
      "percent of NAV, capped by available margin. Always size trades with this rather than " +
      "picking a round number.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        direction: { type: "string", enum: ["long", "short"] },
        stopPips: { type: "number", description: "Stop distance in pips. Omit to use stopAtrMultiple." },
        stopAtrMultiple: {
          type: "number",
          description: "Stop distance as a multiple of current ATR. Default: params entry.stopAtrMultiple.",
        },
        riskPercent: { type: "number", description: "Override params risk.riskPerTradePct." },
      },
      required: ["instrument", "direction"],
    },
  },
  {
    name: "oanda_backtest",
    description:
      "Run the current (or a patched) parameter set over real historical candles and return " +
      "trade-by-trade metrics: expectancy in R, profit factor, win rate, max drawdown, and a " +
      "breakdown by strategy and instrument. Entries fill at the next bar's open, the spread is " +
      "charged both ways, and a bar containing both stop and target counts as a loss. Use this " +
      "before changing any parameter.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: { type: "array", items: { type: "string" } },
        granularity: { type: "string", description: "Default: from params." },
        candles: { type: "number", description: "History depth per instrument. Default 3000, max 20000." },
        startingEquity: { type: "number", description: "Default: current NAV." },
        paramPatch: {
          type: "object",
          description:
            "Partial parameter object merged over the saved params for this run only, e.g. " +
            '{"entry":{"takeProfitR":2.5}}. Nothing is written to disk.',
        },
        includeTrades: { type: "boolean", description: "Return the individual trades (default false)." },
      },
    },
  },
  {
    name: "oanda_optimize",
    description:
      "Walk-forward parameter search: grid-searches on the older 60% of the history and scores " +
      "every candidate on the unseen remainder. Returns the ranked candidates with both columns " +
      "and an explicit verdict on whether anything is worth adopting. A candidate that only wins " +
      "out-of-sample is treated as noise.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: { type: "array", items: { type: "string" } },
        granularity: { type: "string" },
        candles: { type: "number", description: "History depth per instrument. Default 5000." },
        grid: {
          type: "object",
          description:
            "Section → key → values to try, e.g. " +
            '{"entry":{"stopAtrMultiple":[1,1.5,2],"takeProfitR":[1.5,2,3]}}. ' +
            "Defaults to a sensible stop/target/ADX grid.",
        },
        trainFraction: { type: "number", description: "In-sample share, default 0.6." },
        perInstrument: {
          type: "boolean",
          description:
            "Optimise each instrument separately and return a per-pair profile patch. Prefer this: " +
            "one grid fitted across six pairs finds the compromise that suits none of them.",
        },
        apply: {
          type: "boolean",
          description: "With perInstrument, write the winning profiles to the parameter file.",
        },
      },
    },
  },
  {
    name: "oanda_trade_consensus",
    description:
      "Should this trade be taken? Scores one instrument across several timeframes (default " +
      "M15/H1/H4) and all enabled strategies, and returns a signed −100..+100 conviction score, " +
      "the percentage of timeframes agreeing, a take/lean/wait/avoid verdict, every caution, and " +
      "the sized order it would imply. Higher timeframes carry more weight, so a signal fighting " +
      "the dominant trend is graded down rather than hidden. Use before any discretionary entry.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        timeframes: {
          type: "array",
          items: { type: "string" },
          description: "Coarsest last, e.g. [\"M15\",\"H1\",\"H4\"]. Defaults to params.consensus.timeframes.",
        },
        includeSizing: { type: "boolean", description: "Attach the risk-based size (default true)." },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_rank_instruments",
    description:
      "Which pairs are worth trading, and with which strategy. Backtests each strategy on each " +
      "pair SEPARATELY out of sample, ranks by expectancy scaled for sample size, and returns a " +
      "ready-to-apply per-pair profile patch. This is the tool that answers 'do different pairs " +
      "want different strategies' with measurements: a pair whose only positive strategy is " +
      "mean reversion is told to run mean reversion alone, and a pair with no durable edge is " +
      "told to be disabled.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: { type: "array", items: { type: "string" } },
        granularity: { type: "string" },
        candles: { type: "number", description: "History per instrument. Default 6000, max 20000." },
        trainFraction: { type: "number", description: "In-sample share, default 0.6." },
        minTrades: { type: "number", description: "Out-of-sample trades required to count. Default 12." },
        apply: {
          type: "boolean",
          description:
            "Write the suggested profiles to the shared parameter file. Default false — read the " +
            "verdicts first.",
        },
      },
    },
  },
  {
    name: "oanda_session_clock",
    description:
      "Session and timezone state right now: which of Sydney/Tokyo/London/New York are quoting, " +
      "whether they overlap, whether the market is shut for the weekend, whether it is inside the " +
      "17:00 New York rollover window, and per-instrument tradeability with a liquidity score. " +
      "All resolved through the timezone database, so DST is correct in every hemisphere.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: {
          type: "array",
          items: { type: "string" },
          description: "Defaults to the watchlist.",
        },
        at: { type: "string", description: "ISO timestamp to evaluate instead of now." },
      },
    },
  },
  {
    name: "oanda_fifo_check",
    description:
      "FIFO / no-hedge compliance for a US OANDA account. Says whether a proposed entry would " +
      "open a position or silently REDUCE an existing one (US accounts cannot hedge), and lists " +
      "the only legal close order for the instrument's open trades (oldest first). Use before " +
      "reversing a position or closing a specific trade ID.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        direction: { type: "string", enum: ["long", "short"], description: "Omit to only inspect closes." },
        tradeID: { type: "string", description: "Check whether closing this specific trade is legal." },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_carry_check",
    description:
      "Financing (carry) and the 17:00 New York rollover charge. OANDA charges financing on the " +
      "FULL NOTIONAL of every position open at 17:00 New York, and one weekday — Wednesday for " +
      "most FX — charges THREE days at once to cover weekend value dates. That tripled charge is " +
      "the 'extra cost after 5pm' people notice. Returns the per-day and next-rollover cost for a " +
      "proposed trade or for every open position, expressed as a fraction of risk, plus how long " +
      "until the next rollover and whether it is the tripled one.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string", description: "Omit to report on all open positions." },
        direction: { type: "string", enum: ["long", "short"] },
        units: { type: "number", description: "Units for a proposed trade. Defaults to the risk-based size." },
        riskAmount: {
          type: "number",
          description: "Account-currency risk, so the cost is expressed as a fraction of it.",
        },
        at: { type: "string", description: "ISO timestamp to evaluate instead of now." },
      },
    },
  },
  {
    name: "oanda_trade_review",
    description:
      "Post-mortem on real closed trades from the account's transaction history: win rate, " +
      "expectancy, financing paid, and the split of exits between stop-loss and take-profit, " +
      "grouped by instrument. Answers 'what is actually working' rather than 'what backtested'.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Closed trades to analyse. Default 100, max 500." },
      },
    },
  },
  {
    name: "oanda_open_trade_review",
    description:
      "Review trades that are OPEN right now: entry, current price, unrealised P/L, how far " +
      "each one is from its own stop and target, progress in R, how long it has been held, " +
      "financing accrued, and what the brackets imply if price reaches either side. Use this " +
      "before deciding to hold, trim, move a stop or close. For closed-trade post-mortems use " +
      "oanda_trade_review instead.",
    inputSchema: {
      type: "object",
      properties: {
        tradeID: { type: "string", description: "One trade. Omit for every open trade." },
        instrument: { type: "string", description: "Limit to one instrument, e.g. EUR_USD." },
      },
    },
  },
  {
    name: "oanda_trade_roi",
    description:
      "Expected return on a trade — open or proposed — priced three ways: the arithmetic " +
      "reward-to-risk the brackets imply, the expectancy of those brackets at this account's " +
      "own historical hit rate for the instrument, and the cost drag from spread and " +
      "financing. Answers 'is this worth the risk' rather than 'will it win'.",
    inputSchema: {
      type: "object",
      properties: {
        tradeID: { type: "string", description: "Price an open trade from its live brackets." },
        instrument: { type: "string", description: "For a proposed trade." },
        direction: { type: "string", enum: ["long", "short"] },
        entryPrice: { type: "number", description: "Defaults to the current mid." },
        stopLossPrice: { type: "number" },
        takeProfitPrice: { type: "number" },
        units: { type: "number", description: "Defaults to the risk-based size." },
        holdDays: { type: "number", description: "Expected holding period for the carry estimate. Default 3." },
        winRatePct: {
          type: "number",
          description: "Override the historical hit rate, e.g. from a backtest.",
        },
      },
    },
  },
  {
    name: "oanda_pretrade_research",
    description:
      "Web research before entering: near-term commentary on the pair, scheduled high-impact " +
      "releases for both currencies, and central-bank/rate expectations on each side — with " +
      "the source URLs and excerpts. Pair it with oanda_market_scan (the technical side) and " +
      "oanda_session_clock (timing) before a live order. Returns evidence, never a verdict.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string", description: "e.g. EUR_USD or XAU_USD." },
        question: { type: "string", description: "An extra angle to search, in your own words." },
        readPages: {
          type: "number",
          description: "Pages to read in full, 0-6. Default 3. Use 0 for a fast headline sweep.",
        },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_close_trade",
    description:
      "Close ONE open trade by its trade ID, fully or partially, at market. Use when several " +
      "trades share an instrument and only one should go; oanda_remove_position closes the " +
      "whole net position instead. Realises that trade's P/L immediately.",
    inputSchema: {
      type: "object",
      properties: {
        tradeID: { type: "string" },
        units: { type: "number", description: "Units to close. Omit to close all of it." },
        confirm: { type: "boolean", description: "Must be true." },
      },
      required: ["tradeID"],
    },
  },
  {
    name: "oanda_get_params",
    description:
      "Read the shared strategy parameter file that both this server and the OandaVisualBot app " +
      "use, plus its path and any validation problems.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oanda_update_params",
    description:
      "Patch the shared strategy parameter file the live bot reads each cycle. Rejects unsafe " +
      "values (risk per trade above 2% of NAV, stops inside noise, and so on). Back a change " +
      "with oanda_backtest output — this tool changes what the running bot does.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: 'Partial parameters, e.g. {"risk":{"riskPerTradePct":0.35}}.',
        },
        reset: { type: "boolean", description: "Restore the built-in defaults instead of patching." },
        note: { type: "string", description: "Why this change was made; stored in the file." },
      },
    },
  },
  {
    name: "oanda_create_order",
    description:
      "Place a risk-sized market or limit order with a stop loss and take profit attached. Size " +
      "comes from the risk budget unless units are given explicitly. Refuses when the server is " +
      "read-only, when the spread filter fails, when exposure or margin caps would break, or " +
      "when confirm is not true. This spends real money.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        direction: { type: "string", enum: ["long", "short"] },
        type: { type: "string", enum: ["MARKET", "LIMIT"], description: "Default MARKET." },
        limitPrice: { type: "number", description: "Required for LIMIT." },
        units: { type: "number", description: "Absolute units. Omit to size from risk (recommended)." },
        stopPips: { type: "number", description: "Stop distance in pips. Omit to use the ATR multiple." },
        takeProfitR: { type: "number", description: "Target as a multiple of the stop. Default: params." },
        riskPercent: { type: "number", description: "Override params risk.riskPerTradePct." },
        confirm: { type: "boolean", description: "Must be true. Without it the order is only priced." },
      },
      required: ["instrument", "direction"],
    },
  },
  {
    name: "oanda_update_trade_brackets",
    description:
      "Move an open trade's stop loss, take profit or trailing stop. Use to lock in a break-even " +
      "stop once a trade is in front, which is the single largest lever on expectancy.",
    inputSchema: {
      type: "object",
      properties: {
        tradeID: { type: "string" },
        stopLossPrice: { type: "number" },
        takeProfitPrice: { type: "number" },
        trailingDistancePips: { type: "number" },
        confirm: { type: "boolean", description: "Must be true." },
      },
      required: ["tradeID"],
    },
  },
  {
    name: "oanda_remove_position",
    description:
      "Close an open position, fully or partially. Realises P/L immediately at market.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        side: { type: "string", enum: ["long", "short", "both"], description: "Default both." },
        units: { type: "number", description: "Units to close. Omit for the whole position." },
        confirm: { type: "boolean", description: "Must be true." },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_list_instruments",
    description:
      "Every instrument THIS account is actually permitted to trade, straight from OANDA — so on " +
      "a US account the list is already limited to what US regulation allows, with no guessing. " +
      "Each one is priced live: spread, ATR, spread-as-a-fraction-of-ATR, margin rate, financing " +
      "both ways, and a 0-100 tradeability score. Also says which are on your watchlist, which " +
      "are worth adding, and which are worth dropping. Use before choosing pairs.",
    inputSchema: {
      type: "object",
      properties: {
        types: {
          type: "array",
          items: { type: "string" },
          description: 'Filter by OANDA type, e.g. ["CURRENCY"] or ["CURRENCY","METAL"]. Default: all.',
        },
        granularity: { type: "string", description: "Candle size for the ATR. Default: from params." },
        limit: { type: "number", description: "Price only the first N. Default: all of them." },
        watchedOnly: { type: "boolean", description: "Only describe the current watchlist." },
      },
    },
  },
  {
    name: "oanda_update_watchlist",
    description:
      "Choose which pairs are traded. Set the whole list, or add and remove individually. " +
      "Instruments are validated against what the account can actually trade, so a typo is " +
      "refused rather than silently ignored. Profiles for removed pairs are kept, not deleted, " +
      "so putting a pair back restores its tuning.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: { type: "array", items: { type: "string" }, description: "Replace the whole watchlist." },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
        note: { type: "string", description: "Why; stored in the parameter file." },
      },
    },
  },
  {
    name: "oanda_update_pair_strategy",
    description:
      "Change ONE pair's strategy, timeframe, stop/target or risk without touching any other " +
      "pair. This writes that pair's profile only — every other instrument keeps its own " +
      "settings exactly as they were. Several strategies can run on the same pair at once; " +
      "`selection` decides which one wins when more than one fires.",
    inputSchema: {
      type: "object",
      properties: {
        instrument: { type: "string" },
        strategies: {
          type: "array",
          items: { type: "string", enum: ["trend", "meanReversion", "breakout"] },
          description:
            "The strategies this pair should run. Pass several to run several. Omit to leave unchanged.",
        },
        selection: {
          type: "string",
          enum: ["precedence", "conviction", "agreement"],
          description:
            "How to pick when several fire: fixed order, strongest evidence, or require two to agree.",
        },
        granularity: { type: "string", description: "Candle size for this pair only, e.g. H1." },
        stopAtrMultiple: { type: "number" },
        takeProfitR: { type: "number" },
        riskMultiplier: {
          type: "number",
          description: "Scale this pair's risk against the global budget. 0.25-1.5.",
        },
        disabled: { type: "boolean", description: "Stop trading this pair, keeping its settings." },
        clear: { type: "boolean", description: "Delete this pair's profile so it follows the globals again." },
        note: { type: "string", description: "Why — ideally the backtest number that justified it." },
      },
      required: ["instrument"],
    },
  },
  {
    name: "oanda_update_appetite",
    description:
      "The passive↔aggressive dial: conservative, balanced, aggressive or max. Each one moves " +
      "risk per trade, the open-risk ceiling, the daily loss stop, stop/target distances, the " +
      "spread tolerance and the consensus threshold together, because moving one alone just " +
      "means the next trade is refused. Call with no level to see what each one does.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["conservative", "balanced", "aggressive", "max"] },
        confirm: {
          type: "boolean",
          description: "Required for aggressive and max, which materially increase drawdown.",
        },
      },
    },
  },
  {
    name: "oanda_daily_plan",
    description:
      "The highest-return plan available right now, with money attached. Scans the watchlist for " +
      "live signals, measures what each pair+strategy has actually been worth out of sample, " +
      "prices every candidate's expected value in account currency, then fills the remaining " +
      "risk budget best-first. Returns the ranked opportunities, the trades worth taking, and " +
      "an expected gain with its best and worst case. This is the tool behind /roi and /money.",
    inputSchema: {
      type: "object",
      properties: {
        instruments: { type: "array", items: { type: "string" }, description: "Default: the watchlist." },
        measure: {
          type: "boolean",
          description:
            "Backtest each pair+strategy to price the plan on measured hit rates (default true). " +
            "False is much faster but prices everything on priors.",
        },
        candles: { type: "number", description: "History depth for the measurement. Default 3000." },
      },
    },
  },
  {
    name: "oanda_performance_report",
    description:
      "How the day or the week actually went, per pair and per strategy, ending in verdicts: " +
      "keep, adjust, stop or watch — each one hedged by sample size, because a week of trading " +
      "rarely proves anything. Includes financing paid, the exit breakdown, what is still open, " +
      "and a concrete action list. This is the tool behind /tradereport.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week", "month", "custom"],
          description: "Default today.",
        },
        from: { type: "string", description: "ISO date, for period=custom." },
        to: { type: "string", description: "ISO date, for period=custom." },
        count: { type: "number", description: "Closed trades to pull before filtering. Default 300, max 500." },
      },
    },
  },
  {
    name: "oanda_update_autopilot",
    description:
      "Configure the scheduled trader: on or off, managed (protects open trades, queues new " +
      "entries) or full (opens trades unattended), the daily trade budget, the loss stop, the " +
      "break-even and trailing rules, and the arming window. Full mode additionally requires " +
      "arming for a bounded number of hours, and live money requires allowLive on top of that. " +
      "Call with no arguments to see the current state and exactly why it is or is not allowed to act.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        mode: { type: "string", enum: ["managed", "full"] },
        armForHours: {
          type: "number",
          description:
            "Arm full mode for this many hours from now, max 24. Arming always expires; there is " +
            "no permanently-armed state.",
        },
        disarm: { type: "boolean", description: "Expire the arming immediately." },
        allowLive: { type: "boolean", description: "Permit unattended trading on a LIVE account." },
        maxNewTradesPerDay: { type: "number" },
        maxActionsPerRun: { type: "number" },
        dailyLossStopPct: { type: "number" },
        breakEvenAtR: { type: "number" },
        trailAtrMultiple: { type: "number" },
        closeOnSignalInvalidation: { type: "boolean" },
        minConsensusScore: { type: "number" },
        confirm: { type: "boolean", description: "Required to enable full mode or allowLive." },
      },
    },
  },
  {
    name: "oanda_autopilot_run",
    description:
      "One autopilot cycle, intended for a cron job. Always, in order: re-check every open trade " +
      "and move stops to break-even, trail winners, and close positions whose signal has " +
      "inverted. Then, only in full mode with valid arming, open the trades the daily plan " +
      "recommends and place their brackets. Returns everything it did and everything it " +
      "deliberately did not do, with reasons. Safe to run while locked or disarmed — it reports " +
      "the plan instead of acting on it.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "Report the actions without sending any of them. Default false.",
        },
        manageOnly: { type: "boolean", description: "Skip the new-entry phase even in full mode." },
      },
    },
  },
  {
    name: "oanda_remove_pending_orders",
    description:
      "Cancel pending (unfilled) orders — one by ID, or every pending order on the account.",
    inputSchema: {
      type: "object",
      properties: {
        orderID: { type: "string", description: "Omit with all=true to cancel everything pending." },
        all: { type: "boolean" },
        confirm: { type: "boolean", description: "Must be true." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pipOf(pipLocation: number): number {
  return Math.pow(10, pipLocation);
}

/**
 * Risk currently at stake, from each open trade's distance to its own stop.
 *
 * Trades with no stop are counted as unbounded and named: an unstopped position
 * is the one thing that can undo any amount of careful sizing elsewhere.
 */
async function openRisk(trades: OpenTrade[], nav: number) {
  let atRisk = 0;
  const unstopped: string[] = [];
  const perCurrency = new Map<string, number>();

  for (const trade of trades) {
    for (const currency of currenciesOf(trade.instrument)) {
      perCurrency.set(currency, (perCurrency.get(currency) ?? 0) + 1);
    }
    if (trade.stopLossPrice === null) {
      unstopped.push(`${trade.instrument} (trade ${trade.id})`);
      continue;
    }
    const distance = Math.abs(trade.price - trade.stopLossPrice);
    const spec = await api.instrumentSpec(trade.instrument);
    const rate = trade.instrument.endsWith("_USD") ? 1 : 1;
    atRisk += Math.abs(trade.currentUnits) * distance * rate;
    void spec;
  }

  return {
    openRiskAmount: Number(atRisk.toFixed(2)),
    openRiskPct: nav > 0 ? Number(((atRisk / nav) * 100).toFixed(2)) : 0,
    unstoppedTrades: unstopped,
    tradesPerCurrency: Object.fromEntries(perCurrency),
  };
}

async function buildSeries(
  instruments: string[],
  granularity: string,
  count: number,
  params: StrategyParams
): Promise<{ series: InstrumentSeries[]; notes: string[] }> {
  const series: InstrumentSeries[] = [];
  const notes: string[] = [];

  // One live quote per instrument gives a real spread to charge in the test;
  // outside market hours OANDA still returns the last spread, which is closer to
  // the truth than any constant we could invent.
  let quotes: Awaited<ReturnType<typeof api.pricing>> = [];
  try {
    quotes = await api.pricing(instruments);
  } catch (error) {
    notes.push(
      `Live pricing unavailable (${(error as Error).message}); spread estimated as 8% of ATR.`
    );
  }

  for (const instrument of instruments) {
    const spec = await api.instrumentSpec(instrument);
    const candles = await api.candleHistory(instrument, granularity, count);
    const complete = candles.filter((candle) => candle.complete);
    const quote = quotes.find((q) => q.instrument === instrument);
    const atrSeries = atr(complete, params.entry.atrPeriod);
    const typicalAtr = last(atrSeries);
    const spread =
      quote && quote.spread > 0
        ? quote.spread
        : Number.isFinite(typicalAtr)
          ? typicalAtr * 0.08
          : pipOf(spec.pipLocation) * 1.5;

    series.push({ instrument, spec, candles: complete, spread });
  }

  return { series, notes };
}

/** Candles for one instrument across several timeframes, primary first. */
async function multiTimeframeCandles(
  instrument: string,
  timeframes: string[],
  params: StrategyParams
): Promise<Array<{ timeframe: string; candles: Awaited<ReturnType<typeof api.candles>> }>> {
  const need = Math.max(warmupBars(params) + 30, params.trend.smaSlow + 40);
  const out: Array<{ timeframe: string; candles: Awaited<ReturnType<typeof api.candles>> }> = [];
  for (const timeframe of timeframes) {
    out.push({ timeframe, candles: await api.candles(instrument, timeframe, need) });
  }
  return out;
}

/** Consensus for one instrument using its own resolved profile. */
async function consensusFor(
  instrument: string,
  globalParams: StrategyParams,
  timeframesOverride?: string[]
) {
  const params = resolveParams(globalParams, instrument);
  const spec = await api.instrumentSpec(instrument);
  const timeframes =
    timeframesOverride?.length
      ? timeframesOverride
      : // The primary timeframe is always this instrument's own granularity, so a
        // profile that trades H1 is not scored on M15 structure.
        [params.granularity, ...params.consensus.timeframes.filter((t) => t !== params.granularity)];

  const byTimeframe = await multiTimeframeCandles(instrument, timeframes, params);
  return {
    params,
    spec,
    consensus: buildConsensus({
      instrument,
      pipSize: pipOf(spec.pipLocation),
      params,
      byTimeframe,
    }),
  };
}

const DEFAULT_GRID = {
  entry: {
    stopAtrMultiple: [1, 1.5, 2, 2.5],
    takeProfitR: [1.5, 2, 3],
    trailAfterR: [0, 1],
  },
  trend: { adxMin: [15, 20, 25] },
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** Tools that move money. Refused outright in read-only mode. */
const ORDER_TOOLS = new Set([
  "oanda_create_order",
  "oanda_update_trade_brackets",
  "oanda_remove_position",
  "oanda_remove_pending_orders",
  "oanda_close_trade",
]);

async function handle(name: string, args: Record<string, any>): Promise<unknown> {
  const params = loadParams();

  // Fail before the first network call. OandaApi refuses these too, but only at
  // the moment of submission — several round-trips in, with a confusing error if
  // anything else goes wrong first. A locked server should say so immediately.
  if (readOnly && ORDER_TOOLS.has(name)) {
    return {
      refused: true,
      reason: "read-only",
      message:
        `${name} is unavailable: the oanda-trading server is locked. Unlock it with the 🔒 ` +
        `toggle next to "oanda-trading" in Settings → Connections. Analysis tools ` +
        `(oanda_status, oanda_market_scan, oanda_position_size, oanda_backtest, oanda_optimize, ` +
        `oanda_trade_review, oanda_open_trade_review, oanda_trade_roi, oanda_pretrade_research) ` +
        `all work while locked — use those to produce the plan first.`,
    };
  }

  switch (name) {
    // -- Reads ------------------------------------------------------------
    case "oanda_status": {
      const [summary, trades, pending] = await Promise.all([
        api.accountSummary(),
        api.openTrades(),
        api.pendingOrders(),
      ]);
      const risk = await openRisk(trades, summary.nav);
      const clock = sessionState();
      const marginUtilPct =
        summary.nav > 0 ? Number(((summary.marginUsed / summary.nav) * 100).toFixed(2)) : 0;

      return {
        environment,
        tradingEnabled: api.tradingEnabled,
        readOnlyNote: api.tradingEnabled
          ? "Order tools are live. Every one still requires confirm: true."
          : "Read-only: order tools will refuse. Unlock with the 🔒 toggle in Settings → Connections.",
        account: summary,
        risk: {
          ...risk,
          maxOpenRiskPct: params.risk.maxOpenRiskPct,
          riskPerTradePct: params.risk.riskPerTradePct,
          marginUtilizationPct: marginUtilPct,
          maxMarginUtilizationPct: params.risk.maxMarginUtilizationPct,
          headroomPct: Number((params.risk.maxOpenRiskPct - risk.openRiskPct).toFixed(2)),
        },
        openTrades: trades,
        pendingOrders: pending,
        sessionClock: {
          openSessions: clock.open,
          overlap: clock.overlap,
          weekendClosed: clock.weekendClosed,
          rolloverWindow: clock.rolloverWindow,
          newYorkTime: clock.newYorkTime,
          notes: clock.notes,
        },
        financing: await (async () => {
          const specs = new Map<string, Awaited<ReturnType<typeof api.instrumentSpec>>>();
          for (const instrument of new Set(trades.map((trade) => trade.instrument))) {
            specs.set(instrument, await api.instrumentSpec(instrument));
          }
          const book = portfolioCarry(trades, specs, new Date(), summary.currency);
          const reference = specs.values().next().value;
          return {
            totalAtNextRollover: book.totalAtNextRollover,
            totalPerDay: book.totalPerDay,
            tripleRolloverAhead: book.tripleRolloverAhead,
            nextRollover: reference ? nextRollover(reference) : null,
            summary: book.summary,
          };
        })(),
        compliance: {
          fifoEnabled: params.fifo.enabled,
          allowReducingOrders: params.fifo.allowReducingOrders,
          note: params.fifo.enabled
            ? "US FIFO mode: no hedging, one trade per instrument, closes are oldest-first."
            : "FIFO mode is OFF. Enable it for a US-regulated account or expect FIFO_VIOLATION rejections.",
          instrumentsWithOpposingRisk: [
            ...new Set(trades.map((trade) => trade.instrument)),
          ].filter((instrument) => {
            const net = netPosition(instrument, trades);
            return net !== 0 && trades.filter((t) => t.instrument === instrument).length > 1;
          }),
        },
        params: {
          path: paramsPath(),
          granularity: params.granularity,
          instruments: params.instruments,
          disabledInstruments: params.instruments.filter(
            (instrument) => params.profiles?.[instrument]?.disabled
          ),
          instrumentsWithProfiles: Object.keys(params.profiles ?? {}),
          globalStrategies: [
            params.trend.enabled ? "trend" : null,
            params.meanReversion.enabled ? "meanReversion" : null,
            params.breakout.enabled ? "breakout" : null,
          ].filter(Boolean),
          consensus: params.consensus,
          partialTakeProfitFraction: params.entry.partialTakeProfitFraction,
        },
        advice: Object.keys(params.profiles ?? {}).length
          ? undefined
          : "No per-pair profiles configured: every pair is scanned with identical parameters. " +
            "oanda_rank_instruments will measure which strategy each pair actually trades well.",
      };
    }

    case "oanda_market_scan": {
      const instruments: string[] = args.instruments?.length
        ? args.instruments
        : activeInstruments(params);
      const includeNoSignal = args.includeNoSignal !== false;
      const summary = await api.accountSummary();
      const openTrades = await api.openTrades();
      const risk = await openRisk(openTrades, summary.nav);
      const quotes = await api.pricing(instruments);
      const clock = sessionState();

      const rows: any[] = [];
      for (const instrument of instruments) {
        // Each instrument is scanned with ITS OWN resolved parameters. Scanning
        // every pair with the globals is what made per-pair tuning pointless.
        const perPair = resolveParams(params, instrument);
        const granularity = args.granularity ?? perPair.granularity;
        const spec = await api.instrumentSpec(instrument);
        const need = warmupBars(perPair) + 20;

        const candles = (await api.candles(instrument, granularity, need + 5)).filter(
          (candle) => candle.complete
        );
        if (candles.length < need) {
          rows.push({ instrument, skipped: `Only ${candles.length}/${need} candles available.` });
          continue;
        }

        const frame = computeIndicators(candles, perPair);
        const i = candles.length - 1;
        const choice = selectSignal(candles, frame, i, perPair);
        const signal = choice.signal;
        const quote = quotes.find((q) => q.instrument === instrument);
        const currentAtr = frame.atr[i];
        const cost = quote
          ? checkCost(quote.spread, currentAtr, spec, perPair)
          : { ok: false, reason: "No live quote.", spreadPips: 0, atrPips: 0, spreadAtrRatio: 0 };
        const session = evaluateSession(instrument, new Date(), {
          enforce: perPair.sessions.enforce && perPair.enforceLiquidityWindow,
          blockRollover: perPair.sessions.blockRollover,
        });
        const alreadyOpen = openTrades.filter((t) => t.instrument === instrument).length;
        const pip = pipOf(spec.pipLocation);

        let sizing = null;
        let consensus: Awaited<ReturnType<typeof consensusFor>>["consensus"] | null = null;
        const blockers: string[] = [];

        if (signal) {
          if (!cost.ok) blockers.push(cost.reason);
          if (!session.tradeable) blockers.push(session.reason);

          // FIFO: on a US account an opposite-direction order flattens rather
          // than hedges, so this must be checked before size, not after.
          const fifo = checkFifoEntry(instrument, signal.direction, openTrades, perPair.fifo);
          if (!fifo.allowed) blockers.push(...fifo.reasons);

          if (alreadyOpen >= perPair.risk.maxOpenTradesPerInstrument) {
            blockers.push(`Already holding ${alreadyOpen} trade(s) in ${instrument}.`);
          }
          for (const currency of currenciesOf(instrument)) {
            const held = risk.tradesPerCurrency[currency] ?? 0;
            if (held >= perPair.risk.maxTradesPerCurrency) {
              blockers.push(
                `${held} open trade(s) already expose ${currency} (cap ${perPair.risk.maxTradesPerCurrency}).`
              );
            }
          }
          if (risk.openRiskPct + perPair.risk.riskPerTradePct > perPair.risk.maxOpenRiskPct) {
            blockers.push(
              `Open risk ${risk.openRiskPct}% + ${perPair.risk.riskPerTradePct}% would exceed the ` +
                `${perPair.risk.maxOpenRiskPct}% ceiling.`
            );
          }

          // Consensus is only worth its API calls once a signal exists.
          if (perPair.consensus.enabled) {
            consensus = (await consensusFor(instrument, params)).consensus;
            if (consensus.direction !== signal.direction) {
              blockers.push(
                `Consensus points ${consensus.direction} (score ${consensus.score}) against a ` +
                  `${signal.direction} signal.`
              );
            } else if (Math.abs(consensus.score) < perPair.consensus.minScore) {
              blockers.push(
                `Consensus score ${consensus.score} is below the ${perPair.consensus.minScore} minimum.`
              );
            }
            if (
              perPair.consensus.requireHigherTimeframeAlignment &&
              !consensus.higherTimeframeAligned
            ) {
              blockers.push("Higher timeframe disagrees with this direction.");
            }
          }

          const entryPrice =
            quote ? (signal.direction === "long" ? quote.ask : quote.bid) : candles[i].close;

          // Size scales with session quality when enabled: a thin-book entry is
          // taken smaller rather than being all-or-nothing.
          const liquidityScale = perPair.sessions.scaleSizeByLiquidity
            ? Math.min(1, session.liquidityScore)
            : 1;

          sizing = sizePosition({
            nav: summary.nav,
            riskPerTradePct: perPair.risk.riskPerTradePct * liquidityScale,
            stopDistance: signal.stopDistance,
            spec,
            direction: signal.direction,
            quoteToAccountRate: 1,
            marginAvailable: summary.marginAvailable,
            entryPrice,
            maxMarginUtilizationPct: perPair.risk.maxMarginUtilizationPct,
          });
          if (sizing.units <= 0) blockers.push(...sizing.notes);
        }

        const profile = params.profiles?.[instrument];
        const row = {
          instrument,
          profile: profile
            ? {
                granularity: perPair.granularity,
                strategies: [
                  perPair.trend.enabled ? "trend" : null,
                  perPair.meanReversion.enabled ? "meanReversion" : null,
                  perPair.breakout.enabled ? "breakout" : null,
                ].filter(Boolean),
                riskMultiplier: profile.riskMultiplier ?? 1,
                notes: profile.notes,
              }
            : "global parameters (no per-pair profile — run oanda_rank_instruments)",
          price: quote
            ? {
                bid: quote.bid,
                ask: quote.ask,
                spreadPips: Number(quote.spreadPips.toFixed(2)),
                tradeable: quote.tradeable,
              }
            : null,
          indicators: {
            atrPips: Number((currentAtr / pip).toFixed(1)),
            adx: Number((frame.adx[i] || 0).toFixed(1)),
            rsi: Number((frame.rsi[i] || 0).toFixed(1)),
            smaFast: frame.smaFast[i],
            smaSlow: frame.smaSlow[i],
            close: candles[i].close,
          },
          session: {
            tradeable: session.tradeable,
            reason: session.reason,
            liquidityScore: session.liquidityScore,
            preferredSessions: session.preferred,
          },
          netPosition: netPosition(instrument, openTrades),
          signal: signal
            ? {
                direction: signal.direction,
                strategy: signal.strategy,
                reason: signal.reason,
                stopPips: Number((signal.stopDistance / pip).toFixed(1)),
                targetPips: Number((signal.takeProfitDistance / pip).toFixed(1)),
              }
            : null,
          // Every strategy's opinion, not only the one that won. A pair running
          // three strategies should be able to show all three disagreeing.
          strategyVotes: {
            mode: choice.selection,
            why: choice.reason,
            candidates: choice.candidates.map((c) => ({
              strategy: c.signal.strategy,
              direction: c.signal.direction,
              conviction: Number(c.conviction.toFixed(0)),
              reason: c.signal.reason,
            })),
          },
          consensus: consensus
            ? {
                score: consensus.score,
                direction: consensus.direction,
                agreement: consensus.agreement,
                verdict: consensus.verdict,
                cautions: consensus.cautions,
              }
            : null,
          costFilter: cost,
          openTradesHere: alreadyOpen,
          sizing: sizing
            ? {
                units: sizing.units,
                signedUnits: sizing.signedUnits,
                riskBudget: Number(sizing.riskAmount.toFixed(2)),
                riskIfStopped: Number(sizing.actualRiskAmount.toFixed(2)),
                stopPips: Number(sizing.stopPips.toFixed(1)),
                notes: sizing.notes,
              }
            : null,
          actionable: Boolean(signal) && blockers.length === 0,
          blockers,
        };

        if (row.signal || includeNoSignal) rows.push(row);
      }

      const actionable = rows.filter((row) => row.actionable);
      const unprofiled = rows.filter((row) => typeof row.profile === "string").length;

      return {
        asOf: new Date().toISOString(),
        sessionClock: {
          openSessions: clock.open,
          overlap: clock.overlap,
          weekendClosed: clock.weekendClosed,
          rolloverWindow: clock.rolloverWindow,
          newYorkTime: clock.newYorkTime,
          notes: clock.notes,
        },
        accountNav: summary.nav,
        openRiskPct: risk.openRiskPct,
        fifoEnabled: params.fifo.enabled,
        actionableCount: actionable.length,
        summary: actionable.length
          ? actionable
              .map(
                (row) =>
                  `${row.instrument}: ${row.signal.direction} (${row.signal.strategy}), ` +
                  `${row.sizing.units} units, risking ${row.sizing.riskIfStopped}` +
                  (row.consensus ? `, consensus ${row.consensus.score}` : "")
              )
              .join("; ")
          : "No actionable setups: see each row's blockers.",
        advice:
          unprofiled === rows.length && rows.length > 1
            ? "No pair has its own profile yet, so every pair is being scanned with identical " +
              "parameters. Run oanda_rank_instruments to find which strategy each pair actually " +
              "trades well."
            : undefined,
        instruments: rows,
      };
    }

    case "oanda_trade_consensus": {
      const instrument: string = args.instrument;
      const { params: perPair, spec, consensus } = await consensusFor(
        instrument,
        params,
        args.timeframes
      );
      const summary = await api.accountSummary();
      const openTrades = await api.openTrades();
      const quote = (await api.pricing([instrument]))[0];
      const session = evaluateSession(instrument, new Date(), {
        enforce: perPair.sessions.enforce && perPair.enforceLiquidityWindow,
        blockRollover: perPair.sessions.blockRollover,
      });
      const pip = pipOf(spec.pipLocation);

      // Conviction is not permission: gather the practical blockers too, so a
      // "take" verdict that cannot be acted on says why.
      const gates: string[] = [];
      if (!session.tradeable) gates.push(session.reason);
      if (consensus.direction !== "none") {
        const fifo = checkFifoEntry(instrument, consensus.direction, openTrades, perPair.fifo);
        if (!fifo.allowed) gates.push(...fifo.reasons);
      }
      if (quote) {
        const currentAtr = consensus.timeframes[0]
          ? consensus.timeframes[0].atrPips * pip
          : 0;
        const cost = checkCost(quote.spread, currentAtr, spec, perPair);
        if (!cost.ok) gates.push(cost.reason);
      }

      let sizing = null;
      if (args.includeSizing !== false && consensus.direction !== "none" && consensus.primarySignal) {
        const entryPrice = quote
          ? consensus.direction === "long"
            ? quote.ask
            : quote.bid
          : consensus.timeframes[0]?.close ?? 0;
        const scale = perPair.sessions.scaleSizeByLiquidity
          ? Math.min(1, session.liquidityScore)
          : 1;
        const result = sizePosition({
          nav: summary.nav,
          riskPerTradePct: perPair.risk.riskPerTradePct * scale,
          stopDistance: consensus.primarySignal.stopDistance,
          spec,
          direction: consensus.direction,
          quoteToAccountRate: 1,
          marginAvailable: summary.marginAvailable,
          entryPrice,
          maxMarginUtilizationPct: perPair.risk.maxMarginUtilizationPct,
        });
        sizing = {
          units: result.units,
          signedUnits: result.signedUnits,
          stopPips: Number(result.stopPips.toFixed(1)),
          riskIfStopped: Number(result.actualRiskAmount.toFixed(2)),
          entryPrice,
          stopPrice:
            consensus.direction === "long"
              ? entryPrice - result.stopDistance
              : entryPrice + result.stopDistance,
          targetPrice:
            consensus.direction === "long"
              ? entryPrice + result.stopDistance * perPair.entry.takeProfitR
              : entryPrice - result.stopDistance * perPair.entry.takeProfitR,
          partialTakeProfitAt:
            perPair.entry.partialTakeProfitFraction > 0
              ? consensus.direction === "long"
                ? entryPrice + result.stopDistance
                : entryPrice - result.stopDistance
              : null,
          notes: result.notes,
        };
      }

      return {
        ...consensus,
        granularity: perPair.granularity,
        minScoreRequired: perPair.consensus.minScore,
        session: {
          tradeable: session.tradeable,
          reason: session.reason,
          liquidityScore: session.liquidityScore,
        },
        blockingGates: gates,
        finalRecommendation:
          consensus.verdict === "take" && gates.length === 0
            ? `Take the ${consensus.direction}. ${consensus.summary}`
            : consensus.verdict === "take"
              ? `Setup is good but blocked right now: ${gates.join(" ")}`
              : consensus.summary,
        sizing,
      };
    }

    case "oanda_session_clock": {
      const instruments: string[] = args.instruments?.length
        ? args.instruments
        : activeInstruments(params);
      const at = args.at ? new Date(args.at) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error(`"${args.at}" is not a valid ISO timestamp.`);

      const state = sessionState(at);
      return {
        at: at.toISOString(),
        newYorkTime: state.newYorkTime,
        openSessions: state.open,
        overlap: state.overlap,
        weekendClosed: state.weekendClosed,
        rolloverWindow: state.rolloverWindow,
        notes: state.notes,
        schedule: sessionSchedule(at),
        instruments: instruments.map((instrument) => {
          const perPair = resolveParams(params, instrument);
          const verdict = evaluateSession(instrument, at, {
            enforce: perPair.sessions.enforce && perPair.enforceLiquidityWindow,
            blockRollover: perPair.sessions.blockRollover,
          });
          return {
            instrument,
            tradeable: verdict.tradeable,
            reason: verdict.reason,
            liquidityScore: verdict.liquidityScore,
            preferredSessions: verdict.preferred,
          };
        }),
      };
    }

    case "oanda_carry_check": {
      const at = args.at ? new Date(args.at) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error(`"${args.at}" is not a valid ISO timestamp.`);
      const openTrades = await api.openTrades();

      // No instrument named: report the whole book's daily drag.
      if (!args.instrument) {
        const specs = new Map<string, Awaited<ReturnType<typeof api.instrumentSpec>>>();
        for (const instrument of new Set(openTrades.map((trade) => trade.instrument))) {
          specs.set(instrument, await api.instrumentSpec(instrument));
        }
        const accountSummary = await api.accountSummary();
        const book = portfolioCarry(openTrades, specs, at, accountSummary.currency);
        return {
          scope: "portfolio",
          at: at.toISOString(),
          ...book,
          positions: book.positions.map((entry) => ({
            instrument: entry.instrument,
            direction: entry.direction,
            units: entry.units,
            notional: entry.notional,
            annualRatePct: Number((entry.annualRate * 100).toFixed(3)),
            perDay: entry.perDay,
            atNextRollover: entry.atNextRollover,
            summary: entry.summary,
          })),
        };
      }

      const instrument: string = args.instrument;
      const perPair = resolveParams(params, instrument);
      const spec = await api.instrumentSpec(instrument);
      const summary = await api.accountSummary();
      const quote = (await api.pricing([instrument]))[0];
      const price = quote?.mid ?? 0;
      const direction: "long" | "short" = args.direction ?? "long";

      // Size and risk default to what the bot would actually use, so the answer
      // is about a real trade rather than an abstract one unit.
      let units = args.units;
      let riskAmount = args.riskAmount;
      if (units === undefined || riskAmount === undefined) {
        const candles = (await api.candles(instrument, perPair.granularity, 120)).filter(
          (candle) => candle.complete
        );
        const currentAtr = last(atr(candles, perPair.entry.atrPeriod));
        const sized = sizePosition({
          nav: summary.nav,
          riskPerTradePct: perPair.risk.riskPerTradePct,
          stopDistance: currentAtr * perPair.entry.stopAtrMultiple,
          spec,
          direction,
          quoteToAccountRate: 1,
        });
        units = units ?? sized.units;
        riskAmount = riskAmount ?? sized.actualRiskAmount;
      }

      const estimate = estimateCarry({
        spec,
        direction,
        units: units!,
        price,
        riskAmount,
        accountCurrency: summary.currency,
        at,
      });
      const verdict = checkCarry(estimate, {
        maxCarryFractionOfRisk: perPair.carry.maxCarryFractionOfRisk,
        avoidTripleRolloverHours: perPair.carry.avoidTripleRolloverHours,
      });

      return {
        scope: "proposed-trade",
        at: at.toISOString(),
        instrument,
        direction,
        units,
        riskAmount: riskAmount === undefined ? null : Number(riskAmount.toFixed(2)),
        price,
        annualRatePct: Number((estimate.annualRate * 100).toFixed(3)),
        notional: estimate.notional,
        perDay: estimate.perDay,
        atNextRollover: estimate.atNextRollover,
        fractionOfRiskPct:
          estimate.fractionOfRisk === null ? null : Number((estimate.fractionOfRisk * 100).toFixed(2)),
        rollover: estimate.rollover,
        carryGate: {
          enabled: perPair.carry.enabled,
          passes: verdict.ok,
          reasons: verdict.reasons,
        },
        summary: estimate.summary,
        note:
          "Financing is charged on notional, not on profit, so it matters most to small targets " +
          "and long holds. A strategy with real edge should usually pay it.",
      };
    }

    case "oanda_fifo_check": {
      const instrument: string = args.instrument;
      const openTrades = await api.openTrades();
      const net = netPosition(instrument, openTrades);
      const closePlan = planFifoClose(instrument, openTrades, args.tradeID);
      const entry = args.direction
        ? checkFifoEntry(instrument, args.direction, openTrades, params.fifo)
        : null;

      return {
        instrument,
        fifoEnabled: params.fifo.enabled,
        allowReducingOrders: params.fifo.allowReducingOrders,
        netPosition: net,
        currentSide: net > 0 ? "long" : net < 0 ? "short" : "flat",
        positionFillUsed: positionFillFor(params.fifo),
        entryCheck: entry,
        closeOrder: closePlan.order,
        closeWouldViolateFifo: closePlan.violatesFifo,
        closeNotes: closePlan.reasons,
        recommendation: closePlan.recommendation,
      };
    }

    case "oanda_candles": {
      const granularity = args.granularity ?? params.granularity;
      const count = Math.min(Math.max(args.count ?? 200, 20), 500);
      const spec = await api.instrumentSpec(args.instrument);
      const candles = await api.candles(args.instrument, granularity, count);
      const closes = candles.map((candle) => candle.close);
      const atrSeries = atr(candles, params.entry.atrPeriod);
      const adxSeries = adx(candles, 14);
      const rsiSeries = rsi(closes, params.meanReversion.rsiPeriod);
      const fast = sma(closes, params.trend.smaFast);
      const slow = sma(closes, params.trend.smaSlow);
      const pip = pipOf(spec.pipLocation);

      return {
        instrument: args.instrument,
        granularity,
        pipSize: pip,
        latest: {
          close: closes[closes.length - 1],
          atrPips: Number((last(atrSeries) / pip).toFixed(1)),
          adx: Number(last(adxSeries).toFixed(1)),
          rsi: Number(last(rsiSeries).toFixed(1)),
          smaFast: last(fast),
          smaSlow: last(slow),
        },
        candles: candles.map((candle, i) => ({
          ...candle,
          atr: atrSeries[i],
          adx: adxSeries[i],
          rsi: rsiSeries[i],
          smaFast: fast[i],
          smaSlow: slow[i],
        })),
      };
    }

    case "oanda_position_size": {
      const spec = await api.instrumentSpec(args.instrument);
      const summary = await api.accountSummary();
      const pip = pipOf(spec.pipLocation);
      const candles = (await api.candles(args.instrument, params.granularity, 100)).filter(
        (candle) => candle.complete
      );
      const currentAtr = last(atr(candles, params.entry.atrPeriod));
      const multiple = args.stopAtrMultiple ?? params.entry.stopAtrMultiple;
      const stopDistance =
        args.stopPips !== undefined ? args.stopPips * pip : currentAtr * multiple;
      const quote = (await api.pricing([args.instrument]))[0];
      const entryPrice = quote ? (args.direction === "long" ? quote.ask : quote.bid) : last(candles.map((c) => c.close));

      const sizing = sizePosition({
        nav: summary.nav,
        riskPerTradePct: args.riskPercent ?? params.risk.riskPerTradePct,
        stopDistance,
        spec,
        direction: args.direction,
        quoteToAccountRate: 1,
        marginAvailable: summary.marginAvailable,
        entryPrice,
        maxMarginUtilizationPct: params.risk.maxMarginUtilizationPct,
      });

      return {
        instrument: args.instrument,
        direction: args.direction,
        nav: summary.nav,
        accountCurrency: summary.currency,
        atrPips: Number((currentAtr / pip).toFixed(1)),
        stopPips: Number(sizing.stopPips.toFixed(1)),
        stopDistance,
        units: sizing.units,
        signedUnits: sizing.signedUnits,
        riskBudget: Number(sizing.riskAmount.toFixed(2)),
        riskIfStopped: Number(sizing.actualRiskAmount.toFixed(2)),
        suggestedStopPrice:
          entryPrice && args.direction === "long" ? entryPrice - stopDistance : entryPrice + stopDistance,
        suggestedTargetPrice:
          entryPrice && args.direction === "long"
            ? entryPrice + stopDistance * params.entry.takeProfitR
            : entryPrice - stopDistance * params.entry.takeProfitR,
        notes: sizing.notes,
      };
    }

    case "oanda_backtest": {
      const instruments: string[] = args.instruments?.length ? args.instruments : params.instruments;
      const granularity = args.granularity ?? params.granularity;
      const count = Math.min(Math.max(args.candles ?? 3000, 300), 20_000);
      const effective = args.paramPatch
        ? mergeParams(params, { ...args.paramPatch, granularity })
        : { ...params, granularity };
      const summary = await api.accountSummary();
      const startingEquity = args.startingEquity ?? summary.nav ?? 10_000;

      const { series, notes } = await buildSeries(instruments, granularity, count, effective);
      const result = runBacktest(series, effective, {
        startingEquity,
        accountCurrency: summary.currency,
      });

      return {
        granularity,
        instruments,
        candlesPerInstrument: count,
        window: result.window,
        startingEquity: result.startingEquity,
        endingEquity: Number(result.endingEquity.toFixed(2)),
        metrics: result.metrics,
        spreadsUsed: series.map((s) => ({
          instrument: s.instrument,
          spreadPips: Number((s.spread / pipOf(s.spec.pipLocation)).toFixed(2)),
        })),
        interpretation: interpret(result.metrics),
        warnings: [...notes, ...result.warnings],
        trades: args.includeTrades ? result.trades : undefined,
      };
    }

    case "oanda_optimize": {
      const instruments: string[] = args.instruments?.length
        ? args.instruments
        : activeInstruments(params);
      const granularity = args.granularity ?? params.granularity;
      const count = Math.min(Math.max(args.candles ?? 5000, 600), 20_000);
      const summary = await api.accountSummary();
      const effective = { ...params, granularity };
      const { series, notes } = await buildSeries(instruments, granularity, count, effective);
      const grid = args.grid ?? DEFAULT_GRID;
      const startingEquity = summary.nav ?? 10_000;

      if (args.perInstrument) {
        const results = series.map((item) =>
          optimizeInstrumentProfile(item, effective, grid, {
            startingEquity,
            trainFraction: args.trainFraction ?? 0.6,
          })
        );

        const profiles: Record<string, unknown> = {};
        for (const result of results) {
          if (result.profilePatch) profiles[result.instrument] = result.profilePatch;
        }

        let applied = false;
        let path: string | null = null;
        if (args.apply && Object.keys(profiles).length > 0) {
          const next = mergeParams(params, { profiles });
          const problems = validateParams(next);
          if (problems.length > 0) {
            return { applied: false, problems, results, message: "Rejected: unsafe profiles." };
          }
          path = saveParams(next);
          applied = true;
        }

        return {
          mode: "perInstrument",
          granularity,
          candlesPerInstrument: count,
          results: results.map((result) => ({
            instrument: result.instrument,
            verdict: result.verdict,
            baselineOutOfSample: result.baseline.outOfSample,
            bestOutOfSample: result.best?.outOfSample ?? null,
            profilePatch: result.profilePatch,
          })),
          suggestedProfiles: profiles,
          applied,
          path,
          nextStep: applied
            ? "Profiles written. The bot picks them up on its next cycle."
            : Object.keys(profiles).length > 0
              ? "Re-run with apply: true to write these profiles, or patch them yourself with oanda_update_params."
              : "Nothing beat the current parameters per pair. Keeping them is correct.",
          warnings: notes,
        };
      }

      const result = walkForwardOptimize(series, effective, grid, {
        startingEquity,
        trainFraction: args.trainFraction ?? 0.6,
      });

      return {
        mode: "global",
        granularity,
        instruments,
        candlesPerInstrument: count,
        splitAt: result.splitAt,
        candidatesTested: result.tested,
        baseline: result.baseline,
        ranked: result.ranked,
        verdict: result.verdict,
        nextStep:
          "A global fit is a compromise across every pair. Re-run with perInstrument: true to see " +
          "what each pair wants on its own, then apply with oanda_update_params.",
        warnings: notes,
      };
    }

    case "oanda_rank_instruments": {
      const instruments: string[] = args.instruments?.length ? args.instruments : params.instruments;
      const granularity = args.granularity ?? params.granularity;
      const count = Math.min(Math.max(args.candles ?? 6000, 800), 20_000);
      const summary = await api.accountSummary();
      const effective = { ...params, granularity };
      const { series, notes } = await buildSeries(instruments, granularity, count, effective);

      const { ranked, skipped, summary: verdictSummary } = rankInstruments(series, effective, {
        startingEquity: summary.nav ?? 10_000,
        trainFraction: args.trainFraction ?? 0.6,
        minTrades: args.minTrades ?? 12,
      });

      const profiles: Record<string, unknown> = {};
      for (const entry of ranked) {
        if (entry.suggestedProfile) profiles[entry.instrument] = entry.suggestedProfile;
      }

      let applied = false;
      let path: string | null = null;
      if (args.apply && Object.keys(profiles).length > 0) {
        const next = mergeParams(params, { profiles });
        const problems = validateParams(next);
        if (problems.length > 0) {
          return { applied: false, problems, message: "Rejected: the suggested profiles are unsafe." };
        }
        path = saveParams(next);
        applied = true;
      }

      return {
        granularity,
        candlesPerInstrument: count,
        summary: verdictSummary,
        ranked: ranked.map((entry) => ({
          instrument: entry.instrument,
          worthTrading: entry.worthTrading,
          confidence: entry.confidence,
          verdict: entry.verdict,
          bestStrategy: entry.bestStrategy
            ? {
                strategy: entry.bestStrategy.strategy,
                outOfSampleExpectancyR: entry.bestStrategy.outOfSample.expectancyR,
                outOfSampleTrades: entry.bestStrategy.outOfSample.trades,
                outOfSampleProfitFactor: entry.bestStrategy.outOfSample.profitFactor,
                inSampleExpectancyR: entry.bestStrategy.inSample.expectancyR,
                maxDrawdownPct: entry.bestStrategy.outOfSample.maxDrawdownPct,
              }
            : null,
          perStrategy: entry.strategies.map((score) => ({
            strategy: score.strategy,
            outOfSampleExpectancyR: score.outOfSample.expectancyR,
            outOfSampleTrades: score.outOfSample.trades,
          })),
          allStrategiesCombinedOutOfSampleR: entry.combined.outOfSample.expectancyR,
          suggestedProfile: entry.suggestedProfile,
        })),
        suggestedProfiles: profiles,
        applied,
        path,
        caveat:
          "These are out-of-sample results on past candles, not a forecast. A pair that ranks well " +
          "here can still lose; the ranking's job is to stop capital going to pairs with no " +
          "measurable edge at all.",
        nextStep: applied
          ? "Profiles written. Run oanda_market_scan to see the new per-pair setup."
          : "Re-run with apply: true to adopt the suggested profiles.",
        skipped,
        warnings: notes,
      };
    }

    case "oanda_trade_review": {
      const count = Math.min(Math.max(args.count ?? 100, 1), 500);
      const closed = await api.closedTrades(count);
      if (closed.length === 0) {
        return { trades: 0, message: "No closed trades in the recent transaction history." };
      }

      const wins = closed.filter((t) => t.realizedPL > 0);
      const losses = closed.filter((t) => t.realizedPL <= 0);
      const grossWin = wins.reduce((sum, t) => sum + t.realizedPL, 0);
      const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPL, 0));
      const financing = closed.reduce((sum, t) => sum + t.financing, 0);

      const byReason: Record<string, number> = {};
      for (const trade of closed) {
        byReason[trade.closeReason] = (byReason[trade.closeReason] ?? 0) + 1;
      }

      const byInstrument: Record<string, { trades: number; netPL: number; winRatePct: number }> = {};
      for (const trade of closed) {
        const bucket = (byInstrument[trade.instrument] ??= { trades: 0, netPL: 0, winRatePct: 0 });
        bucket.trades++;
        bucket.netPL += trade.realizedPL;
      }
      for (const [instrument, bucket] of Object.entries(byInstrument)) {
        const subset = closed.filter((t) => t.instrument === instrument);
        bucket.netPL = Number(bucket.netPL.toFixed(2));
        bucket.winRatePct = Number(
          ((subset.filter((t) => t.realizedPL > 0).length / subset.length) * 100).toFixed(1)
        );
      }

      const avgWin = wins.length ? grossWin / wins.length : 0;
      const avgLoss = losses.length ? grossLoss / losses.length : 0;
      const diagnosis: string[] = [];
      if (grossLoss > 0 && grossWin / grossLoss < 1) {
        diagnosis.push(
          `Profit factor ${(grossWin / grossLoss).toFixed(2)} — the book is losing. ` +
            `Run oanda_optimize before adding size.`
        );
      }
      if (avgLoss > avgWin * 1.2 && wins.length > losses.length) {
        diagnosis.push(
          "Winning often but losing more per loss: targets are being taken early relative to " +
            "stops. Raise entry.takeProfitR or tighten entry.stopAtrMultiple."
        );
      }
      if ((byReason.STOP_LOSS_ORDER ?? 0) > closed.length * 0.6) {
        diagnosis.push(
          `${byReason.STOP_LOSS_ORDER}/${closed.length} exits were stop-outs: stops are likely ` +
            "inside normal noise. Test a larger entry.stopAtrMultiple."
        );
      }
      if (financing < -Math.abs(grossWin) * 0.1) {
        diagnosis.push(
          `Financing cost ${financing.toFixed(2)} is eating a meaningful share of gross profit — ` +
            "holding periods may be too long for the edge."
        );
      }
      if (diagnosis.length === 0) {
        diagnosis.push("No structural problem stands out in this sample.");
      }

      return {
        trades: closed.length,
        winRatePct: Number(((wins.length / closed.length) * 100).toFixed(1)),
        netPL: Number((grossWin - grossLoss).toFixed(2)),
        profitFactor: grossLoss === 0 ? Infinity : Number((grossWin / grossLoss).toFixed(2)),
        avgWin: Number(avgWin.toFixed(2)),
        avgLoss: Number(avgLoss.toFixed(2)),
        financingPaid: Number(financing.toFixed(2)),
        exitBreakdown: byReason,
        byInstrument,
        diagnosis,
      };
    }

    case "oanda_open_trade_review": {
      const trades = await api.openTrades();
      const wanted = trades.filter(
        (trade) =>
          (!args.tradeID || trade.id === String(args.tradeID)) &&
          (!args.instrument || trade.instrument === args.instrument)
      );

      if (wanted.length === 0) {
        return {
          trades: 0,
          message:
            trades.length === 0
              ? "No open trades on the account."
              : `No open trade matches that filter. Open trade IDs: ${trades
                  .map((t) => `${t.id} (${t.instrument})`)
                  .join(", ")}.`,
        };
      }

      const summary = await api.accountSummary();
      const instruments = [...new Set(wanted.map((t) => t.instrument))];
      const quotes = await api.pricing(instruments);

      const reviewed = await Promise.all(
        wanted.map(async (trade) => {
          const spec = await api.instrumentSpec(trade.instrument);
          const pip = pipOf(spec.pipLocation);
          const quote = quotes.find((q) => q.instrument === trade.instrument);
          const long = trade.currentUnits > 0;

          // Value the position at the price it would actually be CLOSED at — bid
          // for a long, ask for a short. Using the mid flatters every open trade
          // by half the spread, which is exactly the trade you are deciding
          // whether to keep.
          const exitPrice = quote ? (long ? quote.bid : quote.ask) : trade.price;
          const moved = long ? exitPrice - trade.price : trade.price - exitPrice;

          const stop = trade.stopLossPrice;
          const target = trade.takeProfitPrice;
          const riskDistance = stop === null ? null : Math.abs(trade.price - stop);
          const rewardDistance = target === null ? null : Math.abs(target - trade.price);

          const heldMs = Date.now() - new Date(trade.openTime).getTime();
          const heldDays = heldMs / 86_400_000;
          const units = Math.abs(trade.currentUnits);

          // What each side is worth in account currency, taken from the live P/L
          // rather than recomputed: that keeps the cross rate the broker is
          // actually applying, instead of assuming 1.0.
          const plPerPrice = moved !== 0 ? trade.unrealizedPL / moved : null;
          const carry = estimateCarry({
            spec,
            direction: long ? "long" : "short",
            units,
            price: exitPrice || trade.price,
            accountCurrency: summary.currency,
          });

          const warnings: string[] = [];
          if (stop === null) {
            warnings.push(
              "NO STOP LOSS on this trade — the loss is unbounded. Attach one with " +
                "oanda_update_trade_brackets before doing anything else."
            );
          }
          if (target === null && trade.trailingStopDistance === null) {
            warnings.push("No take profit and no trailing stop: the exit is entirely discretionary.");
          }
          if (riskDistance !== null && rewardDistance !== null && rewardDistance < riskDistance) {
            warnings.push(
              `Target is closer than the stop (${(rewardDistance / pip).toFixed(1)} vs ` +
                `${(riskDistance / pip).toFixed(1)} pips): this needs a win rate above 50% to pay.`
            );
          }
          if (heldDays > 5 && carry.perDay < 0) {
            warnings.push(
              `Held ${heldDays.toFixed(1)} days at a negative carry of about ` +
                `${carry.perDay.toFixed(2)}/day — financing is working against it.`
            );
          }

          const progressR =
            riskDistance && riskDistance > 0 ? Number((moved / riskDistance).toFixed(2)) : null;

          if (progressR !== null && progressR >= 1 && stop !== null) {
            const beyondEntry = long ? stop > trade.price : stop < trade.price;
            if (!beyondEntry) {
              warnings.push(
                `Up ${progressR}R with the stop still at or behind entry. Moving it to ` +
                  `break-even removes the loss case; oanda_update_trade_brackets does it.`
              );
            }
          }

          return {
            tradeID: trade.id,
            instrument: trade.instrument,
            direction: long ? "long" : "short",
            units,
            openTime: trade.openTime,
            heldDays: Number(heldDays.toFixed(2)),
            entryPrice: trade.price,
            currentExitPrice: exitPrice,
            movedPips: Number((moved / pip).toFixed(1)),
            unrealizedPL: Number(trade.unrealizedPL.toFixed(2)),
            unrealizedPLPctOfNav:
              summary.nav > 0 ? Number(((trade.unrealizedPL / summary.nav) * 100).toFixed(2)) : null,
            realizedPL: Number(trade.realizedPL.toFixed(2)),
            stopLossPrice: stop,
            takeProfitPrice: target,
            trailingStopDistance: trade.trailingStopDistance,
            stopDistancePips: riskDistance === null ? null : Number((riskDistance / pip).toFixed(1)),
            targetDistancePips:
              rewardDistance === null ? null : Number((rewardDistance / pip).toFixed(1)),
            pipsToStop:
              stop === null
                ? null
                : Number((Math.abs(exitPrice - stop) / pip).toFixed(1)),
            pipsToTarget:
              target === null
                ? null
                : Number((Math.abs(target - exitPrice) / pip).toFixed(1)),
            progressR,
            plannedRiskReward:
              riskDistance && rewardDistance && riskDistance > 0
                ? Number((rewardDistance / riskDistance).toFixed(2))
                : null,
            plIfStopped:
              stop === null || plPerPrice === null
                ? null
                : Number(((long ? stop - trade.price : trade.price - stop) * plPerPrice).toFixed(2)),
            plIfTargetHit:
              target === null || plPerPrice === null
                ? null
                : Number(
                    ((long ? target - trade.price : trade.price - target) * plPerPrice).toFixed(2)
                  ),
            financingPerDay: Number(carry.perDay.toFixed(2)),
            financingSoFarEstimate: Number((carry.perDay * heldDays).toFixed(2)),
            warnings,
          };
        })
      );

      const totalUnrealized = reviewed.reduce((sum, t) => sum + t.unrealizedPL, 0);

      return {
        trades: reviewed.length,
        accountCurrency: summary.currency,
        nav: summary.nav,
        totalUnrealizedPL: Number(totalUnrealized.toFixed(2)),
        openRisk: await openRisk(wanted, summary.nav),
        positions: reviewed,
        nextActions: [
          "oanda_trade_roi prices whether each of these is still worth its risk.",
          "oanda_update_trade_brackets moves a stop to break-even once a trade is 1R in front.",
          "oanda_close_trade closes one of these by ID; oanda_remove_position closes a whole instrument.",
        ],
      };
    }

    case "oanda_trade_roi": {
      // Two entry points to the same arithmetic: an open trade priced from its
      // live brackets, or a proposal priced from arguments. Resolving both to one
      // shape here keeps the maths below honest — a proposal and a position must
      // be judged the same way, or the comparison is meaningless.
      let instrument: string;
      let direction: "long" | "short";
      let entryPrice: number;
      let stopPrice: number | null;
      let targetPrice: number | null;
      let units: number;
      let source: string;
      let openTradeID: string | null = null;

      const summary = await api.accountSummary();

      if (args.tradeID) {
        const trades = await api.openTrades();
        const trade = trades.find((t) => t.id === String(args.tradeID));
        if (!trade) throw new Error(`No open trade with ID ${args.tradeID}.`);
        instrument = trade.instrument;
        direction = trade.currentUnits > 0 ? "long" : "short";
        entryPrice = trade.price;
        stopPrice = args.stopLossPrice ?? trade.stopLossPrice;
        targetPrice = args.takeProfitPrice ?? trade.takeProfitPrice;
        units = Math.abs(trade.currentUnits);
        openTradeID = trade.id;
        source = "open trade";
      } else {
        if (!args.instrument || !args.direction) {
          throw new Error(
            "Give either a tradeID, or instrument + direction for a proposed trade."
          );
        }
        instrument = args.instrument;
        direction = args.direction;
        const quote = (await api.pricing([instrument]))[0];
        entryPrice =
          args.entryPrice ?? (quote ? (direction === "long" ? quote.ask : quote.bid) : 0);
        stopPrice = args.stopLossPrice ?? null;
        targetPrice = args.takeProfitPrice ?? null;
        units = args.units ?? 0;
        source = "proposed trade";
      }

      const spec = await api.instrumentSpec(instrument);
      const pip = pipOf(spec.pipLocation);
      const quote = (await api.pricing([instrument]))[0];

      const candles = (await api.candles(instrument, params.granularity, 100)).filter(
        (candle) => candle.complete
      );
      const currentAtr = last(atr(candles, params.entry.atrPeriod));

      // Fill in whatever was not supplied from the same rules the live bot uses,
      // so an unbracketed proposal is priced against the stop it would actually
      // get rather than against nothing.
      const assumed: string[] = [];
      if (stopPrice === null) {
        const distance = currentAtr * params.entry.stopAtrMultiple;
        stopPrice = direction === "long" ? entryPrice - distance : entryPrice + distance;
        assumed.push(
          `No stop given, so this uses the params stop of ${params.entry.stopAtrMultiple}×ATR ` +
            `(${(distance / pip).toFixed(1)} pips).`
        );
      }
      const riskDistance = Math.abs(entryPrice - stopPrice);

      if (targetPrice === null) {
        const distance = riskDistance * params.entry.takeProfitR;
        targetPrice = direction === "long" ? entryPrice + distance : entryPrice - distance;
        assumed.push(
          `No target given, so this uses the params target of ${params.entry.takeProfitR}R.`
        );
      }
      const rewardDistance = Math.abs(targetPrice - entryPrice);

      if (units === 0) {
        const sizing = sizePosition({
          nav: summary.nav,
          riskPerTradePct: params.risk.riskPerTradePct,
          stopDistance: riskDistance,
          spec,
          direction,
          quoteToAccountRate: 1,
          marginAvailable: summary.marginAvailable,
          entryPrice,
          maxMarginUtilizationPct: params.risk.maxMarginUtilizationPct,
        });
        units = sizing.units;
        assumed.push(
          `No units given, so this uses the risk-based size of ${units} at ` +
            `${params.risk.riskPerTradePct}% of NAV.`
        );
      }

      // Account-currency value of one price unit. 1.0 for a quote currency that
      // matches the account; stated as an assumption rather than silently
      // assumed, because on a JPY-quoted pair in a USD account it is wrong.
      const valuePerPrice = units;
      const quoteMatchesAccount = instrument.endsWith(`_${summary.currency}`);
      if (!quoteMatchesAccount) {
        assumed.push(
          `${instrument} is not quoted in ${summary.currency}, so the cash figures below assume a ` +
            `1:1 quote→account rate and are indicative only. The R multiples are unaffected.`
        );
      }

      const grossWin = rewardDistance * valuePerPrice;
      const grossLoss = riskDistance * valuePerPrice;

      const spread = quote ? Math.max(quote.ask - quote.bid, 0) : 0;
      const spreadCost = spread * valuePerPrice;
      const holdDays = Math.max(args.holdDays ?? 3, 0);
      const carry = estimateCarry({
        spec,
        direction,
        units,
        price: entryPrice,
        accountCurrency: summary.currency,
      });
      const carryCost = carry.perDay * holdDays;

      // Hit rate: this account's own record on this instrument first, because a
      // backtest number and a live number differ for reasons that matter. Falls
      // back to the whole book, then to break-even, and says which was used.
      const closed = await api.closedTrades(300);
      const sameInstrument = closed.filter((t) => t.instrument === instrument);
      const sample = sameInstrument.length >= 15 ? sameInstrument : closed;
      const historicalWinRate =
        sample.length > 0
          ? (sample.filter((t) => t.realizedPL > 0).length / sample.length) * 100
          : null;

      const winRatePct =
        args.winRatePct ?? historicalWinRate ?? (rewardDistance / (rewardDistance + riskDistance)) * 100;
      const winRateBasis =
        args.winRatePct !== undefined
          ? "the rate you supplied"
          : sameInstrument.length >= 15
            ? `this account's last ${sameInstrument.length} closed ${instrument} trades`
            : closed.length > 0
              ? `this account's last ${closed.length} closed trades across all instruments`
              : "no history — the break-even rate implied by the brackets, which assumes no edge";

      const p = Math.min(Math.max(winRatePct / 100, 0), 1);
      const rMultiple = riskDistance > 0 ? rewardDistance / riskDistance : 0;
      const netWin = grossWin - spreadCost - Math.max(-carryCost, 0);
      const netLoss = grossLoss + spreadCost + Math.max(-carryCost, 0);

      const expectedValue = p * netWin - (1 - p) * netLoss;
      const breakEvenWinRatePct = (riskDistance / (riskDistance + rewardDistance)) * 100;

      const verdict: string[] = [];
      if (riskDistance <= 0) {
        verdict.push("Stop is at the entry price: there is no risk to divide by, so no ROI to quote.");
      } else {
        verdict.push(
          `Risking ${grossLoss.toFixed(2)} to make ${grossWin.toFixed(2)} — ${rMultiple.toFixed(2)}R. ` +
            `That needs a win rate above ${breakEvenWinRatePct.toFixed(1)}% to break even, ` +
            `and ${winRateBasis} puts it at ${winRatePct.toFixed(1)}%.`
        );
        verdict.push(
          expectedValue > 0
            ? `Expected value per trade: +${expectedValue.toFixed(2)} (${summary.currency}).`
            : `Expected value per trade: ${expectedValue.toFixed(2)} (${summary.currency}) — ` +
              `this is negative at that hit rate. Widen the target, tighten the stop, or skip it.`
        );
      }
      const cost = checkCost(spread, currentAtr, spec, params);
      if (!cost.ok) verdict.push(`Cost filter: ${cost.reason}`);
      if (spreadCost > grossLoss * 0.1 && grossLoss > 0) {
        verdict.push(
          `Spread alone is ${((spreadCost / grossLoss) * 100).toFixed(1)}% of the amount at risk — ` +
            `a stop this tight is expensive to enter.`
        );
      }

      return {
        source,
        openTradeID,
        instrument,
        direction,
        units,
        accountCurrency: summary.currency,
        entryPrice,
        stopLossPrice: stopPrice,
        takeProfitPrice: targetPrice,
        stopPips: Number((riskDistance / pip).toFixed(1)),
        targetPips: Number((rewardDistance / pip).toFixed(1)),
        rewardToRisk: Number(rMultiple.toFixed(2)),
        amountAtRisk: Number(grossLoss.toFixed(2)),
        riskPctOfNav:
          summary.nav > 0 ? Number(((grossLoss / summary.nav) * 100).toFixed(2)) : null,
        grossProfitIfTargetHit: Number(grossWin.toFixed(2)),
        returnOnRiskPct: grossLoss > 0 ? Number(((grossWin / grossLoss) * 100).toFixed(1)) : null,
        returnOnNavPct:
          summary.nav > 0 ? Number(((grossWin / summary.nav) * 100).toFixed(2)) : null,
        costs: {
          spreadPips: Number((spread / pip).toFixed(1)),
          spreadCost: Number(spreadCost.toFixed(2)),
          financingPerDay: Number(carry.perDay.toFixed(2)),
          financingOverHold: Number(carryCost.toFixed(2)),
          holdDaysAssumed: holdDays,
        },
        netProfitIfTargetHit: Number(netWin.toFixed(2)),
        netLossIfStopped: Number(netLoss.toFixed(2)),
        winRatePctUsed: Number(winRatePct.toFixed(1)),
        winRateBasis,
        breakEvenWinRatePct: Number(breakEvenWinRatePct.toFixed(1)),
        expectancyPerTrade: Number(expectedValue.toFixed(2)),
        expectancyR:
          grossLoss > 0 ? Number((expectedValue / grossLoss).toFixed(3)) : null,
        assumptions: assumed,
        verdict,
        caveats: [
          "Expectancy is arithmetic on a hit rate, not a forecast. A small sample of closed trades makes it little better than a guess.",
          "Slippage and gap risk are not modelled: a stop is a price to attempt, not a guarantee.",
        ],
      };
    }

    case "oanda_pretrade_research": {
      const instrument = String(args.instrument);
      const currencies = currenciesOf(instrument);

      const research = await researchInstrument({
        instrument,
        currencies,
        question: args.question,
        readPages: args.readPages,
      });

      // Bolt the cheap quantitative context onto the same answer. The point of a
      // pre-trade check is one place to look, and the session clock in particular
      // is what turns "CPI at 13:30" into "that is inside my holding period".
      const clock = sessionState();
      const session = evaluateSession(instrument, new Date(), {
        enforce: params.sessions?.enforce,
      });

      // Rollover timing needs the instrument spec, which is a network call. The
      // research above is the point of this tool and does not depend on it, so a
      // broker outage degrades the timing block rather than losing the lot.
      let rollover: unknown = null;
      let rolloverError: string | null = null;
      try {
        rollover = nextRollover(await api.instrumentSpec(instrument));
      } catch (err: any) {
        rolloverError = `Could not read the instrument spec: ${err?.message ?? String(err)}`;
      }

      return {
        ...research,
        timing: {
          session: clock,
          verdict: session,
          nextRollover: rollover,
          rolloverError,
          note:
            "Financing is charged at rollover, and spreads widen around it. Check any release " +
            "time above against these.",
        },
        nextActions: [
          "oanda_market_scan for the technical side of the same instrument.",
          "oanda_trade_roi to price the trade you are considering.",
          "oanda_carry_check if you plan to hold it for more than a day.",
        ],
      };
    }

    case "oanda_close_trade": {
      const trades = await api.openTrades();
      const trade = trades.find((t) => t.id === String(args.tradeID));
      if (!trade) {
        return {
          closed: false,
          message:
            trades.length === 0
              ? "No open trades on the account."
              : `No open trade with ID ${args.tradeID}. Open: ${trades
                  .map((t) => `${t.id} (${t.instrument})`)
                  .join(", ")}.`,
        };
      }

      // Closing one trade out of turn is the case FIFO exists to reject, and on a
      // US account OANDA answers with FIFO_VIOLATION rather than doing something
      // sensible. Check it before asking for confirmation, not after the reject.
      const fifoPlan = planFifoClose(trade.instrument, trades, trade.id);
      const fifoWarning = fifoPlan.violatesFifo
        ? [...fifoPlan.reasons, fifoPlan.recommendation].join(" ")
        : null;

      if (fifoPlan.violatesFifo && params.fifo.enabled && args.confirm === true) {
        return {
          closed: false,
          refused: true,
          tradeID: trade.id,
          instrument: trade.instrument,
          fifoWarning,
          fifoCloseOrder: fifoPlan.order,
          message:
            "Refused before submission: this close breaks FIFO and the broker would reject it. " +
            "Close the older trades first, or use oanda_remove_position.",
        };
      }

      if (args.confirm !== true) {
        return {
          closed: false,
          tradeID: trade.id,
          instrument: trade.instrument,
          direction: trade.currentUnits > 0 ? "long" : "short",
          units: Math.abs(trade.currentUnits),
          unitsToClose: args.units === undefined ? "ALL" : Math.abs(args.units),
          unrealizedPL: Number(trade.unrealizedPL.toFixed(2)),
          fifoWarning,
          fifoCloseOrder: fifoPlan.order,
          message:
            `Pass confirm: true to close. This realises ${trade.unrealizedPL.toFixed(2)} at market.`,
        };
      }

      const response = await api.closeTrade(
        trade.id,
        args.units === undefined ? "ALL" : args.units
      );
      return {
        closed: true,
        tradeID: trade.id,
        instrument: trade.instrument,
        realisedFrom: Number(trade.unrealizedPL.toFixed(2)),
        fifoWarning,
        raw: response,
      };
    }

    case "oanda_get_params": {
      return { path: paramsPath(), params, problems: validateParams(params) };
    }

    // -- Writes -----------------------------------------------------------
    case "oanda_update_params": {
      const next: StrategyParams = args.reset
        ? { ...DEFAULT_PARAMS }
        : mergeParams(params, args.patch ?? {});
      if (args.note) next.notes = String(args.note);

      const problems = validateParams(next);
      if (problems.length > 0) {
        return {
          applied: false,
          problems,
          message: "Rejected: the patch would leave the bot with unsafe parameters. Nothing written.",
        };
      }

      const file = saveParams(next);
      return {
        applied: true,
        path: file,
        params: next,
        message:
          "Saved. The OandaVisualBot app re-reads this file at the top of each cycle, so the " +
          "change takes effect on the next tick without a restart.",
      };
    }

    case "oanda_create_order": {
      const instrument: string = args.instrument;
      const direction: "long" | "short" = args.direction;
      // This instrument's own profile, not the globals: a pair tuned to H1 with a
      // wider stop must be ordered on those terms.
      const pairParams = resolveParams(params, instrument);
      const orderType = args.type ?? "MARKET";
      const spec = await api.instrumentSpec(instrument);
      const summary = await api.accountSummary();
      const openTrades = await api.openTrades();
      const risk = await openRisk(openTrades, summary.nav);
      const pip = pipOf(spec.pipLocation);
      const quote = (await api.pricing([instrument]))[0];
      const candles = (await api.candles(instrument, pairParams.granularity, 120)).filter(
        (candle) => candle.complete
      );
      const currentAtr = last(atr(candles, pairParams.entry.atrPeriod));

      const stopDistance =
        args.stopPips !== undefined ? args.stopPips * pip : currentAtr * pairParams.entry.stopAtrMultiple;
      const takeProfitR = args.takeProfitR ?? pairParams.entry.takeProfitR;
      const entryPrice =
        orderType === "LIMIT"
          ? Number(args.limitPrice)
          : direction === "long"
            ? quote.ask
            : quote.bid;

      if (orderType === "LIMIT" && !Number.isFinite(entryPrice)) {
        throw new Error("limitPrice is required for a LIMIT order.");
      }

      // Every reason this order should not exist, gathered before it is priced.
      const blockers: string[] = [];
      const cost = checkCost(quote?.spread ?? Infinity, currentAtr, spec, pairParams);
      if (!cost.ok) blockers.push(cost.reason);
      if (quote && !quote.tradeable) blockers.push(`${instrument} is not currently tradeable.`);

      const session = evaluateSession(instrument, new Date(), {
        enforce: pairParams.sessions.enforce && pairParams.enforceLiquidityWindow,
        blockRollover: pairParams.sessions.blockRollover,
      });
      if (!session.tradeable) blockers.push(session.reason);

      // FIFO first among the position checks: on a US account this is the
      // difference between opening a trade and closing the one you had.
      const fifo = checkFifoEntry(instrument, direction, openTrades, pairParams.fifo);
      if (!fifo.allowed) blockers.push(...fifo.reasons, ...fifo.guidance);

      const here = openTrades.filter((t) => t.instrument === instrument).length;
      if (here >= pairParams.risk.maxOpenTradesPerInstrument) {
        blockers.push(`Already holding ${here} trade(s) in ${instrument}.`);
      }
      for (const currency of currenciesOf(instrument)) {
        const held = risk.tradesPerCurrency[currency] ?? 0;
        if (held >= pairParams.risk.maxTradesPerCurrency) {
          blockers.push(`${held} open trade(s) already expose ${currency}.`);
        }
      }
      if (risk.openRiskPct + pairParams.risk.riskPerTradePct > pairParams.risk.maxOpenRiskPct) {
        blockers.push(
          `Open risk ${risk.openRiskPct}% plus this trade exceeds the ${pairParams.risk.maxOpenRiskPct}% ceiling.`
        );
      }
      const marginUtilPct = summary.nav > 0 ? (summary.marginUsed / summary.nav) * 100 : 0;
      if (marginUtilPct >= pairParams.risk.maxMarginUtilizationPct) {
        blockers.push(
          `Margin utilisation ${marginUtilPct.toFixed(1)}% is at or above the ` +
            `${pairParams.risk.maxMarginUtilizationPct}% limit.`
        );
      }

      // Consensus gate. Checked here as well as in the scan because an order can
      // be requested directly, and "the model asked for it" is not a reason to
      // skip the multi-timeframe check the strategy path has to pass.
      let consensusSnapshot: { score: number; direction: string; verdict: string } | null = null;
      if (pairParams.consensus.enabled) {
        const { consensus } = await consensusFor(instrument, params);
        consensusSnapshot = {
          score: consensus.score,
          direction: consensus.direction,
          verdict: consensus.verdict,
        };
        if (consensus.direction !== direction) {
          blockers.push(
            `Consensus is ${consensus.direction} at score ${consensus.score}; this order is ` +
              `${direction}. Trading against the multi-timeframe read is the most expensive habit ` +
              `available.`
          );
        } else if (Math.abs(consensus.score) < pairParams.consensus.minScore) {
          blockers.push(
            `Consensus score ${consensus.score} is below the ${pairParams.consensus.minScore} minimum.`
          );
        }
        if (
          pairParams.consensus.requireHigherTimeframeAlignment &&
          !consensus.higherTimeframeAligned
        ) {
          blockers.push(`Higher timeframe disagrees with a ${direction} here.`);
        }
      }

      const sizing = sizePosition({
        nav: summary.nav,
        riskPerTradePct: args.riskPercent ?? pairParams.risk.riskPerTradePct,
        stopDistance,
        spec,
        direction,
        quoteToAccountRate: 1,
        marginAvailable: summary.marginAvailable,
        entryPrice,
        maxMarginUtilizationPct: pairParams.risk.maxMarginUtilizationPct,
      });

      const units = args.units !== undefined ? Math.abs(Math.trunc(args.units)) : sizing.units;
      if (units <= 0) blockers.push(...(sizing.notes.length ? sizing.notes : ["Sized to zero units."]));

      // Financing. Distinct from the rollover SPREAD block above: this is the
      // charge applied at 17:00 New York to whatever is open, tripled on one
      // weekday. Priced against risk, because the absolute figure means nothing.
      let carry: ReturnType<typeof estimateCarry> | null = null;
      if (units > 0) {
        carry = estimateCarry({
          spec,
          direction,
          units,
          price: entryPrice,
          riskAmount: units * stopDistance,
          accountCurrency: summary.currency,
        });
        if (pairParams.carry.enabled) {
          const verdict = checkCarry(carry, {
            maxCarryFractionOfRisk: pairParams.carry.maxCarryFractionOfRisk,
            avoidTripleRolloverHours: pairParams.carry.avoidTripleRolloverHours,
          });
          if (!verdict.ok) blockers.push(...verdict.reasons);
        }
      }
      if (args.units !== undefined) {
        const impliedRisk = units * stopDistance;
        const impliedPct = summary.nav > 0 ? (impliedRisk / summary.nav) * 100 : 0;
        if (impliedPct > pairParams.risk.riskPerTradePct * 1.5) {
          blockers.push(
            `Explicit ${units} units risks ${impliedPct.toFixed(2)}% of NAV, well above the ` +
              `configured ${pairParams.risk.riskPerTradePct}%. Drop the units argument to size from risk.`
          );
        }
      }

      const plan = {
        instrument,
        direction,
        orderType,
        units,
        signedUnits: direction === "long" ? units : -units,
        entryPrice,
        stopLossPrice: Number(
          (direction === "long" ? entryPrice - stopDistance : entryPrice + stopDistance).toFixed(
            spec.displayPrecision
          )
        ),
        takeProfitPrice: Number(
          (direction === "long"
            ? entryPrice + stopDistance * takeProfitR
            : entryPrice - stopDistance * takeProfitR
          ).toFixed(spec.displayPrecision)
        ),
        stopPips: Number((stopDistance / pip).toFixed(1)),
        targetPips: Number(((stopDistance * takeProfitR) / pip).toFixed(1)),
        riskIfStopped: Number((units * stopDistance).toFixed(2)),
        riskPctOfNav:
          summary.nav > 0 ? Number(((units * stopDistance * 100) / summary.nav).toFixed(3)) : 0,
        spreadPips: Number((cost.spreadPips ?? 0).toFixed(2)),
        consensus: consensusSnapshot,
        financing: carry
          ? {
              annualRatePct: Number((carry.annualRate * 100).toFixed(3)),
              atNextRollover: carry.atNextRollover,
              perDay: carry.perDay,
              fractionOfRiskPct:
                carry.fractionOfRisk === null ? null : Number((carry.fractionOfRisk * 100).toFixed(2)),
              hoursUntilRollover: carry.rollover.hoursUntil,
              tripleCharge: carry.rollover.isTripleCharge,
              summary: carry.summary,
            }
          : null,
        sessionLiquidityScore: session.liquidityScore,
        positionFill: positionFillFor(pairParams.fifo),
        // OANDA cannot attach a partial take-profit to an order, so the scale-out
        // is a manual follow-up: close this fraction here, then move the stop to
        // break-even with oanda_update_trade_brackets.
        partialTakeProfit:
          pairParams.entry.partialTakeProfitFraction > 0
            ? {
                atPrice: Number(
                  (direction === "long"
                    ? entryPrice + stopDistance
                    : entryPrice - stopDistance
                  ).toFixed(spec.displayPrecision)
                ),
                closeUnits: Math.floor(units * pairParams.entry.partialTakeProfitFraction),
                instruction:
                  "At 1R, close that many units with oanda_remove_position, then move the stop to " +
                  "break-even with oanda_update_trade_brackets. The OandaVisualBot app does this " +
                  "automatically for trades it opens.",
              }
            : null,
      };

      if (blockers.length > 0) {
        return {
          placed: false,
          plan,
          blockers,
          message: "Not placed: the risk checks above failed. Fix the cause or wait for a better setup.",
        };
      }
      if (args.confirm !== true) {
        return {
          placed: false,
          plan,
          message:
            "Priced but not placed — all risk checks passed. Call again with confirm: true to send it.",
        };
      }

      const order: Record<string, unknown> = {
        type: orderType,
        instrument,
        units: String(plan.signedUnits),
        // GTD/FOK on a market order can reject on a fast tick; IOC fills what it
        // can at a price the account will accept.
        timeInForce: orderType === "MARKET" ? "FOK" : "GTC",
        // REDUCE_FIRST on a FIFO account, so the broker's netting behaviour is
        // stated rather than inherited from an account setting we cannot see.
        positionFill: positionFillFor(pairParams.fifo),
        stopLossOnFill: {
          price: plan.stopLossPrice.toFixed(spec.displayPrecision),
          timeInForce: "GTC",
        },
        takeProfitOnFill: {
          price: plan.takeProfitPrice.toFixed(spec.displayPrecision),
          timeInForce: "GTC",
        },
      };
      if (orderType === "LIMIT") order.price = entryPrice.toFixed(spec.displayPrecision);

      const response = await api.createOrder(order);
      const rejection =
        response.orderCancelTransaction?.reason ?? response.orderRejectTransaction?.rejectReason;

      return {
        placed: !rejection,
        plan,
        rejection: rejection ?? null,
        fill: response.orderFillTransaction
          ? {
              tradeID: response.orderFillTransaction.tradeOpened?.tradeID,
              price: response.orderFillTransaction.price,
              units: response.orderFillTransaction.units,
              time: response.orderFillTransaction.time,
            }
          : null,
        raw: response,
      };
    }

    case "oanda_update_trade_brackets": {
      if (args.confirm !== true) {
        return { applied: false, message: "Pass confirm: true to modify a live trade's brackets." };
      }
      const trades = await api.openTrades();
      const trade = trades.find((t) => t.id === String(args.tradeID));
      if (!trade) throw new Error(`No open trade with ID ${args.tradeID}.`);
      const spec = await api.instrumentSpec(trade.instrument);
      const pip = pipOf(spec.pipLocation);

      const response = await api.setTradeBrackets(
        String(args.tradeID),
        {
          stopLossPrice: args.stopLossPrice,
          takeProfitPrice: args.takeProfitPrice,
          trailingDistance:
            args.trailingDistancePips !== undefined ? args.trailingDistancePips * pip : undefined,
        },
        spec.displayPrecision
      );
      return { applied: true, tradeID: args.tradeID, instrument: trade.instrument, raw: response };
    }

    case "oanda_remove_position": {
      const allTrades = await api.openTrades();
      const closePlan = planFifoClose(args.instrument, allTrades);

      if (args.confirm !== true) {
        const trades = allTrades.filter((t) => t.instrument === args.instrument);
        return {
          closed: false,
          openTrades: trades,
          netPosition: netPosition(args.instrument, allTrades),
          unrealizedPL: Number(trades.reduce((sum, t) => sum + t.unrealizedPL, 0).toFixed(2)),
          fifoCloseOrder: closePlan.order,
          message:
            "Pass confirm: true to close. This realises the P/L shown above at market. " +
            (params.fifo.enabled
              ? "Closing goes through the position endpoint, which applies FIFO server-side, so " +
                "the oldest trade is closed first."
              : ""),
        };
      }
      const response = await api.closePosition(
        args.instrument,
        args.side ?? "both",
        args.units === undefined ? "ALL" : args.units
      );
      return {
        closed: true,
        instrument: args.instrument,
        fifoCloseOrder: closePlan.order,
        raw: response,
      };
    }

    case "oanda_remove_pending_orders": {
      const pending = await api.pendingOrders();
      if (args.confirm !== true) {
        return {
          cancelled: false,
          pendingOrders: pending,
          message: "Pass confirm: true to cancel.",
        };
      }
      if (args.orderID) {
        const response = await api.cancelOrder(String(args.orderID));
        return { cancelled: true, orderID: args.orderID, raw: response };
      }
      if (args.all !== true) {
        throw new Error("Pass either orderID, or all: true to cancel every pending order.");
      }
      const results: unknown[] = [];
      for (const order of pending) {
        results.push({ orderID: order.id, result: await api.cancelOrder(order.id) });
      }
      return { cancelled: true, count: pending.length, results };
    }

    // -- Universe and configuration ---------------------------------------
    case "oanda_list_instruments": {
      const sweep = await sweepUniverse(api, params, {
        granularity: args.granularity,
        types: args.types,
        limit: args.limit,
      });

      if (args.watchedOnly) {
        return {
          ...sweep,
          entries: sweep.entries.filter((entry) => entry.watched),
        };
      }
      return sweep;
    }

    case "oanda_update_watchlist": {
      const available = new Set((await api.listInstruments()).map((spec) => spec.name));
      const current = new Set(params.instruments ?? []);

      const unknown: string[] = [];
      const check = (list: string[] | undefined) => {
        for (const name of list ?? []) if (!available.has(name)) unknown.push(name);
      };
      check(args.instruments);
      check(args.add);

      if (unknown.length) {
        return {
          updated: false,
          unknownInstruments: unknown,
          message:
            `Not tradeable on this account: ${unknown.join(", ")}. Run oanda_list_instruments ` +
            `for the exact names — OANDA uses BASE_QUOTE with an underscore, e.g. EUR_USD.`,
        };
      }

      let next: string[];
      if (Array.isArray(args.instruments)) {
        next = [...new Set(args.instruments as string[])];
      } else {
        for (const name of (args.add ?? []) as string[]) current.add(name);
        for (const name of (args.remove ?? []) as string[]) current.delete(name);
        next = [...current];
      }

      if (next.length === 0) {
        return {
          updated: false,
          message: "That would empty the watchlist, which the validator rejects. Keep at least one pair.",
        };
      }

      // Profiles for dropped pairs are kept deliberately: re-adding a pair
      // should restore its tuning, not silently hand it the globals. The
      // validator complains about orphans, so they are pruned from the COPY
      // that gets validated, not from what is saved.
      const merged = mergeParams(params, {
        instruments: next.sort(),
        notes: args.note ?? params.notes,
      });
      const problems = validateParams({
        ...merged,
        profiles: Object.fromEntries(
          Object.entries(merged.profiles ?? {}).filter(([key]) => next.includes(key))
        ),
      });
      if (problems.length) return { updated: false, problems };

      const file = saveParams(merged);
      const orphaned = Object.keys(merged.profiles ?? {}).filter((key) => !next.includes(key));

      return {
        updated: true,
        watchlist: merged.instruments,
        added: next.filter((name) => !params.instruments.includes(name)),
        removed: params.instruments.filter((name) => !next.includes(name)),
        dormantProfiles: orphaned.length
          ? `Kept (inactive) profiles for ${orphaned.join(", ")} — re-add the pair to use them again.`
          : undefined,
        file,
        nextStep:
          "Run oanda_rank_instruments to give the new pairs their own measured profiles; until " +
          "then they trade on the global parameters.",
      };
    }

    case "oanda_update_pair_strategy": {
      const instrument: string = args.instrument;
      if (!params.instruments.includes(instrument)) {
        return {
          updated: false,
          message:
            `${instrument} is not on the watchlist, so a profile for it would never apply. ` +
            `Add it first with oanda_update_watchlist.`,
        };
      }

      if (args.clear === true) {
        const cleared = mergeParams(params, { profiles: { [instrument]: null } });
        const problems = validateParams(cleared);
        if (problems.length) return { updated: false, problems };
        return {
          updated: true,
          instrument,
          profile: null,
          file: saveParams(cleared),
          message: `${instrument} now follows the global parameters. No other pair was touched.`,
        };
      }

      // Built as a partial: an unspecified field must stay exactly as it was,
      // because the entire point of this tool is that it changes one pair
      // without disturbing anything else — including that pair's other settings.
      const profile: Record<string, unknown> = {};
      if (Array.isArray(args.strategies)) {
        const wanted = new Set(args.strategies as string[]);
        if (wanted.size === 0) {
          return {
            updated: false,
            message:
              "An empty strategies list disables every strategy. Use disabled: true if that is " +
              "what you mean.",
          };
        }
        profile.trend = { enabled: wanted.has("trend") };
        profile.meanReversion = { enabled: wanted.has("meanReversion") };
        profile.breakout = { enabled: wanted.has("breakout") };
        // Two or more strategies with precedence selection is the configuration
        // that looks like multi-strategy and does not behave like it, so it is
        // upgraded unless the caller asked for something specific.
        if (wanted.size > 1 && !args.selection) profile.strategySelection = "conviction";
      }
      if (args.selection) profile.strategySelection = args.selection;
      if (args.granularity) profile.granularity = args.granularity;
      if (args.stopAtrMultiple !== undefined || args.takeProfitR !== undefined) {
        profile.entry = {
          ...(args.stopAtrMultiple !== undefined ? { stopAtrMultiple: args.stopAtrMultiple } : {}),
          ...(args.takeProfitR !== undefined ? { takeProfitR: args.takeProfitR } : {}),
        };
      }
      if (args.riskMultiplier !== undefined) profile.riskMultiplier = args.riskMultiplier;
      if (args.disabled !== undefined) profile.disabled = args.disabled;
      if (args.note) profile.notes = args.note;

      if (Object.keys(profile).length === 0) {
        return {
          updated: false,
          currentProfile: params.profiles?.[instrument] ?? null,
          effective: resolveParams(params, instrument),
          message: "Nothing to change. Pass strategies, selection, granularity, stops, risk or disabled.",
        };
      }

      const before = JSON.stringify(params.profiles ?? {});
      const next = mergeParams(params, { profiles: { [instrument]: profile } });
      const problems = validateParams(next);
      if (problems.length) return { updated: false, problems };

      const file = saveParams(next);
      const others = Object.keys(next.profiles ?? {}).filter((key) => key !== instrument);
      const othersUnchanged =
        JSON.stringify(Object.fromEntries(others.map((k) => [k, (JSON.parse(before) as any)[k]]))) ===
        JSON.stringify(Object.fromEntries(others.map((k) => [k, next.profiles[k]])));

      const resolved = resolveParams(next, instrument);
      return {
        updated: true,
        instrument,
        profile: next.profiles[instrument],
        effective: {
          granularity: resolved.granularity,
          strategySelection: resolved.strategySelection,
          strategies: [
            resolved.trend.enabled ? "trend" : null,
            resolved.meanReversion.enabled ? "meanReversion" : null,
            resolved.breakout.enabled ? "breakout" : null,
          ].filter(Boolean),
          stopAtrMultiple: resolved.entry.stopAtrMultiple,
          takeProfitR: resolved.entry.takeProfitR,
          riskPerTradePct: resolved.risk.riskPerTradePct,
        },
        otherPairsUnchanged: othersUnchanged,
        untouched: others,
        file,
        warning:
          Array.isArray(args.strategies) && args.strategies.length > 1
            ? "Multiple strategies on one pair trade more often. Backtest it with oanda_backtest " +
              "before leaving it running."
            : undefined,
      };
    }

    case "oanda_update_appetite": {
      const catalogue = Object.entries(APPETITE_PRESETS).map(([level, preset]) => ({
        level,
        current: params.appetite === level,
        summary: preset.summary,
        riskPerTradePct: preset.risk.riskPerTradePct,
        maxOpenRiskPct: preset.risk.maxOpenRiskPct,
        maxDailyLossPct: preset.risk.maxDailyLossPct,
        minConsensusScore: preset.consensus.minScore,
      }));

      if (!args.level) {
        return {
          current: params.appetite,
          levels: catalogue,
          message: "Pass level to change it. aggressive and max additionally need confirm: true.",
        };
      }

      const level = args.level as keyof typeof APPETITE_PRESETS;
      if (!APPETITE_PRESETS[level]) {
        return { updated: false, message: `Unknown level "${args.level}".`, levels: catalogue };
      }
      if ((level === "aggressive" || level === "max") && args.confirm !== true) {
        return {
          updated: false,
          level,
          wouldApply: APPETITE_PRESETS[level],
          message:
            `${level} risks ${APPETITE_PRESETS[level].risk.riskPerTradePct}% of NAV per trade with ` +
            `up to ${APPETITE_PRESETS[level].risk.maxOpenRiskPct}% open at once. Call again with ` +
            `confirm: true.`,
        };
      }

      const next = applyAppetite(params, level);
      const problems = validateParams(next);
      if (problems.length) return { updated: false, problems };

      return {
        updated: true,
        level,
        applied: {
          risk: next.risk,
          entry: {
            stopAtrMultiple: next.entry.stopAtrMultiple,
            takeProfitR: next.entry.takeProfitR,
            maxSpreadAtrRatio: next.entry.maxSpreadAtrRatio,
            trailAfterR: next.entry.trailAfterR,
          },
          consensus: next.consensus,
        },
        perPairOverridesKept: Object.keys(next.profiles ?? {}),
        file: saveParams(next),
        note:
          "Per-pair profiles are unchanged: a pair with its own stop multiple keeps it. The " +
          "appetite moves the globals and anything inheriting from them.",
      };
    }

    // -- Planning, reporting, autopilot -----------------------------------
    case "oanda_daily_plan":
      return await buildPlan(params, args);

    case "oanda_performance_report": {
      const count = Math.min(Math.max(args.count ?? 300, 1), 500);
      const now = new Date();
      let from: Date;
      let label: string;

      switch (args.period ?? "today") {
        case "week":
          from = new Date(now.getTime() - 7 * 86_400_000);
          label = "Last 7 days";
          break;
        case "month":
          from = new Date(now.getTime() - 30 * 86_400_000);
          label = "Last 30 days";
          break;
        case "custom":
          from = new Date(args.from ?? now.getTime() - 86_400_000);
          label = `${args.from ?? "?"} → ${args.to ?? "now"}`;
          break;
        default:
          // Local midnight, not 24 hours ago: "today" means the trading day the
          // user is looking at, not a rolling window.
          from = new Date(now);
          from.setHours(0, 0, 0, 0);
          label = "Today";
      }
      const to = args.period === "custom" && args.to ? new Date(args.to) : now;

      const [closed, open, summary] = await Promise.all([
        api.closedTrades(count),
        api.openTrades(),
        api.accountSummary(),
      ]);

      return buildPeriodReport({
        closed,
        open,
        params,
        currency: summary.currency,
        from,
        to,
        label,
      });
    }

    case "oanda_update_autopilot": {
      const auto = params.autopilot;
      const gate = autopilotGate(params, environment);

      const wantsFull = args.mode === "full" || (auto.mode === "full" && args.enabled === true);
      if ((wantsFull || args.allowLive === true) && args.confirm !== true) {
        return {
          updated: false,
          current: auto,
          gate,
          message:
            (args.allowLive === true
              ? "allowLive permits unattended orders with real money. "
              : "full mode opens positions with no human in the loop. ") +
            "Call again with confirm: true.",
        };
      }

      const patch: Record<string, unknown> = {};
      for (const key of [
        "enabled",
        "mode",
        "allowLive",
        "maxNewTradesPerDay",
        "maxActionsPerRun",
        "dailyLossStopPct",
        "breakEvenAtR",
        "trailAtrMultiple",
        "closeOnSignalInvalidation",
        "minConsensusScore",
      ]) {
        if (args[key] !== undefined) patch[key] = args[key];
      }

      if (args.disarm === true) patch.armedUntil = undefined;
      if (args.armForHours !== undefined) {
        const hours = Math.max(0, Math.min(Number(args.armForHours), 24));
        // Arming always expires. There is no "armed forever" value, because the
        // failure mode of this whole feature is a bot left running on a
        // forgotten config through a news event.
        patch.armedUntil = new Date(Date.now() + hours * 3_600_000).toISOString();
      }

      if (Object.keys(patch).length === 0) {
        return {
          current: auto,
          environment,
          gate,
          armingExpiresIn: auto.armedUntil
            ? `${((new Date(auto.armedUntil).getTime() - Date.now()) / 3_600_000).toFixed(1)}h`
            : "not armed",
          message:
            "Nothing changed. Pass enabled, mode, armForHours, or any limit. " +
            (gate.allowed
              ? "Autopilot IS currently allowed to open trades unattended."
              : `Autopilot cannot open trades: ${gate.reasons.join(" ")}`),
        };
      }

      const next = mergeParams(params, { autopilot: patch });
      // `undefined` survives a spread, so an explicit disarm has to delete.
      if (args.disarm === true) delete (next.autopilot as any).armedUntil;

      const problems = validateParams(next);
      if (problems.length) return { updated: false, problems };

      const file = saveParams(next);
      const after = autopilotGate(next, environment);
      return {
        updated: true,
        autopilot: next.autopilot,
        environment,
        gate: after,
        file,
        message: after.allowed
          ? `Autopilot armed: it may open trades unattended until ${next.autopilot.armedUntil}.`
          : `Saved. It still will not open trades unattended: ${after.reasons.join(" ")}`,
        scheduleHint:
          "Nothing runs on its own until a cron job calls oanda_autopilot_run. Use /autopilot " +
          "in the UI, or Settings → Scheduled jobs.",
      };
    }

    case "oanda_autopilot_run":
      return await runAutopilot(params, args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Daily plan
// ---------------------------------------------------------------------------

/**
 * Measured out-of-sample performance for one pair, per strategy.
 *
 * This is the "is this setup worth anything" half of the plan. It reuses
 * rankInstruments rather than inventing a second measurement path, so the
 * numbers in a plan and the numbers in a ranking always agree.
 */
async function measureEdges(
  instruments: string[],
  params: StrategyParams,
  candleCount: number,
  startingEquity: number
): Promise<Map<string, Map<string, MeasuredEdge>>> {
  const out = new Map<string, Map<string, MeasuredEdge>>();

  for (const instrument of instruments) {
    const perPair = resolveParams(params, instrument);
    try {
      const { series } = await buildSeries([instrument], perPair.granularity, candleCount, perPair);
      const { ranked } = rankInstruments(series, perPair, { startingEquity, minTrades: 8 });
      const entry = ranked[0];
      if (!entry) continue;

      const byStrategy = new Map<string, MeasuredEdge>();
      for (const score of entry.strategies) {
        byStrategy.set(score.strategy, {
          strategy: score.strategy,
          expectancyR: score.outOfSample.expectancyR,
          winRatePct: score.outOfSample.winRatePct,
          trades: score.outOfSample.trades,
          profitFactor: score.outOfSample.profitFactor,
        });
      }
      out.set(instrument, byStrategy);
    } catch {
      // A pair without enough history is priced on a prior instead. Failing the
      // whole plan because one instrument is thin would be worse.
    }
  }

  return out;
}

async function buildPlan(params: StrategyParams, args: Record<string, any>) {
  const instruments: string[] = args.instruments?.length
    ? args.instruments
    : activeInstruments(params);

  const scan = (await handle("oanda_market_scan", {
    instruments,
    includeNoSignal: false,
  })) as any;

  const summary = await api.accountSummary();
  const measure = args.measure !== false;
  const edges = measure
    ? await measureEdges(
        instruments,
        params,
        Math.min(Math.max(args.candles ?? 3000, 500), 20_000),
        summary.nav
      )
    : new Map<string, Map<string, MeasuredEdge>>();

  const candidates: PlanCandidate[] = [];
  for (const row of scan.instruments ?? []) {
    if (!row.signal || !row.sizing) continue;

    const risk = row.sizing.riskIfStopped;
    const reward =
      row.sizing.stopPips > 0 ? risk * (row.signal.targetPips / row.signal.stopPips) : 0;
    const vote = (row.strategyVotes?.candidates ?? []).find(
      (c: any) => c.strategy === row.signal.strategy
    );

    candidates.push({
      instrument: row.instrument,
      direction: row.signal.direction,
      strategy: row.signal.strategy,
      conviction: vote?.conviction ?? 50,
      consensusScore: row.consensus?.score ?? null,
      riskAmount: risk,
      rewardAmount: Number(reward.toFixed(2)),
      units: row.sizing.units,
      stopPips: row.signal.stopPips,
      targetPips: row.signal.targetPips,
      spreadPips: row.price?.spreadPips ?? 0,
      blockers: row.blockers ?? [],
      measured: edges.get(row.instrument)?.get(row.signal.strategy) ?? null,
    });
  }

  const plan = buildDailyPlan(candidates, {
    nav: summary.nav,
    currency: summary.currency,
    params,
    openRiskPct: scan.openRiskPct ?? 0,
  });

  return {
    ...plan,
    measured: measure,
    sessionClock: scan.sessionClock,
    scannedInstruments: instruments,
    howToAct:
      plan.recommended.length === 0
        ? "Nothing to place. Re-run after the next candle closes, or widen the watchlist with " +
          "oanda_list_instruments."
        : "Place these with oanda_create_order (confirm: true), or let oanda_autopilot_run do it " +
          "in full mode. Sizes above are already risk-based — do not round them up.",
  };
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

interface AutopilotAction {
  phase: "manage" | "enter";
  instrument: string;
  action: string;
  done: boolean;
  detail: string;
}

/**
 * One autopilot cycle.
 *
 * The order of the two phases is the whole safety argument. Managing what is
 * already open — moving a stop to break-even, trailing a winner, closing a
 * trade whose reason has evaporated — only ever REDUCES risk, so it runs
 * unconditionally and needs no arming. Opening new positions only ever ADDS
 * risk, so it runs last and only when every gate agrees.
 */
async function runAutopilot(params: StrategyParams, args: Record<string, any>) {
  const auto = params.autopilot;
  // A locked server cannot act, so the whole run degrades to a report rather
  // than attempting calls that will each come back refused. Without this the
  // manage phase would record "closed trade X" from a refusal object.
  const dryRun = args.dryRun === true || readOnly;
  const actions: AutopilotAction[] = [];
  const skipped: string[] = [];
  if (readOnly && args.dryRun !== true) {
    skipped.push("Server is locked read-only, so this run reports actions instead of taking them.");
  }

  const gate = autopilotGate(params, environment);

  // Checked before the first network call. A cron job firing every fifteen
  // minutes against a disabled autopilot should cost nothing at all.
  if (!auto.enabled) {
    return {
      ran: false,
      reason: "autopilot.enabled is false.",
      fix: "oanda_update_autopilot with enabled: true.",
      environment,
      gate,
    };
  }

  const [summary, openTrades] = await Promise.all([api.accountSummary(), api.openTrades()]);

  // The day's own loss stop, checked against realised AND unrealised: a book
  // that is 3% underwater on open trades is having a bad day whether or not it
  // has admitted it yet.
  const unrealised = openTrades.reduce((sum, trade) => sum + trade.unrealizedPL, 0);
  const dayDrawdownPct = summary.nav > 0 ? (-unrealised / summary.nav) * 100 : 0;
  const lossStopHit = dayDrawdownPct >= auto.dailyLossStopPct;

  // --- Phase 1: manage what is open ---------------------------------------
  let budget = auto.maxActionsPerRun;

  for (const trade of openTrades) {
    if (budget <= 0) {
      skipped.push(`Action budget (${auto.maxActionsPerRun}) spent before reaching ${trade.instrument}.`);
      break;
    }

    const perPair = resolveParams(params, trade.instrument);
    const spec = await api.instrumentSpec(trade.instrument);
    const isLong = trade.currentUnits > 0;
    const entry = trade.price;
    const stop = trade.stopLossPrice;

    const candles = (await api.candles(trade.instrument, perPair.granularity, 200)).filter(
      (candle) => candle.complete
    );
    if (candles.length < warmupBars(perPair)) {
      skipped.push(`${trade.instrument}: not enough candles to re-evaluate.`);
      continue;
    }
    const frame = computeIndicators(candles, perPair);
    const i = candles.length - 1;
    const currentAtr = frame.atr[i];
    const price = candles[i].close;

    // R progress measured against the trade's OWN stop, not a recomputed one:
    // the trade was sized on the stop it actually has.
    const riskDistance = stop !== null ? Math.abs(entry - stop) : currentAtr * perPair.entry.stopAtrMultiple;
    const moved = isLong ? price - entry : entry - price;
    const rProgress = riskDistance > 0 ? moved / riskDistance : 0;

    // 1a. Signal invalidation — close a trade whose reason has inverted.
    if (auto.closeOnSignalInvalidation) {
      const choice = selectSignal(candles, frame, i, perPair);
      const inverted =
        choice.signal && choice.signal.direction !== (isLong ? "long" : "short") && rProgress < 0.5;
      if (inverted) {
        budget--;
        if (dryRun) {
          actions.push({
            phase: "manage",
            instrument: trade.instrument,
            action: "close",
            done: false,
            detail: `Would close ${trade.id}: signal inverted to ${choice.signal!.direction}.`,
          });
        } else {
          const result = (await handle("oanda_close_trade", {
            tradeID: trade.id,
            confirm: true,
          })) as any;
          actions.push({
            phase: "manage",
            instrument: trade.instrument,
            action: "close",
            done: result?.closed === true,
            detail:
              `Closed ${trade.id}: the ${isLong ? "long" : "short"} signal inverted to ` +
              `${choice.signal!.direction} while only ${rProgress.toFixed(2)}R in front.`,
          });
        }
        continue;
      }
    }

    // 1b. Break-even, then trail. Both are stop MOVES in the safe direction
    // only — the update is skipped when it would loosen an existing stop.
    if (auto.breakEvenAtR > 0 && rProgress >= auto.breakEvenAtR) {
      const spreadPad = currentAtr * 0.05;
      const target =
        auto.trailAtrMultiple > 0
          ? isLong
            ? price - currentAtr * auto.trailAtrMultiple
            : price + currentAtr * auto.trailAtrMultiple
          : isLong
            ? entry + spreadPad
            : entry - spreadPad;

      const floor = isLong ? entry + spreadPad : entry - spreadPad;
      const wanted = isLong ? Math.max(target, floor) : Math.min(target, floor);
      const improves = stop === null || (isLong ? wanted > stop : wanted < stop);

      if (improves) {
        budget--;
        const rounded = Number(wanted.toFixed(spec.displayPrecision));
        if (dryRun) {
          actions.push({
            phase: "manage",
            instrument: trade.instrument,
            action: "stop",
            done: false,
            detail: `Would move ${trade.id} stop to ${rounded} (${rProgress.toFixed(2)}R in front).`,
          });
        } else {
          const moveResult = (await handle("oanda_update_trade_brackets", {
            tradeID: trade.id,
            stopLossPrice: rounded,
            confirm: true,
          })) as any;
          actions.push({
            phase: "manage",
            instrument: trade.instrument,
            action: "stop",
            done: moveResult?.refused !== true,
            detail:
              `Moved ${trade.id} stop ${stop === null ? "to" : "from " + stop + " to"} ${rounded} ` +
              `at ${rProgress.toFixed(2)}R — ` +
              (auto.trailAtrMultiple > 0 ? `trailing ${auto.trailAtrMultiple}×ATR.` : "break-even."),
          });
        }
      }
    }
  }

  // --- Phase 2: new risk ---------------------------------------------------
  const plan = (await buildPlan(params, { measure: false })) as any;
  const entriesBlocked: string[] = [];

  if (args.manageOnly === true) entriesBlocked.push("manageOnly was requested.");
  if (!gate.allowed) entriesBlocked.push(...gate.reasons);
  if (lossStopHit) {
    entriesBlocked.push(
      `Open positions are ${dayDrawdownPct.toFixed(2)}% underwater against a ` +
        `${auto.dailyLossStopPct}% daily stop.`
    );
  }
  if (readOnly) entriesBlocked.push("the oanda-trading server is locked read-only.");

  const wanted = (plan.recommended ?? []).filter(
    (opportunity: any) => (opportunity.consensusScore ?? 100) >= auto.minConsensusScore
  );
  const rejectedOnConsensus = (plan.recommended ?? []).length - wanted.length;

  if (entriesBlocked.length === 0) {
    let opened = 0;
    for (const opportunity of wanted) {
      if (opened >= auto.maxNewTradesPerDay) {
        skipped.push(`Daily new-trade cap (${auto.maxNewTradesPerDay}) reached.`);
        break;
      }
      if (budget <= 0) {
        skipped.push(`Action budget (${auto.maxActionsPerRun}) spent before entering ${opportunity.instrument}.`);
        break;
      }

      budget--;
      opened++;

      if (dryRun) {
        actions.push({
          phase: "enter",
          instrument: opportunity.instrument,
          action: "order",
          done: false,
          detail:
            `Would open ${opportunity.direction} ${opportunity.units} units ` +
            `(${opportunity.strategy}), risking ${opportunity.riskAmount}.`,
        });
        continue;
      }

      // Routed through the normal order tool, not a private path: every risk
      // check an interactive order passes must apply here too. An unattended
      // order should be the MOST checked one, not the least.
      const result = (await handle("oanda_create_order", {
        instrument: opportunity.instrument,
        direction: opportunity.direction,
        confirm: true,
      })) as any;

      actions.push({
        phase: "enter",
        instrument: opportunity.instrument,
        action: "order",
        done: result?.placed === true,
        detail: result?.placed
          ? `Opened ${opportunity.direction} ${result.plan?.units} units at ${result.fill?.price}, ` +
            `stop ${result.plan?.stopLossPrice}, target ${result.plan?.takeProfitPrice}.`
          : `Refused: ${(result?.blockers ?? [result?.rejection ?? result?.message]).join(" ")}`,
      });
    }
  }

  const performed = actions.filter((action) => action.done).length;
  return {
    ran: true,
    dryRun,
    environment,
    mode: auto.mode,
    gate,
    account: {
      nav: summary.nav,
      currency: summary.currency,
      openTrades: openTrades.length,
      unrealizedPL: Number(unrealised.toFixed(2)),
      dayDrawdownPct: Number(dayDrawdownPct.toFixed(2)),
      lossStopHit,
    },
    actions,
    actionsPerformed: performed,
    skipped,
    entriesBlocked,
    // Queued rather than placed is the managed-mode product: the work is done,
    // the decision is still the user's.
    queuedForApproval:
      entriesBlocked.length > 0
        ? (wanted as any[]).map((opportunity) => ({
            instrument: opportunity.instrument,
            direction: opportunity.direction,
            strategy: opportunity.strategy,
            units: opportunity.units,
            riskAmount: opportunity.riskAmount,
            expectedValue: opportunity.expectedValue,
            command:
              `oanda_create_order instrument=${opportunity.instrument} ` +
              `direction=${opportunity.direction} confirm=true`,
          }))
        : [],
    rejectedOnConsensus: rejectedOnConsensus || undefined,
    projection: plan.projection,
    summary:
      `${performed} action(s) taken. ` +
      (entriesBlocked.length
        ? `No new trades: ${entriesBlocked.join(" ")}` +
          ((wanted as any[]).length ? ` ${wanted.length} candidate(s) queued for approval.` : "")
        : `${actions.filter((a) => a.phase === "enter").length} entry attempt(s).`),
  };
}

/** Plain-language read of a metrics block, so the numbers are not just decoration. */
function interpret(metrics: {
  trades: number;
  expectancyR: number;
  profitFactor: number;
  winRatePct: number;
  maxDrawdownPct: number;
  longestLossStreak: number;
}): string[] {
  const lines: string[] = [];
  if (metrics.trades === 0) {
    return ["No trades were taken: the filters rejected every bar. Loosen them or lengthen the window."];
  }
  if (metrics.trades < 30) {
    lines.push(`${metrics.trades} trades is too small a sample to act on with confidence.`);
  }
  lines.push(
    metrics.expectancyR > 0
      ? `Positive expectancy: ${metrics.expectancyR}R per trade, profit factor ${metrics.profitFactor}.`
      : `Negative expectancy: ${metrics.expectancyR}R per trade. This parameter set loses money.`
  );
  lines.push(
    `Win rate ${metrics.winRatePct}% with a worst drawdown of ${metrics.maxDrawdownPct}% and a ` +
      `longest losing streak of ${metrics.longestLossStreak} trades — size for surviving that streak, not the average.`
  );
  if (metrics.maxDrawdownPct > 25) {
    lines.push("Drawdown above 25% is beyond what most people hold through; reduce risk per trade.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "oanda-trading", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handle(name, (args ?? {}) as Record<string, any>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // Errors here are usually actionable (bad instrument, insufficient margin,
    // read-only mode) so they belong in the model's context, not just a log.
    return {
      content: [{ type: "text", text: `Error in ${name}: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[oanda-trading] ready — ${environment} account ${accountID}, ` +
    `${readOnly ? "read-only" : "TRADING ENABLED"}, params ${paramsPath()}\n`
);
