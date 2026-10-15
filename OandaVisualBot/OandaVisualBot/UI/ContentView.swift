//
//  ContentView.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var botConfig: BotConfiguration
    @StateObject private var engine: BotEngine
    
    init(botConfig: BotConfiguration) {
        _engine = StateObject(wrappedValue: BotEngine(
            client: CircuitBreakerClient(
                innerClient: OandaClient(token: Configuration.apiToken)
            ),
            accountID: Configuration.accountID,
            botConfig: botConfig
        ))
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // MARK: - Top Scrollable Telemetry & Data Feeds
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Execution & Portfolio Telemetry")
                                .font(.subheadline)
                                .bold()
                            
                            HStack(spacing: 4) {
                                Text("Margin Available:")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                                Text(String(format: "%.2f USD", engine.marginAvailable))
                                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                                    .foregroundColor(.primary)
                            }
                        }
                        
                        Spacer()
                        
                        // Production Status Pill
                        HStack(spacing: 6) {
                            Circle()
                                .fill(engine.isRunning ? Color.green : Color.orange)
                                .frame(width: 8, height: 8)
                            Text(engine.isRunning ? "IDLE / SCANNING" : "STOPPED")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.windowBackgroundColor).opacity(0.8))
                        .cornerRadius(4)
                    }
                     
                    // 1. Active Positions (Rendered at top if live exposure exists)
                    if !engine.activeTrades.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Active Positions")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.secondary)
                            
                            VStack(spacing: 12) {
                                ForEach(engine.activeTrades) { trade in
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(trade.instrument)
                                                .bold()
                                            Spacer()
                                            Text(trade.positionTypeString)
                                                .font(.caption)
                                                .bold()
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(trade.isLong ? Color.green.opacity(0.2) : Color.red.opacity(0.2))
                                                .foregroundColor(trade.isLong ? .green : .red)
                                                .cornerRadius(4)
                                        }
                                        
                                        Divider()
                                        
                                        Group {
                                            HStack {
                                                Text("Active Instrument Price:")
                                                Spacer()
                                                Text(String(format: "%.5f", trade.currentPrice))
                                            }
                                            HStack {
                                                Text("Trade Entered At:")
                                                Spacer()
                                                Text(String(format: "$%.5f", trade.entryPrice))
                                            }
                                            HStack {
                                                Text("Margin Required:")
                                                Spacer()
                                                Text(String(format: "%.2f USD", trade.marginRequired))
                                            }
                                            HStack {
                                                Text("Expected Exit (TP):")
                                                Spacer()
                                                Text(trade.takeProfit > 0 ? formatOandaPL(price: trade.takeProfit, entry: trade.entryPrice, isLong: trade.isLong) : "None Set")
                                                    .foregroundColor(trade.takeProfit > 0 ? .primary : .orange)
                                            }
                                            HStack {
                                                Text("Stop Loss (SL):")
                                                Spacer()
                                                Text(trade.stopLoss > 0 ? formatOandaPL(price: trade.stopLoss, entry: trade.entryPrice, isLong: trade.isLong) : "None Set")
                                                    .foregroundColor(trade.stopLoss > 0 ? .primary : .red)
                                            }
                                        }
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    }
                                    .padding(8)
                                    .background(Color(.windowBackgroundColor))
                                    .cornerRadius(6)
                                }
                            }
                        }
                    } else {
                        // Flat-Market State Notice
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "waveform.path.ecg")
                                .foregroundColor(.blue)
                                .font(.system(size: 16))
                            
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Market Neutral / No Active Exposure")
                                    .font(.caption)
                                    .bold()
                                Text("Engine is actively polling Oanda feeds and evaluating signal criteria.")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.windowBackgroundColor))
                        .cornerRadius(6)
                    }
                     
                    // 2. Risk & Account Snapshot Grid
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Risk & Account Telemetry")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.secondary)
                        
                        VStack(spacing: 4) {
                            telemetryRow(title: "NAV (Net Asset Value):", value: String(format: "$%.2f", engine.nav))
                            telemetryRow(title: "API Latency:", value: "\(engine.apiLatencyMs) ms")
                            telemetryRow(title: "Daily Drawdown:", value: String(format: "%.2f%%", engine.dailyDrawdown))
                        }
                        .padding(10)
                        .background(Color(.windowBackgroundColor))
                        .cornerRadius(6)
                    }
                     
                    // 3. Active Strategy Watchlist (Guaranteed fixed layout position below risk snapshot)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Active Strategy Watchlist")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.secondary)
                        
                        VStack(spacing: 6) {
                            ForEach(engine.watchlistItems) { item in
                                watchlistScanRow(
                                    instrument: item.instrument,
                                    strategyName: item.strategyName,
                                    indicatorStatus: item.indicatorStatus,
                                    statusColor: item.statusColor
                                )
                            }
                        }
                        .padding(10)
                        .background(Color(.windowBackgroundColor))
                        .cornerRadius(6)
                    }
                }
                .padding()
            }
             
            Divider()
             
            // Controls
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        Button(action: { engine.startBot() }) {
                            Text("Start Bot")
                                .frame(maxWidth: .infinity)
                        }
                        .disabled(engine.isRunning)
                         
                        Button(action: { engine.stopBot() }) {
                            Text("Stop")
                                .frame(maxWidth: .infinity)
                        }
                        .disabled(!engine.isRunning)
                        .tint(.red)
                    }
                    
                    Button(action: { engine.clearAllOrders() }) {
                        Text("Clear All Orders")
                            .frame(maxWidth: .infinity)
                    }
                    .tint(.orange)
                     
                    Divider()
                    Text("Execution & Strategy Overrides")
                        .font(.headline)
                     
                    Toggle("Bypass Liquidity Windows", isOn: $botConfig.ignoreLiquidityWindow)
                    Toggle("Bypass Confluence Gates", isOn: $botConfig.ignoreConfluenceGates)
                    Toggle("Force Immediate Market Scalping", isOn: $botConfig.forceImmediateMarketExecution)
                    Toggle("Enable Coinbase Trading", isOn: $botConfig.enableCoinbaseTrading)
                     
                    VStack(alignment: .leading) {
                        Text("Mean Reversion Sensitivity: \(String(format: "%.2f", botConfig.meanReversionThreshold))")
                        Slider(value: $botConfig.meanReversionThreshold, in: 0.1...0.5, step: 0.05)
                    }
                     
                    VStack(alignment: .leading) {
                        Text("Breakout Lookback Candles: \(botConfig.breakoutLookbackCount)")
                        Stepper(value: $botConfig.breakoutLookbackCount, in: 5...30, step: 5) {
                            Text("Lookback: \(botConfig.breakoutLookbackCount)")
                        }
                    }
                }
                .padding(.horizontal)
            }
        }
        .background(Color(.windowBackgroundColor))
    }
     
    // MARK: - Formatting Helpers
     
    private func formatOandaPL(price: Double, entry: Double, isLong: Bool) -> String {
        let diff = isLong ? (price - entry) : (entry - price)
        let pips = diff * 10000
        let estimatedUSDValue = abs(diff) * 100000
         
        let sign = diff >= 0 ? "+" : ""
        return String(format: "%@%.2f USD / %@%.1f PIPS", sign, estimatedUSDValue, sign, pips)
    }
     
    @ViewBuilder
    private func telemetryRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
        }
    }
     
    @ViewBuilder
    private func watchlistScanRow(instrument: String, strategyName: String, indicatorStatus: String, statusColor: Color) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(instrument)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
            
            Text("[\(strategyName)]")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
            
            Spacer()
            
            Text(indicatorStatus)
                .font(.system(size: 11))
                .foregroundColor(statusColor)
                .multilineTextAlignment(.trailing)
        }
    }
}
