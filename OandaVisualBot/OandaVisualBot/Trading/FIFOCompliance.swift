//
//  FIFOCompliance.swift
//  OandaVisualBot
//
//  FIFO / no-hedge rules for US-regulated OANDA accounts.
//
//  CFTC/NFA rules make a US account behave in two ways that break naive bot
//  logic, and the bot previously did both wrong:
//
//   1. NO HEDGING. A US account cannot be long and short the same instrument. An
//      opposite-direction order REDUCES or CLOSES the existing position instead
//      of opening a new one. The bot's strategies now emit shorts — so without
//      this guard, a short signal on a pair the bot is already long would quietly
//      flatten a winning position and log it as a new trade.
//
//   2. FIFO CLOSEOUT. With several trades open on one instrument they must be
//      closed oldest-first. `clearAllOrders()` iterated `fetchActiveTrades` in
//      whatever order the API returned and called cancelOrder on each — on a US
//      account that is a FIFO_VIOLATION for any trade that is not the oldest.
//
//  Mirrors src/mcp/oanda/fifo.ts.
//

import Foundation

public struct FIFOEntryCheck: Sendable {
    public let allowed: Bool
    /// True when the order would reduce or close rather than open.
    public let wouldReduce: Bool
    public let reasons: [String]
}

public enum FIFOCompliance {

    /// Net signed units held on an instrument.
    public static func netPosition(instrument: String, trades: [ActiveTradeInfo]) -> Int {
        trades.filter { $0.instrument == instrument }.reduce(0) { $0 + $1.units }
    }

    /**
     Open trades on an instrument, oldest first — the only order FIFO permits.

     ActiveTradeInfo carries no open timestamp, so trade ID is used as the proxy:
     OANDA issues them monotonically, so a numerically smaller ID is older. That
     holds for every v20 account and is the ordering the broker itself applies.
     */
    public static func fifoOrdered(instrument: String, trades: [ActiveTradeInfo]) -> [ActiveTradeInfo] {
        trades
            .filter { $0.instrument == instrument }
            .sorted { lhs, rhs in
                let left = Int(lhs.tradeID) ?? Int.max
                let right = Int(rhs.tradeID) ?? Int.max
                return left == right ? lhs.tradeID < rhs.tradeID : left < right
            }
    }

    /// All open trades ordered so that closing them in sequence never violates FIFO.
    public static func fifoOrderedAll(_ trades: [ActiveTradeInfo]) -> [ActiveTradeInfo] {
        let instruments = Set(trades.map(\.instrument))
        return instruments.sorted().flatMap { fifoOrdered(instrument: $0, trades: trades) }
    }

    /// Can this entry be opened, or would it silently reduce a position?
    public static func checkEntry(
        instrument: String,
        isLong: Bool,
        trades: [ActiveTradeInfo],
        enabled: Bool,
        allowReducingOrders: Bool
    ) -> FIFOEntryCheck {
        guard enabled else { return FIFOEntryCheck(allowed: true, wouldReduce: false, reasons: []) }

        let net = netPosition(instrument: instrument, trades: trades)
        guard net != 0 else { return FIFOEntryCheck(allowed: true, wouldReduce: false, reasons: []) }

        let heldLong = net > 0
        if heldLong != isLong {
            let message = "FIFO/no-hedge: \(instrument) is already \(heldLong ? "long" : "short") "
                + "\(abs(net)) units. A \(isLong ? "long" : "short") order would reduce or flatten "
                + "that position, not open a new one."
            return FIFOEntryCheck(
                allowed: allowReducingOrders,
                wouldReduce: true,
                reasons: [message]
            )
        }

        return FIFOEntryCheck(
            allowed: true,
            wouldReduce: false,
            reasons: ["Adding to an existing \(heldLong ? "long" : "short") on \(instrument); exits will be oldest-first."]
        )
    }

    /// `positionFill` for a new order. REDUCE_FIRST states the netting behaviour
    /// explicitly instead of inheriting an account default we cannot inspect.
    public static func positionFill(enabled: Bool) -> String {
        enabled ? "REDUCE_FIRST" : "DEFAULT"
    }
}
