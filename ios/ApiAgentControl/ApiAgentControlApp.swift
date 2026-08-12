import SwiftUI

@main
struct ApiAgentControlApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var app = AppState()
    @Environment(\.scenePhase) private var scenePhase

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
            // 解锁/切回前台时连接多半已死但不报错，必须主动验活，
            // 否则界面停在「已连接」却处处等超时（见 RelayClient.ensureAlive）
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { app.relay.ensureAlive() }
            }
            // 支持直接点开配对链接 —— 手输 300+ 字符的 base64 串完全不现实，
            // 扫码之外必须给一条一键路径
            .onOpenURL { url in
                try? app.pair(with: url.absoluteString)
            }
        }
    }
}
