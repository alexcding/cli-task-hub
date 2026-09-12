import XCTest

final class TaskHubUITests: XCTestCase {

    @MainActor
    func testNativeEditorSaveCancelDiscardAndHistory() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let file = URL(fileURLWithPath: path).appendingPathComponent("Editable.swift").standardizedFileURL
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        let row = app.outlines["workspace-sidebar"].staticTexts["Editor fixture"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.click()
        let editor = app.webViews.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 15), "Saved file tab should load Monaco")
        editor.click(); app.typeKey("a", modifierFlags: .command); app.typeText("let saved = true")
        XCTAssertTrue(app.buttons["● Editable.swift"].waitForExistence(timeout: 5))
        app.typeKey("s", modifierFlags: .command)
        let saved = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["● Editable.swift"])
        wait(for: [saved], timeout: 6)
        editor.click(); app.typeText(" // unsaved")
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.sheets.buttons["action-button-2"].waitForExistence(timeout: 5), app.debugDescription)
        app.sheets.buttons["action-button-3"].click()
        XCTAssertTrue(editor.exists)
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.sheets.buttons["action-button-2"].waitForExistence(timeout: 5))
        app.sheets.buttons["action-button-2"].click()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: editor)
        wait(for: [closed], timeout: 5)
        app.menuButtons["History"].click()
        app.menuItems[file.path].click()
        XCTAssertTrue(editor.waitForExistence(timeout: 10), app.debugDescription)
        editor.click()
        XCTAssertEqual(editor.value as? String, "let saved = true")
        XCTAssertFalse(app.webViews.staticTexts["let saved = true // unsaved"].exists)
        app.typeKey("w", modifierFlags: .command)
    }

    @MainActor
    func testFocusedWorkingDiffCollapseRefreshAndRecovery() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        let row = app.outlines["workspace-sidebar"].staticTexts["sidebar-2"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
        row.click()
        app.buttons["Show Changes"].click()
        let file = app.webViews.staticTexts["Sources/Fixture.swift"]
        let renderError = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH 'Could not'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 10), "\(renderError.value ?? app.debugDescription)")
        let code = app.webViews.staticTexts.matching(NSPredicate(format: "value CONTAINS 'Native diff ready'")).firstMatch
        XCTAssertTrue(code.exists, app.debugDescription)
        file.click()
        let collapsed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: code)
        wait(for: [collapsed], timeout: 5)
        file.click()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        app.buttons["Refresh Changes"].click()
        XCTAssertTrue(app.staticTexts["Fixture diff unavailable"].waitForExistence(timeout: 5))
        XCTAssertTrue(code.exists) // A failed refresh preserves the last good diff.
        app.buttons["Refresh Changes"].click()
        let recovered = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Fixture diff unavailable"])
        wait(for: [recovered], timeout: 5)
        XCTAssertTrue(app.webViews.staticTexts["Untracked.txt"].exists)
        app.buttons["Hide Changes"].click()
        XCTAssertFalse(app.webViews.firstMatch.exists)
    }

    @MainActor
    func testNativeCLIStatusAndHookInstallationRecovery() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 10))
        app.typeKey(",", modifierFlags: .command)
        app.radioButtons["CLIs"].click()
        XCTAssertTrue(app.staticTexts["Not signed in"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Installed; sign-in status unavailable"].exists)
        app.buttons["hook-toggle-claude"].click()
        XCTAssertTrue(app.staticTexts["Claude Code hooks installed."].waitForExistence(timeout: 5))
        app.buttons["hook-toggle-codex"].click()
        XCTAssertTrue(app.staticTexts["Fixture hook configuration rejected"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["hook-status-claude"].value as? String, "Installed")
        app.buttons["hook-toggle-claude"].click()
        XCTAssertTrue(app.staticTexts["Claude Code hooks removed."].waitForExistence(timeout: 5))
    }

    @MainActor
    func testNativeSettingsSaveRevertAndMenuNavigation() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 10))
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(app.radioButtons["Connections"].waitForExistence(timeout: 5))
        app.radioButtons["Connections"].click()
        let interval = app.textFields["settings-poll-interval"]
        XCTAssertTrue(interval.waitForExistence(timeout: 5))
        interval.click(); app.typeKey("a", modifierFlags: .command); app.typeText("0")
        XCTAssertTrue(app.staticTexts["PR polling must be between 15 and 86400 seconds."].exists)
        XCTAssertFalse(app.buttons["Save Settings"].isEnabled)
        interval.click(); app.typeKey("a", modifierFlags: .command); app.typeText("90")
        app.buttons["Save Settings"].click()
        XCTAssertTrue(app.staticTexts["Settings saved"].waitForExistence(timeout: 5))
        interval.click(); app.typeKey("a", modifierFlags: .command); app.typeText("120")
        app.typeKey("1", modifierFlags: .command)
        app.typeKey(",", modifierFlags: .command)
        XCTAssertEqual(interval.value as? String, "120")
        app.buttons["Revert Settings"].click()
        XCTAssertEqual(interval.value as? String, "90")
        app.radioButtons["General"].click()
        XCTAssertTrue(app.descendants(matching: .any)["settings-default-agent"].firstMatch.waitForExistence(timeout: 5), app.debugDescription)
    }

    @MainActor
    func testNativeJiraTicketsSearchTransitionAndOpen() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        let project = app.outlines["workspace-sidebar"].staticTexts["Native integration fixture"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.click(); app.radioButtons["Tickets"].click()
        let ticket = app.descendants(matching: .any)["jira-ticket-REC-1"].firstMatch
        XCTAssertTrue(ticket.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        let status = app.descendants(matching: .any)["jira-status-REC-1"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5), app.debugDescription)
        status.click(); app.menuItems["Blocked"].click()
        XCTAssertTrue(app.staticTexts["Fixture transition rejected"].waitForExistence(timeout: 5))
        status.click(); app.menuItems["Done"].click()
        let changed = expectation(for: NSPredicate(format: "title == 'Done'"), evaluatedWith: status)
        wait(for: [changed], timeout: 5)
        let query = app.textFields["jira-query"]
        query.click(); app.typeText("rec-2"); app.buttons["Search Jira"].click()
        XCTAssertTrue(app.staticTexts["Search results: rec-2"].waitForExistence(timeout: 5))
        XCTAssertFalse(ticket.exists)
        XCTAssertTrue(app.descendants(matching: .any)["jira-ticket-REC-2"].firstMatch.exists)
        app.buttons["Clear Search"].click()
        XCTAssertTrue(ticket.waitForExistence(timeout: 5))
        status.click(); app.menuItems["To Do"].click()
        let restored = expectation(for: NSPredicate(format: "title == 'To Do'"), evaluatedWith: status)
        wait(for: [restored], timeout: 5)
        ticket.click()
        XCTAssertTrue(app.webViews.staticTexts["Native ticket fixture"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testWebSprintBoardMovesAssignsAndOpensNativeTicketContext() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        let project = app.outlines["workspace-sidebar"].staticTexts["Native integration fixture"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.click()
        app.radioButtons["Sprint Board"].click()
        XCTAssertTrue(app.webViews.staticTexts["Native board integration"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.webViews.staticTexts["Fixture sprint"].exists)
        app.webViews.buttons["Move REC-1"].click()
        app.webViews.buttons["Blocked"].click()
        XCTAssertTrue(app.webViews.staticTexts["Fixture transition rejected"].waitForExistence(timeout: 5))
        app.webViews.buttons["Move REC-1"].click()
        app.webViews.buttons["Done"].click()
        XCTAssertTrue(app.webViews.staticTexts["REC-1 → Done"].waitForExistence(timeout: 5))
        app.webViews.buttons["Assign"].firstMatch.click()
        app.webViews.buttons["Alice"].click()
        XCTAssertTrue(app.webViews.staticTexts["REC-1 → Alice"].waitForExistence(timeout: 5))
        app.webViews.links["REC-1"].click()
        XCTAssertTrue(app.webViews.staticTexts["Native ticket fixture"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Create Session"].exists)
        project.click()
        XCTAssertTrue(app.webViews.staticTexts["Native board integration"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testNativeActivityFiltersAndConfirmsClear() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 10))
        app.outlines["workspace-sidebar"].staticTexts["Activity"].click()
        XCTAssertTrue(app.staticTexts["Native Activity"].waitForExistence(timeout: 10))
        app.checkBoxes["Errors only"].click()
        XCTAssertTrue(app.staticTexts["Native Failure"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Native Activity"].exists)
        app.buttons["Clear Logs…"].click()
        XCTAssertTrue(app.sheets.buttons["Clear Logs"].waitForExistence(timeout: 5))
        app.sheets.buttons["Cancel"].click()
        XCTAssertTrue(app.staticTexts["Native Failure"].exists)
        app.buttons["Clear Logs…"].click()
        app.sheets.buttons["Clear Logs"].click()
        XCTAssertTrue(app.staticTexts["No matching entries."].waitForExistence(timeout: 10))
    }

    @MainActor
    func testNativeProjectCreateEditAndDelete() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        let create = app.buttons["New Project"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        let enabled = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: create)
        wait(for: [enabled], timeout: 10)
        create.click()
        let name = app.textFields["project-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.click(); app.typeText("UI project")
        app.buttons["Create Project"].click()
        let row = app.outlines["workspace-sidebar"].staticTexts["UI project"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.click()
        XCTAssertTrue(app.radioButtons["Settings"].waitForExistence(timeout: 5), app.debugDescription)
        app.radioButtons["Settings"].click()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.click(); app.typeKey("a", modifierFlags: .command); app.typeText("Renamed UI project")
        app.buttons["Save Project"].click()
        XCTAssertTrue(app.outlines["workspace-sidebar"].staticTexts["Renamed UI project"].waitForExistence(timeout: 10))
        app.buttons["Delete Project…"].click()
        XCTAssertTrue(app.sheets.buttons["Delete Project"].waitForExistence(timeout: 5))
        app.sheets.buttons["Cancel"].click()
        XCTAssertTrue(app.outlines["workspace-sidebar"].staticTexts["Renamed UI project"].exists)
        app.buttons["Delete Project…"].click()
        app.sheets.buttons["Delete Project"].click()
        let removed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.outlines["workspace-sidebar"].staticTexts["Renamed UI project"])
        wait(for: [removed], timeout: 10)
    }

    @MainActor
    func testNativeDashboardFiltersAndOpensContextPage() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["TASKHUB_UI_BACKEND_URL"],
              let path = environment["TASKHUB_UI_DATA_DIR"], let socket = environment["TASKHUB_UI_PTY_SOCKET"] else {
            throw XCTSkip("Run macos/scripts/test-browser-ui.sh to provide the isolated dashboard fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--backend-url", base, "--data-dir", path, "--pty-socket", socket]
        app.launch()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 10))
        app.outlines["workspace-sidebar"].staticTexts["Overview"].click()
        let search = app.textFields["dashboard-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.click()
        app.typeText("Previously reviewed")
        let reviewed = app.buttons["dashboard-pr-2"]
        XCTAssertTrue(reviewed.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["dashboard-pr-1"].exists)
        XCTAssertFalse(app.buttons["dashboard-pr-3"].exists)
        reviewed.click()
        XCTAssertTrue(app.webViews.staticTexts["Native browser fixture"].waitForExistence(timeout: 10))
        app.typeKey("1", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertEqual(search.value as? String, "Previously reviewed")
    }

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
        XCTAssertTrue(app.staticTexts["Pull requests"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["Pull requests"].waitForExistence(timeout: 5))
        app.typeKey("q", modifierFlags: .command)
        XCTAssertNotEqual(app.state, .notRunning)
        app.activate()
        app.menuBars.menuBarItems["Go"].click()
        app.menuItems["Overview"].click()
        XCTAssertTrue(app.outlines["workspace-sidebar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pull requests"].exists)
    }
}
