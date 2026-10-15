//
//  MultiStrategyDispatcher+AdvancedIntegration.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/9/26.
//

import Foundation

extension MultiStrategyDispatcher {
    
    private var advancedOrchestrator: AdvancedExecutionOrchestrator {
        return AdvancedExecutionOrchestrator(
            client: self.client,
            accountID: self.accountID,
            parameters: .institutionalDefaults,
            botConfig: self.botConfig
        )
    }

    public func executeAdvancedDispatchCycle(
        coinbaseClient: CoinbaseExecutionClient,
        instrument: String,
        currentAccountBalance: Double,
        currentOpenEquity: Double,
        currentMarginUsed: Double,
        estimatedRiskPerTrade: Double,
        baseAtr: Double,
        currentAtr: Int,
        baselineAtr: Int,
        currentSpread: Double
    ) async {
        do {
            let isAllowed = await self.portfolioManager.validateAndRegisterTrade(
                strategyKey: "AdvancedExecution_\(instrument)",
                currentAccountBalance: currentAccountBalance,
                proposedRiskAmount: estimatedRiskPerTrade
            )
             
            guard isAllowed else {
                print("[DISPATCHER] Trade suppressed by Portfolio Manager drawdown caps.")
                return
            }

            let baseUnits = 1000
            let compoundedUnits = CompoundingPositionSizer.calculateCompoundedUnits(
                baseUnits: baseUnits,
                baseAccountBalance: 20000.0,
                currentAccountBalance: currentAccountBalance
            )
            let finalUnits = VolatilityLeverageManager.scaleUnitsForVolatility(
                baseUnits: compoundedUnits,
                currentAtr: currentAtr,
                baselineAtr: baselineAtr
            )

            // If instrument denotes crypto (contains "-"), route through coinbaseClient or handle payload safely
            if instrument.contains("-") {
                print("[DISPATCHER] Routing crypto asset \(instrument) via Coinbase execution layer...")
                // Add your Coinbase execution or validation call here if needed
            }

            let executed = try await advancedOrchestrator.validateAndExecuteAdvancedOrder(
                instrument: instrument,
                units: finalUnits,
                isLong: true,
                isLimit: true,
                targetPrice: 1.08500,
                baseAtr: baseAtr,
                currentSpread: currentSpread,
                currentAccountBalance: currentAccountBalance,
                currentOpenEquity: currentOpenEquity,
                currentMarginUsed: currentMarginUsed
            )

            if executed {
                print("[DISPATCHER] Advanced order successfully routed with \(finalUnits) units.")
            }
             
        } catch {
            print("[DISPATCHER] Error during advanced execution cycle for \(instrument): \(error)")
        }
    }


    
    
    public func executeMultiAssetDispatchCycle(
        coinbaseClient: CoinbaseExecutionClient,
        instrument: String,
        currentAccountBalance: Double,
        currentOpenEquity: Double,
        currentMarginUsed: Double,
        estimatedRiskPerTrade: Double,
        baseAtr: Double,
        currentAtr: Int,
        baselineAtr: Int,
        currentSpread: Double
    ) async {
        do {
            let isAllowed = await self.portfolioManager.validateAndRegisterTrade(
                strategyKey: "CoinbaseMultiAsset",
                currentAccountBalance: currentAccountBalance,
                proposedRiskAmount: estimatedRiskPerTrade
            )
            
            guard isAllowed else {
                print("[DISPATCHER] Multi-asset trade suppressed by Portfolio Manager drawdown caps.")
                return
            }
            
            let baseUnits = 1
            let compoundedUnits = CompoundingPositionSizer.calculateCompoundedUnits(
                baseUnits: baseUnits,
                baseAccountBalance: 20000.0,
                currentAccountBalance: currentAccountBalance
            )
            let finalUnits = VolatilityLeverageManager.scaleUnitsForVolatility(
                baseUnits: compoundedUnits,
                currentAtr: currentAtr,
                baselineAtr: baselineAtr
            )
            
            // Route dynamic dual-tranche order through Coinbase Advanced Trade API
            try await coinbaseClient.executeDynamicOrder(
                accountID: "COINBASE-PORTFOLIO",
                instrument: instrument,
                units: finalUnits,
                isLong: true,
                isLimit: true,
                targetPrice: 60000.00,
                stopLossDistance: String(format: "%.2f", baseAtr * 1.5),
                takeProfitDistance: String(format: "%.2f", baseAtr * 3.0)
            )
            
            print("[DISPATCHER] Multi-asset crypto order successfully routed for \(instrument).")
            
        } catch {
            print("[DISPATCHER] Error during Coinbase multi-asset execution cycle: \(error)")
        }
    }
}
