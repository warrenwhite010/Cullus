//
//  MockOandaClient.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public final class MockOandaClient: OandaServiceProtocol, @unchecked Sendable {
    public func fetchPendingOrders(accountID: String) async throws -> [PendingOrderInfo] {
        return []
    }
    
    public var shouldHavePosition: Bool
    public var shouldThrowError: Bool
    public nonisolated(unsafe) var executedOrderCount: Int = 0
    
    public nonisolated init(shouldHavePosition: Bool = false, shouldThrowError: Bool = false) {
        self.shouldHavePosition = shouldHavePosition
        self.shouldThrowError = shouldThrowError
    }
    
    public func fetchAccountSummary(accountID: String) async throws -> AccountSummaryResponse {
        if shouldThrowError {
            throw URLError(.badServerResponse)
        }
        // Return an appropriate mock account summary response for testing
        return AccountSummaryResponse(nav: "10000.0", marginAvailable: "5000.0", pl: "0.0")
    }
    
    public func cancelOrder(accountID: String, orderID: String) async throws {
            // Mock implementation for testing order cancellation
        }
    
    public func fetchRecentClosePrices(instrument: String, granularity: String, count: Int) async throws -> [Double] {
        if shouldThrowError { throw URLError(.badServerResponse) }
        return (0..<count).map { 1.1000 + (Double($0) * 0.0001) }
    }

    /// Synthetic bars with a real high/low range, so ATR-driven code under test
    /// sees a non-zero true range instead of the degenerate one that
    /// close-only data produces.
    public func fetchCandles(instrument: String, granularity: String, count: Int) async throws -> [Candle] {
        if shouldThrowError { throw URLError(.badServerResponse) }
        let closes = try await fetchRecentClosePrices(instrument: instrument, granularity: granularity, count: count)
        let spec = InstrumentSpec.forInstrument(instrument)
        let wick = spec.distance(pips: 4)
        let now = Date()

        return closes.enumerated().map { index, close in
            Candle(
                time: now.addingTimeInterval(Double(index - closes.count) * 60),
                open: index == 0 ? close : closes[index - 1],
                high: close + wick,
                low: close - wick,
                close: close,
                volume: 100,
                complete: true
            )
        }
    }

    /// Position reductions and stop moves, recorded for assertions.
    public struct RecordedReduction: Sendable {
        public let instrument: String
        public let units: Int
        public let isLong: Bool
    }

    public struct RecordedStopMove: Sendable {
        public let tradeID: String
        public let stopPrice: Double
    }

    public nonisolated(unsafe) var reductions: [RecordedReduction] = []
    public nonisolated(unsafe) var stopMoves: [RecordedStopMove] = []

    public func reducePosition(accountID: String, instrument: String, units: Int, isLong: Bool) async throws {
        if shouldThrowError { throw URLError(.badServerResponse) }
        reductions.append(RecordedReduction(instrument: instrument, units: units, isLong: isLong))
    }

    public func updateTradeStop(accountID: String, tradeID: String, stopPrice: Double, precision: Int) async throws {
        if shouldThrowError { throw URLError(.badServerResponse) }
        stopMoves.append(RecordedStopMove(tradeID: tradeID, stopPrice: stopPrice))
    }

    public func fetchQuote(instrument: String) async throws -> PriceQuote? {
        if shouldThrowError { throw URLError(.badServerResponse) }
        let spec = InstrumentSpec.forInstrument(instrument)
        let mid = 1.1000
        return PriceQuote(
            instrument: instrument,
            bid: mid - spec.distance(pips: 0.5),
            ask: mid + spec.distance(pips: 0.5),
            tradeable: true
        )
    }
    
    public func executeMarketOrder(
        accountID: String,
        instrument: String,
        units: Int,
        stopLoss: String,
        takeProfit: String
        ) async throws {
        if shouldThrowError { throw URLError(.badServerResponse) }
        executedOrderCount += 1
    }
    
    public func hasExistingPosition(accountID: String, instrument: String) async throws -> Bool {
        return shouldHavePosition
    }
    public func fetchActiveTrades(accountID: String) async throws -> [ActiveTradeInfo] {
        if shouldThrowError { throw URLError(.badServerResponse) }
        if shouldHavePosition {
            return [
                ActiveTradeInfo(
                    instrument: "EUR_USD",
                    tradeID: "mock_trade_1",
                    price: 1.1020,
                    units: 1000,
                    isLong: true,
                    entryPrice: 1.1000,
                    currentPrice: 1.1020,
                    stopLoss: 1.0980,
                    takeProfit: 1.1060,
                    initialUnits: "1000",
                    unrealizedPL: 20.0,
                    marginRequired: 0.0
                )
            ]
        }
        return []
    }
    /// What the last dynamic order actually asked the broker for. Recorded so
    /// tests can assert on direction and bracket distances, which is where the
    /// expensive bugs live.
    public struct RecordedOrder: Sendable {
        public let instrument: String
        public let units: Int
        public let isLong: Bool
        public let isLimit: Bool
        public let targetPrice: Double?
        public let stopLossDistance: String
        public let takeProfitDistance: String

        /// Signed units as the real client would compute them.
        public var signedUnits: Int { isLong ? units : -units }
    }

    public nonisolated(unsafe) var lastOrder: RecordedOrder?

    public func executeDynamicOrder(
        accountID: String,
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        stopLossDistance: String,
        takeProfitDistance: String
    ) async throws {
        if shouldThrowError {
            throw URLError(.badServerResponse)
        }
        executedOrderCount += 1
        lastOrder = RecordedOrder(
            instrument: instrument,
            units: units,
            isLong: isLong,
            isLimit: isLimit,
            targetPrice: targetPrice,
            stopLossDistance: stopLossDistance,
            takeProfitDistance: takeProfitDistance
        )
    }
}
