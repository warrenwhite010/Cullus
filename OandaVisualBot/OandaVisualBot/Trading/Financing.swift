//
//  Financing.swift
//  OandaVisualBot
//
//  Financing (carry) and the 17:00 New York rollover charge.
//
//  OANDA applies financing once a day, at 17:00 New York, to every position open
//  at that instant. Two properties make it worth modelling:
//
//   1. It is charged on the base-currency NOTIONAL, not on the profit. A
//      25,000-unit EUR_USD position is ~27,500 of notional; a −3% annual rate is
//      about $2.30 a day. Against a 2R target worth $100 that is noise — against
//      a scalp risking $50 it is 5% of the edge, every day it stays open.
//
//   2. One weekday charges THREE days at once — Wednesday for most FX — to cover
//      the weekend's value dates. A position held through that single rollover
//      pays triple. That is the "extra charge after 5pm": the same mechanism, on
//      the one day it is tripled.
//
//  Mirrors src/mcp/oanda/financing.ts.
//

import Foundation

/// Financing terms for one instrument, as reported by the v20 API.
public struct InstrumentFinancing: Codable, Sendable, Equatable {
    /// Annualised rate applied to a long position, as a fraction. Negative costs.
    public let longRate: Double
    /// Annualised rate applied to a short position, as a fraction.
    public let shortRate: Double
    /// Days charged per weekday (0 = Sunday). Usually 1, and 3 on one weekday.
    public let daysCharged: [Int: Int]

    public init(longRate: Double, shortRate: Double, daysCharged: [Int: Int]) {
        self.longRate = longRate
        self.shortRate = shortRate
        self.daysCharged = daysCharged
    }

    /// The standard FX schedule, for when the API has not been reached yet.
    /// One day on weekdays, tripled on Wednesday, nothing at the weekend.
    public static let standardFX = InstrumentFinancing(
        longRate: 0,
        shortRate: 0,
        daysCharged: [0: 0, 1: 1, 2: 1, 3: 3, 4: 1, 5: 1, 6: 0]
    )
}

public struct RolloverTiming: Sendable {
    public let hoursUntil: Double
    public let daysCharged: Int
    public let isTripleCharge: Bool
    public let weekday: Int
    public let description: String
}

public struct CarryEstimate: Sendable {
    public let instrument: String
    public let isLong: Bool
    public let notional: Double
    public let annualRate: Double
    /// Account-currency cost (negative) or credit (positive) per charged day.
    public let perDay: Double
    /// Cost or credit at the next rollover, tripling included.
    public let atNextRollover: Double
    /// As a fraction of the trade's risk — the only comparison that matters.
    public let fractionOfRisk: Double?
    public let rollover: RolloverTiming
    public let costsMoney: Bool
    /// False for a cross pair, where the base → account rate is assumed 1.0.
    public let conversionExact: Bool
    public let summary: String
}

public enum Financing {

    private static let fxTimeZone = TimeZone(identifier: "America/New_York") ?? .current
    private static let weekdayNames = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
    ]

    /// When the next 17:00 New York rollover lands, and how many days it charges.
    public static func nextRollover(
        financing: InstrumentFinancing,
        at date: Date = Date()
    ) -> RolloverTiming {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = fxTimeZone
        let components = calendar.dateComponents([.hour, .minute, .weekday], from: date)
        let hour = components.hour ?? 0
        let minute = components.minute ?? 0
        let weekdayNow = (components.weekday ?? 1) - 1

        let minutesNow = hour * 60 + minute
        let rolloverMinutes = 17 * 60

        // Before 17:00 the next rollover is today's; after it, tomorrow's.
        let beforeToday = minutesNow < rolloverMinutes
        let minutesUntil = beforeToday
            ? rolloverMinutes - minutesNow
            : (24 * 60) - minutesNow + rolloverMinutes
        let weekday = beforeToday ? weekdayNow : (weekdayNow + 1) % 7

        let days = financing.daysCharged[weekday] ?? 1
        let hoursUntil = (Double(minutesUntil) / 60 * 100).rounded() / 100

        let description: String
        if days == 0 {
            description = "Next rollover is \(weekdayNames[weekday]) 17:00 New York and charges nothing (weekend)."
        } else {
            description = "Next rollover in \(String(format: "%.1f", hoursUntil))h "
                + "(\(weekdayNames[weekday]) 17:00 New York), charging \(days) day(s) of financing"
                + (days >= 3 ? " — the tripled weekend rollover." : ".")
        }

        return RolloverTiming(
            hoursUntil: hoursUntil,
            daysCharged: days,
            isTripleCharge: days >= 3,
            weekday: weekday,
            description: description
        )
    }

    /**
     Value of one unit of an instrument's BASE currency in the account currency.

     Financing accrues on the base-currency notional: 20,000 units of AUD_JPY is
     20,000 AUD, not 20,000 × 98.5 of anything. Multiplying by the quote price
     instead inflates the estimate by roughly 150× on a JPY cross and turns every
     carry check into a false alarm.
     */
    public static func baseToAccountRate(
        instrument: String,
        price: Double,
        accountCurrency: String = "USD"
    ) -> (rate: Double, exact: Bool) {
        let parts = InstrumentSpec.currencies(of: instrument)
        guard parts.count == 2 else { return (1, false) }
        if parts[0] == accountCurrency { return (1, true) }
        if parts[1] == accountCurrency { return (price, true) }
        return (1, false)
    }

    public static func estimate(
        instrument: String,
        financing: InstrumentFinancing,
        isLong: Bool,
        units: Int,
        price: Double,
        riskAmount: Double? = nil,
        accountCurrency: String = "USD",
        at date: Date = Date()
    ) -> CarryEstimate {
        let conversion = baseToAccountRate(
            instrument: instrument,
            price: price,
            accountCurrency: accountCurrency
        )
        let annualRate = isLong ? financing.longRate : financing.shortRate
        let notional = Double(abs(units)) * conversion.rate
        // OANDA divides the annual rate by 365, not 252: financing accrues on
        // calendar days, which is exactly why the weekend has to be charged.
        let perDay = notional * annualRate / 365

        let rollover = nextRollover(financing: financing, at: date)
        let atNextRollover = perDay * Double(rollover.daysCharged)

        var fractionOfRisk: Double?
        if let risk = riskAmount, risk > 0 {
            fractionOfRisk = abs(atNextRollover) / risk
        }

        let costsMoney = atNextRollover < 0
        let magnitude = abs(atNextRollover)

        var summary: String
        if rollover.daysCharged == 0 {
            summary = "No financing at the next rollover (weekend)."
        } else if !costsMoney {
            summary = "Holding \(isLong ? "long" : "short") pays \(String(format: "%.2f", magnitude)) "
                + "at the next rollover (positive carry\(rollover.isTripleCharge ? ", tripled" : ""))."
        } else {
            summary = "Holding \(isLong ? "long" : "short") through 17:00 New York costs "
                + String(format: "%.2f", magnitude)
                + (rollover.isTripleCharge ? " — TRIPLED weekend rollover" : "")
            if let fraction = fractionOfRisk {
                summary += ", which is \(String(format: "%.1f", fraction * 100))% of the amount at risk."
            } else {
                summary += "."
            }
        }
        if !conversion.exact {
            summary += " (Indicative: \(instrument) is a cross pair, so the base-currency conversion is assumed 1.0.)"
        }

        return CarryEstimate(
            instrument: instrument,
            isLong: isLong,
            notional: notional,
            annualRate: annualRate,
            perDay: perDay,
            atNextRollover: atNextRollover,
            fractionOfRisk: fractionOfRisk,
            rollover: rollover,
            costsMoney: costsMoney,
            conversionExact: conversion.exact,
            summary: summary
        )
    }

    /**
     Should carry stop this entry?

     Only ever blocks on cost relative to risk — never on the raw figure, and
     never when carry is positive. A trade that earns its financing is a better
     trade, not a worse one.
     */
    public static func check(
        _ estimate: CarryEstimate,
        params: CarryParameters
    ) -> (ok: Bool, reasons: [String]) {
        guard params.enabled else { return (true, ["Carry checks disabled."]) }
        guard estimate.costsMoney else { return (true, [estimate.summary]) }

        var reasons: [String] = []

        if params.maxCarryFractionOfRisk > 0,
           let fraction = estimate.fractionOfRisk,
           fraction > params.maxCarryFractionOfRisk {
            reasons.append(
                "Financing at the next rollover is \(String(format: "%.1f", fraction * 100))% of the "
                + "trade's risk, above the \(String(format: "%.0f", params.maxCarryFractionOfRisk * 100))% limit"
                + (estimate.rollover.isTripleCharge ? " (tripled weekend rollover)" : "")
                + ". Either size for it or wait until after 17:00 New York."
            )
        }

        if params.avoidTripleRolloverHours > 0,
           estimate.rollover.isTripleCharge,
           estimate.rollover.hoursUntil <= params.avoidTripleRolloverHours {
            reasons.append(
                "The tripled rollover is \(String(format: "%.1f", estimate.rollover.hoursUntil))h away and "
                + "this position has negative carry — three days of financing for a few hours of "
                + "exposure. Wait until after 17:00 New York."
            )
        }

        return (reasons.isEmpty, reasons.isEmpty ? [estimate.summary] : reasons)
    }
}

/// Financing terms fetched once per instrument and reused for the session.
public final class FinancingCache: @unchecked Sendable {
    public static let shared = FinancingCache()

    private let lock = NSLock()
    private var cache: [String: InstrumentFinancing] = [:]

    private init() {}

    public func cached(_ instrument: String) -> InstrumentFinancing? {
        lock.lock()
        defer { lock.unlock() }
        return cache[instrument]
    }

    public func store(_ financing: InstrumentFinancing, for instrument: String) {
        lock.lock()
        defer { lock.unlock() }
        cache[instrument] = financing
    }

    /**
     Financing terms for an instrument, fetched on first use.

     Falls back to the standard FX schedule with ZERO rates when the API cannot
     be reached. Zero rates mean the carry gate cannot block anything, which is
     the right failure direction: a missing cost estimate should not silently
     become a refusal to trade.
     */
    public func financing(
        for instrument: String,
        accountID: String,
        client: OandaServiceProtocol
    ) async -> InstrumentFinancing {
        if let hit = cached(instrument) { return hit }
        // Double-optional: `try?` wraps the method's own `InstrumentFinancing?`.
        if let fetched = (try? await client.fetchInstrumentFinancing(
            accountID: accountID,
            instrument: instrument
        )) ?? nil {
            store(fetched, for: instrument)
            return fetched
        }
        return .standardFX
    }
}
