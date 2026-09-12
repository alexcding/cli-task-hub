import Foundation

public enum BackendError: LocalizedError, Sendable {
    case configuration(String)
    case http(Int)
    case incompatible
    case startup(String)
    case oversizedEvent

    public var errorDescription: String? {
        switch self {
        case .configuration(let message), .startup(let message): message
        case .http(let status): "The backend returned HTTP \(status)."
        case .incompatible: "This address is not a compatible TaskHub backend."
        case .oversizedEvent: "The backend sent an oversized stream event."
        }
    }
}

public struct BackendHealth: Decodable, Sendable {
    public let service: String
    public let `protocol`: Int
    public let pid: Int32
    public let instanceId: String?

    public func validate(instanceID: String? = nil) throws {
        guard service == "taskhub", self.protocol == 1,
              instanceID == nil || instanceId == instanceID else { throw BackendError.incompatible }
    }
}

public struct Project: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let repo: String
    public let color: String?
    public let workspace: String
}

// Actor isolation keeps response decoding off the UI actor. Only decoded snapshots
// cross into the store; network operations remain cancellable.
public actor APIClient {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) throws {
        guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              parts.scheme == "http", ["127.0.0.1", "localhost", "[::1]"].contains(parts.host ?? ""),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw BackendError.configuration("The backend address must be a loopback HTTP origin.")
        }
        self.baseURL = baseURL
        self.session = session
    }

    public func get<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        var request = URLRequest(url: try url(path))
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        try Self.validate(response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func health() async throws -> BackendHealth {
        let value: BackendHealth = try await get(Routes.BACKEND_HEALTH)
        try value.validate()
        return value
    }

    func url(_ path: String) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let url = URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)
        else { throw BackendError.configuration("Invalid backend route.") }
        return url
    }

    static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw BackendError.incompatible }
        guard (200..<300).contains(http.statusCode) else { throw BackendError.http(http.statusCode) }
    }
}
