import SwiftUI

@main
struct ApiAgentControlApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if app.pairing == nil {
                    PairingView()
                } else {
                    HomeView()
                }
            }
            .environmentObject(app)
            .environmentObject(app.push)
            .task {
                AppDelegate.push = app.push
                app.push.configure { [weak app] token in
                    await app?.registerPushToken(token)
                }
            }
            // 支持直接点开配对链接 —— 手输 300+ 字符的 base64 串完全不现实，
            // 扫码之外必须给一条一键路径
            .onOpenURL { url in
                try? app.pair(with: url.absoluteString)
            }
        }
    }
}
