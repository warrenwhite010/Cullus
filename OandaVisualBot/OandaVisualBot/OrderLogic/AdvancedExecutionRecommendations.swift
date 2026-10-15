//
//  AdvancedExecutionRecommendations.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public struct AdvancedExecutionParameters {
    public let orderBookImbalanceThreshold: Double
    public let atrMultiplier: Double
    public let twapSlices: Int
    public let maxSpreadLimit: Double
    public let requiredTimeframesConfluence: [String]
    public let partialTakeProfitRatio: Double
    public let maxDrawdownCap: Double
    public let cooldownDuration: TimeInterval

    public static let institutionalDefaults = AdvancedExecutionParameters(
        orderBookImbalanceThreshold: 1.65,
        atrMultiplier: 1.5,
        twapSlices: 4,
        maxSpreadLimit: 0.00030,
        requiredTimeframesConfluence: ["M1", "M5", "H1"],
        partialTakeProfitRatio: 0.5,
        maxDrawdownCap: 0.10,
        cooldownDuration: 300.0
    )
}
