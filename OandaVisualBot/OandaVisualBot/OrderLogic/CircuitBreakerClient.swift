//
//  CircuitBreakerClient.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public final class CircuitBreakerClient: OandaServiceProtocol {
    private let innerClient: OandaServiceProtocol
    private var failureCount: Int = 0
    private let failureThreshold: Int = 3
    private var lastFailureTime: Date?
    private let cooldownInterval: TimeInterval = 30.0
    
    public init(innerClient: OandaServiceProtocol) {
        self.innerClient = innerClient
    }
    
    private func checkCircuitState() throws {
        if failureCount >= failureThreshold {
            if let lastTime = lastFailureTime, Date().timeIntervalSince(lastTime) < cooldownInterval {
                print("[CircuitBreaker] TRIPPED: Rejecting request due to consecutive failures. Cooling off.")
                throw URLError(.networkConnectionLost)
            } else {
                failureCount = 0
                lastFailureTime = nil
            }
        }
    }
    
    private func recordSuccess() {
        failureCount = 0
        lastFailureTime = nil
    }
    
    private func recordFailure() {
        failureCount += 1
        lastFailureTime = Date()
        print("[Debug] CircuitBreaker threshold reached. Current state count: \(failureCount)/\(failureThreshold)") // Add this line
        print("[CircuitBreaker] Failure recorded. Current count: \(failureCount)/\(failureThreshold)")
    }
    
    public func fetchPendingOrders(accountID: String) async throws -> [PendingOrderInfo] {
        // Forward the call to your inner client or network implementation
        return try await innerClient.fetchPendingOrders(accountID: accountID) // For CircuitBreakerClient
    }
    
    public func fetchAccountSummary(accountID: String) async throws -> AccountSummaryResponse {
        try checkCircuitState()
        do {
            let summary = try await innerClient.fetchAccountSummary(accountID: accountID)
            recordSuccess() // Fixed method call
            return summary
        } catch {
            recordFailure()
            throw error
        }
    }
    
    public func cancelOrder(accountID: String, orderID: String) async throws {
        try await innerClient.cancelOrder(accountID: accountID, orderID: orderID)
    }
    
    public func fetchRecentClosePrices(instrument: String, granularity: String, count: Int) async throws -> [Double] {
        try checkCircuitState()
        do {
            let result = try await innerClient.fetchRecentClosePrices(instrument: instrument, granularity: granularity, count: count)
            recordSuccess()
            return result
        } catch {
            recordFailure()
            throw error
        }
    }
    
    public func executeMarketOrder(accountID: String, instrument: String, units: Int, stopLoss: String, takeProfit: String) async throws {
        try checkCircuitState()
        do {
            try await innerClient.executeMarketOrder(accountID: accountID, instrument: instrument, units: units, stopLoss: stopLoss, takeProfit: takeProfit)
            recordSuccess()
        } catch {
            recordFailure()
            throw error
        }
    }
    
    public func hasExistingPosition(accountID: String, instrument: String) async throws -> Bool {
        try checkCircuitState()
        do {
            let result = try await innerClient.hasExistingPosition(accountID: accountID, instrument: instrument)
            recordSuccess()
            return result
        } catch {
            recordFailure()
            throw error
        }
    }
    
    public func fetchActiveTrades(accountID: String) async throws -> [ActiveTradeInfo] {
        try checkCircuitState()
        do {
            let result = try await innerClient.fetchActiveTrades(accountID: accountID)
            recordSuccess()
            return result
        } catch {
            recordFailure()
            throw error
        }
    }
    
    public func executeDynamicOrder(
        accountID: String,
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        stopLossDistance: String,
        takeProfitDistance: String
    ) async throws {
        let formattedInstrument = instrument.contains("_") ? instrument : insertUnderscore(into: instrument)
        
        let isJpyPair = formattedInstrument.hasSuffix("_JPY")
        let adjustedStopLoss = scaleDistance(stopLossDistance, forJpy: isJpyPair)
        let adjustedTakeProfit = scaleDistance(takeProfitDistance, forJpy: isJpyPair)
        
        print("[DEBUG OANDA PAYLOAD] Instrument: \(formattedInstrument) | Units: \(units) | SL: \(adjustedStopLoss) | TP: \(adjustedTakeProfit) | IsJPY: \(isJpyPair)")
        
        try checkCircuitState()
        do {
            // BUG FIX: Pass the scaled distances and formatted instrument down to the inner client instead of raw unscaled variables
            try await innerClient.executeDynamicOrder(
                accountID: accountID,
                instrument: formattedInstrument,
                units: units,
                isLong: isLong,
                isLimit: isLimit,
                targetPrice: targetPrice,
                stopLossDistance: adjustedStopLoss,
                takeProfitDistance: adjustedTakeProfit
            )
            recordSuccess()
        } catch {
            print("[CircuitBreaker] Execution failed for \(formattedInstrument): \(error)")
            recordFailure()
            throw error
        }
    }
    
    private func scaleDistance(_ distanceStr: String, forJpy: Bool) -> String {
        guard let baseVal = Double(distanceStr) else { return distanceStr }
        if forJpy && baseVal < 0.1 {
            // Scale 5-decimal standard forex distance (e.g., 0.0020) up to 3-decimal JPY scale (e.g., 0.200)
            return String(format: "%.3f", baseVal * 100.0)
        }
        return distanceStr
    }
    
    private func insertUnderscore(into symbol: String) -> String {
        guard symbol.count == 6, !symbol.contains("_") else { return symbol }
        let index = symbol.index(symbol.startIndex, offsetBy: 3)
        return "\(symbol[..<index])_\(symbol[index...])"
    }
}
