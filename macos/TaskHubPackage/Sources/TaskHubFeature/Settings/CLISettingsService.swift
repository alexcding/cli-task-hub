import Foundation

enum ManagedCLI: String, CaseIterable, Identifiable, Sendable {
    case claude, codex, gh, acli
    var id: String { rawValue }
    var title: String { switch self { case .claude: "Claude Code"; case .codex: "Codex"; case .gh: "GitHub CLI"; case .acli: "Atlassian CLI" } }
    var supportsHooks: Bool { self == .claude || self == .codex }
    var loginCommand: String? { switch self { case .gh: "gh auth login"; case .acli: "acli jira auth login"; default: nil } }
    var installationGuide: URL {
        let address: String = switch self {
        case .claude: "https://docs.claude.com/en/docs/claude-code/setup"
        case .codex: "https://github.com/openai/codex"
        case .gh: "https://cli.github.com"
        case .acli: "https://developer.atlassian.com/cloud/acli/guides/install-macos/"
        }
        return URL(string: address)!
    }
}

struct CLIAvailability: Decodable, Sendable {
    let present: Bool
    var authed: Bool?
    func label(for cli: ManagedCLI) -> String {
        guard present else { return "Not found" }
        if cli.supportsHooks { return "Installed" }
        switch authed {
        case true: return "Signed in"
        case false: return "Not signed in"
        default: return "Installed; sign-in status unavailable"
        }
    }
}

protocol CLISettingsService: Sendable {
    func probe() async throws -> [String: CLIAvailability]
    func hooks() async throws -> [String: String]
    func setHook(_ cli: ManagedCLI, installed: Bool) async throws -> [String: String]
}

struct APICLISettingsService: CLISettingsService {
    let api: APIClient
    func probe() async throws -> [String: CLIAvailability] { try await api.get(Routes.CLI_TOOLS, timeout: 30) }
    func hooks() async throws -> [String: String] { try await api.get(Routes.AGENT_HOOKS) }
    func setHook(_ cli: ManagedCLI, installed: Bool) async throws -> [String: String] {
        struct Result: Decodable, Sendable { let status: [String: String] }
        let result: Result = try await api.request(Routes.agentHook(cli.rawValue), method: installed ? "POST" : "DELETE", body: [String: String]())
        return result.status
    }
}
