import Foundation

// MARK: - 配对

/// 配对串 `apiagentcontrol://pair?d=<base64url>` 解出的内容
struct PairingPayload: Codable {
    let v: Int
    let relay: String
    let room: String
    let hostKey: String
    let token: String
    let scope: String
    let secret: String?

    static func parse(_ uri: String) throws -> PairingPayload {
        // 手机输入法会插入空格、换行甚至智能标点，粘贴来源也常带首尾空白。
        // 载荷是 base64url，本身不含空白字符，所以直接全部剔除最稳妥。
        let cleaned = uri.filter { !$0.isWhitespace }
        // 直接取 d= 之后的部分，避免 URLComponents 对自定义 scheme 的解析差异
        guard let range = cleaned.range(of: "d=") else { throw PairingError.malformed }
        let payload = String(cleaned[range.upperBound...])
        guard !payload.isEmpty, let raw = B64URL.decode(payload) else { throw PairingError.malformed }
        let p = try JSONDecoder().decode(PairingPayload.self, from: raw)
        // 中继地址必须在这里就校验：坏地址一旦存进 Keychain，之后每次启动
        // 自动重连都会在 webSocketTask 上崩掉（ObjC 异常拦不住），app 直接废掉。
        guard RelayClient.websocketURL(from: p.relay) != nil else { throw PairingError.badRelay(p.relay) }
        return p
    }
}

enum PairingError: Error, LocalizedError {
    case malformed
    case badRelay(String)
    var errorDescription: String? {
        switch self {
        case .malformed: return "配对串格式不正确"
        case .badRelay(let r):
            return "中继地址无效（\(r)）：需要 ws:// 或 wss:// 开头。请在电脑端检查 --relay 参数后重新生成配对码"
        }
    }
}

/// 权限档位。风险差一个数量级，UI 上要如实呈现。
enum Scope: String, Codable {
    case read, approve, control

    var label: String {
        switch self {
        case .read: return "只读"
        case .approve: return "可审批"
        case .control: return "完全控制"
        }
    }
    var canApprove: Bool { self != .read }
    var canControl: Bool { self == .control }
}

// MARK: - 会话

/// 与 daemon `/sessions` 返回结构对应。字段大多可选，因为会话元数据是逐步补全的。
struct Session: Codable, Identifiable, Equatable {
    let id: String
    var title: String?
    var status: String?
    var project: String?
    var worktree: String?
    var cwd: String?
    var originator: String?
    var model: String?
    var lastActivity: String?
    var updatedAt: String?
    var lastUserMessage: String?
    var lastAssistantMessage: String?
    var unread: Int?
    var pendingApproval: String?
    var archived: Bool?
    /// signal = 协议给出的确定信号；inferred = 从最后一句话推断出来的
    var waitingReason: String?

    /// 会话的写锁被谁占着。Codex 同一会话只允许一个写入方，
    /// 被电脑上的 Desktop 占着时手机发不了指令 —— 提前告诉用户，
    /// 而不是等他打完一长段字才吃 409。
    var locked: Bool?
    /// `self` = 本 daemon 正在跑手机发起的任务（转瞬即释，不用拦）
    /// `other` = 电脑上的 Codex Desktop 占着
    var lockedBy: String?

    /// 手机现在能不能往这条会话发指令
    var blockedByDesktop: Bool { locked == true && lockedBy == "other" }

    var displayTitle: String { title ?? String(id.suffix(8)) }
    var state: SessionState { SessionState(rawValue: status ?? "idle") ?? .idle }
    var recency: String { lastActivity ?? updatedAt ?? "" }
}

enum SessionState: String {
    case running
    case waitingApproval = "waiting_approval"
    /// 模型用文字问了你，正等一条文字回复。协议上没有任何请求，只是线程状态变了，
    /// 但这是实际使用中最常见的「卡住等我」—— 比结构化审批常见得多。
    case waitingInput = "waiting_input"
    case idle, aborted, error

    var label: String {
        switch self {
        case .running: return "进行中"
        case .waitingApproval: return "等待审批"
        case .waitingInput: return "等你回复"
        case .idle: return "空闲"
        case .aborted: return "已中止"
        case .error: return "出错"
        }
    }
    var needsAttention: Bool { self == .waitingApproval || self == .waitingInput }

    /// 排序权重：需要用户处理的排最前，时间只是次级排序
    var priority: Int {
        switch self {
        case .waitingApproval: return 0
        case .waitingInput: return 1
        case .running: return 2
        case .error, .aborted: return 3
        case .idle: return 4
        }
    }
}

struct ProjectGroup: Codable, Identifiable, Equatable {
    let project: String
    var kind: String?          // pinned / project / recent，对应 Desktop 侧栏三段
    var projectId: String?
    var sessions: [Session]
    var attention: Int
    var running: Int
    var lastActivity: String?

    var id: String { project }

    var icon: String {
        switch kind {
        case "pinned": return "pin.fill"
        case "recent": return "clock"
        default: return "folder"
        }
    }
    /// 置顶是用户自己排的顺序，不能按时间重排
    var preservesOrder: Bool { kind == "pinned" }
}

// MARK: - 事件

/// daemon 归一化后的事件。详情页按重要性分级呈现。
struct AgentEvent: Codable, Identifiable, Equatable {
    /// seq 是事件在会话文件中的字节偏移量，历史回填与实时流共用同一套游标，
    /// 用它做 id 就能天然去重（断线重连后重复推送的事件不会重复渲染）
    var id: String {
        if let seq { return "\(sessionId ?? "")-\(seq)" }
        return "\(ts ?? "")-\(kind)-\(sessionId ?? "")-\(text?.prefix(24) ?? "")-\(name ?? "")"
    }

    let seq: Int?
    let ts: String?
    let sessionId: String?
    let kind: String
    let text: String?
    let name: String?
    let args: String?
    let output: String?
    let model: String?
    let approvalId: String?
    let method: String?
    // 审批请求携带的可读字段（由 daemon 归一化）
    let title: String?
    let command: String?
    let summary: String?
    let cwd: String?
    let reason: String?
    let network: String?
    let approvalKind: String?
    // thread_status 事件携带
    let status: String?
    let waitingOnUserInput: Bool?
    let waitingOnApproval: Bool?

    enum CodingKeys: String, CodingKey {
        case seq, ts, kind, text, name, args, output, model, method
        case title, command, summary, cwd, reason, network, approvalKind
        case status, waitingOnUserInput, waitingOnApproval
        case sessionId = "session_id"
        case approvalId = "approval_id"
    }

    /// 呈现层级 —— 实测一个 turn 里 reasoning 9 条、工具 12 条，而 assistant_message 只有 2 条，
    /// 噪音是信号的 10 倍，必须分级，否则手机上根本没法看。
    enum Tier { case primary, progress, internalDetail, status, blocking, hidden }

    var tier: Tier {
        switch kind {
        case "user_message", "assistant_message": return .primary
        case "tool_call", "tool_result": return .progress
        case "reasoning": return .internalDetail
        case "approval_request": return .blocking
        case "turn_started", "turn_complete", "turn_aborted", "turn_context", "session_meta", "compacted": return .status
        default: return .hidden
        }
    }

    var time: String { ts.map { String($0.dropFirst(11).prefix(8)) } ?? "" }
}

// MARK: - 中继协议

struct RelayRequest: Encodable {
    let id: String
    let method: String
    let path: String
    let token: String
    var body: [String: AnyEncodable]?
}

struct RelayResponse: Decodable {
    let type: String?
    let id: String?
    let status: Int?
    let body: AnyDecodable?
    let event: AgentEvent?
}

/// 中继转发的外层信封
struct RelayFrame: Codable {
    var from: String?
    var to: String?
    var env: Envelope?
    var type: String?
}

// MARK: - 任意 JSON 编解码辅助

struct AnyEncodable: Encodable {
    let value: Any
    init(_ v: Any) { value = v }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let v as String: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as Bool: try c.encode(v)
        case let v as [String: Any]: try c.encode(v.mapValues(AnyEncodable.init))
        case let v as [Any]: try c.encode(v.map(AnyEncodable.init))
        default: try c.encodeNil()
        }
    }
}

@dynamicMemberLookup
struct AnyDecodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode([String: AnyDecodable].self) { value = v.mapValues(\.value) }
        else if let v = try? c.decode([AnyDecodable].self) { value = v.map(\.value) }
        else { value = NSNull() }
    }
    subscript(dynamicMember key: String) -> Any? { (value as? [String: Any])?[key] }
}
