use std::{ffi::OsStr, path::Path, process::Stdio, sync::OnceLock, time::Duration};

use anyhow::{anyhow, Context, Result};
use tokio::{process::Command, time::timeout};

/// A command for an external CLI (`gh`, `acli`, `git`, agent CLIs). Finder and Xcode
/// launches hand the app a minimal PATH, and the backend runs inside the app, so the
/// child gets the usual install locations too. Set per command: mutating the process
/// environment would race with every other thread in the host app.
pub(crate) fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    // A PATH set on the Command is also the one used to resolve `program`.
    command.env("PATH", search_path());
    command
}

fn search_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| with_install_locations(&std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())))
}

fn with_install_locations(path: &str) -> String {
    let mut entries: Vec<&str> = path.split(':').filter(|entry| !entry.is_empty()).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !entries.contains(&extra) {
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
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = timeout(duration, command.output())
        .await
        .map_err(|_| anyhow!("{program} timed out after {}s", duration.as_secs()))?
        .with_context(|| format!("start {program}"))?;
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
    let output = timeout(duration, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("{program} timed out after {}s", duration.as_secs()))??;
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
        assert_eq!(with_install_locations("/usr/bin:/bin"), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(with_install_locations("/opt/homebrew/bin::/usr/bin"), "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
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
}
