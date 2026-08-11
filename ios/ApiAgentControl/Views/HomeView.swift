import SwiftUI

/// 第 1 层 · 首页：按项目分组，顶部固定「需要我处理」。
///
/// 用户打开 App 的第一诉求就是"有没有事等我"，不应该要求他逐个项目点进去找，
/// 所以待审批的会话跨项目聚合在最上面。
struct HomeView: View {
    @EnvironmentObject var app: AppState
    @EnvironmentObject var push: PushManager
    @State private var showSettings = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                // 错误必须看得见。此前 errorMessage 只赋值不渲染，
                // 凭证失效后界面停在旧数据上，看起来一切正常，实则早已失联。
                if let msg = app.errorMessage {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(msg, systemImage: app.authFailed ? "exclamationmark.lock" : "exclamationmark.triangle")
                                .font(.subheadline)
                                .foregroundStyle(app.authFailed ? .red : .orange)
                            if app.authFailed {
                                Button("重新配对") { app.unpair() }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.small)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                if !app.approvals.isEmpty || !app.awaitingReply.isEmpty {
                    Section {
                        ForEach(app.approvals) { ap in
                            ApprovalCard(approval: ap)
                        }
                        // 模型用文字问你、等一条文字回复 —— 实测比结构化审批常见得多，
                        // 首页要能直接回，不必点进会话
                        ForEach(app.awaitingReply) { s in
                            ReplyCard(session: s)
                        }
                    } header: {
                        Label("需要我处理", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                ForEach(app.projects) { group in
                    Section {
                        ForEach(group.sessions) { s in
                            NavigationLink(value: s.id) {
                                SessionRow(session: s)
                            }
                        }
                    } header: {
                        HStack(spacing: 4) {
                            Image(systemName: group.icon).font(.caption2)
                            Text(group.project)
                            Spacer()
                            if group.attention > 0 {
                                Label("\(group.attention)", systemImage: "lock.fill")
                                    .foregroundStyle(.orange)
                            }
                            if group.running > 0 {
                                Label("\(group.running)", systemImage: "play.fill")
                                    .foregroundStyle(.blue)
                            }
                        }
                        .font(.caption)
                    }
                }

                if app.projects.isEmpty && !app.loading {
                    ContentUnavailableView(
                        "暂无会话",
                        systemImage: "tray",
                        description: Text(app.connection.isUsable
                                          ? "电脑上还没有近期活动的会话"
                                          : app.connection.label)
                    )
                }
            }
            .navigationTitle("Codex")
            .navigationDestination(for: String.self) { id in
                SessionDetailView(sessionId: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionBadge(state: app.connection) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .refreshable { await app.refresh() }
            .task { await app.refresh() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            // 点通知 → 直接进对应会话。通知里只有会话 id（没有内容），
            // 内容由 App 进去后经加密通道取。
            .onChange(of: push.pendingSessionId) { _, sid in
                guard let sid else { return }
                path = NavigationPath()
                path.append(sid)
                push.pendingSessionId = nil
                Task { await app.loadHistory(sid) }
            }
        }
    }
}

struct ConnectionBadge: View {
    let state: ConnectionState
    var body: some View {
        HStack(spacing: 4) {
            Circle().frame(width: 8, height: 8).foregroundStyle(color)
            Text(state.label).font(.caption2)
        }
        .foregroundStyle(.secondary)
    }
    private var color: Color {
        switch state {
        case .connected: return .green
        case .connecting: return .yellow
        case .hostOffline: return .orange
        case .idle: return .gray
        case .failed: return .red
        }
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                StatusBadge(state: session.state)
                Text(session.displayTitle)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer()
                if let n = session.unread, n > 0 {
                    Text("\(n)")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.tint, in: Capsule())
                        .foregroundStyle(.white)
                }
            }
            if let last = session.lastAssistantMessage ?? session.lastUserMessage {
                Text(last).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 8) {
                if let wt = session.worktree {
                    Label(wt, systemImage: "arrow.triangle.branch")
                }
                if let o = session.originator {
                    Text(o)
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let state: SessionState
    var body: some View {
        Text(state.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(bg.opacity(0.2), in: RoundedRectangle(cornerRadius: 4))
            .foregroundStyle(bg)
    }
    private var bg: Color {
        switch state {
        case .running: return .blue
        case .waitingApproval: return .orange
        case .waitingInput: return .orange
        case .idle: return .secondary
        case .aborted: return .brown
        case .error: return .red
        }
    }
}

/// 「等你回文字」卡片。
///
/// Codex 经常不是发结构化审批请求，而是直接用文字问你（"请确认按以下目标执行…"），
/// 然后结束这一轮等你回复。协议上这只体现为线程的 `waitingOnUserInput` 标志，
/// 没有任何请求可以「批准」—— 只能回文字。所以这里给的是输入框而不是允许/拒绝。
struct ReplyCard: View {
    @EnvironmentObject var app: AppState
    let session: Session
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                Text("等你回复").font(.subheadline.bold())
                if session.waitingReason == "inferred" {
                    Text("推测").font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.secondary.opacity(0.15), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(session.displayTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .foregroundStyle(.orange)

            // 把模型最后说的话带出来，否则不点进去根本不知道它在问什么
            if let last = session.lastAssistantMessage, !last.isEmpty {
                Text(last)
                    .font(.caption)
                    .lineLimit(6)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }

            if app.scope.canControl {
                HStack(spacing: 8) {
                    TextField("回复…", text: $text, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                        .focused($focused)
                    Button {
                        let t = text; text = ""; focused = false; sending = true
                        Task { await app.send(session.id, text: t); sending = false }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sending || !app.connection.isUsable)
                }
            } else {
                Text("当前设备权限为「\(app.scope.label)」，无法回复。需要「完全控制」档位。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

/// 审批卡片 —— 整个产品最有价值的交互：人不在电脑前也能放行卡住的会话。
struct ApprovalCard: View {
    @EnvironmentObject var app: AppState
    let approval: AppState.PendingApproval
    @State private var busy = false

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: approval.icon)
                Text(approval.displayTitle).font(.subheadline.bold())
                if approval.hasNetwork {
                    Label("联网", systemImage: "network")
                        .font(.caption2.bold())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.red.opacity(0.15), in: Capsule())
                        .foregroundStyle(.red)
                }
                Spacer()
                if let s = app.sessions[approval.sessionId ?? ""] {
                    Text(s.displayTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .foregroundStyle(.orange)

            // 要批准什么，必须看得见 —— 盲批比不批更危险
            if let body = approval.body, !body.isEmpty {
                Text(body)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(expanded ? nil : 6)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                    .onTapGesture { withAnimation { expanded.toggle() } }
            }
            if let reason = approval.reason, !reason.isEmpty {
                Label(reason, systemImage: "info.circle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let cwd = approval.cwd, !cwd.isEmpty {
                Label(cwd, systemImage: "folder")
                    .font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
            }
            if app.scope.canApprove {
                HStack {
                    Button("允许") { decide("allow") }
                        .buttonStyle(.borderedProminent)
                    Button("始终允许") { decide("allow_always") }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("拒绝", role: .destructive) { decide("deny") }
                        .buttonStyle(.bordered)
                }
                .font(.caption)
                .disabled(busy || app.authFailed)
            } else {
                Text("当前设备为只读，无法审批")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func decide(_ d: String) {
        busy = true
        Task { await app.decide(approval.id, d); busy = false }
    }
}
