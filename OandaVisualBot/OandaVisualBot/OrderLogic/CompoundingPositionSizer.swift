//
//  CompoundingPositionSizer.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class CompoundingPositionSizer {
    public static func calculateCompoundedUnits(
        baseUnits: Int,
        baseAccountBalance: Double,
        currentAccountBalance: Double,
        compoundingFactor: Double = 1.0
    ) -> Int {
        guard currentAccountBalance > baseAccountBalance else { return baseUnits }
        let growthRatio = currentAccountBalance / baseAccountBalance
        let scaledUnits = Double(baseUnits) * (1.0 + ((growthRatio - 1.0) * compoundingFactor))
        return Int(scaledUnits)
    }
}
