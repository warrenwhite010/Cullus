//
//  TrailingLimitManager.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class TrailingLimitManager {
    private let client: OandaServiceProtocol
    private let accountID: String
    private var activeTrackingTasks: [String: Task<Void, Never>] = [:]

    public init(client: OandaServiceProtocol, accountID: String) {
        self.client = client
        self.accountID = accountID
    }

    public func startTrackingLimitOrder(
        orderID: String,
        instrument: String,
        isLong: Bool,
        initialLimitPrice: Double,
        maxDriftDistance: Double
    ) {
        // Cancel any existing tracker for this order
        activeTrackingTasks[orderID]?.cancel()

        activeTrackingTasks[orderID] = Task { [weak self] in
            guard let self = self else { return }
            
            let pollInterval: UInt64 = 10_000_000_000 // 10 seconds
            
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: pollInterval)
                    
                    // Fetch latest price
                    let prices = try await client.fetchRecentClosePrices(instrument: instrument, granularity: "M1", count: 1)
                    guard let currentPrice = prices.last else { continue }
                    
                    // Check drift logic (if price moves away, adjust limit order closer)
                    let drift = isLong ? (currentPrice - initialLimitPrice) : (initialLimitPrice - currentPrice)
                    if drift > maxDriftDistance {
                        print("[TrailingLimit] Order \(orderID) drifting. Adjusting closer to market...")
                        // Implement cancel and re-issue logic here via client
                        break
                    }
                } catch {
                    if Task.isCancelled { break }
                    print("[TrailingLimit] Error tracking order \(orderID): \(error)")
                }
            }
        }
    }

    public func stopTracking(orderID: String) {
        activeTrackingTasks[orderID]?.cancel()
        activeTrackingTasks[orderID] = nil
    }
}
