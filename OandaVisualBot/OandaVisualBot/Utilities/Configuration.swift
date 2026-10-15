//
//  Configuration.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import Foundation

public struct Configuration {
    public static var apiToken: String {
        if let token = ProcessInfo.processInfo.environment["OANDA_API_TOKEN"], !token.isEmpty {
            return token
        }
        return KeychainManager.load(key: "OANDA_API_TOKEN") ?? ""
    }
    
    public static var accountID: String {
        if let id = ProcessInfo.processInfo.environment["OANDA_ACCOUNT_ID"], !id.isEmpty {
            return id
        }
        return KeychainManager.load(key: "OANDA_ACCOUNT_ID") ?? ""
    }
}
