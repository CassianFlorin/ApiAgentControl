import Foundation
import Combine

/// daemon 的运行状态。字段与 daemon 的 `/status` 端点一一对应。
struct DaemonStatus: Decodable {
    struct Watch: Decodable {
        let sessions: Int
        let trackedFiles: Int
        let lastEventAt: String?
        let sseClients: Int
    }
    struct Relay: Decodable {
        let configured: Bool
        let connected: Bool
        let url: String?
        let room: String?
        let pairedPeers: Int?
    }
    struct Control: Decodable {
        let enabled: Bool
        let appServerUp: Bool
    }
    struct Push: Decodable {
        let configured: Bool
        let production: Bool?
        let bundleId: String?
        let devicesWithToken: Int?
    }
    let pid: Int
    let uptimeSec: Int
    let port: Int
    let watch: Watch
    let relay: Relay
    let control: Control
    let push: Push
    let devices: Int
}

/// 整体健康度。菜单栏图标只有三态，够用且一眼能分辨。
enum Health {
    case stopped          // 进程没跑
    case degraded         // 跑着，但有环节不通（中继断了 / 控制通道起不来）
    case healthy

    var symbol: String {
        switch self {
        case .stopped:  return "antenna.radiowaves.left.and.right.slash"
        case .degraded: return "exclamationmark.triangle"
        case .healthy:  return "antenna.radiowaves.left.and.right"
        }
    }
    var text: String {
        switch self {
        case .stopped:  return "已停止"
        case .degraded: return "运行中（有异常）"
        case .healthy:  return "运行正常"
        }
    }
}

@MainActor
final class DaemonMonitor: ObservableObject {
    @Published private(set) var status: DaemonStatus?
    @Published private(set) var launchdLoaded = false
    @Published private(set) var launchdInstalled = false
    @Published private(set) var busy = false
    @Published private(set) var lastError: String?

    private let label = "com.apiagentcontrol.daemon"
    private let home = FileManager.default.homeDirectoryForCurrentUser
    private var timer: Timer?

    var configDir: URL { home.appending(path: ".codex-watchd") }
    var logURL: URL { configDir.appending(path: "daemon.log") }
    private var plistURL: URL {
        home.appending(path: "Library/LaunchAgents/\(label).plist")
    }

    var health: Health {
        guard let s = status else { return .stopped }
        // 中继没配就是纯本地用法，不该因此报警；配了却没连上才是异常
        let relayBad = s.relay.configured && !s.relay.connected
        let controlBad = s.control.enabled && !s.control.appServerUp
        return (relayBad || controlBad) ? .degraded : .healthy
    }

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // MARK: - 轮询

    func refresh() {
        launchdInstalled = FileManager.default.fileExists(atPath: plistURL.path)
        Task {
            async let loaded = Self.run("/bin/launchctl", ["print", "gui/\(getuid())/\(label)"]).code == 0
            async let fetched = fetchStatus()
            self.launchdLoaded = await loaded
            self.status = await fetched
        }
    }

    /// 读本机主 token。菜单栏 App 与 daemon 同用户，直接读配置文件即可。
    private func readToken() -> String? {
        guard let data = try? Data(contentsOf: configDir.appending(path: "auth.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let devices = obj["devices"] as? [[String: Any]] else { return nil }
        let local = devices.first { $0["id"] as? String == "local" } ?? devices.first
        return local?["token"] as? String
    }

    private func fetchStatus() async -> DaemonStatus? {
        guard let token = readToken() else {
            lastError = "读不到 ~/.codex-watchd/auth.json"
            return nil
        }
        // 端口固定 8787（install-launchd.sh 写死的值）；超时给短一点，
        // daemon 没跑时不该让面板卡住
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8787/status")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 1.5
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            lastError = nil
            return try JSONDecoder().decode(DaemonStatus.self, from: data)
        } catch {
            return nil          // 连不上就是没跑，不当作错误展示
        }
    }

    // MARK: - 开关

    func start() {
        guard launchdInstalled else {
            lastError = "尚未安装 launchd 服务，先跑 scripts/install-launchd.sh"
            return
        }
        perform(["bootstrap", "gui/\(getuid())", plistURL.path])
    }

    func stop() {
        // launchd 托管的必须走 bootout —— 直接 kill 会被 KeepAlive 立刻拉起来。
        // 手动起的实例（start.sh）没有 launchd 记录，只能按 pid 发信号。
        if launchdLoaded {
            perform(["bootout", "gui/\(getuid())/\(label)"])
        } else if let pid = status?.pid {
            busy = true
            Task {
                _ = await Self.run("/bin/kill", [String(pid)])
                try? await Task.sleep(for: .seconds(1))
                busy = false
                refresh()
            }
        }
    }

    func restart() {
        guard launchdLoaded else { return }
        perform(["kickstart", "-k", "gui/\(getuid())/\(label)"])
    }

    private func perform(_ args: [String]) {
        busy = true
        Task {
            let r = await Self.run("/bin/launchctl", args)
            // bootout 在服务本来就没跑时返回非 0，这不算失败
            if r.code != 0, !r.err.contains("No such process") {
                lastError = r.err.isEmpty ? "launchctl 退出码 \(r.code)" : r.err
            } else {
                lastError = nil
            }
            try? await Task.sleep(for: .seconds(1))
            busy = false
            refresh()
        }
    }

    private static func run(_ path: String, _ args: [String]) async -> (code: Int32, err: String) {
        await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: path)
                p.arguments = args
                let errPipe = Pipe()
                p.standardError = errPipe
                p.standardOutput = Pipe()
                do { try p.run() } catch {
                    cont.resume(returning: (-1, error.localizedDescription)); return
                }
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                let msg = String(data: errData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                cont.resume(returning: (p.terminationStatus, msg))
            }
        }
    }

    // MARK: - 便捷动作

    /// 调试页需要 token，拼进 URL 直接打开
    func debugPageURL() -> URL? {
        guard let token = readToken(),
              let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return URL(string: "http://127.0.0.1:8787/?token=\(encoded)")
    }

    /// 日志尾部若干行，面板里直接看得到，不用去开终端
    func logTail(lines: Int = 12) -> String {
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return "（暂无日志）" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = 16_000
        try? handle.seek(toOffset: size > window ? size - window : 0)
        let data = (try? handle.readToEnd()) ?? Data()
        // 日志里有 ANSI 颜色码，直接显示会是一堆乱码
        let text = String(data: data, encoding: .utf8) ?? ""
        let clean = text.replacingOccurrences(
            of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        return clean.split(separator: "\n").suffix(lines).joined(separator: "\n")
    }
}
