# Native Run and Stop acceptance

The native build workflow passed a real simulator build/install/launch/Stop check
on 2026-09-13, under the personal `com.alexcding.taskhub` bundle identity.

## Exercised path

- Created a standalone `TaskHubBuildProbe` iOS workspace with XcodeBuildMCP, then
  copied it into an isolated `taskhub-browser-ui.*` fixture directory.
- Used the real Xcode scheme, simulator and build-settings API routes. The existing
  destination-error fixture was disabled. No Xcode responses or build commands
  were substituted.
- Selected the fixture session in the Cocoa sidebar and opened its ordinary shell.
- Used the native Run sheet to build the `TaskHubBuildProbe` scheme for the available
  iPhone 16 Pro / iOS 18.6 simulator (`A798409B-A556-4E32-AAE5-15E71A6F85CD`).
- Ran the application's real command chain through its separate `build:` PTY:
  simulator boot, Xcode build, install and console-attached launch.
- The launched sample reported its bundle identity and live process ID to the
  isolated loopback fixture. The test checked a separate build PTY and the original
  session shell's unchanged PID.
- Clicked Stop Build and verified that the launched simulator process exited.
- Repeated Run and Stop, verifying a new simulator process and the same session
  shell. Ended through explicit tray Quit.

## Evidence

`testNativeRealBuildLaunchStopPreservesSessionTerminal` passed with no failures or
skips. Native app and UI targets compiled successfully. The two launched sample
processes were 34108 and 34288; both were confirmed stopped after the run, and the
fixture daemon's terminal-manifest directory was empty.

XcodeBuildMCP log:
`test_macos_2026-09-14T01-16-56-731Z_pid33290_d142b6b9.log`.
Result bundle:
`test_macos_2026-09-14T01-16-56-732Z_pid33290_8294af05.xcresult`.
Fixture diagnostics:
`/private/var/folders/n_/jcz3z32d1wv4mlg3wxvrrx880000gp/T/taskhub-browser-ui.HHrkgs`.

The initial unconditional cleanup reported that there was nothing left to
terminate, consistent with the passing Stop assertions. The cleanup helper now
recognizes that specific already-stopped result, while propagating other errors;
it was separately verified against this fixture. It only accepts the generated
`com.alexcding.taskhub.acceptance.buildprobe.b<UUID>` identity.

XCTest emitted its previously observed QoS warning. This run establishes the real
simulator Run/Stop path and session/build isolation; it does not complete the
remaining browser-login, terminal-hardware or signed-distribution acceptance gates.
No performance benchmark was run.

## Reproduction

Scaffold a `TaskHubBuildProbe` iOS workspace with XcodeBuildMCP, then follow the
real-build command in [the native README](../../macos/README.md). The explicit
simulator ID and template path are required; ordinary browser UI runs skip this
test and do not start a simulator build.
