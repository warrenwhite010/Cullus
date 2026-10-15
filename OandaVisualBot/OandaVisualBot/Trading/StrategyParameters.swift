//
//  StrategyParameters.swift
//  OandaVisualBot
//
//  The bot's tunable parameters, loaded from a JSON file shared with the
//  AssistantCLI `oanda-trading` MCP server (default ~/.assistant/oanda-bot.json).
//
//  This is the seam that lets the AI model actually improve the bot instead of
//  only commenting on it: the model backtests a change, writes the file with
//  oanda_update_params, and the next polling cycle picks it up — no rebuild, no
//  restart. Keep this schema in step with src/mcp/oanda/params.ts.
//
//  Nothing here can place a trade. The worst a bad file can do is make the bot
//  more conservative, because unreadable JSON falls back to these defaults.
//

import Foundation

public struct RiskParameters: Codable, Sendable, Equatable {
    /// Percent of NAV risked if a single trade hits its stop.
    public var riskPerTradePct: Double = 0.5
    /// Ceiling on the sum of open risk, in percent of NAV.
    public var maxOpenRiskPct: Double = 3.0
    /// Stop opening trades once the day is this far down.
    public var maxDailyLossPct: Double = 2.0
    public var maxOpenTradesPerInstrument: Int = 1
    /// How many open trades may share one currency (EUR_USD + EUR_JPY = 2).
    public var maxTradesPerCurrency: Int = 2
    public var maxMarginUtilizationPct: Double = 40
}

public struct EntryParameters: Codable, Sendable, Equatable {
    public var atrPeriod: Int = 14
    /// Stop distance = stopAtrMultiple × ATR.
    public var stopAtrMultiple: Double = 1.5
    /// Target distance as a multiple of the stop (the R multiple).
    public var takeProfitR: Double = 2.0
    /// Ratchet the stop to break-even once the trade is this many R up. 0 = off.
    ///
    /// Defaults off: in backtests a stop parked at entry converted would-be
    /// winners into scratches and cost about 0.05R per trade.
    public var trailAfterR: Double = 0.0
    /// Refuse an entry when the spread exceeds this fraction of ATR.
    public var maxSpreadAtrRatio: Double = 0.15
    /// Skip instruments quieter than this: costs would eat the move.
    public var minAtrPips: Double = 3
    /// Close this fraction of the position at 1R. 0 = off.
    ///
    /// Off by default because it measured worse, not better: banking half at 1R
    /// caps the winners that pay for the losers without shrinking the losers
    /// (~0.16R → ~0.02R). Backtest it on your own pairs before switching it on.
    public var partialTakeProfitFraction: Double = 0.0
    /// After a partial fill, trail the remainder by this × ATR.
    public var runnerTrailAtrMultiple: Double = 2.0
}

public struct FifoParameters: Codable, Sendable, Equatable {
    /// US-regulated accounts cannot hedge and must close oldest-first.
    public var enabled: Bool = true
    /// Permit an opposite-direction order that reduces or closes a position.
    public var allowReducingOrders: Bool = false
}

public struct SessionParameters: Codable, Sendable, Equatable {
    /// Restrict entries to the sessions each instrument actually trades well in.
    public var enforce: Bool = true
    /// Refuse entries around 17:00 New York, when spreads blow out for rollover.
    public var blockRollover: Bool = true
    /// Scale size by the session's liquidity score instead of trading all-or-nothing.
    public var scaleSizeByLiquidity: Bool = true
}

public struct CarryParameters: Codable, Sendable, Equatable {
    /// Price financing against the trade's risk before entering.
    ///
    /// Distinct from `sessions.blockRollover`, which is about the SPREAD widening
    /// around 17:00 New York. This is about the CHARGE applied at 17:00 to every
    /// position open at that instant — a different cost with a different fix.
    public var enabled: Bool = true
    /// Refuse an entry when the next rollover's financing exceeds this fraction
    /// of the trade's risk. 0 disables the check.
    public var maxCarryFractionOfRisk: Double = 0.10
    /// Refuse negative-carry entries within this many hours of the TRIPLED
    /// rollover. Paying three days of interest for two hours of exposure is the
    /// specific mistake this prevents.
    public var avoidTripleRolloverHours: Double = 2
    /// Close negative-carry positions shortly before the tripled rollover.
    ///
    /// Off by default: flattening on a schedule closes winners as readily as
    /// losers, and the financing saved is usually smaller than the move given up.
    /// The old checkRolloverCutoff() printed "Forcibly flattening" and did
    /// nothing at all — this is the real switch, and it is a deliberate choice.
    public var flattenBeforeTripleRollover: Bool = false
}

public struct ConsensusParameters: Codable, Sendable, Equatable {
    public var enabled: Bool = true
    /// Timeframes to poll. The instrument's own granularity is always primary.
    public var timeframes: [String] = ["M15", "H1", "H4"]
    /// Minimum absolute score (0–100) needed to take a trade.
    public var minScore: Double = 35
    /// Refuse when a higher timeframe's trend points the other way.
    public var requireHigherTimeframeAlignment: Bool = true
}

public struct TrendParameters: Codable, Sendable, Equatable {
    public var enabled: Bool = true
    public var smaFast: Int = 20
    public var smaSlow: Int = 50
    public var adxMin: Double = 20
}

public struct MeanReversionParameters: Codable, Sendable, Equatable {
    public var enabled: Bool = true
    public var rsiPeriod: Int = 14
    public var rsiBuyBelow: Double = 30
    public var rsiSellAbove: Double = 70
    /// Never fade a market trending harder than this.
    public var adxMax: Double = 25
    public var requireTrendAlignment: Bool = true
}

public struct BreakoutParameters: Codable, Sendable, Equatable {
    public var enabled: Bool = true
    public var lookback: Int = 40
    public var adxMin: Double = 18
}

/**
 A per-instrument override of any section below.

 This is what makes "EUR_USD trades trend, USD_JPY only fades, GBP_JPY is not
 worth trading at all" expressible. Without it every pair is scanned with the
 same ADX threshold and stop multiple, which is the wrong default: majors trend,
 crosses range, and their ATRs differ by an order of magnitude.

 Generate these with the MCP `oanda_rank_instruments` tool rather than by hand —
 a profile fitted by eye is curve-fitting with extra steps.
 */
public struct InstrumentProfile: Codable, Sendable, Equatable {
    public var notes: String?
    /// Stop trading this pair without losing its settings.
    public var disabled: Bool?
    public var granularity: String?
    public var entry: EntryParameters?
    public var carry: CarryParameters?
    public var trend: TrendParameters?
    public var meanReversion: MeanReversionParameters?
    public var breakout: BreakoutParameters?
    public var consensus: ConsensusParameters?
    /// Multiply this pair's risk. Clamped to [0.25, 1.5].
    public var riskMultiplier: Double?

    public init() {}
}

public struct StrategyParameters: Codable, Sendable, Equatable {
    public var version: Int = 1
    public var notes: String = ""
    public var granularity: String = "M15"
    public var instruments: [String] = [
        "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CHF", "EUR_JPY"
    ]
    public var risk = RiskParameters()
    public var entry = EntryParameters()
    public var trend = TrendParameters()
    public var meanReversion = MeanReversionParameters()
    public var breakout = BreakoutParameters()
    public var fifo = FifoParameters()
    public var sessions = SessionParameters()
    public var carry = CarryParameters()
    public var consensus = ConsensusParameters()
    /// Per-instrument overrides, keyed by instrument.
    public var profiles: [String: InstrumentProfile] = [:]
    public var enforceLiquidityWindow: Bool = true

    public init() {}

    /// Instruments to trade: the watchlist minus anything a profile disabled.
    public var activeInstruments: [String] {
        instruments.filter { profiles[$0]?.disabled != true }
    }

    /**
     Effective parameters for one instrument.

     Every per-instrument read must go through this, or the profile silently does
     nothing — which is the failure mode where per-pair tuning appears to be
     configured and has no effect.
     */
    public func resolved(for instrument: String) -> StrategyParameters {
        guard let profile = profiles[instrument] else { return self }

        var copy = self
        if let granularity = profile.granularity { copy.granularity = granularity }
        if let entry = profile.entry { copy.entry = entry }
        if let carry = profile.carry { copy.carry = carry }
        if let trend = profile.trend { copy.trend = trend }
        if let meanReversion = profile.meanReversion { copy.meanReversion = meanReversion }
        if let breakout = profile.breakout { copy.breakout = breakout }
        if let consensus = profile.consensus { copy.consensus = consensus }
        if let multiplier = profile.riskMultiplier {
            copy.risk.riskPerTradePct *= min(max(multiplier, 0.25), 1.5)
        }
        copy.clampToSafeRanges()
        return copy
    }

    /// Bars of history needed before any signal from this parameter set is real.
    public var warmupBars: Int {
        max(trend.smaSlow, trend.smaFast, breakout.lookback, entry.atrPeriod, meanReversion.rsiPeriod, 28) + 2
    }

    /**
     Clamp values that would be dangerous regardless of strategy.

     Not taste — arithmetic. 25% risk per trade is ruin in four losses, and a
     stop inside a fifth of the ATR is a guaranteed stop-out. Since the file can
     be rewritten by a model, the app refuses to honour a lethal value even if
     something upstream let it through.
     */
    public mutating func clampToSafeRanges() {
        risk.riskPerTradePct = min(max(risk.riskPerTradePct, 0.01), 2.0)
        risk.maxOpenRiskPct = min(max(risk.maxOpenRiskPct, risk.riskPerTradePct), 10.0)
        risk.maxDailyLossPct = min(max(risk.maxDailyLossPct, 0.25), 10.0)
        risk.maxOpenTradesPerInstrument = min(max(risk.maxOpenTradesPerInstrument, 1), 5)
        risk.maxTradesPerCurrency = min(max(risk.maxTradesPerCurrency, 1), 6)
        risk.maxMarginUtilizationPct = min(max(risk.maxMarginUtilizationPct, 1), 80)

        entry.atrPeriod = min(max(entry.atrPeriod, 2), 200)
        entry.stopAtrMultiple = min(max(entry.stopAtrMultiple, 0.3), 10)
        entry.takeProfitR = min(max(entry.takeProfitR, 0.3), 10)
        entry.trailAfterR = min(max(entry.trailAfterR, 0), 10)
        entry.maxSpreadAtrRatio = min(max(entry.maxSpreadAtrRatio, 0.01), 1.0)
        entry.minAtrPips = min(max(entry.minAtrPips, 0), 500)
        // 1.0 would close the entire position at 1R, which is just takeProfitR = 1
        // with extra steps — and would leave a zero-unit "runner".
        entry.partialTakeProfitFraction = min(max(entry.partialTakeProfitFraction, 0), 0.9)
        entry.runnerTrailAtrMultiple = min(max(entry.runnerTrailAtrMultiple, 0), 10)

        // A FIFO account cannot exit a second trade on the same instrument
        // independently, so more than one is a rejected order waiting to happen.
        if fifo.enabled {
            risk.maxOpenTradesPerInstrument = 1
        }

        carry.maxCarryFractionOfRisk = min(max(carry.maxCarryFractionOfRisk, 0), 2)
        carry.avoidTripleRolloverHours = min(max(carry.avoidTripleRolloverHours, 0), 24)

        consensus.minScore = min(max(consensus.minScore, 0), 100)
        if consensus.timeframes.isEmpty {
            consensus.timeframes = ["M15", "H1", "H4"]
        }

        trend.smaFast = min(max(trend.smaFast, 2), 400)
        trend.smaSlow = min(max(trend.smaSlow, trend.smaFast + 1), 500)
        meanReversion.rsiPeriod = min(max(meanReversion.rsiPeriod, 2), 100)
        breakout.lookback = min(max(breakout.lookback, 5), 400)
    }
}

/// Loads the shared parameter file, re-reading only when it changes on disk.
public final class StrategyParameterStore: @unchecked Sendable {
    public static let shared = StrategyParameterStore()

    private let lock = NSLock()
    private var cached = StrategyParameters()
    private var cachedModified: Date?
    private var loadedOnce = false

    public private(set) var lastLoadDescription: String = "Defaults (file not read yet)."

    public var fileURL: URL {
        if let override = ProcessInfo.processInfo.environment["OANDA_BOT_PARAMS_PATH"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".assistant")
            .appendingPathComponent("oanda-bot.json")
    }

    private init() {}

    /**
     Current parameters.

     Cheap enough to call at the top of every cycle: it stats the file and only
     re-decodes when the modification date moved. That is what makes an MCP
     parameter change take effect on the next tick.
     */
    public func current() -> StrategyParameters {
        lock.lock()
        defer { lock.unlock() }

        let url = fileURL
        let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date

        if loadedOnce, modified == cachedModified {
            return cached
        }

        loadedOnce = true
        cachedModified = modified

        guard let data = try? Data(contentsOf: url) else {
            cached = StrategyParameters()
            lastLoadDescription = "No parameter file at \(url.path); using built-in defaults."
            return cached
        }

        do {
            var decoded = try JSONDecoder().decode(StrategyParameters.self, from: data)
            decoded.clampToSafeRanges()
            cached = decoded
            lastLoadDescription = "Loaded \(url.lastPathComponent) (risk \(decoded.risk.riskPerTradePct)%/trade, stop \(decoded.entry.stopAtrMultiple)×ATR, \(decoded.entry.takeProfitR)R target)."
        } catch {
            // Keep whatever was last valid rather than adopting a half-decoded
            // parameter set: a partially applied risk change is worse than none.
            lastLoadDescription = "Could not decode \(url.path) (\(error.localizedDescription)); keeping previous parameters."
        }
        return cached
    }

    /// Write the current parameters out, so a fresh install has a file to edit.
    public func writeDefaultsIfMissing() {
        let url = fileURL
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            var defaults = StrategyParameters()
            defaults.notes = "Written by OandaVisualBot. Tune via the AssistantCLI oanda_update_params tool."
            try encoder.encode(defaults).write(to: url)
            print("[PARAMS] Wrote default parameters to \(url.path)")
        } catch {
            print("[PARAMS] Could not write defaults to \(url.path): \(error.localizedDescription)")
        }
    }
}
