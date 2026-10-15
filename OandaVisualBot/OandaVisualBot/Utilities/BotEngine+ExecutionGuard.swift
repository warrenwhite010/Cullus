//
//  BotEngine+ExecutionGuard.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/9/26.
//

import Foundation

extension BotEngine {
    
    /// Validates execution constraints, session liquidity windows, and static data arrays
    /// prior to routing an asynchronous cycle through the portfolio dispatcher.
    public func validateAndSanitizeExecutionTick(for instrument: String) -> Bool {
        if instrument.isEmpty {
            print("[EXECUTION GUARD] CRITICAL: Null or empty instrument descriptor supplied.")
            return false
        }
        
        let isLiquidityValid = self.isWithinPeakLiquidityWindow(for: instrument)
        guard isLiquidityValid || botConfig.ignoreLiquidityWindow else {
            print("[EXECUTION GUARD] Suppressed dispatch for \(instrument): Outside peak session window.")
            return false
        }
        
        return true
    }

    /// Sanitizes and routes execution ticks, ensuring crypto pairs target the Coinbase execution layer
    /// while forex pairs route through the Oanda multi-strategy dispatcher.
    public func executeSanitizedTickCycle(for instrument: String, currentAccountBalance: Double) async {
        guard validateAndSanitizeExecutionTick(for: instrument) else { return }

        let baseAtr = 0.0015
        let currentSpread = 0.00010

        if instrument.contains("-"), let cbClient = coinbaseClient {
            print("[BOT ENGINE] Routing crypto execution for \(instrument) through Coinbase client.")
            await dispatcher.executeMultiAssetDispatchCycle(
                coinbaseClient: cbClient,
                instrument: instrument,
                currentAccountBalance: currentAccountBalance,
                currentOpenEquity: currentAccountBalance,
                currentMarginUsed: 0.0,
                estimatedRiskPerTrade: 50.0,
                baseAtr: baseAtr,
                currentAtr: 15,
                baselineAtr: 10,
                currentSpread: currentSpread
            )
        } else {
            await dispatcher.executeAdvancedDispatchCycle(
                coinbaseClient: coinbaseClient ?? CoinbaseExecutionClient(apiKey: "", apiSecret: ""),
                instrument: instrument,
                currentAccountBalance: currentAccountBalance,
                currentOpenEquity: currentAccountBalance,
                currentMarginUsed: 0.0,
                estimatedRiskPerTrade: 50.0,
                baseAtr: baseAtr,
                currentAtr: 15,
                baselineAtr: 10,
                currentSpread: currentSpread
            )
        }
    }
}
