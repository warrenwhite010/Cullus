//
//  MultiStrategyDispatcher.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/2/26.
//

import Foundation

public protocol TradingStrategy: Sendable {
    var strategyName: String { get }
    var preferredExecutionMode: OrderExecutionPreference { get }
    func evaluate(instrument: String, client: OandaServiceProtocol) async throws -> (shouldTrade: Bool, units: Int, stopLoss: String, takeProfit: String, isLimit: Bool, targetPrice: Double?)
}

public enum OrderExecutionPreference: Sendable {
    case preferLimit
    case preferMarket
}

public final class MultiStrategyDispatcher {
    internal let client: OandaServiceProtocol
    internal let portfolioManager: PortfolioAccountManager
    internal let botConfig: BotConfiguration
    private var instruments: [String]
    private let strategies: [TradingStrategy]
    internal let accountID: String
    
    private var recentlyDispatchedInstruments: Set<String> = []
    private let lockQueue = DispatchQueue(label: "com.rutzllc.dispatcher.lock", attributes: .concurrent)

    public init(
        client: OandaServiceProtocol,
        portfolioManager: PortfolioAccountManager,
        botConfig: BotConfiguration,
        instruments: [String],
        strategies: [TradingStrategy],
        accountID: String
    ) {
        self.client = client
        self.portfolioManager = portfolioManager
        self.botConfig = botConfig
        self.instruments = instruments
        self.strategies = strategies
        self.accountID = accountID
    }

    /// Adopt the watchlist from the shared parameter file, so editing it via the
    /// MCP `oanda_update_params` tool changes what the bot trades on the next
    /// cycle rather than at the next rebuild.
    public func updateInstruments(_ updated: [String]) {
        guard !updated.isEmpty, updated != instruments else { return }
        instruments = updated
        print("[DISPATCHER] Watchlist updated to: \(updated.joined(separator: ", "))")
    }

    /// The instruments currently being scanned.
    public var watchlist: [String] { instruments }

    /// Clear a per-instrument dispatch lock once its position is gone, so the bot
    /// can trade the same pair again later in the session.
    public func releaseLocks(notHeldIn activeInstruments: Set<String>) {
        lockQueue.async(flags: .barrier) {
            self.recentlyDispatchedInstruments.formIntersection(activeInstruments)
        }
    }

    /// Evaluates all strategy and instrument matrix combinations concurrently using structured concurrency.
    public func executeDispatchCycle(currentAccountBalance: Double, estimatedRiskPerTrade: Double) async {
        let activeTrades: [ActiveTradeInfo]
        do {
            activeTrades = try await client.fetchActiveTrades(accountID: accountID)
        } catch {
            print("[DISPATCHER ERROR] Failed to fetch active trades for duplicate protection: \(error)")
            return
        }

        await withTaskGroup(of: Void.self) { group in
            for instrument in instruments {
                for strategy in strategies {
                    group.addTask { [weak self] in
                        guard let self = self else { return }
                       
                        let isLocallyLocked = self.lockQueue.sync {
                            return self.recentlyDispatchedInstruments.contains(instrument)
                        }
                       
                        if isLocallyLocked || activeTrades.contains(where: { $0.instrument == instrument }) {
                            return
                        }

                        do {
                            let strategyKey = "\(strategy.strategyName)_\(instrument)"
                           
                            let isAllowed = await self.portfolioManager.validateAndRegisterTrade(
                                strategyKey: strategyKey,
                                currentAccountBalance: currentAccountBalance,
                                proposedRiskAmount: estimatedRiskPerTrade
                            )
                           
                            guard isAllowed else { return }

                            let result = try await strategy.evaluate(instrument: instrument, client: self.client)
                            if result.shouldTrade {
                               
                                self.lockQueue.async(flags: .barrier) {
                                    self.recentlyDispatchedInstruments.insert(instrument)
                                }

                                var finalTargetPrice = result.targetPrice
                                var finalIsLimit = result.isLimit

                                // Enforce strategy's native execution preference unless overridden
                                if strategy.preferredExecutionMode == .preferMarket {
                                    finalIsLimit = false
                                    finalTargetPrice = nil
                                }

                                if finalIsLimit, let target = finalTargetPrice {
                                    let recentPrices = try await client.fetchRecentClosePrices(instrument: instrument, granularity: "S5", count: 1)
                                    guard let currentMarketPrice = recentPrices.last else {
                                        print("[DISPATCHER] ABORT: Could not retrieve current price anchor for \(instrument).")
                                        self.lockQueue.async(flags: .barrier) { self.recentlyDispatchedInstruments.remove(instrument) }
                                        return
                                    }
                                    
                                    let percentageDistance = abs(target - currentMarketPrice) / currentMarketPrice
                                    let maxAllowedPercentage = 0.0025 // 0.25% max tolerance
                                    
                                    if percentageDistance > maxAllowedPercentage || target <= 0 {
                                        print("[DISPATCHER] CRITICAL: Rogue/detached limit order intercepted for \(instrument). Target: \(target), Mark: \(currentMarketPrice). Forcing Market Order fallback.")
                                        finalIsLimit = false
                                        finalTargetPrice = nil
                                    }
                                }

                                let executionManager = OrderExecutionManager(client: self.client, accountID: self.accountID)
                               
                                // Strategies return SIGNED units (negative = short) and the
                                // client re-applies the sign from `isLong`. Passing the signed
                                // value through would double-negate, turning every short into
                                // a long — so the magnitude goes down, the direction goes in
                                // the flag.
                                let success = await executionManager.executeDynamicOrderSafely(
                                    instrument: instrument,
                                    units: abs(result.units),
                                    isLong: result.units > 0,
                                    isLimit: finalIsLimit,
                                    targetPrice: finalTargetPrice,
                                    stopLoss: result.stopLoss,
                                    takeProfit: result.takeProfit
                                )
                               
                                if success {
                                    print("[DISPATCHER] Executed trade for \(instrument) via \(strategy.strategyName) [Limit: \(finalIsLimit)]")
                                } else {
                                    self.lockQueue.async(flags: .barrier) {
                                        self.recentlyDispatchedInstruments.remove(instrument)
                                    }
                                }
                            }
                        } catch {
                            print("[DISPATCHER ERROR] Failed execution for \(strategy.strategyName) on \(instrument): \(error)")
                            self.lockQueue.async(flags: .barrier) {
                                self.recentlyDispatchedInstruments.remove(instrument)
                            }
                        }
                    }
                }
            }
        }
    }
}
