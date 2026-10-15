//
//  TradingSessions.swift
//  OandaVisualBot
//
//  Trading sessions in real exchange time.
//
//  The old check was `Calendar.current.component(.hour, from: Date())` compared
//  against hardcoded numbers that assumed the machine was set to New York. That
//  is wrong three ways: it breaks on a laptop in any other timezone, it drifts by
//  an hour twice a year (the US, UK, Australia and Japan switch on different
//  dates, or never), and it cannot express an overlap — which is where the
//  tightest spreads of the day actually are.
//
//  Everything here resolves through TimeZone(identifier:), so DST is the
//  platform's problem rather than arithmetic we would get wrong. Mirrors
//  src/mcp/oanda/sessions.ts.
//

import Foundation

public enum TradingSession: String, Sendable, CaseIterable, Codable {
    case sydney, tokyo, london, newYork

    public var label: String {
        switch self {
        case .sydney: return "Sydney"
        case .tokyo: return "Tokyo"
        case .london: return "London"
        case .newYork: return "New York"
        }
    }

    public var timeZoneIdentifier: String {
        switch self {
        case .sydney: return "Australia/Sydney"
        case .tokyo: return "Asia/Tokyo"
        case .london: return "Europe/London"
        case .newYork: return "America/New_York"
        }
    }

    /// Local opening hour (inclusive) and closing hour (exclusive) at that centre.
    public var hours: (open: Int, close: Int) {
        switch self {
        case .sydney: return (7, 16)
        case .tokyo: return (9, 18)
        case .london: return (8, 17)
        case .newYork: return (8, 17)
        }
    }
}

public struct SessionClock: Sendable {
    public let open: [TradingSession]
    /// Two centres quoting at once, when that is happening.
    public let overlap: String?
    /// The FX market is shut: Friday 17:00 to Sunday 17:00, New York time.
    public let weekendClosed: Bool
    /// Within minutes of 17:00 New York, when spreads widen for rollover.
    public let rolloverWindow: Bool
    public let newYorkTime: String
    public let notes: [String]
}

public struct SessionVerdict: Sendable {
    public let tradeable: Bool
    public let reason: String
    /// 0–1.25. Deliberately separate from `tradeable`, so a merely-acceptable
    /// window can be traded at reduced size rather than skipped outright.
    public let liquidityScore: Double
    public let preferred: [TradingSession]
}

public enum TradingSessions {

    private static let fxTimeZone = TimeZone(identifier: "America/New_York") ?? .current

    private static func parts(_ date: Date, in identifier: String) -> (hour: Int, minute: Int, weekday: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: identifier) ?? .current
        let components = calendar.dateComponents([.hour, .minute, .weekday], from: date)
        // Calendar weekday is 1-based from Sunday; normalise to 0-based.
        return (components.hour ?? 0, components.minute ?? 0, (components.weekday ?? 1) - 1)
    }

    public static func clock(at date: Date = Date(), rolloverPaddingMinutes: Int = 15) -> SessionClock {
        var open: [TradingSession] = []
        for session in TradingSession.allCases {
            let local = parts(date, in: session.timeZoneIdentifier)
            // A centre does not quote on its own weekend.
            if local.weekday == 0 || local.weekday == 6 { continue }
            let hours = session.hours
            if local.hour >= hours.open && local.hour < hours.close { open.append(session) }
        }

        let ny = parts(date, in: TradingSession.newYork.timeZoneIdentifier)

        let weekendClosed =
            ny.weekday == 6 ||
            (ny.weekday == 5 && ny.hour >= 17) ||
            (ny.weekday == 0 && ny.hour < 17)

        let minutesFromRollover = (ny.hour - 17) * 60 + ny.minute
        let rolloverWindow = abs(minutesFromRollover) <= rolloverPaddingMinutes

        var overlap: String?
        if open.contains(.london) && open.contains(.newYork) { overlap = "London–New York" }
        else if open.contains(.tokyo) && open.contains(.london) { overlap = "Tokyo–London" }
        else if open.contains(.sydney) && open.contains(.tokyo) { overlap = "Sydney–Tokyo" }

        var notes: [String] = []
        if weekendClosed { notes.append("FX closed for the weekend (Fri 17:00 – Sun 17:00 New York).") }
        if rolloverWindow { notes.append("Inside the 17:00 New York rollover window — spreads widen sharply.") }
        if overlap == "London–New York" { notes.append("London–New York overlap: deepest liquidity of the day.") }
        if open.isEmpty && !weekendClosed { notes.append("No major centre quoting — thin book.") }

        let formatter = DateFormatter()
        formatter.dateFormat = "EEE HH:mm"
        formatter.timeZone = fxTimeZone

        return SessionClock(
            open: open,
            overlap: overlap,
            weekendClosed: weekendClosed,
            rolloverWindow: rolloverWindow,
            newYorkTime: formatter.string(from: date),
            notes: notes
        )
    }

    /**
     Sessions an instrument actually trades well in, derived from its currencies.

     Deriving this beats the old substring checks: a pair is liquid when one of
     its own centres is quoting, so adding an instrument needs no code change.
     */
    public static func preferredSessions(for instrument: String) -> [TradingSession] {
        let symbol = instrument.uppercased()
        if symbol.contains("BTC") || symbol.contains("ETH") || symbol.contains("LTC") || symbol.contains("BCH") {
            return TradingSession.allCases
        }

        let byCurrency: [String: [TradingSession]] = [
            "AUD": [.sydney], "NZD": [.sydney],
            "JPY": [.tokyo], "SGD": [.tokyo], "HKD": [.tokyo], "CNH": [.tokyo],
            "EUR": [.london], "GBP": [.london], "CHF": [.london], "SEK": [.london], "NOK": [.london],
            "USD": [.newYork], "CAD": [.newYork], "MXN": [.newYork],
            "XAU": [.london, .newYork], "XAG": [.london, .newYork],
        ]

        var sessions: Set<TradingSession> = []
        for currency in InstrumentSpec.currencies(of: symbol) {
            for session in byCurrency[currency] ?? [] { sessions.insert(session) }
        }
        // Unknown symbol: the two deepest sessions, not "always".
        return sessions.isEmpty ? [.london, .newYork] : Array(sessions)
    }

    public static func evaluate(
        instrument: String,
        at date: Date = Date(),
        enforce: Bool = true,
        blockRollover: Bool = true
    ) -> SessionVerdict {
        let state = clock(at: date)
        let preferred = preferredSessions(for: instrument)
        let symbol = instrument.uppercased()
        let isCrypto = symbol.contains("BTC") || symbol.contains("ETH")
            || symbol.contains("LTC") || symbol.contains("BCH")

        // The weekend gap is not a preference: there is no market to trade.
        if state.weekendClosed && !isCrypto {
            return SessionVerdict(
                tradeable: false,
                reason: "FX is closed (\(state.newYorkTime) New York). Reopens Sunday 17:00 New York.",
                liquidityScore: 0,
                preferred: preferred
            )
        }

        if blockRollover && state.rolloverWindow && !isCrypto {
            return SessionVerdict(
                tradeable: false,
                reason: "Inside the 17:00 New York rollover window — spreads are at their worst.",
                liquidityScore: 0.2,
                preferred: preferred
            )
        }

        // Crypto has no sessions to be inside or outside. Without this it falls
        // through to the "no preferred session open" branch every weekend and
        // overnight — when every FX centre is shut but crypto is still trading.
        if isCrypto {
            return SessionVerdict(
                tradeable: true,
                reason: "Crypto trades continuously; session windows do not apply.",
                liquidityScore: state.open.isEmpty ? 0.7 : 1.0,
                preferred: preferred
            )
        }

        let matching = preferred.filter { state.open.contains($0) }
        if matching.isEmpty {
            return SessionVerdict(
                tradeable: !enforce,
                reason: enforce
                    ? "No preferred session open for \(instrument) (wants \(preferred.map(\.label).joined(separator: "/")); open: \(state.open.isEmpty ? "none" : state.open.map(\.label).joined(separator: "/")))."
                    : "Outside \(instrument)'s preferred sessions, but the window check is disabled.",
                liquidityScore: 0.4,
                preferred: preferred
            )
        }

        var score = 0.8 + Double(min(matching.count - 1, 1)) * 0.2
        if state.overlap == "London–New York" { score = min(1.25, score + 0.25) }

        return SessionVerdict(
            tradeable: true,
            reason: "\(matching.map(\.label).joined(separator: " + ")) open"
                + (state.overlap != nil ? " (\(state.overlap!) overlap)" : "") + ".",
            liquidityScore: score,
            preferred: preferred
        )
    }
}
