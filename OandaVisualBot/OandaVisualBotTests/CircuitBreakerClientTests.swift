//
//  CircuitBreakerClientTests.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import XCTest
@testable import OandaVisualBot

final class CircuitBreakerClientTests: XCTestCase {
    
    func testCircuitBreakerTripsAfterConsecutiveFailures() async {
        let mockClient = MockOandaClient(shouldHavePosition: false, shouldThrowError: true)
        let circuitBreaker = await CircuitBreakerClient(innerClient: mockClient)
        
        // Trigger failures up to the threshold (threshold is 3)
        for i in 1...3 {
            do {
                _ = try await circuitBreaker.fetchRecentClosePrices(instrument: "EUR_USD", granularity: "M1", count: 10)
                XCTFail("Request \(i) should have thrown an error.")
            } catch {
                // Expected network error from mock
            }
        }
        
        // The 4th request should be blocked immediately by the tripped circuit breaker
        do {
            _ = try await circuitBreaker.fetchRecentClosePrices(instrument: "EUR_USD", granularity: "M1", count: 10)
            XCTFail("Circuit breaker should be tripped and reject requests immediately.")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .networkConnectionLost, "Tripped circuit breaker should throw networkConnectionLost.")
        } catch {
            XCTFail("Unexpected error type thrown: \(error)")
        }
    }
}
