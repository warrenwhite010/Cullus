//
//  ConsensusEngine.swift
//  OandaVisualBot
//
//  Multi-timeframe agreement scoring.
//
//  A strategy firing on one timeframe is one opinion. This combines four
//  independent reads across several timeframes into a signed score, so the bot
//  can refuse the single most expensive category of trade it was taking: a
//  15-minute signal against the 4-hour trend.
//
//  Weighting is deliberately uneven — coarser timeframes get more say. The
//  primary timeframe decides *when*; the higher ones decide *whether*.
//
//  Mirrors src/mcp/oanda/consensus.ts.
//

import Foundation

public struct TimeframeView: Sendable {
    public let timeframe: String
    public let weight: Double
    /// −100…100 for this timeframe alone.
    public let score: Double
    public let adx: Double
    public let rsi: Double
    public let close: Double
    public let reasons: [String]

    public var trend: String { score > 12 ? "up" : (score < -12 ? "down" : "flat") }
}

public struct ConsensusResult: Sendable {
    public let instrument: String
    /// −100…100. Sign is direction, magnitude is conviction.
    public let score: Double
    public let isLong: Bool?
    /// Fraction of timeframes agreeing with the score's direction.
    public let agreement: Double
    public let higherTimeframeAligned: Bool
    public let timeframes: [TimeframeView]
    public let cautions: [String]
    public let summary: String

    /// Does this clear the configured bar for a trade in `direction`?
    public func permits(isLong wanted: Bool, params: StrategyParameters) -> (ok: Bool, reason: String) {
        guard params.consensus.enabled else { return (true, "Consensus checks disabled.") }
        guard let side = isLong else {
            return (false, "No consensus direction (score \(Int(score))).")
        }
        if side != wanted {
            return (false, "Consensus is \(side ? "long" : "short") at \(Int(score)); signal is \(wanted ? "long" : "short").")
        }
        if abs(score) < params.consensus.minScore {
            return (false, "Consensus \(Int(score)) is below the \(Int(params.consensus.minScore)) minimum.")
        }
        if params.consensus.requireHigherTimeframeAlignment && !higherTimeframeAligned {
            return (false, "Higher timeframe disagrees with a \(wanted ? "long" : "short").")
        }
        if agreement < 0.6 {
            return (false, "Only \(Int(agreement * 100))% of timeframes agree.")
        }
        return (true, "Consensus \(Int(score)) with \(Int(agreement * 100))% timeframe agreement.")
    }
}

public enum ConsensusEngine {

    /**
     Score one timeframe from four independent reads.

     Structure (price vs. both SMAs) carries the most weight because it is what
     the higher timeframe is being consulted about. ADX scales that; a stretched
     RSI and a late position in the range reduce it. Momentum extremes reduce
     rather than reverse the score — flipping it would be a mean-reversion bet
     dressed up as consensus.
     */
    public static func scoreTimeframe(
        timeframe: String,
        candles: [Candle],
        params: StrategyParameters,
        weight: Double
    ) -> TimeframeView? {
        let complete = candles.filter(\.complete)
        guard complete.count >= max(params.trend.smaSlow, 30) + 2 else { return nil }

        let closes = complete.map(\.close)
        guard let close = closes.last,
              let fast = Indicators.sma(closes, period: params.trend.smaFast),
              let slow = Indicators.sma(closes, period: params.trend.smaSlow) else { return nil }

        let adx = Indicators.adx(complete, period: 14) ?? 0
        let rsi = Indicators.rsi(closes, period: params.meanReversion.rsiPeriod) ?? 50
        let channel = Indicators.donchian(complete, period: min(params.breakout.lookback, complete.count - 2))

        var reasons: [String] = []
        var score = 0.0

        // 1. Structure.
        if close > fast && fast > slow {
            score += 40
            reasons.append("Price above both SMAs, fast above slow — clean uptrend.")
        } else if close < fast && fast < slow {
            score -= 40
            reasons.append("Price below both SMAs, fast below slow — clean downtrend.")
        } else if close > slow {
            score += 15
            reasons.append("Above the slow SMA, structure mixed.")
        } else if close < slow {
            score -= 15
            reasons.append("Below the slow SMA, structure mixed.")
        }

        // 2. Strength.
        if adx >= 25 {
            score *= 1 + (min(adx / 30, 1.5) - 1) * 0.4
            reasons.append("ADX \(String(format: "%.1f", adx)) confirms a trend.")
        } else if adx < 15 {
            score *= 0.6
            reasons.append("ADX \(String(format: "%.1f", adx)) — ranging; direction is unreliable.")
        }

        // 3. Momentum extremes argue against chasing.
        if rsi > 75 && score > 0 {
            score *= 0.7
            reasons.append("RSI \(String(format: "%.1f", rsi)) overbought — poor place to buy.")
        } else if rsi < 25 && score < 0 {
            score *= 0.7
            reasons.append("RSI \(String(format: "%.1f", rsi)) oversold — poor place to sell.")
        }

        // 4. Position in range: a late entry is a worse entry.
        if let channel, channel.upper > channel.lower {
            let position = min(1, max(0, (close - channel.lower) / (channel.upper - channel.lower)))
            if score > 0 && position > 0.9 {
                score *= 0.8
                reasons.append("At the top of its recent range — entry is late.")
            } else if score < 0 && position < 0.1 {
                score *= 0.8
                reasons.append("At the bottom of its recent range — entry is late.")
            }
        }

        return TimeframeView(
            timeframe: timeframe,
            weight: weight,
            score: max(-100, min(100, score)),
            adx: adx,
            rsi: rsi,
            close: close,
            reasons: reasons
        )
    }

    /// Fetch and score every configured timeframe for one instrument.
    public static func evaluate(
        instrument: String,
        client: OandaServiceProtocol,
        params: StrategyParameters
    ) async -> ConsensusResult {
        // The instrument's own granularity is always primary, so a pair profiled
        // to H1 is not judged on M15 structure.
        var timeframes = [params.granularity]
        timeframes.append(contentsOf: params.consensus.timeframes.filter { $0 != params.granularity })

        var views: [TimeframeView] = []
        let need = max(params.warmupBars + 30, params.trend.smaSlow + 40)

        for (index, timeframe) in timeframes.enumerated() {
            guard let candles = try? await client.fetchCandles(
                instrument: instrument,
                granularity: timeframe,
                count: need
            ) else { continue }

            let weight = 1 + Double(index) * (timeframes.count > 1 ? 1 / Double(timeframes.count - 1) : 0)
            if let view = scoreTimeframe(timeframe: timeframe, candles: candles, params: params, weight: weight) {
                views.append(view)
            }
        }

        guard !views.isEmpty else {
            return ConsensusResult(
                instrument: instrument,
                score: 0,
                isLong: nil,
                agreement: 0,
                higherTimeframeAligned: false,
                timeframes: [],
                cautions: ["No timeframe had enough candles to score."],
                summary: "\(instrument): insufficient data for consensus."
            )
        }

        let totalWeight = views.reduce(0) { $0 + $1.weight }
        let weighted = views.reduce(0) { $0 + $1.score * $1.weight } / totalWeight
        let score = max(-100, min(100, weighted))
        let isLong: Bool? = score > 0 ? true : (score < 0 ? false : nil)

        let agreeing = views.filter { view in
            guard let side = isLong else { return false }
            return side ? view.score > 0 : view.score < 0
        }.count
        let agreement = Double(agreeing) / Double(views.count)

        let higher = views.dropFirst()
        let aligned: Bool
        if let side = isLong {
            aligned = higher.isEmpty || higher.allSatisfy { side ? $0.score >= -12 : $0.score <= 12 }
        } else {
            aligned = false
        }

        var cautions: [String] = []
        if !aligned, let side = isLong {
            let opposed = higher
                .filter { side ? $0.score < -12 : $0.score > 12 }
                .map { "\($0.timeframe) (\(Int($0.score)))" }
            cautions.append("Higher timeframe disagrees: \(opposed.joined(separator: ", ")).")
        }
        if agreement < 0.6 && isLong != nil {
            cautions.append("Only \(Int(agreement * 100))% of timeframes agree.")
        }
        if views.allSatisfy({ $0.trend == "flat" }) {
            cautions.append("Every timeframe reads flat — no directional edge.")
        }

        let summary: String
        if let side = isLong, abs(score) >= params.consensus.minScore, agreement >= 0.6, aligned {
            summary = "\(instrument): \(side ? "long" : "short") consensus \(Int(score)) with \(Int(agreement * 100))% agreement."
        } else {
            summary = "\(instrument): no tradeable consensus (score \(Int(score)))."
        }

        return ConsensusResult(
            instrument: instrument,
            score: score,
            isLong: isLong,
            agreement: agreement,
            higherTimeframeAligned: aligned,
            timeframes: views,
            cautions: cautions,
            summary: summary
        )
    }
}
