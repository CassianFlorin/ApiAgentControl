import Foundation
import CryptoKit

/// 与 daemon 侧 Node 实现严格对齐的加密层。
///
/// 对齐要点（任一处不一致都会导致解密失败）：
///   - X25519 公钥：Node 导出 SPKI DER，CryptoKit 用 32 字节裸表示，需前缀转换
///   - HKDF：SHA-256，salt = roomId，info = "apiagentcontrol-v1"，输出 32 字节
///   - AES-256-GCM：12 字节 nonce、16 字节 tag，密文与 tag 分开传输
///   - 编码：一律 base64url 且无填充
enum B64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        // 补齐 base64 填充
        let rem = t.count % 4
        if rem > 0 { t += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: t)
    }
}

enum CryptoError: Error, LocalizedError {
    case badPublicKey
    case badEnvelope
    case decryptFailed

    var errorDescription: String? {
        switch self {
        case .badPublicKey: return "对方公钥格式无法解析"
        case .badEnvelope:  return "密文信封格式不正确"
        case .decryptFailed: return "解密失败（密钥不匹配或数据被篡改）"
        }
    }
}

/// 加密信封，与 Node 侧 `seal()` 的输出结构一一对应
struct Envelope: Codable {
    let iv: String
    let ct: String
    let tag: String
}

struct SessionCrypto {
    let key: SymmetricKey
    let myPublicKeySPKI: String

    /// X25519 SPKI DER 的固定前缀（RFC 8410）：算法标识 + BIT STRING 头
    private static let spkiPrefix = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00
    ])

    static func rawFromSPKI(_ b64url: String) throws -> Data {
        guard let der = B64URL.decode(b64url), der.count == 44,
              der.prefix(12) == spkiPrefix else { throw CryptoError.badPublicKey }
        return der.suffix(32)
    }

    static func spkiFromRaw(_ raw: Data) -> String {
        B64URL.encode(spkiPrefix + raw)
    }

    /// 与 daemon 完成密钥协商。每次配对生成一对新的临时密钥。
    init(hostPublicKeySPKI: String, roomId: String) throws {
        let priv = Curve25519.KeyAgreement.PrivateKey()
        let hostRaw = try Self.rawFromSPKI(hostPublicKeySPKI)
        let hostKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: hostRaw)
        let shared = try priv.sharedSecretFromKeyAgreement(with: hostKey)

        // 必须与 Node 的 crypto.hkdfSync('sha256', shared, roomId, 'apiagentcontrol-v1', 32) 一致
        self.key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(roomId.utf8),
            sharedInfo: Data("apiagentcontrol-v1".utf8),
            outputByteCount: 32
        )
        self.myPublicKeySPKI = Self.spkiFromRaw(priv.publicKey.rawRepresentation)
    }

    /// 供测试注入固定私钥使用
    init(privateKey: Curve25519.KeyAgreement.PrivateKey, hostPublicKeySPKI: String, roomId: String) throws {
        let hostRaw = try Self.rawFromSPKI(hostPublicKeySPKI)
        let hostKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: hostRaw)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: hostKey)
        self.key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(roomId.utf8),
            sharedInfo: Data("apiagentcontrol-v1".utf8),
            outputByteCount: 32
        )
        self.myPublicKeySPKI = Self.spkiFromRaw(privateKey.publicKey.rawRepresentation)
    }

    func seal<T: Encodable>(_ value: T) throws -> Envelope {
        let plaintext = try JSONEncoder().encode(value)
        let box = try AES.GCM.seal(plaintext, using: key)
        return Envelope(
            iv: B64URL.encode(Data(box.nonce)),
            ct: B64URL.encode(box.ciphertext),
            tag: B64URL.encode(box.tag)
        )
    }

    func open(_ env: Envelope) throws -> Data {
        guard let iv = B64URL.decode(env.iv),
              let ct = B64URL.decode(env.ct),
              let tag = B64URL.decode(env.tag) else { throw CryptoError.badEnvelope }
        guard let nonce = try? AES.GCM.Nonce(data: iv),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag),
              let pt = try? AES.GCM.open(box, using: key) else { throw CryptoError.decryptFailed }
        return pt
    }

    func open<T: Decodable>(_ env: Envelope, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: open(env))
    }
}
