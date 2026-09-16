use std::{
    ffi::OsStr,
    path::Path,
    process::{Output, Stdio},
    sync::OnceLock,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, Command};

/// A command for an external CLI (`gh`, `acli`, `git`, agent CLIs). Finder and Xcode
/// launches hand the app a minimal PATH, and the backend runs inside the app, so the
/// child gets the usual install locations too. Set per command: mutating the process
/// environment would race with every other thread in the host app.
pub(crate) fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    // A PATH set on the Command is also the one used to resolve `program`.
    command.env("PATH", search_path());
    // Its own process group, because the backend runs INSIDE the app: a child left in the
    // host's group shares its fate in both directions. Anything group-directed would reach
    // the app itself, and helpers the child spawns (`git` starts `git-remote-https`) would
    // outlive it holding its output pipe open, which is what `wait_or_kill` below now ends.
    command.process_group(0);
    command
}

/// The group a child leads, or `None` if it does not lead one. Read once while the child is
/// still alive: `kill_on_drop` reaps it as soon as a timeout drops the wait, and `getpgid` on
/// a reaped pid answers -1 — which would look exactly like "not a group leader" and silently
/// skip the kill, leaving the helpers running. The check itself is the safety property:
/// `command` puts every child in its own group, but were that ever to stop, the child's group
/// would be the APP'S, and signalling it would take the host process down with it.
fn leader_group(child: &Child) -> Option<i32> {
    let pid = child.id()? as i32;
    (unsafe { libc::getpgid(pid) } == pid).then_some(pid)
}

/// Wait for `child`, or kill its whole process group when `duration` runs out. `output()`
/// alone is not recoverable: it waits for the output pipes to close, and a grandchild that
/// inherited them keeps it pending long after the child itself has exited.
async fn wait_or_kill(program: &str, child: Child, duration: Duration) -> Result<Output> {
    // Read before waiting: `getpgid` answers -1 once the leader is reaped, which would look
    // exactly like "not a group leader" and skip the kill, leaving the helpers running.
    let group = leader_group(&child);
    // The kill still reaches those helpers when the leader is already gone — a group lives as
    // long as any member does, and the wedged helper IS a member. What it cannot rule out is
    // the leader's pid being recycled between its reaping and this signal; that window is the
    // same one `tokio::time::timeout` had here, and it cannot touch the app, whose group is
    // never this pid.
    let wait = std::pin::pin!(child.wait_with_output());
    tokio::select! {
        // `timeout` polled the wait first; `select!` is otherwise random, and a tie would
        // report a command that actually finished as timed out.
        biased;
        result = wait => result.with_context(|| format!("wait for {program}")),
        _ = tokio::time::sleep(duration) => {
            if let Some(group) = group {
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
            Err(anyhow!("{program} timed out after {}s", duration.as_secs()))
        }
    }
}

fn search_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        with_install_locations(
            &std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
            std::env::var("HOME").ok().as_deref(),
        )
    })
}

/// Homebrew, plus the per-user directories the agent CLIs install into: the Claude Code
/// and Codex native installers both drop their launcher in `~/.local/bin`, which a Finder
/// or Xcode launch never has on PATH, so without this the CLIs read as "not found".
fn with_install_locations(path: &str, home: Option<&str>) -> String {
    // A trailing slash names the same directory, and a shell rc exports either spelling,
    // so the inherited entries are matched on the trimmed form rather than verbatim.
    let key = |entry: &str| match entry.trim_end_matches('/') {
        "" => "/".to_string(),
        trimmed => trimmed.to_string(),
    };
    let mut entries: Vec<String> = path
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(String::from)
        .collect();
    let mut seen: Vec<String> = entries.iter().map(|entry| key(entry)).collect();
    let mut extras = vec!["/opt/homebrew/bin".to_string(), "/usr/local/bin".to_string()];
    if let Some(home) = home.filter(|home| !home.is_empty()) {
        let home = home.trim_end_matches('/');
        extras.extend(
            [".local/bin", ".bun/bin", ".cargo/bin"]
                .iter()
                .map(|dir| format!("{home}/{dir}")),
        );
    }
    for extra in extras {
        let extra_key = key(&extra);
        if !seen.contains(&extra_key) {
            seen.push(extra_key);
            entries.push(extra);
        }
    }
    entries.join(":")
}

pub async fn run<I, S>(program: &str, args: I, duration: Duration) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_in(program, args, duration, None).await
}

pub async fn run_in<I, S>(
    program: &str,
    args: I,
    duration: Duration,
    cwd: Option<&Path>,
) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command
        .spawn()
        .with_context(|| format!("start {program}"))?;
    let output = wait_or_kill(program, child, duration).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(anyhow!(if stderr.is_empty() {
            format!("{program} exited {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub async fn run_with_input<I, S>(
    program: &str,
    args: I,
    input: &[u8],
    duration: Duration,
    cwd: Option<&Path>,
) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    use tokio::io::AsyncWriteExt;
    let mut command = command(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("start {program}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input).await?;
    }
    let output = wait_or_kill(program, child, duration).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(anyhow!(if stderr.is_empty() {
            format!("{program} exited {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_locations_are_appended_once_after_the_inherited_path() {
        assert_eq!(
            with_install_locations("/usr/bin:/bin", None),
            "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"
        );
        assert_eq!(
            with_install_locations("/opt/homebrew/bin::/usr/bin", None),
            "/opt/homebrew/bin:/usr/bin:/usr/local/bin"
        );
    }

    // The agent CLIs' native installers put their launcher here, so a Finder launch finds them.
    #[test]
    fn per_user_install_directories_come_from_home() {
        assert_eq!(
            with_install_locations("/usr/bin", Some("/Users/me/")),
            "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.bun/bin:/Users/me/.cargo/bin"
        );
        assert_eq!(
            with_install_locations("/Users/me/.local/bin:/usr/bin", Some("/Users/me")),
            "/Users/me/.local/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.bun/bin:/Users/me/.cargo/bin"
        );
        // Same directory, other spelling: appending it again would only cost a second lookup.
        assert_eq!(
            with_install_locations("/Users/me/.local/bin/:/usr/bin", Some("/Users/me")),
            "/Users/me/.local/bin/:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.bun/bin:/Users/me/.cargo/bin"
        );
    }

    // The fix relies on the Command's own PATH resolving the program, not the parent's.
    #[tokio::test]
    async fn a_command_resolves_programs_through_its_own_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("taskhub-path-probe");
        std::fs::write(&tool, "#!/bin/sh\necho found\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new("taskhub-path-probe")
            .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
            .output()
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "found");
    }

    // A timed-out command must take its helpers with it. `git fetch` froze New Session for a
    // minute this way: git died, its `git-remote-https` child kept the output pipe open, and
    // the wait stayed pending. The marker file is the grandchild's proof of life.
    #[tokio::test]
    async fn a_timeout_kills_the_helpers_the_child_started() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("grandchild-survived");
        let script = format!(
            "(sleep 1; touch {}) & sleep 30",
            marker.display()
        );
        let started = std::time::Instant::now();
        let error = run("sh", ["-c", script.as_str()], Duration::from_millis(200))
            .await
            .expect_err("the command outlived its timeout");
        assert!(error.to_string().contains("timed out"), "{error}");
        // Returns on the timeout rather than waiting for the pipe the grandchild holds.
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            !marker.exists(),
            "the grandchild outlived the timeout and kept running"
        );
    }
}
