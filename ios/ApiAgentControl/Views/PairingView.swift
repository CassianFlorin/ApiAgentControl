import SwiftUI
import AVFoundation

/// 配对页：扫码或粘贴配对串。
struct PairingView: View {
    @EnvironmentObject var app: AppState
    @State private var manualText = ""
    @State private var showScanner = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("连接你的电脑")
                .font(.title2.bold())
            Text("在电脑上运行配对命令，然后扫描二维码或粘贴配对串。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Text("codex-watchd --pair --relay ws://…")
                .font(.system(.caption, design: .monospaced))
                .padding(8)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))

            Button {
                showScanner = true
            } label: {
                Label("扫描二维码", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 32)

            VStack(alignment: .leading, spacing: 8) {
                Text("或粘贴配对串").font(.caption).foregroundStyle(.secondary)
                TextField("apiagentcontrol://pair?d=…", text: $manualText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1...3)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("连接") { submit(manualText) }
                    .disabled(manualText.isEmpty)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 32)

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
            }
            Spacer()
            Text("配对串等同一把钥匙，不要转发给他人。")
                .font(.caption2).foregroundStyle(.secondary)
                .padding(.bottom, 8)
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                showScanner = false
                submit(code)
            }
        }
    }

    private func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do { try app.pair(with: trimmed); error = nil }
        catch { self.error = "配对失败：\(error.localizedDescription)" }
    }
}

/// 二维码扫描
struct QRScannerView: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerVC {
        let vc = ScannerVC()
        vc.onFound = onFound
        return vc
    }
    func updateUIViewController(_ vc: ScannerVC, context: Context) {}

    final class ScannerVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onFound: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { showHint(); return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { showHint(); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
            // startRunning 会阻塞，必须离开主线程；捕获局部引用避免跨 actor 访问属性
            let capture = session
            DispatchQueue.global(qos: .userInitiated).async { capture.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        private func showHint() {
            // 模拟器没有摄像头，给出明确提示而不是黑屏
            let label = UILabel()
            label.text = "此设备没有可用摄像头\n请返回并粘贴配对串"
            label.numberOfLines = 0
            label.textColor = .white
            label.textAlignment = .center
            label.frame = view.bounds.insetBy(dx: 24, dy: 0)
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(label)
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput objects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard let obj = objects.first as? AVMetadataMachineReadableCodeObject,
                  let value = obj.stringValue else { return }
            session.stopRunning()
            onFound?(value)
        }
    }
}
