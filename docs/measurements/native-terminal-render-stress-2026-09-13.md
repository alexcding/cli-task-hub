# Native terminal render stress — 2026-09-13

The [raw samples](native-terminal-render-stress-2026-09-13.json) measure the production
native terminal path in the standalone AppKit harness. They add direct native frame
submission counters to the previous parser/queue/resource workload. Full-app and
matching Tauri measurements, physical key-to-display latency and remaining terminal
fidelity checks are still required before M1 passes.

| Setting | Value |
|---|---|
| Hardware | Mac14,9; 12 logical CPUs; 32 GiB RAM |
| OS | macOS 26.6.2, build 25G83 |
| Build | Release Swift harness and release Rust helper |
| Ghostty source | `82938b633ba646db38591d969c3c526332bd7e65` |
| Swift wrapper | `7e45d27160f9b34aca9ca5c9820e9207482f9f04` |
| Duration | 600.50 seconds; 292 samples |
| Workload | One visible interactive terminal, one hidden ANSI/Unicode flood, eight hidden 10 Hz tickers |
| Isolation | Private compiled fixture programs, socket and daemon; no user shell startup files, coding agents, backend or production data |

| Result | Observed |
|---|---|
| Hidden submitted frames | Zero in every sample for each of nine surfaces |
| Visible submitted frames | 14 after warmup → 1,664 at the last sample |
| Input-to-parsed-output p95 | 19.55 ms; not display latency |
| Visible-window samples | 292 / 292 |
| Largest output queue | 60,672 bytes (59.25 KiB) |
| Flood bytes received by final sample | 713,866,766 bytes |
| Native host CPU, median / peak | 166.2% / 408.7% (100% = one logical CPU) |
| Daemon tree CPU, median / peak | 22.1% / 33.4% |
| Native host RSS, first / last | 128.94 / 174.78 MiB |
| Daemon tree RSS, first / last | 32.66 / 73.95 MiB |

Every hidden ticker advanced between samples. PTY PIDs and surface generations stayed
unchanged, and no output pipe failed. An independent observer paused the flood; the
interactive terminal and other tickers continued, and disconnecting the observer
released its pause. The completed report, exited harness/daemon processes and removed
private fixture directory were checked after the run.

The frame counter increments at the native renderer's encoded-frame submission
boundary, reached by both the native renderer thread and embedded host draws. On the
pinned Metal backend this commits a command buffer. It does not count display-link
ticks or refresh requests. Reads do not draw, refresh or acquire the render lock.
Two seconds of mount/occlusion settling precede the initial counters. The final
periodic sample is at 598.46 seconds; the workload completes at 600.50 seconds.
The focused real-surface test also verifies a visible positive control followed by
unchanged counts during hidden Unicode, alternate-screen, keyboard, paste and links.

These counters establish no new hidden render-frame submissions over the sampled
steady state. They do not measure system-wide GPU usage, compositing, GPU execution
time or display presentation. The latency clock ends at the parsed echoed marker,
with 2 ms polling; it cannot close the 50 ms key-to-display target. The workload did
not reach the pipe's automatic high watermark, so it does not replace slow-socket
backlog tests.

RSS grew in both host and daemon. There is no proven plateau or attribution yet.
The web terminal retains 4,000 lines; the headless native daemon configures an 8 MiB
byte limit and snapshots carry retention settings into restored surfaces. These
retention policies must be considered in a fair comparison; their difference alone
does not prove the cause of RSS growth. CPU results likewise are not a Tauri baseline
or a controlled before/after improvement claim.

Measured native input fingerprint:
`e7f90a27171dde01687a73c414e4e7a0fd27ca603e4150de009519eaff71c6a9`.
Measured native archive SHA-256:
`f8fcb6356e66271888e5e35c22ddc0d590627f2ab91d7eccfcb536a91bbd174b`.
The final patch only relocates the draw API's documentation comment below the
new getter; rendering and measurement logic are unchanged. The final managed rebuild has
input fingerprint `606fbfc4d8d1278bf76d11120261fafbd753d8f90e34bcd6cd22a78f07037651`
and archive SHA-256 `ffe4a8c7b7e3037176b4be0d6a8df453a22d132af9885eb2ecf79c5f8f76feff`.
Release daemon SHA-256:
`3c8bbc35c1207da6d8c1695889a4b40a62ba494c03a829a1b65115ee52a45b5c`.

Run through XcodeBuildMCP with structured `arguments` (an array, not a JSON string
passed as one positional argument), release configuration and background execution.
The app command line must contain `--seconds 600`, the explicit release `--helper`
and the desired `--report`. Observe the actual process and final report after any
CLI timeout; do not start a duplicate while the workload is still alive.
