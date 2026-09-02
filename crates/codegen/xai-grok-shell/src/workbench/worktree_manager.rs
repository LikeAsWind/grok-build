//! Per-task worktree creation, branch naming, and delayed GC.
//!
//! Spec §9: every TAPD task gets its own worktree at
//! `~/.grok/worktrees/<task-id>/` with branch `tapd/<task-id>-<slug>`.
//! `.workbench/` is gitignored so artifacts never enter the branch history.

use std::path::{Path, PathBuf};

/// Root directory for all workbench worktrees: `<grok_home>/worktrees`.
pub fn worktree_root(grok_home: &str) -> PathBuf {
    PathBuf::from(grok_home).join("worktrees")
}

/// Path to a specific task's worktree directory.
pub fn worktree_path(grok_home: &str, task_id: &str) -> PathBuf {
    worktree_root(grok_home).join(task_id)
}

/// Build the branch name `tapd/<task-id>-<slug>` from the task id and title.
///
/// Slug is lowercase, kebab-case, max 40 chars. Title punctuation
/// (`-`, `_`, ` `) becomes `-`; everything else is dropped.
pub fn branch_name(task_id: &str, title: &str) -> String {
    format!("tapd/{}-{}", task_id, slugify(title, 40))
}

/// Slugify a string. Keeps alphanumerics; collapses runs of
/// separators (`-`, `_`, space) into a single `-`; trims trailing `-`;
/// caps length to `max_len` chars.
pub fn slugify(title: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(max_len.min(title.len()));
    let mut last_dash = false;
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        let keep = c.is_ascii_alphanumeric();
        if keep {
            out.push(c);
            last_dash = false;
        } else if matches!(ch, '-' | '_' | ' ' | '/') {
            if !out.is_empty() && !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
        if out.len() >= max_len {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Spawn `git worktree add -b <branch> <path> <base>` and write `.workbench/.gitignore`.
/// On Windows this blocks briefly while git runs; callers in async code
/// should `tokio::task::spawn_blocking` around it.
pub fn create_worktree(
    repo_root: &Path,
    grok_home: &str,
    task_id: &str,
    title: &str,
    base_branch: &str,
) -> std::io::Result<PathBuf> {
    let path = worktree_path(grok_home, task_id);
    let branch = branch_name(task_id, title);

    let status = std::process::Command::new("git")
        .args(["worktree", "add", "-b", &branch])
        .arg(path.as_os_str())
        .arg(base_branch)
        .current_dir(repo_root)
        .output()?;
    if !status.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&status.stderr)
            ),
        ));
    }
    write_worktree_gitignore(&path)?;
    Ok(path)
}

/// Write `.workbench/.gitignore` that excludes all workbench artifacts
/// from git history of the task branch.
pub fn write_worktree_gitignore(worktree: &Path) -> std::io::Result<()> {
    let dir = worktree.join(".workbench");
    std::fs::create_dir_all(&dir)?;
    let gi = dir.join(".gitignore");
    std::fs::write(&gi, "*\n!.gitignore\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_simple_title() {
        assert_eq!(
            branch_name("TAPD-1234", "Fix user lookup"),
            "tapd/TAPD-1234-fix-user-lookup"
        );
    }

    #[test]
    fn branch_name_strips_punctuation() {
        assert_eq!(
            branch_name("TAPD-1", "Fix: user/lookup & more!"),
            "tapd/TAPD-1-fix-user-lookup-more"
        );
    }

    #[test]
    fn slugify_truncates_at_max() {
        let long = "a".repeat(80);
        let s = slugify(&long, 40);
        assert_eq!(s.len(), 40);
    }

    #[test]
    fn slugify_collapses_separators() {
        assert_eq!(slugify("foo   bar--baz", 100), "foo-bar-baz");
    }

    #[test]
    fn slugify_strips_leading_and_trailing_dashes() {
        assert_eq!(slugify("---hello world---", 100), "hello-world");
    }

    #[test]
    fn slugify_lowercases() {
        assert_eq!(slugify("HelloWorld", 100), "helloworld");
    }

    #[test]
    fn slugify_empty_input() {
        assert_eq!(slugify("", 100), "");
    }

    #[test]
    fn worktree_path_under_grok_home() {
        let p = worktree_path("/home/user/.grok", "TAPD-9");
        assert_eq!(p, PathBuf::from("/home/user/.grok/worktrees/TAPD-9"));
    }
}

/// Schedules delayed removal of a worktree directory. Used after a task
/// reaches a terminal state (`Done` / `BlockedForHuman` / `Dead`) so the
/// user can still observe the final stage stream before cleanup kicks in.
pub struct WorktreeGcRegistry {
    cfg: crate::agent::config::WorkbenchConfig,
}

impl WorktreeGcRegistry {
    pub fn new(cfg: crate::agent::config::WorkbenchConfig) -> Self {
        Self { cfg }
    }

    /// Spawn a background task that sleeps for `worktree_gc_delay_secs`
    /// then removes the worktree directory. Failures are logged but never
    /// propagated — GC is best-effort.
    pub fn schedule_gc(&self, path: std::path::PathBuf) {
        let delay = std::time::Duration::from_secs(self.cfg.worktree_gc_delay_secs);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Err(e) = std::fs::remove_dir_all(&path) {
                tracing::warn!(
                    path = %path.display(),
                    "workbench GC failed: {e}"
                );
            }
        });
    }
}

#[cfg(test)]
mod gc_tests {
    use super::*;
    use crate::agent::config::WorkbenchConfig;

    #[tokio::test(start_paused = true)]
    async fn gc_runs_after_configured_delay() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wt");
        tokio::fs::create_dir_all(&path).await.unwrap();
        std::fs::write(path.join("marker"), "x").unwrap();

        let mut cfg = WorkbenchConfig::default();
        // 1 second for fast test
        cfg.worktree_gc_delay_secs = 1;
        let registry = WorktreeGcRegistry::new(cfg);

        registry.schedule_gc(path.clone());

        // Sleep less than delay: file should still exist
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(path.exists(), "GC fired too early");

        // Sleep past delay: file should be gone
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert!(!path.exists(), "GC did not run");
    }
}

