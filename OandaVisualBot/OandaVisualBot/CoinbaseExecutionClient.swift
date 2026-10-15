//
//  CoinbaseExecutionClient.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 8/6/26.
//

import Foundation

public final class CoinbaseExecutionClient {
    private let apiKey: String
    private let apiSecret: String
    private let baseURL = URL(string: "https://api.coinbase.com/api/v3/brokerage")! //

    public init(apiKey: String, apiSecret: String) {
        self.apiKey = apiKey
        self.apiSecret = apiSecret
    }

    public func fetchRecentClosePrices(instrument: String, granularity: String, count: Int) async throws -> [Double] {
        let endpoint = baseURL.appendingPathComponent("market/products/\(instrument)/candles")
        var request = URLRequest(url: endpoint)
        request.setValue(apiKey, forHTTPHeaderField: "CB-ACCESS-KEY")
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return []
    }

    public func executeMarketOrder(accountID: String, instrument: String, units: Int, stopLoss: String, takeProfit: String) async throws {
        try await executeDynamicOrder(
            accountID: accountID,
            instrument: instrument,
            units: units,
            isLong: true,
            isLimit: false,
            targetPrice: nil,
            stopLossDistance: stopLoss,
            takeProfitDistance: takeProfit
        )
    }

    public func hasExistingPosition(accountID: String, instrument: String) async throws -> Bool {
        let trades = try await fetchActiveTrades(accountID: accountID)
        return trades.contains { $0.instrument == instrument }
    }

    public func fetchActiveTrades(accountID: String) async throws -> [ActiveTradeInfo] {
        let endpoint = baseURL.appendingPathComponent("orders/historical/batch")
        var request = URLRequest(url: endpoint)
        request.setValue(apiKey, forHTTPHeaderField: "CB-ACCESS-KEY")
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return []
    }

    public func executeDynamicOrder(
        accountID: String,
        instrument: String,
        units: Int,
        isLong: Bool,
        isLimit: Bool,
        targetPrice: Double?,
        stopLossDistance: String,
        takeProfitDistance: String
    ) async throws {
        let endpoint = baseURL.appendingPathComponent("orders")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "CB-ACCESS-KEY")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "product_id": instrument,
            "side": isLong ? "BUY" : "SELL",
            "order_configuration": isLimit ? ["limit_limit_gtc": ["base_size": String(units), "limit_price": String(targetPrice ?? 0.0)]] : ["market_market_ioc": ["base_size": String(units)]]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...201).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    public func cancelOrder(accountID: String, orderID: String) async throws {
        let endpoint = baseURL.appendingPathComponent("orders/batch_cancel")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "CB-ACCESS-KEY")
        
        let body: [String: Any] = ["order_ids": [orderID]]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }
}
