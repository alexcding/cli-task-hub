import Foundation

enum PtyError: LocalizedError, Sendable {
    case connection(String), socket(Int32), protocolMismatch(UInt32), timeout, closed, overflow
    var errorDescription: String? {
        switch self {
        case .connection(let text): text
        case .socket(let code): String(cString: strerror(code))
        case .protocolMismatch(let version): "Terminal daemon protocol \(version) is incompatible; expected 2."
        case .timeout: "The terminal daemon did not respond."
        case .closed: "The terminal daemon connection closed."
        case .overflow: "The terminal connection exceeded its bounded buffer."
        }
    }
}

struct PtyInfo: Codable, Sendable, Identifiable {
    let id: String
    let cwd: String
    let title: String
    let paired: Bool
    let pairKey: String
    let hasContext: Bool
    let pid: UInt32
    let created: UInt64
}

struct PtyHello: Decodable, Sendable {
    let `protocol`: UInt32
    let pid: Int32
    let dataEncoding: String?
    let acknowledgedInput: Bool?
    var snapshotRevision: String? = nil

    func validateSnapshots() throws {
        guard snapshotRevision == PtySnapshot.revision else {
            throw PtyError.connection("This PTY helper cannot provide compatible terminal snapshots. Save your work, quit TaskHub explicitly, rebuild the helper, and reopen. Existing shells have been preserved.")
        }
    }

    func validateInputAcknowledgements() throws {
        guard acknowledgedInput == true else {
            throw PtyError.connection("This PTY helper cannot acknowledge input failures. Save your work, quit TaskHub explicitly, rebuild the helper, and reopen. Existing shells have been preserved.")
        }
    }

    func validateByteTransport() throws {
        guard dataEncoding == "base64" else {
            throw PtyError.connection("This PTY helper cannot preserve terminal bytes. Quit TaskHub explicitly after saving your work, rebuild the helper, and reopen. Existing shells have been preserved.")
        }
    }
}

struct PtyAttachment: Decodable, Sendable {
    let bytes: Data
    let seq: UInt64
    let live: Bool
    let truncated: Bool?

    func validateReplay() throws {
        guard live else { throw PtyError.connection("The terminal exited before attachment.") }
        guard let truncated else {
            throw PtyError.connection("This PTY helper cannot report incomplete history. Rebuild the helper before reattaching.")
        }
        guard !truncated else {
            throw PtyError.connection("Terminal history was truncated; the screen cannot be restored reliably. The shell is still running. Full-state restoration is required.")
        }
    }
}

struct PtyEvent: Decodable, Sendable {
    let ev: String
    let id: String
    let bytes: Data?
    let seq: UInt64?
    let exitCode: Int?
    let signal: Int?
    var message: String? = nil
    var stateSeq: UInt64? = nil
    var cols: UInt16? = nil
    var rows: UInt16? = nil
}

struct PtyRequest: Encodable, Sendable {
    struct Options: Encodable, Sendable {
        var cwd: String
        var shell: String?
        var paired = false
        var pairKey: String
    }
    var id: UInt64?
    var op: String
    var term: String?
    var data: String?
    var bytes: Data?
    var dataEncoding: String?
    var cols: UInt16?
    var rows: UInt16?
    var pause: Bool?
    var opts: Options?
    var snapshotRevision: String?
    var token: UInt64?
    var offset: Int?
}

// Stream framing is independent of socket reads. Decode only complete UTF-8 JSON
// lines; raw reads can split both escape sequences and multibyte characters.
struct PtyFramer {
    private var pending = Data()
    var limit = 2 * 1024 * 1024

    mutating func append(_ data: Data) throws -> [Data] {
        var frames: [Data] = []
        for byte in data {
            if byte == 10 {
                if !pending.isEmpty { frames.append(pending) }
                pending.removeAll(keepingCapacity: true)
            } else {
                guard pending.count < limit else { throw PtyError.overflow }
                pending.append(byte)
            }
        }
        return frames
    }
}
