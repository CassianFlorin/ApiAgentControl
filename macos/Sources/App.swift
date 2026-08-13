import SwiftUI
import AppKit

@main
struct ApiAgentControlMonitorApp: App {
    @StateObject private var monitor = DaemonMonitor()

    var body: some Scene {
        MenuBarExtra {
            PanelView().environmentObject(monitor)
        } label: {
            // 菜单栏图标是模板渲染（自动跟随深浅色、不吃自定义颜色），
            // 所以用**换图形**而不是换颜色来区分状态
            Image(systemName: monitor.health.symbol)
        }
        .menuBarExtraStyle(.window)
    }
}

struct PanelView: View {
    @EnvironmentObject var monitor: DaemonMonitor
    @State private var showLog = false

    private var isRunning: Bool { monitor.status != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            if let s = monitor.status {
                details(s)
            } else {
                Text(monitor.launchdInstalled
                     ? "daemon 未运行。打开上面的开关即可启动。"
                     : "尚未安装 launchd 服务。先在仓库目录执行 scripts/install-launchd.sh。")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let err = monitor.lastError {
                Text(err).font(.caption2).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            if showLog {
                ScrollView {
                    Text(monitor.logTail())
                        .font(.system(size: 10, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 130)
                Divider()
            }
            actions
        }
        .padding(12)
        .frame(width: 300)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text("ApiAgentControl").font(.headline)
                Text(monitor.health.text)
                    .font(.caption)
                    .foregroundStyle(monitor.health == .degraded ? Color.orange : Color.secondary)
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { isRunning },
                set: { $0 ? monitor.start() : monitor.stop() }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .disabled(monitor.busy || (!monitor.launchdInstalled && !isRunning))
        }
    }

    @ViewBuilder
    private func details(_ s: DaemonStatus) -> some View {
        VStack(spacing: 5) {
            row("中继", s.relay.configured
                ? (s.relay.connected ? "已连接" : "未连接")
                : "未配置（仅本机）",
                ok: !s.relay.configured || s.relay.connected)
            row("控制通道", s.control.enabled
                ? (s.control.appServerUp ? "就绪" : "未就绪")
                : "已禁用",
                ok: !s.control.enabled || s.control.appServerUp)
            row("推送", s.push.configured
                ? "\(s.push.production == true ? "生产" : "沙盒") · \(s.push.devicesWithToken ?? 0) 台设备"
                : "未配置",
                ok: true)
            row("会话", "\(s.watch.sessions) 个 · \(s.devices) 台已配对", ok: true)
            row("最近事件", relativeTime(s.watch.lastEventAt), ok: true)
            row("已运行", uptime(s.uptimeSec)
                + (monitor.launchdLoaded ? "" : "（手动启动）"), ok: true)
        }
    }

    private func row(_ k: String, _ v: String, ok: Bool) -> some View {
        HStack(spacing: 6) {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !ok {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.caption2).foregroundStyle(.orange)
            }
            Text(v).font(.caption).foregroundStyle(ok ? Color.primary : Color.orange)
        }
    }

    private var actions: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button(showLog ? "收起日志" : "查看日志") { showLog.toggle() }
                Button("重启") { monitor.restart() }
                    .disabled(!monitor.launchdLoaded || monitor.busy)
            }
            HStack(spacing: 6) {
                Button("调试页") {
                    if let u = monitor.debugPageURL() { NSWorkspace.shared.open(u) }
                }
                .disabled(!isRunning)
                Button("日志文件") { NSWorkspace.shared.open(monitor.logURL) }
                Spacer()
                Button("退出") { NSApplication.shared.terminate(nil) }
            }
            .font(.caption)
        }
    }

    // MARK: - 格式化

    private func uptime(_ sec: Int) -> String {
        if sec < 60 { return "\(sec) 秒" }
        if sec < 3600 { return "\(sec / 60) 分钟" }
        if sec < 86400 { return "\(sec / 3600) 小时" }
        return "\(sec / 86400) 天"
    }

    private func relativeTime(_ iso: String?) -> String {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) else { return "—" }
        let d = Int(Date().timeIntervalSince(date))
        if d < 60 { return "\(max(d, 0)) 秒前" }
        if d < 3600 { return "\(d / 60) 分钟前" }
        if d < 86400 { return "\(d / 3600) 小时前" }
        return "\(d / 86400) 天前"
    }
}
