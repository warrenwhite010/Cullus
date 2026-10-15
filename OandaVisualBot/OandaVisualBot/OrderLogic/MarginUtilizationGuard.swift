//
//  MarginUtilizationGuard.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class MarginUtilizationGuard {
    
    public static func evaluateMarginSafety(
        currentBalance: Double,
        currentOpenEquity: Double,
        currentMarginUsed: Double,
        maxAllowedCap: Double
    ) -> Bool {
        // Calculate current equity drawdown relative to balance
        let equityDelta = currentBalance - currentOpenEquity
        let currentDrawdown = equityDelta > 0 ? (equityDelta / currentBalance) : 0.0
        
        // Calculate margin utilization ratio
        let marginUtilization = currentMarginUsed / currentOpenEquity
        
        // Block new risk if drawdown or margin utilization breaches limits
        if currentDrawdown >= maxAllowedCap || marginUtilization >= 0.80 {
            print("[Margin Guard] REJECTED: Drawdown (\(currentDrawdown * 100)%) or Margin Utilization (\(marginUtilization * 100)%) exceeds limits.")
            return false
        }
        
        return true
    }
}
