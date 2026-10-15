//
//  SettingsView.swift
//  OandaVisualBot
//
//  Created by Rutz LLC on 7/31/26.
//

import SwiftUI

struct SettingsView: View {
    @State private var token: String = ""
    @State private var accountID: String = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            SecureField("OANDA API Token", text: $token)
            TextField("Account ID", text: $accountID)
            
            Button("Save Credentials") {
                _ = KeychainManager.save(key: "OANDA_API_TOKEN", data: token)
                _ = KeychainManager.save(key: "OANDA_ACCOUNT_ID", data: accountID)
                dismiss()
            }
        }
        .padding()
        .frame(width: 300, height: 180)
        .onAppear {
            token = KeychainManager.load(key: "OANDA_API_TOKEN") ?? ""
            accountID = KeychainManager.load(key: "OANDA_ACCOUNT_ID") ?? ""
        }
    }
}
