//
//  OrderExecutionManagerTests.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//
//  These tests previously called `executeOrderSafely`, a method that does not
//  exist on OrderExecutionManager, so the test target could not build and none of
//  it was running. They now exercise the real entry point — and the direction and
//  limit-price handling that a mis-signed order would break.
//

import XCTest
@testable import OandaVisualBot

final class OrderExecutionManagerTests: XCTestCase {

    func testIdempotencyGuardSuppressesDuplicateLimitOrders() async {
        let mockClient = MockOandaClient(shouldHavePosition: true)
        let manager = OrderExecutionManager(client: mockClient, accountID: "TEST_ACCOUNT")

        let success = await manager.executeDynamicOrderSafely(
            instrument: "EUR_USD",
            units: 1000,
            isLong: true,
            isLimit: true,
            targetPrice: 1.1000,
            stopLoss: "0.0050",
            takeProfit: "0.0100"
        )

        XCTAssertFalse(success, "A limit order should be suppressed while a position is already open.")
        XCTAssertEqual(mockClient.executedOrderCount, 0, "Nothing should reach the broker when the guard trips.")
    }

    func testMarketOrderExecutesWhenNoPositionExists() async {
        let mockClient = MockOandaClient(shouldHavePosition: false)
        let manager = OrderExecutionManager(client: mockClient, accountID: "TEST_ACCOUNT")

        let success = await manager.executeDynamicOrderSafely(
            instrument: "EUR_USD",
            units: 1000,
            isLong: true,
            isLimit: false,
            targetPrice: nil,
            stopLoss: "0.0050",
            takeProfit: "0.0100"
        )

        XCTAssertTrue(success)
        XCTAssertEqual(mockClient.executedOrderCount, 1)
        XCTAssertEqual(mockClient.lastOrder?.signedUnits, 1000)
    }

    func testShortOrderReachesBrokerWithNegativeSignedUnits() async {
        let mockClient = MockOandaClient(shouldHavePosition: false)
        let manager = OrderExecutionManager(client: mockClient, accountID: "TEST_ACCOUNT")

        // The dispatcher passes the magnitude with the direction in the flag; if
        // a signed value leaked through here it would double-negate and turn
        // every short into a long.
        let success = await manager.executeDynamicOrderSafely(
            instrument: "USD_JPY",
            units: 750,
            isLong: false,
            isLimit: false,
            targetPrice: nil,
            stopLoss: "0.250",
            takeProfit: "0.500"
        )

        XCTAssertTrue(success)
        XCTAssertEqual(mockClient.lastOrder?.units, 750)
        XCTAssertEqual(mockClient.lastOrder?.isLong, false)
        XCTAssertEqual(mockClient.lastOrder?.signedUnits, -750)
    }

    func testDetachedLimitPriceIsDowngradedToMarketRatherThanSubmitted() async {
        let mockClient = MockOandaClient(shouldHavePosition: false)
        let manager = OrderExecutionManager(client: mockClient, accountID: "TEST_ACCOUNT")

        // The mock's close series sits around 1.10; 1.085 is far outside the
        // 0.25% tolerance. The clamp used to log an interception and then submit
        // the rogue price anyway.
        let success = await manager.executeDynamicOrderSafely(
            instrument: "EUR_USD",
            units: 1000,
            isLong: true,
            isLimit: true,
            targetPrice: 1.08500,
            stopLoss: "0.0050",
            takeProfit: "0.0100"
        )

        XCTAssertTrue(success)
        XCTAssertEqual(mockClient.lastOrder?.isLimit, false, "A detached limit price must not reach the broker.")
        XCTAssertNil(mockClient.lastOrder?.targetPrice)
    }
}
