import Foundation
import CryptoKit
import Security

/// 配对信息持久化。token 是访问凭证，必须进 Keychain，不能落 UserDefaults。
enum PairingStore {
    private static let service = "com.apiagentcontrol.pairing"
    private static let account = "default"

    static func save(_ p: PairingPayload) throws {
        let data = try JSONEncoder().encode(p)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        // 仅本机、解锁后可读；不参与 iCloud 同步
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: "keychain", code: Int(status)) }
    }

    static func load() -> PairingPayload? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(PairingPayload.self, from: data)
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}

enum ConnectionState: Equatable {
    case idle, connecting, connected, hostOffline
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "未连接"
        case .connecting: return "连接中…"
        case .connected: return "已连接"
        case .hostOffline: return "电脑离线"
        case .failed(let m): return "连接失败：\(m)"
        }
    }
    var isUsable: Bool { self == .connected }
}

/// 与中继的连接：WebSocket + 端到端加密的请求/响应/事件推送。
@MainActor
final class RelayClient: NSObject, ObservableObject {
    @Published private(set) var state: ConnectionState = .idle
    @Published private(set) var lastError: String?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var crypto: SessionCrypto?
    private var pairing: PairingPayload?
    private var pending: [String: CheckedContinuation<(Int, Data), Error>] = [:]
    private var reconnectDelay: TimeInterval = 1
    private var shouldReconnect = true

    var onEvent: ((AgentEvent) -> Void)?

    /// 本机的中继公钥。daemon 用它找到与本设备协商的密钥来加密推送内容。
    var myPublicKey: String? { crypto?.myPublicKeySPKI }

    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect(_ p: PairingPayload) {
        pairing = p
        shouldReconnect = true
        do { crypto = try SessionCrypto(hostPublicKeySPKI: p.hostKey, roomId: p.room) }
        catch { state = .failed(error.localizedDescription); return }
        openSocket()
    }

    func disconnect() {
        shouldReconnect = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .idle
    }

    private func openSocket() {
        guard let p = pairing, var comps = URLComponents(string: p.relay) else { return }
        // 中继地址用 ws/wss，URLSession 直接支持
        var items = [URLQueryItem(name: "room", value: p.room), URLQueryItem(name: "role", value: "client")]
        if let s = p.secret { items.append(URLQueryItem(name: "secret", value: s)) }
        comps.queryItems = items
        guard let url = comps.url else { state = .failed("中继地址无效"); return }

        state = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case .failure(let err):
                    self.handleDisconnect(err.localizedDescription)
                case .success(let msg):
                    if case .string(let text) = msg { self.handleFrame(text) }
                    else if case .data(let d) = msg, let s = String(data: d, encoding: .utf8) { self.handleFrame(s) }
                    self.receiveLoop()
                }
            }
        }
    }

    private func handleDisconnect(_ reason: String) {
        for (_, c) in pending { c.resume(throwing: RelayError.disconnected) }
        pending.removeAll()
        task = nil
        guard shouldReconnect else { return }
        state = .failed(reason)
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30)
        Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if self.shouldReconnect && self.task == nil { self.openSocket() }
        }
    }

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONDecoder().decode(RelayFrame.self, from: data) else { return }

        // 中继自身的明文状态通知
        if let type = frame.type, frame.env == nil {
            switch type {
            case "host_online": state = .connected; reconnectDelay = 1
            case "host_offline": state = .hostOffline
            default: break
            }
            return
        }
        guard let env = frame.env, let crypto else { return }
        guard let plain = try? crypto.open(env) else {
            lastError = "收到无法解密的消息"
            return
        }
        guard let resp = try? JSONDecoder().decode(RelayResponse.self, from: plain) else { return }

        if resp.type == "event", let ev = resp.event {
            onEvent?(ev)
            return
        }
        if let id = resp.id, let cont = pending.removeValue(forKey: id) {
            // 把 body 原样回传给调用方自行解码
            let bodyData = extractBody(from: plain)
            cont.resume(returning: (resp.status ?? 0, bodyData))
        }
    }

    /// 从解密后的响应里取出 body 的原始 JSON 片段。
    ///
    /// body 不一定是字典：daemon 侧解析失败时会原样回传字符串（如 404 的纯文本 "not found"）。
    /// `JSONSerialization.data(withJSONObject:)` 对非字典/数组的顶层类型抛的是
    /// **ObjC 异常**，Swift 的 try 拦不住，会直接崩溃 —— 必须先用 isValidJSONObject 挡掉。
    private func extractBody(from plain: Data) -> Data {
        guard let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let body = obj["body"] else { return Data() }
        if JSONSerialization.isValidJSONObject(body),
           let d = try? JSONSerialization.data(withJSONObject: body) {
            return d
        }
        // 标量（字符串/数字）包成合法 JSON 再回传，让上层能读到错误文本
        if let d = try? JSONSerialization.data(withJSONObject: [body], options: .fragmentsAllowed),
           d.count > 2 {
            return d.subdata(in: 1..<(d.count - 1))
        }
        return Data()
    }

    // MARK: - 请求

    enum RelayError: Error, LocalizedError {
        case notConnected, disconnected, timeout
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .notConnected: return "尚未连接"
            case .disconnected: return "连接已断开"
            case .timeout: return "请求超时"
            case .http(let c, let m): return "请求失败（\(c)）：\(m)"
            }
        }
    }

    @discardableResult
    func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        guard let crypto, let p = pairing, let task else { throw RelayError.notConnected }
        let id = UUID().uuidString.prefix(8).lowercased()

        var payload: [String: Any] = ["id": id, "method": method, "path": path, "token": p.token]
        if let body { payload["body"] = body }
        let plain = try JSONSerialization.data(withJSONObject: payload)
        let box = try AES.GCM.seal(plain, using: crypto.key)
        let env = Envelope(iv: B64URL.encode(Data(box.nonce)),
                           ct: B64URL.encode(box.ciphertext),
                           tag: B64URL.encode(box.tag))
        let frame = RelayFrame(from: crypto.myPublicKeySPKI, to: nil, env: env, type: nil)
        let text = String(data: try JSONEncoder().encode(frame), encoding: .utf8)!

        let (status, data): (Int, Data) = try await withCheckedThrowingContinuation { cont in
            pending[String(id)] = cont
            task.send(.string(text)) { [weak self] err in
                if let err {
                    Task { @MainActor in
                        self?.pending.removeValue(forKey: String(id))?.resume(throwing: err)
                    }
                }
            }
            // 超时兜底，避免界面无限等待
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                self?.pending.removeValue(forKey: String(id))?.resume(throwing: RelayError.timeout)
            }
        }

        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw RelayError.http(status, msg ?? "未知错误")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let data = try await request("GET", path)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

extension RelayClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didOpenWithProtocol proto: String?) {
        Task { @MainActor in
            self.reconnectDelay = 1
            // 等中继发来 host_online 才算真正可用
            if self.state == .connecting { self.state = .hostOffline }
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor in self.handleDisconnect("连接被关闭") }
    }
}
