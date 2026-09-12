import XCTest

final class TaskHubUITests: XCTestCase {

    @MainActor
    func testContextPageFindNavigationCloseAndNewSessionSheet() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated browser fixture.")
        }
        let directory = URL(fileURLWithPath: path)
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", directory.path, "--pty-socket", socket]
        app.launch()
        let session = app.outlines["workspace-sidebar"].staticTexts["sidebar-1"].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.click()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Native browser fixture"].waitForExistence(timeout: 10))
        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(app.textFields["Find in page"].waitForExistence(timeout: 5))
        app.textFields["Find in page"].click()
        app.typeText("quokka\n")
        XCTAssertFalse(app.staticTexts["No match"].exists)
        app.buttons["Close Find"].click()
        app.webViews.links["Next page"].click()
        XCTAssertTrue(app.webViews.staticTexts["Next page"].waitForExistence(timeout: 5))
        app.typeKey("[", modifierFlags: .command)
        XCTAssertTrue(app.webViews.staticTexts["Native browser fixture"].waitForExistence(timeout: 5))
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.buttons["Open Terminal"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertNotEqual(app.state, .notRunning)
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(app.staticTexts["New Session"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["session-branch"].exists, app.debugDescription)
        app.buttons["Cancel"].click()
        app.buttons["Remove Session"].click()
        XCTAssertTrue(app.buttons["Forget Session"].waitForExistence(timeout: 10))
        app.buttons["Forget Session"].click()
        let removed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: session)
        wait(for: [removed], timeout: 10)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("sidebar-1").path))
    }

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

    @MainActor
    func testNativeMenusNavigateAndCommandQHidesWithoutQuitting() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", "http://127.0.0.1:1"]
        app.launch()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.menuBars.menuBarItems["Edit"].waitForExistence(timeout: 5), app.debugDescription)
        app.typeKey("1", modifierFlags: .command)
        XCTAssertTrue(app.staticTexts["Native foundation"].waitForExistence(timeout: 5))
        app.typeKey("q", modifierFlags: .command)
        XCTAssertNotEqual(app.state, .notRunning)
        app.activate()
        app.menuBars.menuBarItems["Go"].click()
        app.menuItems["Overview"].click()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Native foundation"].exists)
    }
}
