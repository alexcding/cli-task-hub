# Native project detail tab lag — September 14, 2026

## Finding and fix

Switching from Tickets to Sprint Board reproduced a long UI stall in the running
Debug app on Apple silicon, macOS 27.0 (26A428). The board snapshot contained 200
tickets across 12 occupied statuses; configured empty statuses add further lanes.

The dominant sampled path was AppKit window layout into `NSHostingView.layout`,
SwiftUI stack measurement, and child placement. The board used an eager `HStack`
of eager ticket `VStack`s: all lanes and cards participated in layout on entry.
Each card also built assignment and transition menus. Lanes had no vertical
scroll view, and long lists compressed/clipped within the available height.
`BoardCard.body` and repeated `WebBoardViewModel.columns` calculations were visible
in the app-owned portion of the sampled stacks, but window layout dominated.

`macos/Scenes/Projects/WebBoardView.swift` now uses a horizontal `LazyHStack`,
viewport-height lanes, and a vertical `ScrollView` with `LazyVStack` per lane.
The lane header remains outside its vertical scroll area. Ticket filtering is
evaluated once per lane body for both the count and card list.

This follows Apple's [performant scrollable stacks guidance](https://developer.apple.com/documentation/swiftui/creating-performant-scrollable-stacks):
lazy stacks create children as needed by the viewport.

## Profile evidence

Captured using `/usr/bin/sample` at a requested 1 ms interval. Counts below are
inclusive samples under the window-layout observer, counted once per matching
stack branch. They are not elapsed milliseconds or per-switch latency.

| Capture | Main-thread samples | Window-layout samples | Share |
| --- | ---: | ---: | ---: |
| Original app: 40-second capture spanning Settings, Tickets, then Board | 25,056 | 11,867 | 47.36% |
| Rebuilt QA app: 25-second capture spanning Board entry, vertical scrolling, then Automation | 16,129 | 933 | 5.78% |

The original Board click exceeded the computer-use action timeout (the tool
returned after approximately 18.7 seconds). A subsequent sample found the main
thread idle in the event loop, indicating entry-time work rather than a sustained
idle CPU loop. Before switching, the 8-second idle sample was also almost entirely
in the event loop.

The rebuilt Board action completed and exposed the rendered lanes without a
timeout; leaving and returning also completed successfully. Tool response times
include accessibility capture and synchronization and are not UI latency metrics.

These are diagnostic captures, not a controlled speedup benchmark: durations,
interactions, window sizes, and debugger attachment differed. The original was
attached to Xcode; the QA build was launched independently. No p95 latency or
Release performance claim is made.

## Verification

- Debug arm64 build succeeded with XcodeBuildMCP. Only Sparkle stripping warnings
  were reported.
- Launched a separate bundle identifier, `com.alexcding.taskhub.tab-lag-qa`, using a
  local server with a frozen copy of the affected board snapshot. The server
  exposed no sessions and forwarded no writes to the daily app. Its data directory
  and PTY socket were isolated.
- Verified board entry, leaving for Automation, and returning to Board.
- Verified vertical scrolling reveals later tickets in the 31-ticket first lane.
- Verified horizontal scrollbar navigation creates the final lanes, including the
  97-ticket Done lane and empty configured lanes.
- Inspected the rendered board: lanes fill the viewport and ticket summaries wrap
  instead of the entire ticket stack being compressed into its height.
- `git diff --check` passed.
- No automated tests were added for this view-only change. Ticket mutation and
  drag/drop actions were not exercised; their handlers are unchanged.

Raw captures are retained locally under the ignored build directory:

- `macos/.build/tab-lag-qa/profiles/taskhub-tab-idle.sample.txt`
- `macos/.build/tab-lag-qa/profiles/taskhub-tab-switch.sample.txt`
- `macos/.build/tab-lag-qa/profiles/taskhub-board-stall.sample.txt`
- `macos/.build/tab-lag-qa/profiles/after.sample.txt`

The rebuilt app is at
`macos/.build/tab-lag-qa/Build/Products/Debug/TaskHub.app`.
The daily running app must be rebuilt/relaunched to use the source change.
