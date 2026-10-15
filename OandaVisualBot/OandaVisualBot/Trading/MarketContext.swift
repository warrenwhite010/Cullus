//
//  MarketContext.swift
//  OandaVisualBot
//
//  The live account and spread snapshot the strategies size against.
//
//  Strategies need NAV to size a trade, but the `TradingStrategy` protocol hands
//  them only an instrument and a client — and the dispatcher runs them
//  concurrently. This is the shared, lock-guarded box the engine refreshes once
//  per cycle and every strategy reads. It replaces the hardcoded
//  `currentAccountBalance = 20000.0` that made position sizing fiction the moment
//  the real balance moved.
//

import Foundation

public final class MarketContext: @unchecked Sendable {
    public static let shared = MarketContext()

    private let lock = NSLock()

    private var snapshot = AccountSnapshot(
        nav: 0,
        marginAvailable: 0,
        marginUsed: 0,
        openTrades: [],
        dailyPL: 0
    )
    private var spreads: [String: Double] = [:]
    private var startOfDayNav: Double = 0
    private var startOfDayStamp: Date = .distantPast
    private var storedAccountID: String = ""
    private var storedAccountCurrency: String = "USD"

    private init() {}

    /// Account identity, so code deep in the strategy path can reach the API
    /// without every call site threading it through.
    public var accountID: String {
        lock.lock()
        defer { lock.unlock() }
        return storedAccountID
    }

    /// Currency all P/L, risk and financing figures are expressed in.
    public var accountCurrency: String {
        lock.lock()
        defer { lock.unlock() }
        return storedAccountCurrency
    }

    public func setAccountIdentity(id: String, currency: String) {
        lock.lock()
        defer { lock.unlock() }
        storedAccountID = id
        if !currency.isEmpty { storedAccountCurrency = currency }
    }

    public func account() -> AccountSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return snapshot
    }

    public func updateAccount(nav: Double, marginAvailable: Double, marginUsed: Double, openTrades: [ActiveTradeInfo]) {
        lock.lock()
        defer { lock.unlock() }

        // Re-anchor the day's high-water mark at the first update of each calendar
        // day, so the daily-loss limit measures today rather than all time.
        if !Calendar.current.isDate(startOfDayStamp, inSameDayAs: Date()) || startOfDayNav == 0 {
            startOfDayNav = nav
            startOfDayStamp = Date()
        }

        snapshot = AccountSnapshot(
            nav: nav,
            marginAvailable: marginAvailable,
            marginUsed: marginUsed,
            openTrades: openTrades,
            dailyPL: startOfDayNav > 0 ? nav - startOfDayNav : 0
        )
    }

    /// Latest observed spread for an instrument, in price units.
    public func spread(for instrument: String) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        return spreads[instrument]
    }

    public func updateSpread(_ spread: Double, for instrument: String) {
        guard spread > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        spreads[instrument] = spread
    }

    /**
     Spread to assume for an instrument.

     A real quote when one has been seen this cycle; otherwise 8% of ATR, which
     is a typical major-pair figure and keeps the cost filter meaningful rather
     than accidentally disabled when pricing is unavailable.
     */
    public func effectiveSpread(for instrument: String, atr: Double) -> Double {
        if let observed = spread(for: instrument) { return observed }
        return atr * 0.08
    }
}
