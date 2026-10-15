//
//  RiskManagerTests.swift
//  OandaVisualBotTests
//
//  Covers the arithmetic that decides how much money a losing trade costs.
//  Each test here corresponds to a bug that was live in the bot: fixed unit
//  counts, one price scale for every instrument, no correlation cap, and no
//  daily loss limit.
//

import XCTest
@testable import OandaVisualBot

final class InstrumentSpecTests: XCTestCase {

    func testPipScaleDiffersBetweenMajorAndJpyPairs() {
        let eurusd = InstrumentSpec.forInstrument("EUR_USD")
        let usdjpy = InstrumentSpec.forInstrument("USD_JPY")

        XCTAssertEqual(eurusd.pipSize, 0.0001, accuracy: 1e-12)
        XCTAssertEqual(usdjpy.pipSize, 0.01, accuracy: 1e-12)

        // The old code sent the literal distance "0.0020" to every instrument.
        // On EUR_USD that is 20 pips; on USD_JPY it is a fifth of one pip, which
        // is inside the spread.
        XCTAssertEqual(eurusd.pips(distance: 0.0020), 20, accuracy: 1e-9)
        XCTAssertEqual(usdjpy.pips(distance: 0.0020), 0.2, accuracy: 1e-9)
    }

    func testFormattingRespectsInstrumentPrecision() {
        XCTAssertEqual(InstrumentSpec.forInstrument("EUR_USD").format(0.00123456), "0.00123")
        XCTAssertEqual(InstrumentSpec.forInstrument("USD_JPY").format(0.1234), "0.123")
    }

    func testCurrencyDecomposition() {
        XCTAssertEqual(InstrumentSpec.currencies(of: "EUR_JPY"), ["EUR", "JPY"])
        XCTAssertEqual(InstrumentSpec.currencies(of: "BTC-USD"), ["BTC", "USD"])
    }
}

final class RiskManagerSizingTests: XCTestCase {

    func testSizeRisksTheConfiguredFractionOfNav() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let size = RiskManager.size(
            nav: 10_000,
            riskPerTradePct: 0.5,
            stopDistance: spec.distance(pips: 20),
            spec: spec,
            isLong: true
        )

        // 0.5% of 10,000 = 50 risked over a 20-pip (0.0020) stop = 25,000 units.
        XCTAssertEqual(size.units, 25_000)
        XCTAssertEqual(size.riskBudget, 50, accuracy: 1e-9)
        XCTAssertEqual(size.riskIfStopped, 50, accuracy: 0.01)
        XCTAssertEqual(size.stopPips, 20, accuracy: 1e-6)
    }

    func testSizeShrinksWhenVolatilityWidensTheStop() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let tight = RiskManager.size(nav: 10_000, riskPerTradePct: 0.5,
                                    stopDistance: spec.distance(pips: 10),
                                    spec: spec, isLong: true)
        let wide = RiskManager.size(nav: 10_000, riskPerTradePct: 0.5,
                                   stopDistance: spec.distance(pips: 40),
                                   spec: spec, isLong: true)

        // The fixed 500-unit approach did the opposite of this: identical size
        // regardless of stop width, so risk quadrupled with volatility.
        XCTAssertEqual(tight.units, wide.units * 4)
        XCTAssertEqual(tight.riskIfStopped, wide.riskIfStopped, accuracy: 0.01)
    }

    func testShortsAreSignedNegative() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let size = RiskManager.size(nav: 10_000, riskPerTradePct: 0.5,
                                   stopDistance: spec.distance(pips: 20),
                                   spec: spec, isLong: false)

        XCTAssertEqual(size.signedUnits, -size.units)
        XCTAssertGreaterThan(size.units, 0)
    }

    func testZeroStopIsRefusedRatherThanDividedBy() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let size = RiskManager.size(nav: 10_000, riskPerTradePct: 0.5,
                                   stopDistance: 0, spec: spec, isLong: true)

        XCTAssertEqual(size.units, 0)
        XCTAssertFalse(size.notes.isEmpty)
    }

    func testMarginCapReducesSizeBelowRiskBudget() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let size = RiskManager.size(
            nav: 100_000,
            riskPerTradePct: 2.0,
            stopDistance: spec.distance(pips: 5),
            spec: spec,
            isLong: true,
            marginAvailable: 500,
            entryPrice: 1.10,
            maxMarginUtilizationPct: 40
        )

        // Risk alone would allow 4,000,000 units; 500 of margin at 3% cannot.
        XCTAssertLessThan(size.units, 4_000_000)
        XCTAssertTrue(size.notes.contains { $0.contains("Margin-capped") })
    }
}

final class RiskManagerVetoTests: XCTestCase {

    private func trade(_ instrument: String, units: Int = 1000, entry: Double = 1.10, stop: Double = 1.09) -> ActiveTradeInfo {
        ActiveTradeInfo(
            instrument: instrument,
            tradeID: "t-\(instrument)",
            price: entry,
            units: units,
            isLong: units > 0,
            entryPrice: entry,
            currentPrice: entry,
            stopLoss: stop,
            takeProfit: entry + 0.02,
            initialUnits: String(units),
            unrealizedPL: 0,
            marginRequired: 0
        )
    }

    private func snapshot(nav: Double = 10_000, dailyPL: Double = 0, trades: [ActiveTradeInfo] = []) -> AccountSnapshot {
        AccountSnapshot(nav: nav, marginAvailable: nav, marginUsed: 0, openTrades: trades, dailyPL: dailyPL)
    }

    func testCleanAccountIsAllowed() {
        let veto = RiskManager.vetoNewTrade(
            instrument: "EUR_USD",
            snapshot: snapshot(),
            params: StrategyParameters()
        )
        XCTAssertTrue(veto.allowed, veto.reasons.joined(separator: " "))
    }

    func testDailyLossLimitBlocksNewRisk() {
        var params = StrategyParameters()
        params.risk.maxDailyLossPct = 2

        let veto = RiskManager.vetoNewTrade(
            instrument: "EUR_USD",
            snapshot: snapshot(dailyPL: -250), // −2.5% of 10,000
            params: params
        )

        XCTAssertFalse(veto.allowed)
        XCTAssertTrue(veto.reasons.contains { $0.contains("daily limit") })
    }

    func testCorrelatedCurrencyExposureIsCapped() {
        var params = StrategyParameters()
        params.risk.maxTradesPerCurrency = 2
        params.risk.maxOpenRiskPct = 100 // isolate the correlation rule

        // EUR_USD + EUR_JPY already open: a third EUR trade is one bigger EUR bet.
        let veto = RiskManager.vetoNewTrade(
            instrument: "EUR_GBP",
            snapshot: snapshot(trades: [trade("EUR_USD"), trade("EUR_JPY")]),
            params: params
        )

        XCTAssertFalse(veto.allowed)
        XCTAssertTrue(veto.reasons.contains { $0.contains("expose EUR") })
    }

    func testUnstoppedPositionBlocksFurtherRisk() {
        var params = StrategyParameters()
        params.risk.maxTradesPerCurrency = 9

        let noStop = trade("GBP_USD", stop: 0)
        let veto = RiskManager.vetoNewTrade(
            instrument: "AUD_USD",
            snapshot: snapshot(trades: [noStop]),
            params: params
        )

        XCTAssertFalse(veto.allowed)
        XCTAssertTrue(veto.reasons.contains { $0.contains("Unstopped") })
    }

    func testDuplicateInstrumentIsBlocked() {
        let veto = RiskManager.vetoNewTrade(
            instrument: "EUR_USD",
            snapshot: snapshot(trades: [trade("EUR_USD")]),
            params: StrategyParameters()
        )
        XCTAssertFalse(veto.allowed)
        XCTAssertTrue(veto.reasons.contains { $0.contains("Already holding") })
    }
}

final class SpreadFilterTests: XCTestCase {

    func testWideSpreadRelativeToAtrIsRejected() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        let params = StrategyParameters() // maxSpreadAtrRatio 0.15

        let atr = spec.distance(pips: 10)
        let acceptable = RiskManager.spreadIsAcceptable(
            spread: spec.distance(pips: 1), atr: atr, spec: spec, params: params
        )
        let tooWide = RiskManager.spreadIsAcceptable(
            spread: spec.distance(pips: 4), atr: atr, spec: spec, params: params
        )

        XCTAssertTrue(acceptable.ok, acceptable.reason)
        XCTAssertFalse(tooWide.ok)
    }

    func testDeadMarketIsRejectedOnAtrFloor() {
        let spec = InstrumentSpec.forInstrument("EUR_USD")
        var params = StrategyParameters()
        params.entry.minAtrPips = 3

        let result = RiskManager.spreadIsAcceptable(
            spread: spec.distance(pips: 0.1),
            atr: spec.distance(pips: 1),
            spec: spec,
            params: params
        )

        XCTAssertFalse(result.ok)
        XCTAssertTrue(result.reason.contains("floor"))
    }
}

final class StrategyParameterSafetyTests: XCTestCase {

    func testLethalRiskValuesAreClamped() {
        var params = StrategyParameters()
        params.risk.riskPerTradePct = 25      // ruin in four losses
        params.entry.stopAtrMultiple = 0.01   // stop inside the noise
        params.entry.takeProfitR = 0
        params.clampToSafeRanges()

        XCTAssertLessThanOrEqual(params.risk.riskPerTradePct, 2.0)
        XCTAssertGreaterThanOrEqual(params.entry.stopAtrMultiple, 0.3)
        XCTAssertGreaterThanOrEqual(params.entry.takeProfitR, 0.3)
    }

    func testSlowMovingAverageStaysAboveFast() {
        var params = StrategyParameters()
        params.trend.smaFast = 100
        params.trend.smaSlow = 10
        params.clampToSafeRanges()

        XCTAssertGreaterThan(params.trend.smaSlow, params.trend.smaFast)
    }
}
