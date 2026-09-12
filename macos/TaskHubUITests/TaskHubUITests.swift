import XCTest

final class TaskHubUITests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

        // In UI tests it’s important to set the initial state - such as interface orientation - required for your tests before they run. The setUp method is a good place to do this.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    @MainActor
    func testNativeWindowShowsBackendFailure() throws {
        // UI tests must launch the application that they test.
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", "http://127.0.0.1:1"]
        app.launch()

        // Use XCTAssert and related functions to verify your tests produce the correct results.
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 5))
        app.outlines["workspace-sidebar"].staticTexts["Overview"].click()
        XCTAssertTrue(app.staticTexts["Native foundation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Reconnect"].waitForExistence(timeout: 15))
    }

    @MainActor
    func testTrayOpensOfflineAndEscapeDismisses() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", "http://127.0.0.1:1"]
        app.launch()
        XCTAssertTrue(app.buttons["Reviews & Usage"].waitForExistence(timeout: 5))
        app.buttons["Reviews & Usage"].click()
        XCTAssertTrue(app.staticTexts["Review requested"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect to load review requests"].exists)
        XCTAssertTrue(app.buttons["Quit TaskHub"].exists)
        app.typeKey(.escape, modifierFlags: [])
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Quit TaskHub"])
        wait(for: [dismissed], timeout: 5)
        XCTAssertTrue(app.buttons["Reviews & Usage"].exists)
    }
}
