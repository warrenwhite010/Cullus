//
//  Indicators.swift
//  OandaVisualBot
//
//  Wilder ATR / RSI / ADX, SMA and Donchian channels over OHLC bars.
//
//  These mirror src/mcp/oanda/indicators.ts in the AssistantCLI repo one for
//  one. That is the point: the MCP backtester and this app must agree on what
//  "ATR(14) on M15" means, or the backtest describes a strategy nobody runs.
//

import Foundation

public enum Indicators {

    public static func sma(_ values: [Double], period: Int) -> Double? {
        guard period > 0, values.count >= period else { return nil }
        return values.suffix(period).reduce(0, +) / Double(period)
    }

    /// SMA at every index, NaN until the window fills.
    public static func smaSeries(_ values: [Double], period: Int) -> [Double] {
        guard period > 0 else { return Array(repeating: .nan, count: values.count) }
        var out = Array(repeating: Double.nan, count: values.count)
        var sum = 0.0
        for i in values.indices {
            sum += values[i]
            if i >= period { sum -= values[i - period] }
            if i >= period - 1 { out[i] = sum / Double(period) }
        }
        return out
    }

    public static func trueRange(_ candles: [Candle]) -> [Double] {
        candles.enumerated().map { index, candle in
            guard index > 0 else { return candle.range }
            let previousClose = candles[index - 1].close
            return max(
                candle.range,
                abs(candle.high - previousClose),
                abs(candle.low - previousClose)
            )
        }
    }

    /// Wilder ATR — the volatility unit every stop, target and size derives from.
    public static func atr(_ candles: [Candle], period: Int = 14) -> Double? {
        guard candles.count > period else { return nil }
        let tr = trueRange(candles)
        var value = tr.prefix(period).reduce(0, +) / Double(period)
        for i in period..<tr.count {
            value = ((value * Double(period - 1)) + tr[i]) / Double(period)
        }
        return value.isFinite && value > 0 ? value : nil
    }

    /// Wilder RSI on closes.
    public static func rsi(_ values: [Double], period: Int = 14) -> Double? {
        guard values.count > period else { return nil }
        var gain = 0.0
        var loss = 0.0
        for i in 1...period {
            let change = values[i] - values[i - 1]
            if change >= 0 { gain += change } else { loss -= change }
        }
        var averageGain = gain / Double(period)
        var averageLoss = loss / Double(period)

        if values.count > period + 1 {
            for i in (period + 1)..<values.count {
                let change = values[i] - values[i - 1]
                averageGain = ((averageGain * Double(period - 1)) + max(change, 0)) / Double(period)
                averageLoss = ((averageLoss * Double(period - 1)) + max(-change, 0)) / Double(period)
            }
        }
        if averageLoss == 0 { return 100 }
        return 100 - (100 / (1 + averageGain / averageLoss))
    }

    /**
     Wilder ADX: trend strength without direction.

     The cheapest filter available, and the one the bot was missing. Fading a
     market that is trending hard, or buying a "breakout" in a dead range, are the
     two ways a signal set with a real edge still bleeds.
     */
    public static func adx(_ candles: [Candle], period: Int = 14) -> Double? {
        guard candles.count > period * 2 else { return nil }
        let tr = trueRange(candles)
        var plusDM = Array(repeating: 0.0, count: candles.count)
        var minusDM = Array(repeating: 0.0, count: candles.count)

        for i in 1..<candles.count {
            let upMove = candles[i].high - candles[i - 1].high
            let downMove = candles[i - 1].low - candles[i].low
            plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0
            minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0
        }

        var trSum = tr[1...period].reduce(0, +)
        var plusSum = plusDM[1...period].reduce(0, +)
        var minusSum = minusDM[1...period].reduce(0, +)

        var dxValues: [Double] = []
        for i in (period + 1)..<candles.count {
            trSum = trSum - (trSum / Double(period)) + tr[i]
            plusSum = plusSum - (plusSum / Double(period)) + plusDM[i]
            minusSum = minusSum - (minusSum / Double(period)) + minusDM[i]
            guard trSum > 0 else { continue }

            let plusDI = 100 * plusSum / trSum
            let minusDI = 100 * minusSum / trSum
            let denominator = plusDI + minusDI
            dxValues.append(denominator == 0 ? 0 : 100 * abs(plusDI - minusDI) / denominator)
        }

        guard dxValues.count >= period else { return nil }
        var adxValue = dxValues.prefix(period).reduce(0, +) / Double(period)
        for i in period..<dxValues.count {
            adxValue = ((adxValue * Double(period - 1)) + dxValues[i]) / Double(period)
        }
        return adxValue
    }

    /// Highest high and lowest low over the `period` bars *before* the last one.
    public static func donchian(_ candles: [Candle], period: Int) -> (upper: Double, lower: Double)? {
        guard candles.count > period else { return nil }
        let window = candles.dropLast().suffix(period)
        guard let upper = window.map(\.high).max(), let lower = window.map(\.low).min() else { return nil }
        return (upper, lower)
    }
}
