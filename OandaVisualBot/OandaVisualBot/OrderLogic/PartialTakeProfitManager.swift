//
//  PartialTakeProfitManager.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class PartialTakeProfitManager {
    
    /// Splits total units into tranches (e.g., 50% for quick target, 50% for runner)
    public static func calculateTrancheUnits(totalUnits: Int, ratio: Double) -> (primaryUnits: Int, secondaryUnits: Int) {
        let primary = Int(Double(totalUnits) * ratio)
        let secondary = totalUnits - primary
        return (primary, secondary)
    }
}
