//
//  ActiveTradeInfo.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/4/26.
//

import Foundation
import SwiftUI

public struct ActiveTradeInfo: Identifiable, Sendable {
    public var id: String { instrument }
    public let instrument: String
    public let tradeID: String
    public let price: Double
    public let units: Int
    public let isLong: Bool
    public let entryPrice: Double
    public let currentPrice: Double
    public let stopLoss: Double
    public let takeProfit: Double
    public let initialUnits: String
    public let unrealizedPL: Double
    public let marginRequired: Double
    
    public var positionTypeString: String { isLong ? "LONG" : "SHORT" }
}

public struct WatchlistDisplayItem: Identifiable {
    public var id: String { instrument }
    public let instrument: String
    public let strategyName: String
    public let indicatorStatus: String
    public let statusColor: Color
}
