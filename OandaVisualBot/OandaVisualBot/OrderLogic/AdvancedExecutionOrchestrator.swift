//
//  AdvancedExecutionOrchestrator.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class AdvancedExecutionOrchestrator {
    private let client: OandaServiceProtocol
    private let accountID: String
    private let parameters: AdvancedExecutionParameters
    private let trailingManager: TrailingLimitManager
    private let botConfig: BotConfiguration
    
    private var instrumentCooldowns: [String: Date] = [:]

    public init(client: OandaServiceProtocol, accountID: String, parameters: AdvancedExecutionParameters = .institutionalDefaults, botConfig: BotConfiguration) {
        self.client = client
        self.accountID = accountID
        self.parameters = parameters
        self.trailingManager = TrailingLimitManager(client: client, accountID: accountID)
        self.botConfig = botConfig
    }

    public func registerStopLossTrigger(for instrument: String) {
        instrumentCooldowns[instrument] = Date()
        print("[Advanced Execution] COOLDOWN ACTIVATED: \(instrument) locked due to stop-loss trigger.")
    }

    public func validateAndExecuteAdvancedOrder(
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        baseAtr: Double,
        currentSpread: Double,
        currentAccountBalance: Double,
        currentOpenEquity: Double,
        currentMarginUsed: Double
    ) async throws -> Bool {
        // 1. Cooldown Check
        if let lastTrigger = instrumentCooldowns[instrument],
           Date().timeIntervalSince(lastTrigger) < parameters.cooldownDuration {
            print("[Advanced Execution] REJECTED: Cooldown active for \(instrument).")
            return false
        }

        let isMarginSafe = MarginUtilizationGuard.evaluateMarginSafety(
            currentBalance: currentAccountBalance,
            currentOpenEquity: currentOpenEquity,
            currentMarginUsed: currentMarginUsed,
            maxAllowedCap: parameters.maxDrawdownCap
        )
        guard isMarginSafe else {
            print("[Advanced Execution] REJECTED: Margin safety check failed.")
            return false
        }

        // 2. Spread Guard
        guard currentSpread <= parameters.maxSpreadLimit else {
            print("[Advanced Execution] REJECTED: Spread \(currentSpread) exceeds limit \(parameters.maxSpreadLimit).")
            return false
        }

        // 3. Multi-Timeframe Trend Confluence Check
        if !botConfig.ignoreConfluenceGates {
            let isConfluent = try await verifyTimeframeConfluence(instrument: instrument, targetIsLong: isLong)
            guard isConfluent else {
                print("[Advanced Execution] REJECTED: Timeframe confluence check failed.")
                return false
            }
        } else {
            print("[Advanced Execution] BYPASSED: Timeframe confluence check skipped via UI override.")
        }

        // 4. Dynamic ATR Spread Scaling & Partial Take-Profit Tranche Splits
        let stopDistance = String(format: "%.5f", baseAtr * parameters.atrMultiplier)
        let primaryTpDistance = String(format: "%.5f", baseAtr * parameters.atrMultiplier * 1.0)
        let runnerTpDistance = String(format: "%.5f", baseAtr * parameters.atrMultiplier * 3.0)

        let (primaryUnits, runnerUnits) = PartialTakeProfitManager.calculateTrancheUnits(
            totalUnits: units,
            ratio: parameters.partialTakeProfitRatio
        )

        // HARD ENFORCEMENT: Force all strategies to execute via Market Orders if concurrency or downstream limits malfunction,
        // or ensure safety checks intercept the targetPrice before submission. If limit price is invalid/detached, drop to Market.
        var enforcedIsLimit = isLimit
        var enforcedTargetPrice = targetPrice

        if enforcedIsLimit, let target = enforcedTargetPrice {
            let recentPrices = try await client.fetchRecentClosePrices(instrument: instrument, granularity: "S5", count: 1)
            if let currentMarketPrice = recentPrices.last {
                let percentageDistance = abs(target - currentMarketPrice) / currentMarketPrice
                if percentageDistance > 0.0025 || target <= 0 {
                    print("[Advanced Execution] HARD OVERRIDE: Detached limit order detected (\(target) vs \(currentMarketPrice)). Forcing Market Order globally.")
                    enforcedIsLimit = false
                    enforcedTargetPrice = nil
                }
            } else {
                enforcedIsLimit = false
                enforcedTargetPrice = nil
            }
        }

        let executionManager = OrderExecutionManager(client: client, accountID: accountID)

        // 5. Execution Dispatch via Execution Manager Safely
        if parameters.twapSlices > 1 && enforcedIsLimit {
            return try await executeTwapSlices(
                instrument: instrument,
                totalUnits: units,
                isLong: isLong,
                targetPrice: enforcedTargetPrice,
                stopDistance: stopDistance,
                tpDistance: primaryTpDistance
            )
        } else {
            // Dispatch Tranche 1 (Primary 1x ATR)
            let primarySuccess = await executionManager.executeDynamicOrderSafely(
                instrument: instrument,
                units: primaryUnits,
                isLong: isLong,
                isLimit: enforcedIsLimit,
                targetPrice: enforcedTargetPrice,
                stopLoss: stopDistance,
                takeProfit: primaryTpDistance
            )
            guard primarySuccess else { return false }

            // Dispatch Tranche 2 (Runner 3x ATR)
            let runnerSuccess = await executionManager.executeDynamicOrderSafely(
                instrument: instrument,
                units: runnerUnits,
                isLong: isLong,
                isLimit: enforcedIsLimit,
                targetPrice: enforcedTargetPrice,
                stopLoss: stopDistance,
                takeProfit: runnerTpDistance
            )
            guard runnerSuccess else { return false }

            if enforcedIsLimit, let price = enforcedTargetPrice {
                let mockOrderID = "ORD-\(Int(Date().timeIntervalSince1970))"
                trailingManager.startTrackingLimitOrder(
                    orderID: mockOrderID,
                    instrument: instrument,
                    isLong: isLong,
                    initialLimitPrice: price,
                    maxDriftDistance: baseAtr * 0.5
                )
            }
             
            print("[Advanced Execution] Successfully dispatched dual-tranche order safely: Primary (\(primaryUnits)u), Runner (\(runnerUnits)u). [Limit: \(enforcedIsLimit)]")
            return true
        }
    }
    
    private func verifyTimeframeConfluence(instrument: String, targetIsLong: Bool) async throws -> Bool {
        for tf in parameters.requiredTimeframesConfluence {
            let closes = try await client.fetchRecentClosePrices(instrument: instrument, granularity: tf, count: 2)
            guard closes.count >= 2 else { return false }
            let isUpward = closes.last! > closes.first!
            if targetIsLong != isUpward {
                return false
            }
        }
        return true
    }

    private func executeTwapSlices(
        instrument: String,
        totalUnits: Int,
        isLong: Bool,
        targetPrice: Double?,
        stopDistance: String,
        tpDistance: String
    ) async throws -> Bool {
        let sliceSize = totalUnits / parameters.twapSlices
        let interval: UInt64 = 5_000_000_000
        let executionManager = OrderExecutionManager(client: client, accountID: accountID)

        for slice in 0..<parameters.twapSlices {
            let unitsToExecute = (slice == parameters.twapSlices - 1) ? totalUnits - (sliceSize * slice) : sliceSize
             
            let success = await executionManager.executeDynamicOrderSafely(
                instrument: instrument,
                units: unitsToExecute,
                isLong: isLong,
                isLimit: true,
                targetPrice: targetPrice,
                stopLoss: stopDistance,
                takeProfit: tpDistance
            )
            
            guard success else { return false }
             
            if slice < parameters.twapSlices - 1 {
                try await Task.sleep(nanoseconds: interval)
            }
        }
        return true
    }
}
