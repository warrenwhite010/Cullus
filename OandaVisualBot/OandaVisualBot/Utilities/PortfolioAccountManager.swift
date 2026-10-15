//
//  PortfolioAccountManager.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/2/26.
//

import Foundation

public struct AccountSummaryResponse: Decodable, Sendable {
    public let nav: String
    public let marginAvailable: String
    public let pl: String
    
    enum CodingKeys: String, CodingKey {
        case nav = "NAV"
        case marginAvailable
        case pl = "pl"
    }
}

public actor PortfolioAccountManager {
    private let accountID: String
    private let client: OandaServiceProtocol
    private var strategyDrawdowns: [String: (loss: Double, windowStart: Date)] = [:]
    private let maxDrawdownPercentage: Double = 0.25 // 10%

    public init(accountID: String, client: OandaServiceProtocol) {
        self.accountID = accountID
        self.client = client
    }

    public func fetchAccountSummary() async throws -> AccountSummaryResponse {
        return try await client.fetchAccountSummary(accountID: accountID)
    }

    public func validateAndRegisterTrade(strategyKey: String, currentAccountBalance: Double, proposedRiskAmount: Double) -> Bool {
        let now = Date()
        var record = strategyDrawdowns[strategyKey] ?? (loss: 0.0, windowStart: now)

        if now.timeIntervalSince(record.windowStart) >= 86400 {
            record = (loss: 0.0, windowStart: now)
        }

        let maxAllowedLoss = currentAccountBalance * maxDrawdownPercentage

        if record.loss + proposedRiskAmount > maxAllowedLoss {
            print("[PORTFOLIO RISK] 24hr drawdown limit breached for strategy: \(strategyKey). Loss: \(record.loss)/\(maxAllowedLoss). Suppressing trade.")
            return false
        }

        record.loss += proposedRiskAmount
        strategyDrawdowns[strategyKey] = record
        return true
    }
}
