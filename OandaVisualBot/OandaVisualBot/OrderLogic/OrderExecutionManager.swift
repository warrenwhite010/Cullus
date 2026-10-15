//
//  OrderExecutionManager.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public final class OrderExecutionManager {
    private let client: OandaServiceProtocol
    private let accountID: String
    
    public init(client: OandaServiceProtocol, accountID: String) {
        self.client = client
        self.accountID = accountID
    }
    
    public func executeDynamicOrderSafely(
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        stopLoss: String,
        takeProfit: String
    ) async -> Bool {
        var validatedIsLimit = isLimit
        var validatedTargetPrice = targetPrice
        
        // ULTIMATE SANITY CLAMP: Hard-strip any rogue limit prices directly at the execution perimeter
        if validatedIsLimit, let target = validatedTargetPrice {
            do {
                let hasOpenPosition = try await client.hasExistingPosition(accountID: accountID, instrument: instrument)
                guard !hasOpenPosition else {
                    print("[EXECUTION GUARD] Position already active for \(instrument). Suppressing.")
                    return false
                }
                let recentPrices = try await client.fetchRecentClosePrices(instrument: instrument, granularity: "S5", count: 1)
                guard let currentMarketPrice = recentPrices.last else {
                    print("[EXECUTION MANAGER] ABORT: Failed to fetch anchor price for \(instrument).")
                    return false
                }
                
                let percentageDistance = abs(target - currentMarketPrice) / currentMarketPrice
                let maxAllowedPercentage = 0.0025 // Strict 0.25% boundary
                
                if percentageDistance > maxAllowedPercentage || target <= 0 {
                    print("[EXECUTION MANAGER] BLOCKED: Rogue limit order intercepted! Target (\(target)) is too far from Mark (\(currentMarketPrice)). Forcing Market Order execution.")
                    validatedIsLimit = false
                    validatedTargetPrice = nil
                }
            } catch {
                print("[EXECUTION MANAGER] ABORT: Price verification failed: \(error). Falling back to Market Order.")
                validatedIsLimit = false
                validatedTargetPrice = nil
            }
        }
        
        do {
            
            // The validated values, not the raw arguments. Sending `isLimit` and
            // `targetPrice` here meant the sanity clamp above computed a
            // correction and then threw it away, so a detached limit price was
            // logged as intercepted and submitted anyway.
            try await client.executeDynamicOrder(
                accountID: accountID,
                instrument: instrument,
                units: abs(units),
                isLong: isLong,
                isLimit: validatedIsLimit,
                targetPrice: validatedTargetPrice,
                stopLossDistance: stopLoss,
                takeProfitDistance: takeProfit
            )
            print("[EXECUTION SUCCESS] Order dispatched successfully for \(instrument). Units: \(units)")
            return true
        } catch {
            print("[EXECUTION ERROR] \(error.localizedDescription)")
            return false
        }
    }
}

public func calculateDynamicRiskLevels(prices: [Double], currentPrice: Double) -> (sl: String, tp: String) {
    guard prices.count >= 14 else {
        return (sl: "0.0020", tp: "0.0040") // Fallback default
    }
    
    let mean = prices.reduce(0, +) / Double(prices.count)
    let variance = prices.map { pow($0 - mean, 2) }.reduce(0, +) / Double(prices.count)
    let volatility = sqrt(variance)
    
    let slDistance = volatility * 1.5
    let tpDistance = volatility * 3.0 // 3:1 Reward-to-Risk ratio
    
    return (sl: String(format: "%.5f", slDistance), tp: String(format: "%.5f", tpDistance))
}
