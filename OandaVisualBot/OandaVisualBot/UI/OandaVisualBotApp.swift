//
//  OandaVisualBotApp.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import SwiftUI

@main
struct OandaVisualBotApp: App {
    @StateObject private var botConfig: BotConfiguration
    @StateObject private var botEngine: BotEngine

    init() {
        let config = BotConfiguration()
        _botConfig = StateObject(wrappedValue: config)
        _botEngine = StateObject(wrappedValue: BotEngine(
            client: OandaClient(token: Configuration.apiToken),
            accountID: Configuration.accountID,
            botConfig: config
        ))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(botConfig: botConfig)
                .environmentObject(botConfig)
                .frame(minWidth: 400, minHeight: 600)
        }
        .windowResizability(.contentMinSize)
    }
}
