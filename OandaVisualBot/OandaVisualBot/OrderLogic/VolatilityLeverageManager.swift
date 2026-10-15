//
//  VolatilityLeverageManager.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class VolatilityLeverageManager {
    public static func scaleUnitsForVolatility(
        baseUnits: Int,
        currentAtr: Int,
        baselineAtr: Int,
        maxMultiplier: Double = 2.0
    ) -> Int {
        guard baselineAtr > 0 else { return baseUnits }
        let atrRatio = Double(currentAtr) / Double(baselineAtr)
        let cappedMultiplier = min(max(atrRatio, 0.5), maxMultiplier)
        return Int(Double(baseUnits) * cappedMultiplier)
    }
}
