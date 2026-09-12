import AppKit
import CoreServices

public enum AppLaunchContext {
    // Read during applicationDidFinishLaunching, while the open-application
    // Apple event is current. --autostart also supports explicit quiet launches.
    @MainActor public static var startsQuietly: Bool {
        isLoginLaunch(event: NSAppleEventManager.shared().currentAppleEvent)
            || ProcessInfo.processInfo.arguments.contains("--autostart")
    }
    static func isLoginLaunch(event: NSAppleEventDescriptor?) -> Bool {
        event?.eventClass == kCoreEventClass && event?.eventID == kAEOpenApplication
            && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}
