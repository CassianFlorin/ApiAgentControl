import SwiftUI

/// 第 3 层 · 会话详情。
///
/// 事件按重要性分级呈现：实测一个 turn 里 reasoning 9 条、工具调用 12 条，
/// 而 assistant_message 只有 2 条 —— 噪音是信号的 10 倍，全平铺在手机上没法看。
struct SessionDetailView: View {
    @EnvironmentObject var app: AppState
    let sessionId: String

    @State private var input = ""
    @State private var showInternal = false
    @State private var expandedTools = Set<String>()
    @FocusState private var inputFocused: Bool

    private var session: Session? { app.sessions[sessionId] }
    private var events: [AgentEvent] { app.events[sessionId] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        // 顶部的「加载更早」——历史按需分页拉取，不一次性加载整个会话
                        if !app.historyExhausted.contains(sessionId) && !events.isEmpty {
                            Button {
                                Task { await app.loadHistory(sessionId, older: true) }
                            } label: {
                                if app.loadingHistory.contains(sessionId) {
                                    ProgressView().frame(maxWidth: .infinity)
                                } else {
                                    Text("加载更早的消息")
                                        .font(.caption).frame(maxWidth: .infinity)
                                }
                            }
                            .padding(.vertical, 6)
                        } else if app.historyExhausted.contains(sessionId) && !events.isEmpty {
                            Text("— 会话开始 —")
                                .font(.caption2).foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity)
                        }

                        if events.isEmpty {
                            if app.loadingHistory.contains(sessionId) {
                                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                            } else {
                                Text("这个会话还没有内容")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                        }
                        ForEach(visibleEvents) { ev in
                            EventRow(event: ev, expanded: expandedTools.contains(ev.id)) {
                                if expandedTools.contains(ev.id) { expandedTools.remove(ev.id) }
                                else { expandedTools.insert(ev.id) }
                            }
                            .id(ev.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: events.count) {
                    // 只有在底部附近才自动滚动，否则会把正在往回翻历史的用户拽到底
                    guard !app.loadingHistory.contains(sessionId), let last = visibleEvents.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .task {
                    // 进入会话先取最新一页历史，而不是等新事件
                    if app.events[sessionId]?.isEmpty ?? true {
                        await app.loadHistory(sessionId)
                    }
                    await app.markRead(sessionId)
                }
            }

            // 待审批置顶为卡片，不混进流水
            if let pending = app.approvals.first(where: { $0.sessionId == sessionId }) {
                Divider()
                ApprovalCard(approval: pending)
                    .padding(.horizontal).padding(.vertical, 8)
                    .background(.orange.opacity(0.08))
            }

            Divider()
            composer
        }
        .navigationTitle(session?.displayTitle ?? String(sessionId.suffix(8)))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("显示推理过程", isOn: $showInternal)
                    if session?.state == .running, app.scope.canControl {
                        Button("打断当前任务", systemImage: "stop.circle", role: .destructive) {
                            Task { await app.interrupt(sessionId) }
                        }
                    }
                    if let cwd = session?.cwd {
                        Section("工作目录") { Text(cwd).font(.caption) }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
    }

    private var visibleEvents: [AgentEvent] {
        events.filter { ev in
            switch ev.tier {
            case .primary, .progress, .status, .blocking: return true
            case .internalDetail: return showInternal
            case .hidden: return false
            }
        }
    }

    @ViewBuilder private var composer: some View {
        if app.scope.canControl {
            VStack(spacing: 4) {
                // 发送失败必须显示在手边，而不是只在首页横幅 ——
                // 人在这个页面里发的，错误就得在这个页面里看见
                if let msg = app.errorMessage {
                    Text(msg)
                        .font(.caption).foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                }
                HStack(spacing: 8) {
                    TextField("发送指令…", text: $input, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                        .focused($inputFocused)
                    Button {
                        let text = input
                        input = ""
                        inputFocused = false
                        Task {
                            // 失败还原输入，别让用户重敲一遍
                            if await app.send(sessionId, text: text) == false { input = text }
                        }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || !app.connection.isUsable)
                }
                .padding(.horizontal)
            }
            .padding(.vertical, 8)
        } else {
            Text("当前设备权限为「\(app.scope.label)」，无法发送指令")
                .font(.caption2).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(8)
        }
    }
}

struct EventRow: View {
    let event: AgentEvent
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        switch event.tier {
        case .primary:      messageBubble
        case .progress:     toolLine
        case .internalDetail: reasoningLine
        case .status:       statusLine
        case .blocking:     EmptyView()      // 审批由置顶卡片承担
        case .hidden:       EmptyView()
        }
    }

    private var isUser: Bool { event.kind == "user_message" }

    private var messageBubble: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 2) {
                Text(event.text ?? "")
                    .font(.callout)
                    .padding(10)
                    .background(isUser ? Color.accentColor.opacity(0.15) : Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 12))
                Text(event.time).font(.caption2).foregroundStyle(.tertiary)
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    private var toolLine: some View {
        Button(action: toggle) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: event.kind == "tool_call" ? "wrench.fill" : "arrow.turn.down.left")
                        .font(.caption2)
                    Text(event.kind == "tool_call" ? (event.name ?? "工具调用") : "结果")
                        .font(.caption.weight(.medium))
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2)
                }
                if expanded, let detail = event.args ?? event.output {
                    Text(detail)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }

    private var reasoningLine: some View {
        Text(event.text ?? "")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .italic()
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusLine: some View {
        HStack {
            VStack { Divider() }
            Text(statusText).font(.caption2).foregroundStyle(.tertiary)
            VStack { Divider() }
        }
    }

    private var statusText: String {
        switch event.kind {
        case "turn_started": return "开始处理"
        case "turn_complete": return "完成 · \(event.time)"
        case "turn_aborted": return "已中止"
        case "turn_context": return event.model ?? "上下文更新"
        case "session_meta": return "会话开始"
        case "compacted": return "上下文已压缩"
        default: return event.kind
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) var dismiss
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            List {
                Section("连接") {
                    LabeledContent("状态", value: app.connection.label)
                    if app.connection.needsManualReconnect {
                        Button("重新连接") { app.reconnect() }
                    }
                    if let p = app.pairing {
                        LabeledContent("中继", value: p.relay)
                        LabeledContent("房间", value: String(p.room.prefix(10)) + "…")
                        // 显示服务端确认的档位；与配对时不同则一并标出，避免误以为自己还有旧权限
                        LabeledContent("权限") {
                            if let s = app.serverScope {
                                Text(s.label + (s.rawValue == p.scope ? "" : "（配对时为 \(Scope(rawValue: p.scope)?.label ?? p.scope)）"))
                            } else {
                                Text("未确认").foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let msg = app.errorMessage {
                        LabeledContent("错误") { Text(msg).foregroundStyle(.red) }
                    }
                }
                Section("通知") {
                    switch app.push.authorization {
                    case .authorized:
                        LabeledContent("状态", value: app.push.registered ? "已开启" : "已授权，等待注册")
                    case .denied:
                        LabeledContent("状态", value: "已拒绝")
                        Text("需要到系统「设置 → 通知」里手动开启。")
                            .font(.caption).foregroundStyle(.secondary)
                    default:
                        Button("开启通知") { Task { await app.push.requestAuthorization() } }
                    }
                    if let e = app.push.lastError {
                        Text(e).font(.caption2).foregroundStyle(.secondary)
                    }
                    Text("通知内容不含任何会话信息 —— APNs 服务器能看到推送体，"
                         + "所以只写「有一条需要处理」，真实内容在你点开后由 App 经加密通道取回。")
                        .font(.caption2).foregroundStyle(.secondary)
                }

                Section {
                    Text("权限档位由电脑端配对时决定。「只读」无法审批或发指令；"
                         + "「完全控制」等同远程 shell，仅应授予你完全信任的设备。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Button("解除配对", role: .destructive) { confirmUnpair = true }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
            .alert("解除配对？", isPresented: $confirmUnpair) {
                Button("解除", role: .destructive) { app.unpair(); dismiss() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("本机保存的凭证会被清除，需要重新配对才能连接。")
            }
        }
    }
}
