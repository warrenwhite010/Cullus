//
//  InstrumentSpec.swift
//  OandaVisualBot
//
//  Per-instrument price scale.
//
//  This file exists because of one bug class that quietly costs money: a stop
//  expressed as the literal string "0.0020" is 20 pips on EUR_USD and one fifth
//  of a pip on USD_JPY. The bot used to send that same constant to every
//  instrument, so every JPY and crypto order either got rejected by the broker
//  or opened with a stop inside the spread and was closed on the next tick.
//
//  Everything downstream should reason in *pips* or *ATR multiples* and convert
//  through this type exactly once, at the edge where a price string is built.
//

import Foundation

public struct InstrumentSpec: Sendable, Equatable {
    public let name: String
    /// Exponent of one pip: -4 → 0.0001, -2 → 0.01.
    public let pipExponent: Int
    /// Decimal places OANDA accepts for a price on this instrument.
    public let displayPrecision: Int
    public let minimumTradeSize: Int
    /// Fraction of notional the broker holds as margin.
    public let marginRate: Double

    public var pipSize: Double { pow(10.0, Double(pipExponent)) }

    public init(name: String, pipExponent: Int, displayPrecision: Int, minimumTradeSize: Int, marginRate: Double) {
        self.name = name
        self.pipExponent = pipExponent
        self.displayPrecision = displayPrecision
        self.minimumTradeSize = minimumTradeSize
        self.marginRate = marginRate
    }

    /// Price distance for a pip count.
    public func distance(pips: Double) -> Double { pips * pipSize }

    /// Pip count for a price distance.
    public func pips(distance: Double) -> Double { pipSize > 0 ? distance / pipSize : 0 }

    /// A price or distance formatted the way the v20 API expects it.
    public func format(_ value: Double) -> String {
        String(format: "%.\(displayPrecision)f", value)
    }

    /// Round a price to the instrument's tick so the broker cannot reject it.
    public func round(_ price: Double) -> Double {
        let factor = pow(10.0, Double(displayPrecision))
        return (price * factor).rounded() / factor
    }

    /**
     Spec for an instrument, derived from its symbol.

     Derived rather than fetched so risk maths never depends on a network call
     succeeding. The values match OANDA's published instrument list for the
     common symbols; anything unrecognised falls back to the 5-decimal FX
     convention, which is the safe direction to be wrong in (too small a stop is
     rejected loudly, too large a one is silently expensive).
     */
    public static func forInstrument(_ instrument: String) -> InstrumentSpec {
        let symbol = instrument.uppercased()

        // Crypto: quoted in whole currency units, wide ticks, heavy margin.
        if symbol.contains("BTC") || symbol.contains("ETH") ||
           symbol.contains("LTC") || symbol.contains("BCH") {
            return InstrumentSpec(
                name: symbol,
                pipExponent: 0,
                displayPrecision: 2,
                minimumTradeSize: 1,
                marginRate: 0.50
            )
        }

        // JPY and other two-decimal quotes: one pip is 0.01, not 0.0001.
        if symbol.hasSuffix("_JPY") || symbol.contains("JPY") {
            return InstrumentSpec(
                name: symbol,
                pipExponent: -2,
                displayPrecision: 3,
                minimumTradeSize: 1,
                marginRate: 0.03
            )
        }

        // Metals are quoted per ounce with a 0.01 pip and a much larger tick value.
        if symbol.hasPrefix("XAU") || symbol.hasPrefix("XAG") {
            return InstrumentSpec(
                name: symbol,
                pipExponent: -2,
                displayPrecision: 3,
                minimumTradeSize: 1,
                marginRate: 0.05
            )
        }

        // Standard FX majors and crosses.
        return InstrumentSpec(
            name: symbol,
            pipExponent: -4,
            displayPrecision: 5,
            minimumTradeSize: 1,
            marginRate: 0.03
        )
    }

    /// The currencies this instrument exposes the account to.
    public static func currencies(of instrument: String) -> [String] {
        let parts = instrument.uppercased().split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "/" })
        return parts.count == 2 ? parts.map(String.init) : [instrument.uppercased()]
    }
}
