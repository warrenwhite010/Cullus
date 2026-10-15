//
//  StrategyEngine.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

struct StrategySignal: Sendable {
    enum Action: Equatable, Sendable {
        case buy, sell, hold
    }
    
    let action: Action
    let targetUnits: Int
    let stopLossDistance: String
    let diagnosticLog: String
}

struct StrategyEngine {
    /// Evaluates price series using structural constraints and volatility bounds.
    /// - Parameter prices: Array of historical close prices (oldest to newest).
    /// - Returns: A `StrategySignal` dictating execution behavior.
    static func evaluate(prices: [Double], baseUnits: Int) -> StrategySignal {
        guard prices.count >= 30 else {
            return StrategySignal(action: .hold, targetUnits: 0, stopLossDistance: "0.0", diagnosticLog: "Insufficient candle depth for matrix evaluation.")
        }
        
        // Strict Inversion: Isolate historical window (exclude current unclosed tick leakage)
        let historicalSlice = Array(prices.dropLast())
        let currentPrice = prices.last!
        
        // Calculate rolling Simple Moving Average on historical data
        let sma = historicalSlice.reduce(0, +) / Double(historicalSlice.count)
        
        // Calculate rolling standard deviation for volatility constraints
        let variance = historicalSlice.map { pow($0 - sma, 2) }.reduce(0, +) / Double(historicalSlice.count)
        let volatility = sqrt(variance)
        
        // Dynamic stop-loss based on rolling volatility (e.g., 1.5x standard deviation, bounded)
        let calculatedStop = max(volatility * 1.5, 0.0020)
        let formattedStop = String(format: "%.4f", calculatedStop)
        
        // Strategy Rule: Trend crossover condition
        if currentPrice > sma && volatility >= 0.0001 {
            return StrategySignal(
                action: .buy,
                targetUnits: baseUnits,
                stopLossDistance: formattedStop,
                diagnosticLog: "Signal: Price (\(currentPrice)) > SMA (\(String(format: "%.4f", sma))) [Vol: \(formattedStop)]"
            )
        } else {
            return StrategySignal(
                action: .hold,
                targetUnits: 0,
                stopLossDistance: formattedStop,
                diagnosticLog: "Hold: Price (\(currentPrice)) bounded below SMA/Volatility limits."
            )
        }
    }
}
