//
//  StrategyEngineTests.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import XCTest
@testable import OandaVisualBot

final class StrategyEngineTests: XCTestCase {
    
    func testInsufficientCandlesReturnsHold() {
        let sparsePrices = [1.1000, 1.1010]
        let signal = StrategyEngine.evaluate(prices: sparsePrices, baseUnits: 1000)
        
        XCTAssertEqual(signal.action, StrategySignal.Action.hold)
        XCTAssertEqual(signal.targetUnits, 0)
    }
    
    func testValidTrendTriggersBuySignal() {
        // Generate a controlled array of 30 prices with natural variance and an upward terminal spike
        var prices: [Double] = (0..<29).map { 1.1000 + (Double($0) * 0.0001) }
        prices.append(1.1500) // Terminal price well above SMA with active volatility
        
        let signal = StrategyEngine.evaluate(prices: prices, baseUnits: 1000)
        
        XCTAssertEqual(signal.action, StrategySignal.Action.buy)
        XCTAssertEqual(signal.targetUnits, 1000)
        XCTAssertFalse(signal.stopLossDistance.isEmpty)
    }
}
