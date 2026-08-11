import Foundation
import UIKit
import UserNotifications

/// 推送注册与接收。
///
/// **通知体不含任何真实内容**：APNs 服务器能看到推送体，而会话标题里常带
/// 业务信息（形如"【加急】【0812上线】库存判断逻辑优化"，直接暴露排期与模块），命令内容更敏感。
/// 所以通知只写"有一条需要处理"，用户点开后由 App 经端到端加密通道取真实内容。
///
/// 这样无需 Notification Service Extension 与 App Group 权限就已经是完全隐私的。
/// 后续若想在通知栏直接显示解密后的预览，再加 NSE 即可 —— daemon 已经把密文
/// 放在推送的 `e2e` 字段里备用。
@MainActor
final class PushManager: NSObject, ObservableObject {
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var registered = false
    @Published private(set) var lastError: String?

    /// 收到通知点击后要跳转的会话
    @Published var pendingSessionId: String?

    private var uploadToken: ((String) async -> Void)?

    func configure(uploadToken: @escaping (String) async -> Void) {
        self.uploadToken = uploadToken
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshStatus() }
    }

    func refreshStatus() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if authorization == .authorized { registerForRemote() }
    }

    /// 请求权限。用户拒绝过就不再重复弹，只能去系统设置改。
    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            authorization = granted ? .authorized : .denied
            if granted { registerForRemote() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func registerForRemote() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// 由 AppDelegate 回调转入
    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        registered = true
        lastError = nil
        Task { await uploadToken?(hex) }
    }

    func didFailToRegister(_ error: Error) {
        registered = false
        // 模拟器在没有 APNs 环境时会走到这里，属正常
        lastError = error.localizedDescription
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    /// App 在前台时也显示通知 —— 否则用户会以为推送坏了
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// 点击通知 → 跳到对应会话
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        // daemon 把会话 id 放在 aps.thread-id
        let sid = (info["aps"] as? [String: Any])?["thread-id"] as? String
        await MainActor.run { self.pendingSessionId = sid }
    }
}

/// UIKit 的 APNs 回调只能走 AppDelegate
final class AppDelegate: NSObject, UIApplicationDelegate {
    static weak var push: PushManager?

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in Self.push?.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in Self.push?.didFailToRegister(error) }
    }
}
