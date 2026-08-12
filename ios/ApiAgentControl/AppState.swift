import Foundation
import SwiftUI
import Combine

/// 全局状态：连接、会话列表、事件缓冲、待审批。
@MainActor
final class AppState: ObservableObject {
    @Published var pairing: PairingPayload?
    @Published var projects: [ProjectGroup] = []
    @Published var sessions: [String: Session] = [:]
    @Published var events: [String: [AgentEvent]] = [:]     // sessionId -> 事件
    @Published var approvals: [PendingApproval] = []
    @Published var loading = false
    @Published var errorMessage: String?

    let relay = RelayClient()
    let push = PushManager()

    /// 把 APNs device token 交给 daemon。同时带上本机的中继公钥，
    /// 因为推送内容要用与这台设备协商的会话密钥加密。
    func registerPushToken(_ token: String) async {
        guard relay.state.isUsable else { return }
        var body: [String: Any] = ["token": token]
        if let pk = relay.myPublicKey { body["peerKey"] = pk }
        _ = try? await relay.request("POST", "/devices/push-token", body: body)
    }

    /// 服务端确认的当前档位。配对串里的只是**配对那一刻的快照** ——
    /// 凭证可能已被吊销或调降，一直信任本地快照会让界面显示自己其实没有的权限。
    @Published var serverScope: Scope?
    /// 凭证失效（401/403）。必须让用户看见，否则界面会停在旧数据上装作一切正常。
    @Published var authFailed = false

    var scope: Scope { serverScope ?? Scope(rawValue: pairing?.scope ?? "read") ?? .read }
    var connection: ConnectionState { relay.state }

    /// 待审批。字段由 daemon 归一化后下发 —— 手机上必须看得见要执行什么、
    /// 在哪个目录、为什么要权限，否则就是盲批。
    struct PendingApproval: Identifiable, Equatable {
        let id: String
        let sessionId: String?
        let method: String?
        let receivedAt: Date
        var kind: String?          // exec / file_change / permissions / user_input
        var title: String?
        var command: String?
        var summary: String?
        var cwd: String?
        var reason: String?
        var network: String?

        var displayTitle: String { title ?? "需要审批" }
        var body: String? { command ?? summary }
        var icon: String {
            switch kind {
            case "file_change": return "doc.badge.gearshape"
            case "permissions": return "lock.shield"
            case "user_input": return "text.cursor"
            default: return "terminal"
            }
        }
        /// 涉及网络访问的要额外提醒 —— 风险档次不同
        var hasNetwork: Bool { network != nil }
    }

    private var cancellables = Set<AnyCancellable>()

    init() {
        relay.onEvent = { [weak self] ev in self?.ingest(ev) }

        // 嵌套 ObservableObject 的变化不会自动向上传播：relay.state 更新时
        // 观察 AppState 的视图不会重绘，界面会一直停在"连接中"。必须手动转发。
        relay.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // 连接可用时自动拉一次数据，否则要等用户手动下拉
        relay.$state
            .removeDuplicates()
            .sink { [weak self] st in
                guard st.isUsable else { return }
                Task { await self?.refresh() }
            }
            .store(in: &cancellables)

        if let p = PairingStore.load() {
            pairing = p
            relay.connect(p)
        }
    }

    // MARK: - 配对

    func pair(with uri: String) throws {
        let p = try PairingPayload.parse(uri)
        try PairingStore.save(p)
        pairing = p
        relay.connect(p)
    }

    /// 用户主动重连。自动重试只覆盖瞬时抖动，连续失败后由用户决定何时再试。
    func reconnect() {
        errorMessage = nil
        relay.reconnect()
        Task { await refresh() }
    }

    func unpair() {
        relay.disconnect()
        PairingStore.clear()
        pairing = nil
        projects = []; sessions = [:]; events = [:]; approvals = []
    }

    // MARK: - 数据加载

    struct Me: Decodable { let deviceId: String; let name: String; let scope: String }

    func refresh() async {
        guard relay.state.isUsable else { return }
        loading = true
        defer { loading = false }
        do {
            // 先确认凭证与当前档位，再拉数据 —— 凭证失效时要立刻让用户知道
            let me = try await relay.get("/me", as: Me.self)
            serverScope = Scope(rawValue: me.scope)
            authFailed = false

            let groups = try await relay.get("/projects?days=30", as: [ProjectGroup].self)
            // 服务端的会话数据是快照；本地事件流可能更新，合并时不要覆盖已有的实时状态
            for g in groups {
                for s in g.sessions where sessions[s.id] == nil { sessions[s.id] = s }
            }
            projects = groups
            rebuildProjects()
            await loadApprovals()
            errorMessage = nil
        } catch {
            handle(error)
        }
    }

    /// 统一的错误落点。401/403 是"凭证不再有效"，与网络抖动性质不同，要单独呈现。
    private func handle(_ error: Error) {
        if case RelayClient.RelayError.http(let code, _) = error, code == 401 || code == 403 {
            authFailed = true
            errorMessage = code == 401 ? "配对凭证已失效，请重新配对" : "当前设备权限不足"
            if code == 401 { serverScope = nil }
        } else {
            errorMessage = error.localizedDescription
        }
    }

    func loadApprovals() async {
        struct Raw: Decodable {
            let id: String
            let method: String?
            let sessionId: String?
            let approvalKind: String?
            let title: String?
            let command: String?
            let summary: String?
            let cwd: String?
            let reason: String?
            let network: String?
            enum CodingKeys: String, CodingKey {
                case id, method, approvalKind, title, command, summary, cwd, reason, network
                case sessionId = "session_id"
            }
        }
        guard let list = try? await relay.get("/approvals", as: [Raw].self) else { return }
        let known = Set(approvals.map(\.id))
        for r in list where !known.contains(r.id) {
            approvals.append(.init(id: r.id, sessionId: r.sessionId, method: r.method,
                                   receivedAt: Date(), kind: r.approvalKind, title: r.title,
                                   command: r.command, summary: r.summary,
                                   cwd: r.cwd, reason: r.reason, network: r.network))
        }
        // 服务端已不存在的审批要清掉（可能已在电脑上处理）
        let live = Set(list.map(\.id))
        approvals.removeAll { !live.contains($0.id) }
    }

    struct HistoryPage: Decodable {
        let events: [AgentEvent]
        let nextBefore: Int?
        let hasMore: Bool
    }

    /// 每个会话最早已加载到的游标；nil 表示还没加载过历史
    @Published var historyCursor: [String: Int] = [:]
    @Published var historyExhausted: Set<String> = []
    @Published var loadingHistory: Set<String> = []

    /// 进入会话时清零未读。此前只增不减，看过也一直挂红点。
    func markRead(_ sessionId: String) async {
        guard relay.state.isUsable else { return }
        sessions[sessionId]?.unread = 0
        rebuildProjects()
        _ = try? await relay.request("POST", "/sessions/\(sessionId)/read")
    }

    /// 加载更早的历史。首次进入会话时调用（before=nil 取最新一页），
    /// 之后上滑到顶继续调用以翻页。
    func loadHistory(_ sessionId: String, older: Bool = false) async {
        guard relay.state.isUsable, !loadingHistory.contains(sessionId) else { return }
        if older && historyExhausted.contains(sessionId) { return }
        loadingHistory.insert(sessionId)
        defer { loadingHistory.remove(sessionId) }

        var path = "/sessions/\(sessionId)/history?limit=80"
        if older, let cur = historyCursor[sessionId] { path += "&before=\(cur)" }
        guard let data = try? await relay.request("GET", path),
              let page = try? JSONDecoder().decode(HistoryPage.self, from: data) else { return }

        merge(page.events, into: sessionId)
        if let nb = page.nextBefore { historyCursor[sessionId] = nb }
        if !page.hasMore { historyExhausted.insert(sessionId) }
    }

    /// 按 seq 合并去重并保持时间顺序 —— 历史页与实时流会有重叠
    private func merge(_ incoming: [AgentEvent], into sessionId: String) {
        var byId: [String: AgentEvent] = [:]
        for e in events[sessionId] ?? [] { byId[e.id] = e }
        for e in incoming { byId[e.id] = e }
        events[sessionId] = byId.values.sorted {
            ($0.seq ?? Int.max, $0.ts ?? "") < ($1.seq ?? Int.max, $1.ts ?? "")
        }
    }

    // MARK: - 事件接入

    private func ingest(_ ev: AgentEvent) {
        guard let sid = ev.sessionId else { return }
        // 用 id（含 seq）去重：断线重连时 daemon 会重推部分事件，直接 append 会出现重复气泡
        var list = events[sid] ?? []
        if !list.contains(where: { $0.id == ev.id }) {
            list.append(ev)
            if list.count > 1000 { list.removeFirst(list.count - 1000) }
            events[sid] = list
        }

        // 会话状态机（与 daemon 侧保持一致，保证离线时 UI 也能自洽）
        var s = sessions[sid] ?? Session(id: sid)
        s.lastActivity = ev.ts
        switch ev.kind {
        case "user_message": s.status = "running"; s.lastUserMessage = ev.text
        case "turn_started": s.status = "running"
        case "assistant_message":
            s.lastAssistantMessage = ev.text
            s.unread = (s.unread ?? 0) + 1
        case "turn_complete": s.status = "idle"; s.pendingApproval = nil
        case "turn_aborted": s.status = "aborted"
        case "approval_request":
            s.status = "waiting_approval"
            s.pendingApproval = ev.approvalId
            if let id = ev.approvalId, !approvals.contains(where: { $0.id == id }) {
                approvals.append(.init(id: id, sessionId: sid, method: ev.method,
                                       receivedAt: Date(), kind: ev.approvalKind,
                                       title: ev.title, command: ev.command, summary: ev.summary,
                                       cwd: ev.cwd, reason: ev.reason, network: ev.network))
            }
        case "approval_resolved":
            s.pendingApproval = nil
            approvals.removeAll { $0.id == ev.approvalId }
        case "session_meta":
            s.cwd = ev.text
        case "thread_status":
            // 与 daemon 侧保持一致：等审批和等回文字是两种待办，UI 动作不同
            if ev.waitingOnApproval == true { s.status = "waiting_approval" }
            else if ev.waitingOnUserInput == true { s.status = "waiting_input" }
            else if ev.status == "idle" && s.status != "aborted" { s.status = "idle" }
        default: break
        }
        let isNew = sessions[sid] == nil
        sessions[sid] = s
        // 新会话不在任何分组里，向 daemon 重取一次结构（它知道该放进哪个项目）
        if isNew || hasUngrouped(sid) {
            scheduleStructureRefresh()
        } else {
            rebuildProjects()
        }
    }

    private var structureRefreshTask: Task<Void, Never>?

    /// 合并短时间内的多次请求，避免一轮对话里连着拉好几次
    private func scheduleStructureRefresh() {
        rebuildProjects()
        structureRefreshTask?.cancel()
        structureRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// 就地刷新分组里的会话数据与计数。
    ///
    /// 分组骨架（置顶 / 项目 / 最近，以及置顶内的顺序）来自 daemon，它读的是
    /// Codex Desktop 侧栏里用户自己整理的结构。这里**不能**在本地重新分组，
    /// 否则用户排的置顶顺序和项目归属会被冲掉。
    private func rebuildProjects() {
        projects = projects.map { group in
            var g = group
            g.sessions = group.sessions.compactMap { sessions[$0.id] }
            if !g.preservesOrder {
                g.sessions.sort { sortKey($0) < sortKey($1) }
            }
            g.attention = g.sessions.filter { $0.state == .waitingApproval }.count
            g.running = g.sessions.filter { $0.state == .running }.count
            g.lastActivity = g.sessions.map(\.recency).max()
            return g
        }
    }

    /// 状态优先于时间：等审批的排最前，其次运行中，最后才按最近活动
    private func sortKey(_ s: Session) -> String {
        let recency = s.recency.isEmpty ? "0" : s.recency
        return "\(s.state.priority)-\(String(recency.reversed()))"
    }

    /// 出现了任何分组里都没有的新会话时，需要向 daemon 重新要一次结构
    private func hasUngrouped(_ sessionId: String) -> Bool {
        !projects.contains { $0.sessions.contains { $0.id == sessionId } }
    }

    // MARK: - 操作

    func decide(_ approvalId: String, _ decision: String) async {
        approvals.removeAll { $0.id == approvalId }
        do {
            _ = try await relay.request("POST", "/approvals/\(approvalId)", body: ["decision": decision])
        } catch {
            handle(error)
            await loadApprovals()   // 失败则把审批放回列表，不能让它凭空消失
        }
    }

    func send(_ sessionId: String, text: String) async {
        do {
            _ = try await relay.request("POST", "/threads/\(sessionId)/turns", body: ["text": text])
        } catch {
            handle(error)
        }
    }

    func interrupt(_ sessionId: String) async {
        do {
            _ = try await relay.request("POST", "/threads/\(sessionId)/interrupt")
        } catch {
            handle(error)
        }
    }

    /// 所有「在等我」的会话：等审批的 + 等我回文字的
    var allAttention: [Session] {
        sessions.values.filter { $0.state.needsAttention }
            .sorted { ($0.state.priority, $1.recency) < ($1.state.priority, $0.recency) }
    }

    /// 等着我回文字的会话（首页要能直接回，不必点进去）
    var awaitingReply: [Session] {
        sessions.values.filter { $0.state == .waitingInput }
            .sorted { $0.recency > $1.recency }
    }
}
