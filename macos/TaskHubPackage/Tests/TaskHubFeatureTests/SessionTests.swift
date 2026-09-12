import Foundation
import Testing
@testable import TaskHubFeature

@Test func agentCommandsResumeExactIDsAndQuoteShellMetacharacters() {
    #expect(SessionAgent.shell.command(sessionID: nil) == nil)
    #expect(SessionAgent.claude.command(sessionID: "saved") == "claude --resume 'saved'")
    #expect(SessionAgent.claude.command(sessionID: "new", fresh: true) == "claude --session-id 'new'")
    #expect(SessionAgent.codex.command(sessionID: "saved") == "codex resume 'saved'")
    #expect(SessionAgent.codex.command(sessionID: "") == "codex")
    #expect(SessionAgent.quote("a'$(touch /tmp/no);b") == "'a'\"'\"'$(touch /tmp/no);b'")
}
