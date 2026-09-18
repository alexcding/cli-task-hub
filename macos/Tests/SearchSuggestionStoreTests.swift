import Foundation
import Testing
@testable import TaskHub

@MainActor @Test func searchSuggestionStoreParsesFirefoxShapeAndCachesByQuery() async throws {
    let payload = #"["you",["youtube","youtube music","you"]]"#.data(using: .utf8)!
    #expect(SearchSuggestionStore.parse(payload) == ["youtube", "youtube music", "you"])
    #expect(SearchSuggestionStore.parse(Data("[]".utf8)).isEmpty)
    #expect(SearchSuggestionStore.parse(Data("nope".utf8)).isEmpty)

    var asked: [String] = []
    let store = SearchSuggestionStore { text in asked.append(text); return [text + " music"] }
    #expect(store.cached(" You ").isEmpty) // Reading never fetches.
    store.prefetch(" You ")
    for _ in 0..<200 { if !store.results.isEmpty { break }; try await Task.sleep(for: .milliseconds(5)) }
    #expect(store.cached("you") == ["you music"])
    store.prefetch("you"); try await Task.sleep(for: .milliseconds(200))
    #expect(asked == ["you"]) // One request for the normalised key, none for the cached repeat.
}
