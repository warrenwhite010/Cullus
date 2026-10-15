//
//  PositionManager.swift
//  OandaVisualBot
//
//  Trade management after entry: partial take-profit and stop ratcheting.
//
//  OANDA cannot attach a scale-out to an order, so banking part of a position at
//  1R has to be done by the bot on a later cycle. That is what this does, and it
//  is written FIFO-safely: reductions go through the position-close endpoint,
//  which the broker applies oldest-first, so it cannot trip FIFO_VIOLATION.
//
//  Note on defaults: partial take-profit is OFF unless the parameter file turns
//  it on, because it measured worse than leaving the target alone (it caps the
//  winners that pay for the losers without shrinking the losers). The machinery
//  is here, and the MCP backtester can price it on real candles per pair, which
//  is the only sound basis for enabling it.
//

import Foundation

public struct PositionAction: Sendable {
    public enum Kind: String, Sendable {
        case partialTakeProfit
        case moveStopToBreakEven
        case trailStop
    }

    public let kind: Kind
    public let instrument: String
    public let tradeID: String
    /// Units to close, for a partial take-profit.
    public let units: Int
    /// New stop price, for a stop move.
    public let stopPrice: Double
    public let rationale: String
}

public enum PositionManager {

    /// R multiple currently achieved by an open trade, using its own stop distance.
    public static func currentR(_ trade: ActiveTradeInfo) -> Double? {
        guard trade.stopLoss > 0, trade.entryPrice > 0 else { return nil }
        let stopDistance = abs(trade.entryPrice - trade.stopLoss)
        guard stopDistance > 0 else { return nil }
        let move = trade.isLong
            ? trade.currentPrice - trade.entryPrice
            : trade.entryPrice - trade.currentPrice
        return move / stopDistance
    }

    /**
     What should happen to each open trade on this cycle.

     Pure: it decides, the caller executes. That keeps the rules testable without
     a broker, which matters because every one of these actions spends money.
     */
    public static func plan(
        trades: [ActiveTradeInfo],
        params: StrategyParameters,
        alreadyScaled: Set<String>
    ) -> [PositionAction] {
        var actions: [PositionAction] = []

        for trade in trades {
            let perPair = params.resolved(for: trade.instrument)
            let spec = InstrumentSpec.forInstrument(trade.instrument)
            guard let progressR = currentR(trade) else { continue }

            let stopDistance = abs(trade.entryPrice - trade.stopLoss)

            // 1. Partial take-profit at 1R, once per trade.
            if perPair.entry.partialTakeProfitFraction > 0,
               perPair.entry.takeProfitR > 1,
               !alreadyScaled.contains(trade.tradeID),
               progressR >= 1.0 {
                let closing = Int(Double(abs(trade.units)) * perPair.entry.partialTakeProfitFraction)
                if closing > 0 && closing < abs(trade.units) {
                    actions.append(PositionAction(
                        kind: .partialTakeProfit,
                        instrument: trade.instrument,
                        tradeID: trade.tradeID,
                        units: closing,
                        stopPrice: trade.entryPrice,
                        rationale: "Up \(String(format: "%.2f", progressR))R — banking "
                            + "\(Int(perPair.entry.partialTakeProfitFraction * 100))% and moving the stop to break-even."
                    ))
                    continue
                }
            }

            // 2. Break-even ratchet.
            if perPair.entry.trailAfterR > 0, progressR >= perPair.entry.trailAfterR {
                let breakeven = spec.round(trade.entryPrice)
                let improves = trade.isLong ? breakeven > trade.stopLoss : breakeven < trade.stopLoss
                if improves {
                    actions.append(PositionAction(
                        kind: .moveStopToBreakEven,
                        instrument: trade.instrument,
                        tradeID: trade.tradeID,
                        units: 0,
                        stopPrice: breakeven,
                        rationale: "Up \(String(format: "%.2f", progressR))R — stop to break-even."
                    ))
                    continue
                }
            }

            // 3. ATR trail on a scaled-out runner.
            if alreadyScaled.contains(trade.tradeID),
               perPair.entry.runnerTrailAtrMultiple > 0,
               stopDistance > 0 {
                // The trade's own initial stop distance stands in for ATR here:
                // it was derived from ATR at entry, and using it avoids another
                // candle fetch per open trade every cycle.
                let atrProxy = stopDistance / max(perPair.entry.stopAtrMultiple, 0.0001)
                let trailDistance = atrProxy * perPair.entry.runnerTrailAtrMultiple
                let trailed = spec.round(
                    trade.isLong ? trade.currentPrice - trailDistance : trade.currentPrice + trailDistance
                )
                let improves = trade.isLong ? trailed > trade.stopLoss : trailed < trade.stopLoss
                if improves {
                    actions.append(PositionAction(
                        kind: .trailStop,
                        instrument: trade.instrument,
                        tradeID: trade.tradeID,
                        units: 0,
                        stopPrice: trailed,
                        rationale: "Runner trailing at \(perPair.entry.runnerTrailAtrMultiple)×ATR "
                            + "(\(String(format: "%.1f", spec.pips(distance: trailDistance))) pips)."
                    ))
                }
            }
        }

        return actions
    }
}
