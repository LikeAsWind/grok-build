//! Daemonization for `grok web` on Linux.
//!
//! `--daemon` forks the process (via `daemonize`) before the tokio runtime is
//! created, redirects output to `~/.grok/logs/web.log`, and writes a pid file
//! to `~/.grok/run/grok-web.pid`. Only compiled on Linux — on other platforms
//! the `--daemon` flag does not exist.

use std::path::PathBuf;

use xai_grok_shell::util::grok_home::grok_home;

/// Paths for the daemon's log and pid files.
pub struct DaemonPaths {
    pub log_file: PathBuf,
    pub pid_file: PathBuf,
}

pub fn daemon_paths() -> DaemonPaths {
    let home = grok_home();
    DaemonPaths {
        log_file: home.join("logs").join("web.log"),
        pid_file: home.join("run").join("grok-web.pid"),
    }
}

/// Detach into the background. On success the parent process has exited and
/// execution continues in the daemonized child. Must be called before the
/// tokio runtime is created.
#[cfg(target_os = "linux")]
pub fn daemonize() -> anyhow::Result<DaemonPaths> {
    use anyhow::Context;
    use ::daemonize::Daemonize;

    let paths = daemon_paths();
    if let Some(dir) = paths.log_file.parent() {
        std::fs::create_dir_all(dir).context("create daemon log dir")?;
    }
    if let Some(dir) = paths.pid_file.parent() {
        std::fs::create_dir_all(dir).context("create daemon pid dir")?;
    }

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_file)
        .context("open daemon log file")?;

    Daemonize::new()
        .pid_file(&paths.pid_file)
        .working_directory(std::env::current_dir().context("read cwd")?)
        .stdout(log.try_clone().context("clone log handle")?)
        .stderr(log)
        .start()
        .context("daemonize failed")?;

    Ok(paths)
}
