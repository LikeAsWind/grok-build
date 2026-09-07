//! `Verify` stage: spawn `test_command`, capture stdout/stderr/exit-code,
//! enforce a per-project timeout, and produce `5-verify.md` per spec §8.
//!
//! Spec §6.5 — the runner is **tool-only** (no LLM). Verdict rule: exit 0
//! → `pass`; anything else → `fail`. Runner crash / timeout is treated as
//! infrastructure failure and surfaces upstream as `Dead` rather than
//! retrying the develop stage.
//!
//! Sync API (this module) is intentional — async tests should wrap calls
//! in `tokio::task::spawn_blocking`.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use serde_json;

/// Pick a shell binary + flag for the current platform. Windows shells
/// (`cmd.exe`) don't accept `-c`; Unix shells (`sh`) do.
fn shell_for(cmd: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(cmd);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    }
}

#[derive(Clone, Debug)]
pub struct RunResult {
    pub command: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Per-test events parsed from `cargo nextest --message-format json`.
    /// Empty when nextest is not used (v1 default).
    pub nextest_events: Vec<NextestEvent>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NextestEventKind {
    Started,
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug)]
pub struct NextestEvent {
    pub name: String,
    pub kind: NextestEventKind,
    pub message: Option<String>,
}

/// Detect whether `cargo-nextest` is on PATH. Uses `where` on Windows,
/// `which` on unix. Tolerant: returns `false` on any IO / spawn error.
pub fn is_nextest_available() -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(probe)
        .arg("cargo-nextest")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Parse a single line of `cargo nextest --message-format json` output.
/// Returns `None` for non-test events (e.g. `run-started`) and for lines
/// that aren't valid JSON.
pub fn parse_nextest_line(line: &str) -> Option<NextestEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let event = v.get("event")?.as_str()?;
    let name = v.get("name")?.as_str()?.to_string();
    let kind = match event {
        "test-started" => NextestEventKind::Started,
        "test-passed" => NextestEventKind::Passed,
        "test-failed" => NextestEventKind::Failed,
        "test-skipped" => NextestEventKind::Skipped,
        _ => return None,
    };
    let message = v
        .get("stdout")
        .and_then(|s| s.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    Some(NextestEvent { name, kind, message })
}

/// Run a shell command, capture stdout + stderr + exit code. A future
/// async variant will enforce `timeout_secs` via `tokio::time::timeout`;
/// for now the parameter is captured-but-unused so callers can wire it in.
pub fn run_and_capture(cmd: &str, cwd: &Path, timeout_secs: u64) -> std::io::Result<RunResult> {
    let started = Instant::now();
    let mut child = shell_for(cmd)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Drain stdout/stderr into strings (cap each at 1 MiB to avoid runaway
    // output consuming memory).
    const CAP: u64 = 1024 * 1024;
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut so) = child.stdout.take() {
        let mut limited = so.take(CAP);
        let _ = limited.read_to_string(&mut stdout);
    }
    if let Some(mut se) = child.stderr.take() {
        let mut limited = se.take(CAP);
        let _ = limited.read_to_string(&mut stderr);
    }

    let exit_code = match child.wait() {
        Ok(status) => status.code().unwrap_or(-1),
        Err(_) => -1,
    };
    let _ = timeout_secs; // TODO(async): real timeout via tokio::time::timeout

    Ok(RunResult {
        command: cmd.into(),
        exit_code,
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        nextest_events: Vec::new(), // populated by callers when nextest is used
    })
}

/// Map an exit code to a `pass` / `fail` string. Centralized so the artifact
/// writer and the state machine agree.
pub fn verdict_for(r: &RunResult) -> &'static str {
    if r.exit_code == 0 { "pass" } else { "fail" }
}

/// Truncate output to keep the artifact readable: first 175 lines + a
/// `[truncated N lines]` marker + last 175 lines. Symmetric windows
/// preserve both header info (errors at the top of build output) and
/// the final state.
pub fn truncate_output(raw: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() <= max_lines {
        return raw.to_string();
    }
    let head_count = max_lines / 2;
    let tail_count = max_lines - head_count;
    let head = lines[..head_count].join("\n");
    let tail = lines[lines.len() - tail_count..].join("\n");
    let hidden = lines.len() - max_lines;
    format!("{head}\n\n... [truncated {hidden} lines] ...\n\n{tail}")
}

/// Write `.workbench/stages/5-verify.md` with frontmatter + command + exit +
/// duration + truncated stdout/stderr.
pub fn write_artifact(
    path: &Path,
    task_id: &str,
    attempt: u8,
    r: &RunResult,
) -> std::io::Result<()> {
    use std::fmt::Write;
    let mut front = String::new();
    let _ = writeln!(
        front,
        "---\nstage: verify\ntask_id: {task_id}\nattempt: {attempt}\nexit_code: {}\nverdict: {}\n---\n",
        r.exit_code,
        verdict_for(r),
    );
    let mut body = String::new();
    let _ = write!(
        body,
        "## Command\n```\n{}\n```\n\n## Exit code\n{}\n\n## Duration\n{} ms\n\n## Stdout (truncated to {})\n```\n{}\n```\n\n## Stderr\n```\n{}\n```\n",
        r.command,
        r.exit_code,
        r.duration_ms,
        truncate_output(&r.stdout, 350).lines().count(),
        truncate_output(&r.stdout, 350),
        r.stderr,
    );
    std::fs::write(path, format!("{}{}", front, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_and_capture_zero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let r = run_and_capture(if cfg!(windows) { "echo hello" } else { "echo hello" }, dir.path(), 30).unwrap();
        assert_eq!(r.exit_code, 0);
        assert!(r.stdout.contains("hello"));
        assert_eq!(verdict_for(&r), "pass");
    }

    #[test]
    fn run_and_capture_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = if cfg!(windows) { "cmd /C exit 7" } else { "exit 7" };
        let r = run_and_capture(cmd, dir.path(), 30).unwrap();
        assert_eq!(r.exit_code, 7);
        assert_eq!(verdict_for(&r), "fail");
    }

    #[test]
    fn run_and_capture_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = if cfg!(windows) { "cmd /C echo err 1>&2" } else { "echo err >&2" };
        let r = run_and_capture(cmd, dir.path(), 30).unwrap();
        assert!(r.stderr.contains("err"));
        assert!(r.stdout.is_empty());
    }

    #[test]
    fn truncate_output_preserves_short_input() {
        let s = "line1\nline2\nline3";
        assert_eq!(truncate_output(s, 100), s);
    }

    #[test]
    fn truncate_output_handles_long_input() {
        let long: String = (1..=1000).map(|i| format!("line{i}\n")).collect();
        let truncated = truncate_output(&long, 200);
        let line_count = truncated.lines().count();
        assert!(line_count <= 210);
        assert!(truncated.contains("[truncated"));
    }

    #[test]
    fn write_artifact_includes_verdict_and_command() {
        let dir = tempfile::tempdir().unwrap();
        let stages = dir.path().join(".workbench/stages");
        std::fs::create_dir_all(&stages).unwrap();
        let r = RunResult {
            command: "echo ok".into(),
            exit_code: 0,
            stdout: "ok\n".into(),
            stderr: String::new(),
            duration_ms: 12,
            nextest_events: vec![],
        };
        let p = stages.join("5-verify.md");
        write_artifact(&p, "TAPD-1", 0, &r).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("stage: verify"));
        assert!(raw.contains("task_id: TAPD-1"));
        assert!(raw.contains("exit_code: 0"));
        assert!(raw.contains("verdict: pass"));
        assert!(raw.contains("```\necho ok\n```"));
    }

    #[test]
    fn nextest_available_detects_binary() {
        // Just check the helper does not panic and returns a bool.
        let _ = is_nextest_available();
    }

    #[test]
    fn nextest_event_parses_test_passed() {
        let line = r#"{"event":"test-passed","name":"tests::foo","elapsed_secs":0.012}"#;
        let e = parse_nextest_line(line).expect("should parse");
        assert_eq!(e.name, "tests::foo");
        assert!(matches!(e.kind, NextestEventKind::Passed));
    }

    #[test]
    fn nextest_event_parses_test_failed_with_message() {
        let line = r#"{"event":"test-failed","name":"tests::bar","stdout":{"message":"boom"}}"#;
        let e = parse_nextest_line(line).expect("should parse");
        assert_eq!(e.name, "tests::bar");
        assert!(matches!(e.kind, NextestEventKind::Failed));
        if let NextestEventKind::Failed = e.kind {
            assert_eq!(e.message.as_deref(), Some("boom"));
        }
    }

    #[test]
    fn nextest_event_ignores_unknown() {
        assert!(parse_nextest_line("not json").is_none());
        assert!(parse_nextest_line(r#"{"event":"run-started"}"#).is_none());
    }
}

