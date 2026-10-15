//
//  OandaClient.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public final class OandaClient: OandaServiceProtocol {
    public let baseURL = URL(string: "https://api-fxpractice.oanda.com/v3")!
    private let token: String

    /// Pricing is an account-scoped endpoint in v20, unlike candles. Defaulted
    /// from Configuration so existing `OandaClient(token:)` callers keep working
    /// and still get live spreads.
    public var accountIDForPricing: String

    public init(token: String, accountIDForPricing: String = Configuration.accountID) {
        self.token = token
        self.accountIDForPricing = accountIDForPricing
    }
    
    public func fetchPendingOrders(accountID: String) async throws -> [PendingOrderInfo] {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/pendingOrders")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return []
        }
         
        struct PendingOrdersResponse: Decodable {
            struct RemoteOrder: Decodable {
                let id: String
                let instrument: String
                let type: String
                let price: String?
                let units: String?
            }
            let orders: [RemoteOrder]
        }
         
        let decoded = try JSONDecoder().decode(PendingOrdersResponse.self, from: data)
        return decoded.orders.map { order in
            PendingOrderInfo(
                id: order.id,
                instrument: order.instrument,
                type: order.type,
                price: order.price ?? "0.0",
                units: order.units ?? "0"
            )
        }
    }
    
    public func fetchAccountSummary(accountID: String) async throws -> AccountSummaryResponse {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/summary")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...209).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
         
        do {
            let decoded = try JSONDecoder().decode(AccountSummaryWrapper.self, from: data)
            return decoded.account
        } catch {
            print("[Debug] HUD Telemetry decoding failed: Verify AccountSummaryResponse keys map to active Oanda JSON schema. Error: \(error)")
            throw error
        }
    }
    
    public func cancelOrder(accountID: String, orderID: String) async throws {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/orders/\(orderID)/cancel")
         
        var request = URLRequest(url: endpoint)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...201).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
    
    public func fetchRecentClosePrices(instrument: String, granularity: String, count: Int) async throws -> [Double] {
        var components = URLComponents(url: baseURL.appendingPathComponent("instruments/\(instrument)/candles"), resolvingAgainstBaseURL: true)!
        components.queryItems = [
            URLQueryItem(name: "granularity", value: granularity),
            URLQueryItem(name: "count", value: String(count)),
            URLQueryItem(name: "price", value: "M")
        ]
         
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
         
        struct CandleResponse: Decodable {
            struct Candle: Decodable {
                struct Price: Decodable { let c: String }
                let mid: Price
            }
            let candles: [Candle]
        }
         
        let decoded = try JSONDecoder().decode(CandleResponse.self, from: data)
        return decoded.candles.compactMap { Double($0.mid.c) }
    }
    
    /// Full OHLC bars. `fetchRecentClosePrices` throws away the high and low,
    /// which makes a true range — and so an ATR, and so any volatility-scaled
    /// stop — impossible to compute.
    public func fetchCandles(instrument: String, granularity: String, count: Int) async throws -> [Candle] {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("instruments/\(instrument)/candles"),
            resolvingAgainstBaseURL: true
        )!
        components.queryItems = [
            URLQueryItem(name: "granularity", value: granularity),
            // One extra bar, because the newest one is usually still forming and
            // callers discard it.
            URLQueryItem(name: "count", value: String(min(count + 1, 5000))),
            URLQueryItem(name: "price", value: "M")
        ]

        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("RFC3339", forHTTPHeaderField: "Accept-Datetime-Format")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? ""
            print("[OandaClient ERROR] Candle fetch failed for \(instrument): \(body)")
            throw URLError(.badServerResponse)
        }

        struct CandleResponse: Decodable {
            struct RemoteCandle: Decodable {
                struct OHLC: Decodable {
                    let o: String
                    let h: String
                    let l: String
                    let c: String
                }
                let time: String
                let mid: OHLC
                let volume: Int?
                let complete: Bool
            }
            let candles: [RemoteCandle]
        }

        let decoded = try JSONDecoder().decode(CandleResponse.self, from: data)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return decoded.candles.compactMap { remote in
            guard let open = Double(remote.mid.o),
                  let high = Double(remote.mid.h),
                  let low = Double(remote.mid.l),
                  let close = Double(remote.mid.c) else { return nil }

            return Candle(
                time: formatter.date(from: remote.time) ?? ISO8601DateFormatter().date(from: remote.time) ?? Date(),
                open: open,
                high: high,
                low: low,
                close: close,
                volume: remote.volume ?? 0,
                complete: remote.complete
            )
        }
    }

    /// Live bid/ask, so the cost filter uses the real spread instead of a guess.
    public func fetchQuote(instrument: String) async throws -> PriceQuote? {
        guard !accountIDForPricing.isEmpty else { return nil }
        var components = URLComponents(
            url: baseURL.appendingPathComponent("accounts/\(accountIDForPricing)/pricing"),
            resolvingAgainstBaseURL: true
        )!
        components.queryItems = [URLQueryItem(name: "instruments", value: instrument)]

        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return nil
        }

        struct PricingResponse: Decodable {
            struct Price: Decodable {
                struct Level: Decodable { let price: String }
                let instrument: String
                let bids: [Level]?
                let asks: [Level]?
                let tradeable: Bool?
            }
            let prices: [Price]
        }

        let decoded = try JSONDecoder().decode(PricingResponse.self, from: data)
        guard let price = decoded.prices.first,
              let bid = price.bids?.first?.price, let bidValue = Double(bid),
              let ask = price.asks?.first?.price, let askValue = Double(ask) else {
            return nil
        }

        return PriceQuote(
            instrument: price.instrument,
            bid: bidValue,
            ask: askValue,
            tradeable: price.tradeable ?? true
        )
    }

    public func executeMarketOrder(accountID: String, instrument: String, units: Int, stopLoss: String, takeProfit: String) async throws {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/orders")
         
        let orderBody: [String: Any] = [
            "order": [
                "type": "MARKET",
                "instrument": instrument,
                "units": String(units),
                "timeInForce": "FOK",
                "positionFill": "DEFAULT",
                "stopLossOnFill": [
                    "distance": stopLoss,
                    "timeInForce": "GTC"
                ],
                "takeProfitOnFill": [
                    "distance": takeProfit,
                    "timeInForce": "GTC"
                ]
            ]
        ]
         
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: orderBody)
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200...201).contains(httpResponse.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error body"
            print("[OandaClient ERROR] Market order rejected by broker: HTTP \(httpResponse.statusCode), Body: \(errorBody)")
            throw URLError(.badServerResponse)
        }
    }
    
    /// Financing rates and the per-weekday charge schedule for an instrument.
    ///
    /// Account-scoped, because the rates depend on the account's own terms. The
    /// `financingDaysOfWeek` array is what reveals the tripled rollover: one
    /// weekday reports `daysCharged: 3` to cover the weekend's value dates.
    public func fetchInstrumentFinancing(accountID: String, instrument: String) async throws -> InstrumentFinancing? {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("accounts/\(accountID)/instruments"),
            resolvingAgainstBaseURL: true
        )!
        components.queryItems = [URLQueryItem(name: "instruments", value: instrument)]

        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return nil
        }

        struct InstrumentsResponse: Decodable {
            struct Instrument: Decodable {
                struct Financing: Decodable {
                    struct DayOfWeek: Decodable {
                        let dayOfWeek: String
                        let daysCharged: Int
                    }
                    let longRate: String?
                    let shortRate: String?
                    let financingDaysOfWeek: [DayOfWeek]?
                }
                let name: String
                let financing: Financing?
            }
            let instruments: [Instrument]
        }

        let decoded = try JSONDecoder().decode(InstrumentsResponse.self, from: data)
        guard let financing = decoded.instruments.first?.financing else { return nil }

        let indexByName: [String: Int] = [
            "SUNDAY": 0, "MONDAY": 1, "TUESDAY": 2, "WEDNESDAY": 3,
            "THURSDAY": 4, "FRIDAY": 5, "SATURDAY": 6
        ]
        var daysCharged: [Int: Int] = [:]
        for entry in financing.financingDaysOfWeek ?? [] {
            if let index = indexByName[entry.dayOfWeek.uppercased()] {
                daysCharged[index] = entry.daysCharged
            }
        }

        return InstrumentFinancing(
            longRate: Double(financing.longRate ?? "0") ?? 0,
            shortRate: Double(financing.shortRate ?? "0") ?? 0,
            // Fall back to the standard schedule rather than to an empty map, so
            // a missing field never reads as "nothing is ever charged".
            daysCharged: daysCharged.isEmpty ? InstrumentFinancing.standardFX.daysCharged : daysCharged
        )
    }

    /// Reduce or close a position through the position endpoint.
    ///
    /// This endpoint, not a close-by-trade-ID, because OANDA applies FIFO to it
    /// server-side. On a US account a trade-ID close that skips an older trade is
    /// rejected with FIFO_VIOLATION.
    public func reducePosition(accountID: String, instrument: String, units: Int, isLong: Bool) async throws {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/positions/\(instrument)/close")

        var body: [String: String] = [:]
        let amount = String(abs(units))
        if isLong { body["longUnits"] = amount } else { body["shortUnits"] = amount }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...201).contains(httpResponse.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error body"
            print("[OandaClient ERROR] Position reduction rejected for \(instrument): \(errorBody)")
            throw URLError(.badServerResponse)
        }
    }

    /// Move an open trade's stop loss.
    public func updateTradeStop(accountID: String, tradeID: String, stopPrice: Double, precision: Int) async throws {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/trades/\(tradeID)/orders")

        let body: [String: Any] = [
            "stopLoss": [
                "price": String(format: "%.\(precision)f", stopPrice),
                "timeInForce": "GTC"
            ]
        ]

        var request = URLRequest(url: endpoint)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...201).contains(httpResponse.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error body"
            print("[OandaClient ERROR] Stop update rejected for trade \(tradeID): \(errorBody)")
            throw URLError(.badServerResponse)
        }
    }

    public func hasExistingPosition(accountID: String, instrument: String) async throws -> Bool {
        let urlString = "https://api-fxpractice.oanda.com/v3/accounts/\(accountID)/openTrades"
        guard let url = URL(string: urlString) else { return false }
         
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return false
        }
         
        if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
           let trades = json["trades"] as? [[String: Any]] {
            return trades.contains { ($0["instrument"] as? String) == instrument }
        }
         
        return false
    }
    
    public func fetchActiveTrades(accountID: String) async throws -> [ActiveTradeInfo] {
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/openTrades")
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return []
        }
         
        struct OpenTradesResponse: Decodable {
            let trades: [RemoteTradeDetails]
        }
         
        let decoded = try JSONDecoder().decode(OpenTradesResponse.self, from: data)
         
        return try await withThrowingTaskGroup(of: ActiveTradeInfo?.self) { group in
            for remoteTrade in decoded.trades {
                group.addTask {
                    let unitsInt = Int(remoteTrade.currentUnits) ?? 0
                    let isLong = unitsInt > 0
                    let entryPx = Double(remoteTrade.price) ?? 0.0
                    let sl = Double(remoteTrade.stopLossOrder?.price ?? "0.0") ?? 0.0
                    let tp = Double(remoteTrade.takeProfitOrder?.price ?? "0.0") ?? 0.0
                     
                    let prices = try await self.fetchRecentClosePrices(instrument: remoteTrade.instrument, granularity: "M1", count: 1)
                    let currentPx = prices.last ?? entryPx
                     
                    let brokerMargin = Double(remoteTrade.marginUsed ?? "0.0") ?? 0.0
                    let finalMargin = brokerMargin > 0.0 ? brokerMargin : (Double(abs(unitsInt)) * entryPx * 0.02)
                     
                    return ActiveTradeInfo(
                        instrument: remoteTrade.instrument,
                        tradeID: remoteTrade.id,
                        price: currentPx,
                        units: Int(remoteTrade.currentUnits) ?? 0,
                        isLong: isLong,
                        entryPrice: entryPx,
                        currentPrice: currentPx,
                        stopLoss: sl,
                        takeProfit: tp,
                        initialUnits: remoteTrade.currentUnits,
                        unrealizedPL: Double(remoteTrade.unrealizedPL ?? "0.0") ?? 0.0,
                        marginRequired: 0.0
                    )
                }
            }
             
            var results: [ActiveTradeInfo] = []
            for try await trade in group {
                if let t = trade { results.append(t) }
            }
            return results
        }
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
        let endpoint = baseURL.appendingPathComponent("accounts/\(accountID)/orders")
         
        let signedUnits = isLong ? units : -units
        let orderType = isLimit ? "LIMIT" : "MARKET"
         
        var orderDict: [String: Any] = [
            "type": orderType,
            "instrument": instrument,
            "units": String(signedUnits),
            "timeInForce": isLimit ? "GTC" : "FOK",
            "positionFill": "DEFAULT",
            "stopLossOnFill": [
                "distance": stopLossDistance,
                "timeInForce": "GTC"
            ],
            "takeProfitOnFill": [
                "distance": takeProfitDistance,
                "timeInForce": "GTC"
            ]
        ]
         
        if isLimit, let price = targetPrice {
            let isJpy = instrument.hasSuffix("_JPY")
            orderDict["price"] = String(format: isJpy ? "%.3f" : "%.5f", price)
        }
         
        let orderBody: [String: Any] = ["order": orderDict]
         
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: orderBody)
         
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...201).contains(httpResponse.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error body"
            print("[OandaClient ERROR] Dynamic order rejected by broker for \(instrument): HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1), Body: \(errorBody)")
            throw URLError(.badServerResponse)
        }
    }
}

private struct RemoteTradeDetails: Decodable {
    let id: String
    let instrument: String
    let currentUnits: String
    let price: String
    let unrealizedPL: String?
    let marginUsed: String?
    let stopLossOrder: SLDetails?
    let takeProfitOrder: TPDetails?
     
    struct SLDetails: Decodable { let price: String }
    struct TPDetails: Decodable { let price: String }
}

private struct AccountSummaryWrapper: Decodable {
    let account: AccountSummaryResponse
}
