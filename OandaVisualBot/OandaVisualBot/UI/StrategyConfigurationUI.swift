//
//  StrategyConfigurationUI.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/9/26.
//

import Foundation
import Combine

public final class BotConfiguration: ObservableObject {
    @Published public var ignoreLiquidityWindow: Bool = false
    @Published public var ignoreConfluenceGates: Bool = false
    @Published public var forceImmediateMarketExecution: Bool = true
    @Published public var enableCoinbaseTrading: Bool = true
    
    // Dynamic Strategy Parameters
    @Published public var trendSMAPeriod: Int = 20
    @Published public var meanReversionThreshold: Double = 0.40 // Loosened from 0.20 for speculative scalping
    @Published public var breakoutLookbackCount: Int = 10     // Shortened from 50 for micro-breakouts
    
    public init() {}
}
