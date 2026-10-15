//
//  OandaServiceProtocol.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public struct PendingOrderInfo: Codable, Sendable, Identifiable {
    public var id: String
    public var instrument: String
    public var type: String
    public var price: String
    public var units: String
    
    public init(id: String, instrument: String, type: String, price: String, units: String) {
        self.id = id
        self.instrument = instrument
        self.type = type
        self.price = price
        self.units = units
    }
}

public protocol OandaServiceProtocol {
    func fetchRecentClosePrices(instrument: String, granularity: String, count: Int) async throws -> [Double]
    /// Full OHLC bars. Required for a true range, and therefore for any ATR.
    func fetchCandles(instrument: String, granularity: String, count: Int) async throws -> [Candle]
    /// Live bid/ask, so the spread filter uses the real cost of trading.
    func fetchQuote(instrument: String) async throws -> PriceQuote?
    func executeMarketOrder(accountID: String, instrument: String, units: Int, stopLoss: String, takeProfit: String) async throws
    func hasExistingPosition(accountID: String, instrument: String) async throws -> Bool
    func fetchActiveTrades(accountID: String) async throws -> [ActiveTradeInfo]
    func fetchPendingOrders(accountID: String) async throws -> [PendingOrderInfo]
    func fetchAccountSummary(accountID: String) async throws -> AccountSummaryResponse
    
    func executeDynamicOrder(
        accountID: String,
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        stopLossDistance: String,
        takeProfitDistance: String
    ) async throws
    func cancelOrder(accountID: String, orderID: String) async throws
    /// Reduce or close an instrument's position. FIFO-safe: the broker applies
    /// oldest-first, unlike a close by trade ID.
    func reducePosition(accountID: String, instrument: String, units: Int, isLong: Bool) async throws
    /// Move an open trade's stop loss.
    func updateTradeStop(accountID: String, tradeID: String, stopPrice: Double, precision: Int) async throws
    /// Financing rates and the per-weekday charge schedule for an instrument.
    func fetchInstrumentFinancing(accountID: String, instrument: String) async throws -> InstrumentFinancing?
}

public extension OandaServiceProtocol {
    /**
     Fallback OHLC, synthesised from closes.

     Present so that a client written before OHLC existed still compiles and
     runs. It is deliberately loud: with open == high == low == close the true
     range collapses to the gap between consecutive closes, so ATR understates
     volatility and stops come out too tight. Any client that trades real money
     should implement `fetchCandles` properly — OandaClient does.
     */
    func fetchCandles(instrument: String, granularity: String, count: Int) async throws -> [Candle] {
        let closes = try await fetchRecentClosePrices(instrument: instrument, granularity: granularity, count: count)
        print("[CANDLES] \(type(of: self)) has no OHLC implementation; synthesising \(closes.count) bars from closes. ATR will read low.")
        let now = Date()
        return closes.enumerated().map { index, close in
            Candle(
                time: now.addingTimeInterval(Double(index - closes.count) * 60),
                open: close,
                high: close,
                low: close,
                close: close,
                volume: 0,
                complete: true
            )
        }
    }

    /// No quote available; callers fall back to an ATR-derived spread estimate.
    func fetchQuote(instrument: String) async throws -> PriceQuote? { nil }

    /// Refuse loudly rather than silently doing nothing: a client that cannot
    /// reduce a position must not let trade management believe it succeeded.
    func reducePosition(accountID: String, instrument: String, units: Int, isLong: Bool) async throws {
        throw NSError(
            domain: "OandaVisualBot",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "\(type(of: self)) does not implement reducePosition."]
        )
    }

    func updateTradeStop(accountID: String, tradeID: String, stopPrice: Double, precision: Int) async throws {
        throw NSError(
            domain: "OandaVisualBot",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "\(type(of: self)) does not implement updateTradeStop."]
        )
    }

    /// No financing data. Callers fall back to zero rates, which makes the carry
    /// gate inert rather than making it refuse everything.
    func fetchInstrumentFinancing(accountID: String, instrument: String) async throws -> InstrumentFinancing? {
        nil
    }
}
