//
//  OptimizedExecutionParameters.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public struct OptimizedExecutionParameters {
    public static let highFrequencyDefaults = AdvancedExecutionParameters(
        orderBookImbalanceThreshold: 0.60,
        atrMultiplier: 1.5,
        twapSlices: 4,
        maxSpreadLimit: 0.00030,
        requiredTimeframesConfluence: ["M1", "M5"],
        partialTakeProfitRatio: 0.5,
        maxDrawdownCap: 0.05,
        cooldownDuration: 60.0
    )
}
