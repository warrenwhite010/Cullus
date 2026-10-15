//
//  Candle.swift
//  OandaVisualBot
//
//  OHLC bar. The strategies used to work from close prices alone, which makes a
//  true range — and therefore an ATR, and therefore any honest stop — impossible
//  to compute.
//

import Foundation

public struct Candle: Sendable, Equatable {
    public let time: Date
    public let open: Double
    public let high: Double
    public let low: Double
    public let close: Double
    public let volume: Int
    /// OANDA marks the forming bar incomplete; trading off it is trading a price
    /// that has not happened yet.
    public let complete: Bool

    public init(time: Date, open: Double, high: Double, low: Double, close: Double, volume: Int, complete: Bool) {
        self.time = time
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
        self.complete = complete
    }

    public var range: Double { high - low }
}

public struct PriceQuote: Sendable {
    public let instrument: String
    public let bid: Double
    public let ask: Double
    public let tradeable: Bool

    public init(instrument: String, bid: Double, ask: Double, tradeable: Bool) {
        self.instrument = instrument
        self.bid = bid
        self.ask = ask
        self.tradeable = tradeable
    }

    public var mid: Double { (bid + ask) / 2 }
    public var spread: Double { ask - bid }
}
