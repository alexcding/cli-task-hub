# Native terminal stress — 2026-09-12

This is a terminal-path stress measurement, not completion of the M1 performance
gate. The [raw samples](native-terminal-stress-2026-09-12.json) were collected by the
standalone AppKit harness using production `TerminalSession`, `WorkspaceTerminalView`,
the bounded output pipe and the snapshot-enabled Rust daemon.

| Setting | Value |
|---|---|
| Hardware | Mac14,9; 12 logical CPUs; 32 GiB RAM |
| OS | macOS 26.6.2, build 25G83 |
| Build | Release Swift harness and release Rust helper |
| Ghostty source | `82938b633ba646db38591d969c3c526332bd7e65`, with the repository's native snapshot patches |
| Duration | 600.32 seconds; 292 input/resource samples |
| Workload | One visible interactive terminal, one hidden ANSI/Unicode flood, eight hidden 10 Hz tickers |
| Isolation | Private temporary daemon, socket and compiled fixture programs; no user shell startup files, coding agents, backend or production data |

| Result | Observed |
|---|---|
| Input-to-parsed-output p95 | 20.51 ms |
| Visible-window samples | 292 / 292 |
| Largest native output queue | 60,686 bytes (59.3 KiB) |
| Flood bytes received by final sample | 814,865,422 bytes |
| Native host CPU, median / peak | 179.7% / 385.3% (100% = one logical CPU) |
| Daemon tree CPU, median / peak | 21.2% / 23.1% |
| Native host RSS, first / last | 126.7 / 173.2 MiB |
| Daemon tree RSS, first / last | 32.1 / 74.5 MiB |

Every ticker advanced between samples. PTY PIDs and native surface generations
remained unchanged; no pipeline failed. An independent client paused the flood,
while the interactive session and tickers continued. Disconnecting that client
released its pause and the flood resumed. The harness stopped its ten fixtures and
daemon, then removed its temporary directory.

Latency starts immediately before Ghostty's encoded Enter and ends when the native
parsed viewport contains the fixture's corresponding marker. It includes a 2 ms
polling interval. It does **not** measure GPU presentation or physical key-to-display
latency. The pipeline never reached its automatic high watermark in this workload;
the separate owner-pause exercise does not prove slow-socket backlog behavior.

RSS increased over the run. These samples do not establish a memory plateau or
identify the source of that growth. The full app's SwiftUI/backend overhead, hidden
surface GPU draw work, a matching Tauri baseline, and real shell/TUI/agent interaction
acceptance still need measurement. The 20.51 ms result therefore cannot close the
50 ms key-to-display gate.

The XcodeBuildMCP foreground invocation lost its CLI connection after 30 seconds;
the existing workload continued. Completion was verified from the full 600-second
report, exited harness/helper processes and removal of the private fixture directory.
Use background execution for long runs, and do not launch another workload solely
because a CLI observation timed out.
