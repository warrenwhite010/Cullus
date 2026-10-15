//
//  Strategies.swift
//  OandaVisualBot
//
//  Trend, mean-reversion and breakout entries.
//
//  What changed, and why each change is a money change rather than a style one:
//
//   * Shorts exist. Every strategy here was long-only (`current > sma`), which
//     discards half of every edge and guarantees the bot fights any downtrend.
//   * Stops and targets are ATR multiples converted through InstrumentSpec, not
//     the literal strings "0.0020"/"0.0040". That constant was 20 pips on
//     EUR_USD and 0.2 pips on USD_JPY, so every JPY order was either rejected by
//     the broker or stopped out inside the spread.
//   * Size comes from RiskManager against live NAV, not a fixed 500 units.
//   * ADX gates every entry: no fading a strong trend, no "breakouts" in a dead
//     range.
//   * A spread-versus-ATR filter refuses bars where costs eat the expected move.
//
//  Signals are returned as SIGNED units — negative means short — which is what
//  the dispatcher and the v20 API already expect.
//

import Foundation

/// Shared plumbing: one place that turns "I want to be long here" into a sized,
/// correctly-formatted, risk-checked order tuple.
public enum StrategySupport {

    public typealias Decision = (
        shouldTrade: Bool,
        units: Int,
        stopLoss: String,
        takeProfit: String,
        isLimit: Bool,
        targetPrice: Double?
    )

    public static let noTrade: Decision = (false, 0, "", "", false, nil)

    public struct Setup {
        let candles: [Candle]
        let closes: [Double]
        let spec: InstrumentSpec
        let atr: Double
        let adx: Double
        /// Resolved for this instrument, profile included.
        let params: StrategyParameters
        let price: Double
        let session: SessionVerdict
        /// Kept so the consensus check can fetch higher timeframes at decision time.
        let client: OandaServiceProtocol
    }

    /// Load and validate everything a strategy needs, or nil when the bar is not
    /// tradeable for reasons no strategy should have to re-check.
    public static func prepare(
        instrument: String,
        client: OandaServiceProtocol,
        extraBars: Int = 40
    ) async throws -> Setup? {
        // This instrument's OWN parameters. Reading the globals here is what made
        // per-pair profiles look configured while doing nothing.
        let params = StrategyParameterStore.shared.current().resolved(for: instrument)
        let spec = InstrumentSpec.forInstrument(instrument)
        let needed = params.warmupBars + extraBars

        // Session gate before any candle fetch: no point analysing a market that
        // is shut, mid-rollover, or outside this pair's own liquid hours.
        let session = TradingSessions.evaluate(
            instrument: instrument,
            enforce: params.sessions.enforce && params.enforceLiquidityWindow,
            blockRollover: params.sessions.blockRollover
        )
        guard session.tradeable else {
            print("[SESSION] \(instrument) skipped: \(session.reason)")
            return nil
        }

        let raw = try await client.fetchCandles(
            instrument: instrument,
            granularity: params.granularity,
            count: needed
        )
        // Never evaluate on the forming bar: its high, low and close are not final.
        let candles = raw.filter(\.complete)
        guard candles.count >= params.warmupBars, let latest = candles.last else { return nil }

        guard let atr = Indicators.atr(candles, period: params.entry.atrPeriod) else { return nil }
        let adx = Indicators.adx(candles, period: 14) ?? 0

        // Cost gate. Uses a live quote when the engine has one from this cycle.
        let spread = MarketContext.shared.effectiveSpread(for: instrument, atr: atr)
        let cost = RiskManager.spreadIsAcceptable(spread: spread, atr: atr, spec: spec, params: params)
        guard cost.ok else {
            print("[STRATEGY] \(instrument) skipped: \(cost.reason)")
            return nil
        }

        return Setup(
            candles: candles,
            closes: candles.map(\.close),
            spec: spec,
            atr: atr,
            adx: adx,
            params: params,
            price: latest.close,
            session: session,
            client: client
        )
    }

    /**
     Turn a direction into a sized order, or into `noTrade` with a printed reason.

     Every veto the risk layer knows about is applied here, so a strategy cannot
     accidentally bypass the daily loss limit or the correlation cap by being
     written carelessly.
     */
    public static func decide(
        instrument: String,
        isLong: Bool,
        setup: Setup,
        rationale: String
    ) async -> Decision {
        let snapshot = MarketContext.shared.account()
        let params = setup.params

        // FIFO first. On a US account an opposite-direction order does not open a
        // hedge, it reduces or flattens the position — so this has to be checked
        // before anything else, or a short signal silently closes a winning long.
        let fifo = FIFOCompliance.checkEntry(
            instrument: instrument,
            isLong: isLong,
            trades: snapshot.openTrades,
            enabled: params.fifo.enabled,
            allowReducingOrders: params.fifo.allowReducingOrders
        )
        guard fifo.allowed else {
            print("[FIFO] \(instrument) \(isLong ? "long" : "short") blocked: \(fifo.reasons.joined(separator: " "))")
            return noTrade
        }

        let veto = RiskManager.vetoNewTrade(instrument: instrument, snapshot: snapshot, params: params)
        guard veto.allowed else {
            print("[RISK] \(instrument) \(isLong ? "long" : "short") blocked: \(veto.reasons.joined(separator: " "))")
            return noTrade
        }

        // Multi-timeframe consensus. The costliest trades this bot took were
        // 15-minute signals against the 4-hour trend; this is the gate that
        // refuses them.
        if params.consensus.enabled {
            let consensus = await ConsensusEngine.evaluate(
                instrument: instrument,
                client: setup.client,
                params: params
            )
            let permission = consensus.permits(isLong: isLong, params: params)
            guard permission.ok else {
                print("[CONSENSUS] \(instrument) \(isLong ? "long" : "short") blocked: \(permission.reason)")
                return noTrade
            }
            print("[CONSENSUS] \(instrument) confirmed: \(permission.reason)")
        }

        let stopDistance = setup.atr * params.entry.stopAtrMultiple
        let takeProfitDistance = stopDistance * params.entry.takeProfitR

        // Thin sessions get smaller size rather than a binary skip.
        let liquidityScale = params.sessions.scaleSizeByLiquidity
            ? min(1.0, setup.session.liquidityScore)
            : 1.0

        let size = RiskManager.size(
            nav: snapshot.nav,
            riskPerTradePct: params.risk.riskPerTradePct * liquidityScale,
            stopDistance: stopDistance,
            spec: setup.spec,
            isLong: isLong,
            marginAvailable: snapshot.marginAvailable,
            entryPrice: setup.price,
            maxMarginUtilizationPct: params.risk.maxMarginUtilizationPct
        )

        guard size.units > 0 else {
            print("[RISK] \(instrument) sized to zero. \(size.notes.joined(separator: " "))")
            return noTrade
        }

        // Financing. Separate from the rollover-spread block in prepare(): this is
        // the CHARGE applied at 17:00 New York to whatever is still open, tripled
        // on one weekday. Priced against risk, because the raw figure is
        // meaningless on its own.
        if params.carry.enabled {
            let financing = await FinancingCache.shared.financing(
                for: instrument,
                accountID: MarketContext.shared.accountID,
                client: setup.client
            )
            let estimate = Financing.estimate(
                instrument: instrument,
                financing: financing,
                isLong: isLong,
                units: size.units,
                price: setup.price,
                riskAmount: size.riskIfStopped,
                accountCurrency: MarketContext.shared.accountCurrency
            )
            let verdict = Financing.check(estimate, params: params.carry)
            guard verdict.ok else {
                print("[CARRY] \(instrument) \(isLong ? "long" : "short") blocked: \(verdict.reasons.joined(separator: " "))")
                return noTrade
            }
            if estimate.costsMoney {
                print("[CARRY] \(instrument): \(estimate.summary)")
            }
        }

        print(
            "[SIGNAL] \(instrument) \(isLong ? "LONG" : "SHORT") \(size.units) units — \(rationale) "
            + "Stop \(String(format: "%.1f", size.stopPips)) pips, risking "
            + "\(String(format: "%.2f", size.riskIfStopped)) of \(String(format: "%.2f", snapshot.nav)) NAV. "
            + "Session: \(setup.session.reason)"
        )

        return (
            shouldTrade: true,
            units: size.signedUnits,
            stopLoss: setup.spec.format(stopDistance),
            takeProfit: setup.spec.format(takeProfitDistance),
            isLimit: false,
            targetPrice: nil
        )
    }
}

// MARK: - Trend following

public final class TrendFollowingStrategy: TradingStrategy, Sendable {
    public let strategyName = "TrendFollowing"
    public let preferredExecutionMode: OrderExecutionPreference = .preferMarket
    private let config: BotConfiguration

    public init(config: BotConfiguration) {
        self.config = config
    }

    public func evaluate(instrument: String, client: OandaServiceProtocol) async throws -> StrategySupport.Decision {
        guard let setup = try await StrategySupport.prepare(instrument: instrument, client: client) else {
            return StrategySupport.noTrade
        }
        let params = setup.params
        guard params.trend.enabled else { return StrategySupport.noTrade }

        let fast = Indicators.smaSeries(setup.closes, period: params.trend.smaFast)
        let slow = Indicators.smaSeries(setup.closes, period: params.trend.smaSlow)
        let i = setup.closes.count - 1
        guard i >= 1,
              fast[i].isFinite, slow[i].isFinite,
              fast[i - 1].isFinite, slow[i - 1].isFinite else {
            return StrategySupport.noTrade
        }

        // Confluence gate: a trend entry without trend strength is a coin flip
        // with a spread attached.
        if !config.ignoreConfluenceGates && setup.adx < params.trend.adxMin {
            return StrategySupport.noTrade
        }

        // The *cross*, not merely "fast above slow" — holding a stale side is how
        // a trend filter degenerates into buying every high.
        let crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]
        let crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]
        guard crossedUp || crossedDown else { return StrategySupport.noTrade }

        return await StrategySupport.decide(
            instrument: instrument,
            isLong: crossedUp,
            setup: setup,
            rationale: "SMA\(params.trend.smaFast) crossed \(crossedUp ? "above" : "below") "
                + "SMA\(params.trend.smaSlow), ADX \(String(format: "%.1f", setup.adx))."
        )
    }
}

// MARK: - Mean reversion

public final class MeanReversionStrategy: TradingStrategy, Sendable {
    public let strategyName = "MeanReversion"
    public let preferredExecutionMode: OrderExecutionPreference = .preferMarket
    private let config: BotConfiguration

    public init(config: BotConfiguration) {
        self.config = config
    }

    public func evaluate(instrument: String, client: OandaServiceProtocol) async throws -> StrategySupport.Decision {
        guard let setup = try await StrategySupport.prepare(instrument: instrument, client: client) else {
            return StrategySupport.noTrade
        }
        let params = setup.params
        guard params.meanReversion.enabled else { return StrategySupport.noTrade }

        guard let rsi = Indicators.rsi(setup.closes, period: params.meanReversion.rsiPeriod) else {
            return StrategySupport.noTrade
        }

        // Do not fade a market that is trending hard. The old code used a
        // min/max position proxy with no strength filter at all, which fades
        // every strong move — the most reliable way to lose money slowly.
        if !config.ignoreConfluenceGates && setup.adx > params.meanReversion.adxMax {
            return StrategySupport.noTrade
        }

        let slow = Indicators.sma(setup.closes, period: params.trend.smaSlow)
        let requireAlignment = params.meanReversion.requireTrendAlignment && !config.ignoreConfluenceGates

        if rsi < params.meanReversion.rsiBuyBelow {
            // Buy dips, but only dips inside an uptrend.
            if requireAlignment, let slow, setup.price < slow { return StrategySupport.noTrade }
            return await StrategySupport.decide(
                instrument: instrument,
                isLong: true,
                setup: setup,
                rationale: "RSI \(String(format: "%.1f", rsi)) below \(params.meanReversion.rsiBuyBelow), "
                    + "ADX \(String(format: "%.1f", setup.adx))."
            )
        }

        if rsi > params.meanReversion.rsiSellAbove {
            if requireAlignment, let slow, setup.price > slow { return StrategySupport.noTrade }
            return await StrategySupport.decide(
                instrument: instrument,
                isLong: false,
                setup: setup,
                rationale: "RSI \(String(format: "%.1f", rsi)) above \(params.meanReversion.rsiSellAbove), "
                    + "ADX \(String(format: "%.1f", setup.adx))."
            )
        }

        return StrategySupport.noTrade
    }
}

// MARK: - Breakout

public final class BreakoutScannerStrategy: TradingStrategy, Sendable {
    public let strategyName = "BreakoutScanner"
    public let preferredExecutionMode: OrderExecutionPreference = .preferMarket
    private let config: BotConfiguration

    public init(config: BotConfiguration) {
        self.config = config
    }

    public func evaluate(instrument: String, client: OandaServiceProtocol) async throws -> StrategySupport.Decision {
        guard let setup = try await StrategySupport.prepare(instrument: instrument, client: client) else {
            return StrategySupport.noTrade
        }
        let params = setup.params
        guard params.breakout.enabled else { return StrategySupport.noTrade }

        guard let channel = Indicators.donchian(setup.candles, period: params.breakout.lookback) else {
            return StrategySupport.noTrade
        }
        if !config.ignoreConfluenceGates && setup.adx < params.breakout.adxMin {
            return StrategySupport.noTrade
        }

        // The channel is built from the PREVIOUS bars only, so the breakout bar
        // cannot be part of its own range.
        if setup.price > channel.upper {
            return await StrategySupport.decide(
                instrument: instrument,
                isLong: true,
                setup: setup,
                rationale: "Close broke the \(params.breakout.lookback)-bar high "
                    + "\(setup.spec.format(channel.upper)), ADX \(String(format: "%.1f", setup.adx))."
            )
        }
        if setup.price < channel.lower {
            return await StrategySupport.decide(
                instrument: instrument,
                isLong: false,
                setup: setup,
                rationale: "Close broke the \(params.breakout.lookback)-bar low "
                    + "\(setup.spec.format(channel.lower)), ADX \(String(format: "%.1f", setup.adx))."
            )
        }

        return StrategySupport.noTrade
    }
}
