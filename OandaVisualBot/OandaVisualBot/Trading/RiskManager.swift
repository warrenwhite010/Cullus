//
//  RiskManager.swift
//  OandaVisualBot
//
//  Position sizing and the pre-trade veto.
//
//  The bot previously sent `units: 500` for every signal on every instrument.
//  That means a 500-unit EUR_USD trade with a 12-pip stop risks about $6, while
//  the same 500 units of USD_JPY with a 60-pip stop risks about $20 — and the
//  size is largest exactly when volatility is highest. Sizing from a fixed
//  fraction of NAV divided by the stop distance is the single change with the
//  largest effect on long-run P/L, ahead of any entry signal.
//

import Foundation

public struct PositionSize: Sendable {
    /// Absolute units. Zero means "do not trade": the risk budget cannot cover it.
    public let units: Int
    /// Signed for the direction, which is what the v20 API wants.
    public let signedUnits: Int
    public let riskBudget: Double
    public let riskIfStopped: Double
    public let stopDistance: Double
    public let stopPips: Double
    public let notes: [String]
}

public struct RiskVeto: Sendable {
    public let allowed: Bool
    public let reasons: [String]

    public static let allow = RiskVeto(allowed: true, reasons: [])
    public static func block(_ reasons: [String]) -> RiskVeto {
        RiskVeto(allowed: false, reasons: reasons)
    }
}

/// Everything the risk layer needs to know about the account this instant.
public struct AccountSnapshot: Sendable {
    public var nav: Double
    public var marginAvailable: Double
    public var marginUsed: Double
    public var openTrades: [ActiveTradeInfo]
    /// Realised + unrealised P/L since the session's start-of-day mark.
    public var dailyPL: Double

    public init(nav: Double, marginAvailable: Double, marginUsed: Double, openTrades: [ActiveTradeInfo], dailyPL: Double) {
        self.nav = nav
        self.marginAvailable = marginAvailable
        self.marginUsed = marginUsed
        self.openTrades = openTrades
        self.dailyPL = dailyPL
    }
}

public enum RiskManager {

    /**
     Units whose stop-out costs exactly `riskPerTradePct` of NAV.

     `quoteToAccountRate` converts one unit of the quote currency into the account
     currency: 1.0 for any XXX_USD pair on a USD account, roughly 1/price for
     USD_XXX. Cross pairs are approximated at 1.0, which is why the caller should
     prefer instruments quoted in the account currency when precision matters.
     */
    public static func size(
        nav: Double,
        riskPerTradePct: Double,
        stopDistance: Double,
        spec: InstrumentSpec,
        isLong: Bool,
        quoteToAccountRate: Double = 1.0,
        marginAvailable: Double? = nil,
        entryPrice: Double? = nil,
        maxMarginUtilizationPct: Double? = nil
    ) -> PositionSize {
        var notes: [String] = []
        let riskBudget = nav * riskPerTradePct / 100.0

        guard stopDistance > 0, nav > 0 else {
            return PositionSize(
                units: 0,
                signedUnits: 0,
                riskBudget: riskBudget,
                riskIfStopped: 0,
                stopDistance: stopDistance,
                stopPips: 0,
                notes: ["Refusing to size a position with a non-positive stop distance or NAV."]
            )
        }

        let lossPerUnit = stopDistance * quoteToAccountRate
        var units = Int((riskBudget / lossPerUnit).rounded(.down))

        if units < spec.minimumTradeSize {
            notes.append(
                "Risk budget \(String(format: "%.2f", riskBudget)) only supports \(units) units of "
                + "\(spec.name), below the \(spec.minimumTradeSize)-unit minimum. Taking the trade "
                + "would exceed \(riskPerTradePct)% risk, so it is skipped."
            )
            units = 0
        }

        // Margin is an independent ceiling: passing the risk test does not mean
        // the broker will accept the order.
        if units > 0, let available = marginAvailable, let price = entryPrice, price > 0 {
            let cap = (maxMarginUtilizationPct ?? 100) / 100
            let marginPerUnit = price * spec.marginRate * quoteToAccountRate
            if marginPerUnit > 0 {
                let affordable = Int((available * cap / marginPerUnit).rounded(.down))
                if affordable < units {
                    notes.append("Margin-capped from \(units) to \(max(0, affordable)) units.")
                    units = max(0, affordable)
                }
            }
        }

        return PositionSize(
            units: units,
            signedUnits: isLong ? units : -units,
            riskBudget: riskBudget,
            riskIfStopped: Double(units) * lossPerUnit,
            stopDistance: stopDistance,
            stopPips: spec.pips(distance: stopDistance),
            notes: notes
        )
    }

    /// Total risk currently on the table, from each open trade's own stop.
    public static func openRisk(_ trades: [ActiveTradeInfo]) -> (amount: Double, unstopped: [String]) {
        var amount = 0.0
        var unstopped: [String] = []
        for trade in trades {
            guard trade.stopLoss > 0 else {
                unstopped.append(trade.instrument)
                continue
            }
            amount += abs(Double(trade.units)) * abs(trade.entryPrice - trade.stopLoss)
        }
        return (amount, unstopped)
    }

    /**
     Every reason not to open this trade, gathered before an order is built.

     Each clause here is a loss the bot could previously take repeatedly:
     stacking three correlated EUR longs, adding risk while already down for the
     day, or opening a fourth position with the margin of a first.
     */
    public static func vetoNewTrade(
        instrument: String,
        snapshot: AccountSnapshot,
        params: StrategyParameters
    ) -> RiskVeto {
        var reasons: [String] = []
        guard snapshot.nav > 0 else {
            return .block(["Account NAV is zero or unknown; refusing to trade blind."])
        }

        // Daily loss limit: the mechanism that turns a bad day into a bad day
        // rather than a bad month.
        let dailyLossPct = snapshot.dailyPL < 0 ? abs(snapshot.dailyPL) / snapshot.nav * 100 : 0
        if dailyLossPct >= params.risk.maxDailyLossPct {
            reasons.append(
                "Down \(String(format: "%.2f", dailyLossPct))% today, at or past the "
                + "\(params.risk.maxDailyLossPct)% daily limit. No new risk until the next session."
            )
        }

        let here = snapshot.openTrades.filter { $0.instrument == instrument }.count
        if here >= params.risk.maxOpenTradesPerInstrument {
            reasons.append("Already holding \(here) trade(s) in \(instrument).")
        }

        // Correlation cap: EUR_USD, EUR_JPY and EUR_GBP long is one leveraged EUR
        // bet wearing three hats.
        var exposure: [String: Int] = [:]
        for trade in snapshot.openTrades {
            for currency in InstrumentSpec.currencies(of: trade.instrument) {
                exposure[currency, default: 0] += 1
            }
        }
        for currency in InstrumentSpec.currencies(of: instrument) {
            let held = exposure[currency] ?? 0
            if held >= params.risk.maxTradesPerCurrency {
                reasons.append(
                    "\(held) open trade(s) already expose \(currency) (cap \(params.risk.maxTradesPerCurrency))."
                )
            }
        }

        let risk = openRisk(snapshot.openTrades)
        let openRiskPct = risk.amount / snapshot.nav * 100
        if openRiskPct + params.risk.riskPerTradePct > params.risk.maxOpenRiskPct {
            reasons.append(
                "Open risk \(String(format: "%.2f", openRiskPct))% plus this trade would exceed the "
                + "\(params.risk.maxOpenRiskPct)% portfolio ceiling."
            )
        }
        if !risk.unstopped.isEmpty {
            reasons.append(
                "Unstopped position(s) on \(risk.unstopped.joined(separator: ", ")) — that unbounded "
                + "risk has to be fixed before adding more."
            )
        }

        let marginUtilPct = snapshot.marginUsed / snapshot.nav * 100
        if marginUtilPct >= params.risk.maxMarginUtilizationPct {
            reasons.append(
                "Margin utilisation \(String(format: "%.1f", marginUtilPct))% is at the "
                + "\(params.risk.maxMarginUtilizationPct)% limit."
            )
        }

        return reasons.isEmpty ? .allow : .block(reasons)
    }

    /// Is the round-trip spread small enough relative to the expected move?
    public static func spreadIsAcceptable(
        spread: Double,
        atr: Double,
        spec: InstrumentSpec,
        params: StrategyParameters
    ) -> (ok: Bool, reason: String) {
        let atrPips = spec.pips(distance: atr)
        let spreadPips = spec.pips(distance: spread)

        if atrPips < params.entry.minAtrPips {
            return (false, "ATR \(String(format: "%.1f", atrPips)) pips is below the \(params.entry.minAtrPips)-pip floor.")
        }
        guard atr > 0 else { return (false, "No ATR available.") }
        let ratio = spread / atr
        if ratio > params.entry.maxSpreadAtrRatio {
            return (
                false,
                "Spread \(String(format: "%.1f", spreadPips)) pips is \(String(format: "%.0f", ratio * 100))% of ATR "
                + "(limit \(String(format: "%.0f", params.entry.maxSpreadAtrRatio * 100))%)."
            )
        }
        return (true, "Spread \(String(format: "%.1f", spreadPips)) pips vs ATR \(String(format: "%.1f", atrPips)) pips.")
    }
}
