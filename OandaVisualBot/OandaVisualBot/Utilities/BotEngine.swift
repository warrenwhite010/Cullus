//
//  BotEngine.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation
import Combine
import SwiftUI

@MainActor
public final class BotEngine: ObservableObject {
    
    private let client: OandaServiceProtocol
    private let portfolioManager: PortfolioAccountManager
    internal let dispatcher: MultiStrategyDispatcher
    private let accountID: String
    internal let coinbaseClient: CoinbaseExecutionClient?
    /// Starting watchlist. Replaced each cycle by whatever the shared parameter
    /// file says, so the model can change what the bot trades without a rebuild.
    private var targetInstruments: [String] = [
        "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "EUR_JPY","EUR_GBP", "USD_CHF",
        "BTC-USD", "ETH-USD"
    ]

    @Published var isRunning: Bool = false
    @Published var lastPrice: Double = 0.0
    @Published var lastLog: String = "Idle. Ready to start."
    @Published var orderCount: Int = 0
    @Published var marginAvailable: Double = 0.0
    @Published var activeTrades: [ActiveTradeInfo] = []
    @Published var nav: Double = 0.0
    @Published var dailyDrawdown: Double = 0.0
    @Published var apiLatencyMs: Int = 0
    @Published var watchlistItems: [WatchlistDisplayItem] = []
    
    private var task: Task<Void, Never>? = nil

    /// Trades whose partial take-profit has already been banked, so it happens
    /// once per trade rather than on every cycle the trade stays above 1R.
    private var scaledOutTradeIDs: Set<String> = []
    
    @ObservedObject public var botConfig: BotConfiguration
    
    public init(client: OandaServiceProtocol, coinbaseClient: CoinbaseExecutionClient? = nil, accountID: String, botConfig: BotConfiguration) {
        
        self.client = client
        self.accountID = accountID
        self.coinbaseClient = coinbaseClient
        self.botConfig = botConfig
        self.portfolioManager = PortfolioAccountManager(accountID: accountID, client: client)
        
        let config = BotConfiguration()
        let strategies: [TradingStrategy] = [
            TrendFollowingStrategy(config: config),
            MeanReversionStrategy(config: config),
            BreakoutScannerStrategy(config: config)
        ]
        
        // 3. Initialize the dispatcher
        self.dispatcher = MultiStrategyDispatcher(
            client: client,
            portfolioManager: portfolioManager,
            botConfig: botConfig, // Pass it down from BotEngine
            instruments: targetInstruments,
            strategies: strategies,
            accountID: accountID
        )
    }
    
    public func clearAllOrders() {
        Task {
            do {
                print("[BOT ENGINE] Emergency clear triggered: Fetching active trades and pending orders...")

                // 1. Flatten active open trades/positions, OLDEST FIRST.
                //
                // On a US account, closing a trade while an older one is open on
                // the same instrument is rejected with FIFO_VIOLATION — so an
                // emergency clear in API order could leave the newest positions
                // open precisely when the point was to be flat.
                let fetched = try await client.fetchActiveTrades(accountID: accountID)
                let trades = FIFOCompliance.fifoOrderedAll(fetched)
                for trade in trades {
                    try await client.cancelOrder(accountID: accountID, orderID: trade.tradeID)
                    print("[BOT ENGINE] Closed active trade/order ID: \(trade.tradeID)")
                    try await Task.sleep(nanoseconds: 300_000_000)
                }
                
                let pendingOrders = try await client.fetchPendingOrders(accountID: accountID)
                for order in pendingOrders {
                    try await client.cancelOrder(accountID: accountID, orderID: order.id)
                    print("[BOT ENGINE] Canceled pending limit order ID: \(order.id) for \(order.instrument)")
                    try await Task.sleep(nanoseconds: 300_000_000)
                }
                
                lastLog = "Emergency clear: All active positions and pending limit orders canceled."
                activeTrades = []
            } catch {
                print("[BOT ENGINE ERROR] Failed to clear all orders: \(error.localizedDescription)")
                lastLog = "Failed to clear orders: \(error.localizedDescription)"
            }
        }
    }
    
    public func runPollingLoop(currentAccountBalance: Double) async {
        // Risk per trade is a fraction of the live account, not a fixed $50 — the
        // whole point of sizing from NAV is that it scales both ways.
        let params = StrategyParameterStore.shared.current()
        let estimatedRiskPerTrade = currentAccountBalance * params.risk.riskPerTradePct / 100.0

        print("[BOT ENGINE] Starting multi-strategy dispatch cycle...")
        await dispatcher.executeDispatchCycle(
            currentAccountBalance: currentAccountBalance,
            estimatedRiskPerTrade: estimatedRiskPerTrade
        )
    }
    
    public func startBot() {
        guard !isRunning else { return }
        isRunning = true

        // Make sure the shared file exists, so the AssistantCLI MCP tools have
        // something to read and tune on the very first run.
        StrategyParameterStore.shared.writeDefaultsIfMissing()
        let params = StrategyParameterStore.shared.current()
        lastLog = "Bot started on \(params.granularity). "
            + "\(StrategyParameterStore.shared.lastLoadDescription)"

        task = Task {
            while isRunning {
                await executeTickCycle()
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000) // 60s interval
            }
        }
    }
    
    public func stopBot() {
        isRunning = false
        task?.cancel()
        lastLog = "Bot halted by user."
    }
        
    public func isWithinPeakLiquidityWindow(for instrument: String) -> Bool {
        // 1. Respect UI Toggle Override immediately
        if botConfig.ignoreLiquidityWindow {
            return true
        }
        
        let calendar = Calendar.current
        let hour = calendar.component(.hour, from: Date())
         
        if instrument.contains("-") {
            // Crypto (Coinbase/24-7 continuous execution)
            return true
        } else if instrument == "EUR_GBP" {
            // European afternoon session bridge: 12:00 PM - 16:00 EST
            return (12...16).contains(hour)
        } else if instrument.contains("JPY") || instrument.contains("AUD") || instrument.contains("NZD") {
            // Asian / Pacific Session: 19:00 to 04:00 EST
            return (19...23).contains(hour) || (0...4).contains(hour)
        } else {
            // Core Forex Majors (EUR, GBP): London / New York Overlap + Morning Push (07:00 to 16:00 EST)
            return (7...16).contains(hour)
        }
    }
    
    public func calculateAggressiveBrackets(entryPrice: Double, isLong: Bool, atr: Double) -> (stopLoss: String, takeProfit: String) {
        let slDistance = atr * 1.0
        let tpDistance = atr * 3.0
        
        return (String(format: "%.5f", slDistance), String(format: "%.5f", tpDistance))
    }
    
    /**
     Report — and optionally act on — the financing charge landing at 17:00 New York.

     What this replaced: a version that used `Calendar.current` (so it fired at
     16:55 in whatever timezone the machine happened to be set to, not New York),
     printed "Forcibly flattening trade ID: …" for every open trade, and then
     flattened nothing at all. Anyone reading that log would believe their
     positions had been closed before rollover.

     Now: the timing is New York time via the timezone database, the charge is
     computed from the account's real financing rates, and flattening only happens
     if `carry.flattenBeforeTripleRollover` is explicitly on. That default is off
     because closing on a schedule closes winners as readily as losers, and the
     financing saved is usually smaller than the move given up.
     */
    public func checkRolloverCutoff() async {
        let params = StrategyParameterStore.shared.current()
        guard !activeTrades.isEmpty else { return }

        var totalCharge = 0.0
        var tripleAhead = false
        var negativeCarry: [ActiveTradeInfo] = []
        var hoursUntil = Double.greatestFiniteMagnitude

        for trade in activeTrades {
            let perPair = params.resolved(for: trade.instrument)
            let financing = await FinancingCache.shared.financing(
                for: trade.instrument,
                accountID: accountID,
                client: client
            )
            let estimate = Financing.estimate(
                instrument: trade.instrument,
                financing: financing,
                isLong: trade.isLong,
                units: abs(trade.units),
                price: trade.currentPrice > 0 ? trade.currentPrice : trade.entryPrice,
                accountCurrency: MarketContext.shared.accountCurrency
            )

            totalCharge += estimate.atNextRollover
            hoursUntil = min(hoursUntil, estimate.rollover.hoursUntil)
            if estimate.rollover.isTripleCharge { tripleAhead = true }

            // Only worth acting on within the last hour: earlier than that, the
            // position still has time to reach its target.
            if estimate.costsMoney,
               estimate.rollover.hoursUntil <= 1.0,
               perPair.carry.flattenBeforeTripleRollover,
               estimate.rollover.isTripleCharge {
                negativeCarry.append(trade)
            }
        }

        guard hoursUntil <= 2.0 else { return }

        print(
            "[ROLLOVER] \(String(format: "%.1f", hoursUntil))h to 17:00 New York. "
            + "\(activeTrades.count) position(s) will "
            + (totalCharge < 0 ? "be charged " : "receive ")
            + String(format: "%.2f", abs(totalCharge))
            + (tripleAhead ? " (TRIPLED weekend rollover)." : ".")
        )

        for trade in negativeCarry {
            do {
                // Position endpoint, so the close is FIFO-safe.
                try await client.reducePosition(
                    accountID: accountID,
                    instrument: trade.instrument,
                    units: abs(trade.units),
                    isLong: trade.isLong
                )
                print("[ROLLOVER] Flattened \(trade.instrument) ahead of the tripled rollover.")
            } catch {
                print("[ROLLOVER] Failed to flatten \(trade.instrument): \(error.localizedDescription)")
            }
        }
    }
        
    /**
     One polling cycle.

     Order matters here, and it did not before:

      1. Re-read the shared parameters, so an MCP-side change lands this tick.
      2. Poll the account FIRST and publish it to `MarketContext`. Sizing used to
         run against a hardcoded `20000.0`, which meant every position was
         mis-sized the moment the real balance differed — by a factor of two on a
         10k account, and with no relationship to risk at all after a drawdown.
      3. Refresh live spreads, so the cost filter uses the real spread.
      4. Dispatch through `executeDispatchCycle`, which runs the actual strategies
         behind the risk vetoes.

     What is deliberately no longer called is `executeAdvancedDispatchCycle`. That
     path hardcoded `isLong: true` and `targetPrice: 1.08500` for every symbol, so
     it sent a fixed-price limit buy at 1.085 to USD_JPY, BTC-USD and everything
     else on every tick. It is left in the codebase for reference but must not run
     against a funded account.
     */
    private func executeTickCycle() async {
        var params = StrategyParameterStore.shared.current()
        params.clampToSafeRanges()
        // activeInstruments, not instruments: a pair a profile marked `disabled`
        // (usually because oanda_rank_instruments found no edge in it) must not be
        // scanned at all.
        let watchlist = params.activeInstruments
        if !watchlist.isEmpty {
            targetInstruments = watchlist
            dispatcher.updateInstruments(watchlist)
        }

        // Session state up front: when the market is shut there is nothing to do
        // but say so, and polling every instrument would be noise.
        let clock = TradingSessions.clock()
        if clock.weekendClosed && params.sessions.enforce {
            lastLog = "FX closed for the weekend (\(clock.newYorkTime) New York). Reopens Sunday 17:00 New York."
            self.watchlistItems = targetInstruments.map { instrument in
                WatchlistDisplayItem(
                    instrument: instrument,
                    strategyName: enabledStrategyLabel(params.resolved(for: instrument)),
                    indicatorStatus: "Market closed",
                    statusColor: .gray
                )
            }
            return
        }

        lastLog = "Polling account…"

        // --- 1. Real account state, before any sizing decision ---------------
        var currentAccountBalance = 0.0
        do {
            let startTime = CFAbsoluteTimeGetCurrent()
            let summary = try await portfolioManager.fetchAccountSummary()
            self.apiLatencyMs = Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000)

            let liveNav = Double(summary.nav) ?? 0.0
            let liveMargin = Double(summary.marginAvailable) ?? 0.0
            self.nav = liveNav
            self.marginAvailable = liveMargin
            self.dailyDrawdown = Double(summary.pl) ?? 0.0
            currentAccountBalance = liveNav

            let trades = try await client.fetchActiveTrades(accountID: accountID)
            self.activeTrades = trades
            dispatcher.releaseLocks(notHeldIn: Set(trades.map(\.instrument)))

            MarketContext.shared.setAccountIdentity(id: accountID, currency: "USD")
            MarketContext.shared.updateAccount(
                nav: liveNav,
                marginAvailable: liveMargin,
                marginUsed: max(0, liveNav - liveMargin),
                openTrades: trades
            )
        } catch {
            // Without NAV there is no risk-based size, so this cycle trades
            // nothing rather than guessing at a balance.
            print("[HUD] Account poll failed: \(error.localizedDescription). Skipping this cycle's entries.")
            lastLog = "Account poll failed — no trades this cycle. \(error.localizedDescription)"
            return
        }

        guard currentAccountBalance > 0 else {
            lastLog = "NAV reported as zero; refusing to size positions blind."
            return
        }

        lastLog = "Scanning \(targetInstruments.count) instruments…"

        var updatedWatchlist: [WatchlistDisplayItem] = []

        // --- 2. Per-instrument telemetry: real ATR, ADX and spread -----------
        var tradableInstruments: [String] = []

        for instrument in targetInstruments {
            // Per-pair parameters throughout: its own granularity, ATR period and
            // ADX thresholds, so the watchlist reflects what that pair is actually
            // being judged on.
            let perPair = params.resolved(for: instrument)
            let spec = InstrumentSpec.forInstrument(instrument)
            let session = TradingSessions.evaluate(
                instrument: instrument,
                enforce: perPair.sessions.enforce && perPair.enforceLiquidityWindow
                    && !botConfig.ignoreLiquidityWindow,
                blockRollover: perPair.sessions.blockRollover
            )

            // A live quote gives the cost filter the real spread instead of the
            // 1-pip constant that was assumed for every symbol, crypto included.
            if let quote = try? await client.fetchQuote(instrument: instrument), quote.spread > 0 {
                MarketContext.shared.updateSpread(quote.spread, for: instrument)
                self.lastPrice = quote.mid
            }

            var statusText: String
            var statusColor: Color

            if !session.tradeable {
                statusText = session.reason
                statusColor = .orange
            } else if let candles = try? await client.fetchCandles(
                instrument: instrument,
                granularity: perPair.granularity,
                count: perPair.warmupBars + 20
            ).filter(\.complete),
                      let atr = Indicators.atr(candles, period: perPair.entry.atrPeriod),
                      let close = candles.last?.close {
                let adx = Indicators.adx(candles, period: 14) ?? 0
                let atrPips = spec.pips(distance: atr)
                let spread = MarketContext.shared.effectiveSpread(for: instrument, atr: atr)
                let cost = RiskManager.spreadIsAcceptable(spread: spread, atr: atr, spec: spec, params: perPair)

                if !cost.ok {
                    statusText = "Cost filter: \(cost.reason)"
                    statusColor = .orange
                } else if adx >= perPair.trend.adxMin {
                    statusText = "Trending — ADX \(String(format: "%.0f", adx)), ATR \(String(format: "%.1f", atrPips))p"
                    statusColor = .green
                } else if adx <= perPair.meanReversion.adxMax {
                    statusText = "Ranging — ADX \(String(format: "%.0f", adx)), ATR \(String(format: "%.1f", atrPips))p"
                    statusColor = .secondary
                } else {
                    statusText = "Neutral — ADX \(String(format: "%.0f", adx))"
                    statusColor = .gray
                }
                self.lastPrice = close
            } else {
                statusText = "Awaiting candle data"
                statusColor = .gray
            }

            // A pair already holding a position cannot take another under FIFO,
            // so say that rather than showing a signal it cannot act on.
            let net = FIFOCompliance.netPosition(instrument: instrument, trades: activeTrades)
            if net != 0 && perPair.fifo.enabled {
                statusText = "Holding \(net > 0 ? "long" : "short") \(abs(net)) units — FIFO: no new entry"
                statusColor = .blue
            }

            if instrument.contains("-") && !botConfig.enableCoinbaseTrading {
                statusText = "Crypto routing disabled"
                statusColor = .gray
            } else if session.tradeable {
                tradableInstruments.append(instrument)
            }

            let label = params.profiles[instrument] != nil
                ? "\(enabledStrategyLabel(perPair)) · \(perPair.granularity)"
                : enabledStrategyLabel(perPair)

            updatedWatchlist.append(
                WatchlistDisplayItem(
                    instrument: instrument,
                    strategyName: label,
                    indicatorStatus: statusText,
                    statusColor: statusColor
                )
            )
        }

        // --- 2b. Manage what is already open ---------------------------------
        // Rollover first: it needs activeTrades, which only exist after the poll
        // above. The old code called it before the poll, so it always saw an
        // empty book.
        await checkRolloverCutoff()
        await manageOpenPositions(params: params)

        self.watchlistItems = updatedWatchlist

        // --- 3. Dispatch: real strategies, behind the risk vetoes ------------
        guard !tradableInstruments.isEmpty else {
            lastLog = "No instruments in an active window. Holding."
            return
        }

        dispatcher.updateInstruments(tradableInstruments)
        let riskPerTrade = currentAccountBalance * params.risk.riskPerTradePct / 100.0

        await dispatcher.executeDispatchCycle(
            currentAccountBalance: currentAccountBalance,
            estimatedRiskPerTrade: riskPerTrade
        )

        // Re-poll positions so the HUD reflects anything just opened.
        if let trades = try? await client.fetchActiveTrades(accountID: accountID) {
            self.activeTrades = trades
            self.orderCount = trades.count
        }

        lastLog = "Cycle complete — \(tradableInstruments.count) instrument(s) scanned, "
            + "\(activeTrades.count) position(s) open, risking "
            + "\(String(format: "%.2f", riskPerTrade)) per trade. "
            + StrategyParameterStore.shared.lastLoadDescription
    }

    /**
     Partial take-profit and stop ratcheting on open trades.

     Runs before new entries so that freeing risk from a winner can let the next
     setup through the portfolio-risk ceiling in the same cycle.

     Both features are off by default — see PositionManager for the measurements —
     so on stock settings this is a no-op that costs one plan() call.
     */
    private func manageOpenPositions(params: StrategyParameters) async {
        guard !activeTrades.isEmpty else { return }

        let actions = PositionManager.plan(
            trades: activeTrades,
            params: params,
            alreadyScaled: scaledOutTradeIDs
        )
        guard !actions.isEmpty else { return }

        for action in actions {
            switch action.kind {
            case .partialTakeProfit:
                // Closing through the position endpoint keeps this FIFO-safe: the
                // broker applies oldest-first, so a partial can never be rejected
                // for skipping an older trade.
                do {
                    try await client.reducePosition(
                        accountID: accountID,
                        instrument: action.instrument,
                        units: action.units,
                        isLong: activeTrades.first { $0.tradeID == action.tradeID }?.isLong ?? true
                    )
                    scaledOutTradeIDs.insert(action.tradeID)
                    print("[POSITION] Partial take-profit on \(action.instrument): \(action.rationale)")
                } catch {
                    print("[POSITION] Partial take-profit failed for \(action.instrument): \(error.localizedDescription)")
                }

            case .moveStopToBreakEven, .trailStop:
                do {
                    try await client.updateTradeStop(
                        accountID: accountID,
                        tradeID: action.tradeID,
                        stopPrice: action.stopPrice,
                        precision: InstrumentSpec.forInstrument(action.instrument).displayPrecision
                    )
                    print("[POSITION] \(action.instrument) stop → \(action.stopPrice): \(action.rationale)")
                } catch {
                    print("[POSITION] Stop update failed for \(action.instrument): \(error.localizedDescription)")
                }
            }
        }

        // Forget scale-out bookkeeping for trades that have since closed, so the
        // set cannot grow without bound across a long session.
        let live = Set(activeTrades.map(\.tradeID))
        scaledOutTradeIDs.formIntersection(live)
    }

    private func enabledStrategyLabel(_ params: StrategyParameters) -> String {
        var names: [String] = []
        if params.trend.enabled { names.append("Trend") }
        if params.meanReversion.enabled { names.append("Mean Reversion") }
        if params.breakout.enabled { names.append("Breakout") }
        return names.isEmpty ? "All strategies disabled" : names.joined(separator: " / ")
    }
}
