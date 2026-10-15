//
//  LoggerEngine.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

struct LoggerEngine {
    static func logExecutionBoundary(instrument: String, count: Int, currentPrice: Double, sma: Double, volatility: Double) {
        print("""
        [EXECUTION BOUNDARY TRACE]
        ------------------------------------------
        Timestamp: \(ISO8601DateFormatter().string(from: Date()))
        Instrument: \(instrument)
        Candle Count: \(count)
        Current Close Price: \(currentPrice)
        Calculated SMA: \(String(format: "%.4f", sma))
        Rolling Volatility: \(String(format: "%.6f", volatility))
        ------------------------------------------
        """)
    }
}
