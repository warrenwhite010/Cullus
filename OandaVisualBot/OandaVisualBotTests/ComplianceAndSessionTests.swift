//
//  ComplianceAndSessionTests.swift
//  OandaVisualBotTests
//
//  FIFO compliance, session/timezone handling, per-pair profiles and trade
//  management. Each of these covers a rule that costs real money when it is
//  wrong on a US-regulated account.
//

import XCTest
@testable import OandaVisualBot

private func trade(
    _ instrument: String,
    id: String,
    units: Int,
    entry: Double = 1.1000,
    stop: Double = 1.0980,
    current: Double? = nil
) -> ActiveTradeInfo {
    ActiveTradeInfo(
        instrument: instrument,
        tradeID: id,
        price: current ?? entry,
        units: units,
        isLong: units > 0,
        entryPrice: entry,
        currentPrice: current ?? entry,
        stopLoss: stop,
        takeProfit: entry + 0.0040,
        initialUnits: String(units),
        unrealizedPL: 0,
        marginRequired: 0
    )
}

final class FIFOComplianceTests: XCTestCase {

    func testOpposingEntryIsBlockedBecauseUsAccountsCannotHedge() {
        let open = [trade("EUR_USD", id: "101", units: 5000)]
        let check = FIFOCompliance.checkEntry(
            instrument: "EUR_USD",
            isLong: false,
            trades: open,
            enabled: true,
            allowReducingOrders: false
        )

        XCTAssertFalse(check.allowed)
        XCTAssertTrue(check.wouldReduce, "A short against a long reduces the position on a netting account.")
        XCTAssertTrue(check.reasons.first?.contains("no-hedge") == true)
    }

    func testOpposingEntryIsAllowedWhenReducingIsExplicitlyPermitted() {
        let open = [trade("EUR_USD", id: "101", units: 5000)]
        let check = FIFOCompliance.checkEntry(
            instrument: "EUR_USD",
            isLong: false,
            trades: open,
            enabled: true,
            allowReducingOrders: true
        )

        XCTAssertTrue(check.allowed)
        XCTAssertTrue(check.wouldReduce)
    }

    func testEntryOnFlatInstrumentIsAllowed() {
        let open = [trade("GBP_USD", id: "101", units: 5000)]
        let check = FIFOCompliance.checkEntry(
            instrument: "EUR_USD",
            isLong: true,
            trades: open,
            enabled: true,
            allowReducingOrders: false
        )
        XCTAssertTrue(check.allowed)
        XCTAssertFalse(check.wouldReduce)
    }

    func testFifoDisabledPermitsOpposingEntry() {
        let open = [trade("EUR_USD", id: "101", units: 5000)]
        let check = FIFOCompliance.checkEntry(
            instrument: "EUR_USD",
            isLong: false,
            trades: open,
            enabled: false,
            allowReducingOrders: false
        )
        XCTAssertTrue(check.allowed, "Non-US accounts may hedge.")
    }

    func testNetPositionSumsSignedUnits() {
        let open = [
            trade("EUR_USD", id: "101", units: 5000),
            trade("EUR_USD", id: "102", units: -2000),
            trade("GBP_USD", id: "103", units: 1000),
        ]
        XCTAssertEqual(FIFOCompliance.netPosition(instrument: "EUR_USD", trades: open), 3000)
        XCTAssertEqual(FIFOCompliance.netPosition(instrument: "USD_JPY", trades: open), 0)
    }

    func testClosesAreOrderedOldestFirst() {
        // OANDA issues trade IDs monotonically, so a lower ID is older. Closing
        // out of order is a FIFO_VIOLATION on a US account.
        let open = [
            trade("EUR_USD", id: "205", units: 1000),
            trade("EUR_USD", id: "101", units: 1000),
            trade("EUR_USD", id: "150", units: 1000),
        ]
        let ordered = FIFOCompliance.fifoOrdered(instrument: "EUR_USD", trades: open)
        XCTAssertEqual(ordered.map(\.tradeID), ["101", "150", "205"])
    }

    func testOrderedAllGroupsByInstrumentAndStaysOldestFirst() {
        let open = [
            trade("GBP_USD", id: "300", units: 1000),
            trade("EUR_USD", id: "205", units: 1000),
            trade("EUR_USD", id: "101", units: 1000),
            trade("GBP_USD", id: "120", units: 1000),
        ]
        let ordered = FIFOCompliance.fifoOrderedAll(open)
        let eur = ordered.filter { $0.instrument == "EUR_USD" }.map(\.tradeID)
        let gbp = ordered.filter { $0.instrument == "GBP_USD" }.map(\.tradeID)

        XCTAssertEqual(eur, ["101", "205"])
        XCTAssertEqual(gbp, ["120", "300"])
    }

    func testPositionFillIsReduceFirstUnderFifo() {
        XCTAssertEqual(FIFOCompliance.positionFill(enabled: true), "REDUCE_FIRST")
        XCTAssertEqual(FIFOCompliance.positionFill(enabled: false), "DEFAULT")
    }

    func testParameterClampForcesOneTradePerInstrumentUnderFifo() {
        var params = StrategyParameters()
        params.fifo.enabled = true
        params.risk.maxOpenTradesPerInstrument = 3
        params.clampToSafeRanges()

        XCTAssertEqual(params.risk.maxOpenTradesPerInstrument, 1,
                       "A second trade on one instrument cannot be exited independently under FIFO.")
    }
}

final class TradingSessionTests: XCTestCase {

    /// 14:00 UTC in January: London and New York are both open (EST/GMT).
    private let winterOverlap = Date(timeIntervalSince1970: 1_768_399_200) // 2026-01-14T14:00Z
    /// 14:00 UTC in July: still the overlap, but both zones are on summer time.
    private let summerOverlap = Date(timeIntervalSince1970: 1_784_037_600) // 2026-07-14T14:00Z
    /// Saturday.
    private let weekend = Date(timeIntervalSince1970: 1_786_881_600) // 2026-08-15T12:00Z

    func testLondonNewYorkOverlapIsDetectedInBothDstRegimes() {
        for date in [winterOverlap, summerOverlap] {
            let clock = TradingSessions.clock(at: date)
            XCTAssertTrue(clock.open.contains(.london), "London should be open at \(date)")
            XCTAssertTrue(clock.open.contains(.newYork), "New York should be open at \(date)")
            XCTAssertEqual(clock.overlap, "London–New York")
            XCTAssertFalse(clock.weekendClosed)
        }
    }

    func testOverlapEarnsTheHighestLiquidityScore() {
        let verdict = TradingSessions.evaluate(instrument: "EUR_USD", at: winterOverlap)
        XCTAssertTrue(verdict.tradeable)
        XCTAssertGreaterThan(verdict.liquidityScore, 1.0, "The overlap should score above a single session.")
    }

    func testWeekendIsClosedForFxRegardlessOfSettings() {
        let verdict = TradingSessions.evaluate(
            instrument: "EUR_USD",
            at: weekend,
            enforce: false,
            blockRollover: false
        )
        XCTAssertFalse(verdict.tradeable, "There is no FX market on a Saturday; settings cannot conjure one.")
        XCTAssertEqual(verdict.liquidityScore, 0)
    }

    func testCryptoTradesThroughTheWeekend() {
        let verdict = TradingSessions.evaluate(instrument: "BTC-USD", at: weekend)
        XCTAssertTrue(verdict.tradeable)
    }

    func testPreferredSessionsAreDerivedFromCurrencies() {
        XCTAssertEqual(Set(TradingSessions.preferredSessions(for: "USD_JPY")), Set([.tokyo, .newYork]))
        XCTAssertEqual(Set(TradingSessions.preferredSessions(for: "EUR_GBP")), Set([.london]))
        XCTAssertEqual(Set(TradingSessions.preferredSessions(for: "AUD_NZD")), Set([.sydney]))
    }

    func testEuroPairIsNotTradeableDuringTheAsianSessionOnly() {
        // 02:00 UTC — Sydney and Tokyo only.
        let asia = Date(timeIntervalSince1970: 1_768_356_000) // 2026-01-14T02:00Z
        let eur = TradingSessions.evaluate(instrument: "EUR_USD", at: asia)
        let jpy = TradingSessions.evaluate(instrument: "USD_JPY", at: asia)

        XCTAssertFalse(eur.tradeable, "EUR_USD has no centre quoting in the Asian session.")
        XCTAssertTrue(jpy.tradeable, "USD_JPY does.")
    }

    func testEnforcementCanBeDisabledForOutOfSessionEntries() {
        let asia = Date(timeIntervalSince1970: 1_768_356_000)
        let verdict = TradingSessions.evaluate(instrument: "EUR_USD", at: asia, enforce: false)
        XCTAssertTrue(verdict.tradeable)
        XCTAssertLessThan(verdict.liquidityScore, 0.6, "Still a thin book, so size should scale down.")
    }
}

final class InstrumentProfileTests: XCTestCase {

    func testProfileOverridesOnlyTheSectionsItSets() {
        var params = StrategyParameters()
        var profile = InstrumentProfile()
        profile.granularity = "H1"
        var breakout = BreakoutParameters()
        breakout.enabled = false
        profile.breakout = breakout
        params.profiles["EUR_USD"] = profile

        let resolved = params.resolved(for: "EUR_USD")
        XCTAssertEqual(resolved.granularity, "H1")
        XCTAssertFalse(resolved.breakout.enabled)
        XCTAssertTrue(resolved.trend.enabled, "Untouched sections keep the global value.")
        XCTAssertEqual(resolved.risk.riskPerTradePct, params.risk.riskPerTradePct)
    }

    func testUnprofiledInstrumentGetsTheGlobals() {
        var params = StrategyParameters()
        var profile = InstrumentProfile()
        profile.granularity = "H4"
        params.profiles["EUR_USD"] = profile

        XCTAssertEqual(params.resolved(for: "USD_JPY").granularity, params.granularity)
    }

    func testRiskMultiplierScalesAndIsClamped() {
        var params = StrategyParameters()
        params.risk.riskPerTradePct = 0.5

        var half = InstrumentProfile()
        half.riskMultiplier = 0.5
        var absurd = InstrumentProfile()
        absurd.riskMultiplier = 100
        params.profiles["EUR_USD"] = half
        params.profiles["GBP_USD"] = absurd

        XCTAssertEqual(params.resolved(for: "EUR_USD").risk.riskPerTradePct, 0.25, accuracy: 1e-9)
        // 0.5 × 1.5 (the cap) = 0.75, and never the 50% a bad multiplier asked for.
        XCTAssertEqual(params.resolved(for: "GBP_USD").risk.riskPerTradePct, 0.75, accuracy: 1e-9)
    }

    func testDisabledInstrumentsAreExcludedFromTheWatchlist() {
        var params = StrategyParameters()
        params.instruments = ["EUR_USD", "GBP_USD", "USD_JPY"]
        var disabled = InstrumentProfile()
        disabled.disabled = true
        params.profiles["GBP_USD"] = disabled

        XCTAssertEqual(params.activeInstruments, ["EUR_USD", "USD_JPY"])
    }

    func testResolvedParametersAreStillClamped() {
        var params = StrategyParameters()
        var reckless = InstrumentProfile()
        var entry = EntryParameters()
        entry.stopAtrMultiple = 0.01 // inside the noise
        reckless.entry = entry
        params.profiles["EUR_USD"] = reckless

        XCTAssertGreaterThanOrEqual(params.resolved(for: "EUR_USD").entry.stopAtrMultiple, 0.3)
    }
}

final class PositionManagerTests: XCTestCase {

    private func params(partial: Double, trail: Double) -> StrategyParameters {
        var params = StrategyParameters()
        params.entry.stopAtrMultiple = 1.5
        params.entry.takeProfitR = 2
        params.entry.partialTakeProfitFraction = partial
        params.entry.trailAfterR = trail
        params.entry.runnerTrailAtrMultiple = 0
        return params
    }

    func testCurrentRMeasuresProgressAgainstTheTradesOwnStop() {
        // 20-pip stop, 20 pips in front = exactly 1R.
        let long = trade("EUR_USD", id: "1", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1020)
        XCTAssertEqual(PositionManager.currentR(long) ?? 0, 1.0, accuracy: 1e-6)

        let short = trade("EUR_USD", id: "2", units: -1000, entry: 1.1000, stop: 1.1020, current: 1.0980)
        XCTAssertEqual(PositionManager.currentR(short) ?? 0, 1.0, accuracy: 1e-6,
                       "Shorts progress when price falls.")
    }

    func testNothingHappensOnDefaultSettings() {
        // Both features ship off because they measured worse; the default cycle
        // must therefore be a no-op.
        let open = [trade("EUR_USD", id: "1", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1030)]
        let actions = PositionManager.plan(trades: open, params: StrategyParameters(), alreadyScaled: [])
        XCTAssertTrue(actions.isEmpty)
    }

    func testPartialTakeProfitFiresOnceAtOneR() {
        let open = [trade("EUR_USD", id: "7", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1020)]
        let actions = PositionManager.plan(trades: open, params: params(partial: 0.5, trail: 0), alreadyScaled: [])

        XCTAssertEqual(actions.count, 1)
        XCTAssertEqual(actions.first?.kind, .partialTakeProfit)
        XCTAssertEqual(actions.first?.units, 500)

        // Already banked: it must not fire again on the next cycle.
        let repeated = PositionManager.plan(
            trades: open,
            params: params(partial: 0.5, trail: 0),
            alreadyScaled: ["7"]
        )
        XCTAssertTrue(repeated.filter { $0.kind == .partialTakeProfit }.isEmpty)
    }

    func testPartialTakeProfitDoesNotFireBelowOneR() {
        let open = [trade("EUR_USD", id: "7", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1010)]
        let actions = PositionManager.plan(trades: open, params: params(partial: 0.5, trail: 0), alreadyScaled: [])
        XCTAssertTrue(actions.isEmpty)
    }

    func testBreakEvenRatchetOnlyMovesTheStopForward() {
        let open = [trade("EUR_USD", id: "9", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1020)]
        let actions = PositionManager.plan(trades: open, params: params(partial: 0, trail: 1), alreadyScaled: [])
        XCTAssertEqual(actions.first?.kind, .moveStopToBreakEven)
        XCTAssertEqual(actions.first?.stopPrice ?? 0, 1.1000, accuracy: 1e-6)

        // Stop already at break-even: nothing to do, no pointless API call.
        let atBreakEven = [trade("EUR_USD", id: "9", units: 1000, entry: 1.1000, stop: 1.1000, current: 1.1030)]
        XCTAssertTrue(
            PositionManager.plan(trades: atBreakEven, params: params(partial: 0, trail: 1), alreadyScaled: []).isEmpty
        )
    }

    func testTradeWithNoStopIsSkippedRatherThanCrashing() {
        let open = [trade("EUR_USD", id: "11", units: 1000, entry: 1.1000, stop: 0, current: 1.1030)]
        XCTAssertNil(PositionManager.currentR(open[0]))
        XCTAssertTrue(PositionManager.plan(trades: open, params: params(partial: 0.5, trail: 1), alreadyScaled: []).isEmpty)
    }

    func testProfileCanEnablePartialTakeProfitForOnePairOnly() {
        var base = StrategyParameters()
        var profile = InstrumentProfile()
        var entry = EntryParameters()
        entry.partialTakeProfitFraction = 0.5
        entry.takeProfitR = 2
        entry.stopAtrMultiple = 1.5
        profile.entry = entry
        base.profiles["EUR_USD"] = profile

        let open = [
            trade("EUR_USD", id: "1", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1020),
            trade("GBP_USD", id: "2", units: 1000, entry: 1.1000, stop: 1.0980, current: 1.1020),
        ]
        let actions = PositionManager.plan(trades: open, params: base, alreadyScaled: [])

        XCTAssertEqual(actions.count, 1)
        XCTAssertEqual(actions.first?.instrument, "EUR_USD")
    }
}

final class ConsensusEngineTests: XCTestCase {

    /// Bars trending in one direction, with enough range for ADX to register.
    private func trendingCandles(count: Int, up: Bool) -> [Candle] {
        let step = 0.0004 * (up ? 1 : -1)
        var price = up ? 1.0500 : 1.1500
        var candles: [Candle] = []
        for i in 0..<count {
            let open = price
            price += step
            candles.append(Candle(
                time: Date().addingTimeInterval(Double(i - count) * 900),
                open: open,
                high: max(open, price) + 0.0002,
                low: min(open, price) - 0.0002,
                close: price,
                volume: 100,
                complete: true
            ))
        }
        return candles
    }

    private func flatCandles(count: Int) -> [Candle] {
        var candles: [Candle] = []
        for i in 0..<count {
            // Small alternating wiggle: no trend, some range.
            let drift = (i % 2 == 0 ? 1.0 : -1.0) * 0.0001
            let open = 1.1000 + drift
            candles.append(Candle(
                time: Date().addingTimeInterval(Double(i - count) * 900),
                open: open,
                high: open + 0.0003,
                low: open - 0.0003,
                close: 1.1000 - drift,
                volume: 100,
                complete: true
            ))
        }
        return candles
    }

    func testUptrendScoresPositive() {
        let view = ConsensusEngine.scoreTimeframe(
            timeframe: "M15",
            candles: trendingCandles(count: 200, up: true),
            params: StrategyParameters(),
            weight: 1
        )
        XCTAssertNotNil(view)
        XCTAssertGreaterThan(view!.score, 0)
        XCTAssertEqual(view!.trend, "up")
    }

    func testDowntrendScoresNegative() {
        let view = ConsensusEngine.scoreTimeframe(
            timeframe: "M15",
            candles: trendingCandles(count: 200, up: false),
            params: StrategyParameters(),
            weight: 1
        )
        XCTAssertNotNil(view)
        XCTAssertLessThan(view!.score, 0)
        XCTAssertEqual(view!.trend, "down")
    }

    func testInsufficientHistoryReturnsNil() {
        XCTAssertNil(ConsensusEngine.scoreTimeframe(
            timeframe: "M15",
            candles: trendingCandles(count: 10, up: true),
            params: StrategyParameters(),
            weight: 1
        ))
    }

    func testFlatMarketScoresNearZero() {
        let view = ConsensusEngine.scoreTimeframe(
            timeframe: "M15",
            candles: flatCandles(count: 200),
            params: StrategyParameters(),
            weight: 1
        )
        XCTAssertNotNil(view)
        XCTAssertLessThan(abs(view!.score), 30, "A directionless market should not produce conviction.")
    }

    func testPermitsRejectsTradesAgainstTheConsensus() {
        let params = StrategyParameters() // minScore 35
        let bullish = ConsensusResult(
            instrument: "EUR_USD",
            score: 60,
            isLong: true,
            agreement: 1.0,
            higherTimeframeAligned: true,
            timeframes: [],
            cautions: [],
            summary: ""
        )

        XCTAssertTrue(bullish.permits(isLong: true, params: params).ok)
        XCTAssertFalse(bullish.permits(isLong: false, params: params).ok,
                       "Shorting into a +60 consensus is the trade this gate exists to stop.")
    }

    func testPermitsRejectsWeakConvictionAndMisalignment() {
        let params = StrategyParameters()

        let weak = ConsensusResult(instrument: "EUR_USD", score: 20, isLong: true, agreement: 1.0,
                                   higherTimeframeAligned: true, timeframes: [], cautions: [], summary: "")
        XCTAssertFalse(weak.permits(isLong: true, params: params).ok)

        let misaligned = ConsensusResult(instrument: "EUR_USD", score: 60, isLong: true, agreement: 1.0,
                                         higherTimeframeAligned: false, timeframes: [], cautions: [], summary: "")
        XCTAssertFalse(misaligned.permits(isLong: true, params: params).ok)

        let split = ConsensusResult(instrument: "EUR_USD", score: 60, isLong: true, agreement: 0.33,
                                    higherTimeframeAligned: true, timeframes: [], cautions: [], summary: "")
        XCTAssertFalse(split.permits(isLong: true, params: params).ok)
    }

    func testDisablingConsensusPermitsEverything() {
        var params = StrategyParameters()
        params.consensus.enabled = false
        let hostile = ConsensusResult(instrument: "EUR_USD", score: -80, isLong: false, agreement: 1.0,
                                      higherTimeframeAligned: false, timeframes: [], cautions: [], summary: "")
        XCTAssertTrue(hostile.permits(isLong: true, params: params).ok)
    }

    func testEvaluateAgainstMockClientProducesAScore() async {
        let client = MockOandaClient()
        let result = await ConsensusEngine.evaluate(
            instrument: "EUR_USD",
            client: client,
            params: StrategyParameters()
        )
        // The mock returns a steadily rising series, so the read should be long.
        XCTAssertEqual(result.instrument, "EUR_USD")
        XCTAssertFalse(result.timeframes.isEmpty)
        XCTAssertEqual(result.isLong, true)
    }
}
