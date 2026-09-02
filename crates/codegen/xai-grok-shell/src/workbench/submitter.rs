//! `MrSubmit` stage: GitLab REST client + MR payload assembly + reviewer
//! resolution + status classifier. Spec §6.6, §11.
//!
//! Auth follows spec §17 D14 — the GitLab token is read from an env var
//! named by `GitlabConfig::token_env`, never stored in `config.toml`.

use std::path::Path;

use crate::agent::config::GitlabConfig;

/// Response wrapper for `POST /projects/:id/merge_requests`. We capture the
/// raw body so the state machine / artifact writer can inspect the JSON
/// payload without us re-deserializing every field.
pub struct GitlabCreateMrResponse {
    pub status: u16,
    pub body: String,
}

impl GitlabCreateMrResponse {
    /// Extract `web_url` from the JSON body. Returns None on parse failure
    /// or if the field is missing (e.g. on an error response).
    pub fn mr_url(&self) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(&self.body)
            .ok()
            .and_then(|v| v.get("web_url").and_then(|u| u.as_str().map(|s| s.to_string())))
    }
}

#[derive(Debug)]
pub struct GitlabClient {
    cfg: GitlabConfig,
    http: reqwest::Client,
    token: String,
}

impl GitlabClient {
    /// Construct a client, reading the token from the env var named in
    /// `cfg.token_env`. Returns an error if the env var is unset (per
    /// spec §17 D14 — never store tokens in config).
    pub fn new(cfg: &GitlabConfig) -> anyhow::Result<Self> {
        let token = std::env::var(&cfg.token_env).map_err(|_| {
            anyhow::anyhow!(
                "GitLab token env var `{}` is not set",
                cfg.token_env
            )
        })?;
        Ok(Self {
            cfg: cfg.clone(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| anyhow::anyhow!("reqwest build failed: {e}"))?,
            token,
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn url(&self) -> &str {
        &self.cfg.url
    }

    /// `POST /api/v4/projects/:id/merge_requests`. The caller is responsible
    /// for shaping the JSON payload (see `build_mr_payload`).
    pub async fn create_merge_request(
        &self,
        project_id: &str,
        payload: &serde_json::Value,
    ) -> anyhow::Result<GitlabCreateMrResponse> {
        let url = format!(
            "{}/api/v4/projects/{}/merge_requests",
            self.cfg.url.trim_end_matches('/'),
            project_id
        );
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(payload)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let body = resp.text().await?;
        Ok(GitlabCreateMrResponse { status, body })
    }
}

// Reviewer resolution + CODEOWNERS parser. Spec §11.1 — priority:
//   1. [tapd.projects.<key>].mr_reviewers (config)
//   2. TAPD task.owner
//   3. .gitlab/CODEOWNERS (based on files changed)
//   4. Empty fallback (UI surfaces the gap)

/// Resolve reviewers per spec §11.1. Order: config reviewers → TAPD owner
/// (if config empty) → CODEOWNERS matches (added, deduped).
pub fn resolve_reviewers(
    config_reviewers: &[String],
    tapd_owner: Option<&str>,
    codeowners: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !config_reviewers.is_empty() {
        out.extend(config_reviewers.iter().cloned());
    } else if let Some(o) = tapd_owner {
        out.push(o.to_string());
    }
    for c in codeowners {
        if !out.contains(c) {
            out.push(c.clone());
        }
    }
    if out.is_empty() {
        if let Some(o) = tapd_owner {
            out.push(o.to_string());
        }
    }
    out
}

/// Resolve assignees per spec §11.1. Config takes precedence; otherwise
/// TAPD owner. Empty if neither is configured.
pub fn resolve_assignees(
    config_assignees: &[String],
    tapd_owner: Option<&str>,
) -> Vec<String> {
    if !config_assignees.is_empty() {
        config_assignees.to_vec()
    } else if let Some(o) = tapd_owner {
        vec![o.to_string()]
    } else {
        vec![]
    }
}

/// Minimal CODEOWNERS matcher: supports `*`, trailing `/`, and `*` wildcards.
/// Returns the union of `@user` handles whose patterns match at least one
/// of `changed_files`. Files are relative paths within the worktree.
pub fn resolve_codeowners(worktree: &Path, changed_files: &[String]) -> Vec<String> {
    let co = worktree.join(".gitlab").join("CODEOWNERS");
    if !co.exists() {
        return vec![];
    }
    let raw = match std::fs::read_to_string(&co) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (pattern, owners) = match line.split_once(' ') {
            Some((p, o)) => (p, o),
            None => continue,
        };
        if changed_files
            .iter()
            .any(|f| matches_pattern(pattern, f))
        {
            for o in owners.split_whitespace() {
                if let Some(handle) = o.strip_prefix('@') {
                    if !out.contains(&handle.to_string()) {
                        out.push(handle.to_string());
                    }
                }
            }
        }
    }
    out
}

fn matches_pattern(pattern: &str, file: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(raw_dir) = pattern.strip_suffix("/") {
        // CODEOWNERS dir patterns may be "src/" (relative) or "/src/" (repo-anchored).
        // Match either, with or without the leading "./".
        let dir = raw_dir.trim_start_matches("/");
        return file.starts_with(dir)
            || file.starts_with(&format!("./{dir}"));
    }
    if pattern.contains("*") {
        let parts: Vec<&str> = pattern.split("*").collect();
        if parts.is_empty() {
            return true;
        }
        let mut idx = 0usize;
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() {
                continue;
            }
            if i == 0 {
                if !file[idx..].starts_with(part) {
                    return false;
                }
                idx += part.len();
            } else if i == parts.len() - 1 {
                return file[idx..].ends_with(part);
            } else if let Some(p) = file[idx..].find(part) {
                idx += p + part.len();
            } else {
                return false;
            }
        }
        return true;
    }
    file == pattern || file.ends_with(&format!("/{pattern}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_resolves_token_from_env() {
        unsafe { std::env::set_var("WORKBENCH_TEST_GITLAB_TOKEN", "secret-abc"); }
        let cfg = GitlabConfig {
            url: "https://gl.example".into(),
            token_env: "WORKBENCH_TEST_GITLAB_TOKEN".into(),
            default_assignees_self: false,
        };
        let client = GitlabClient::new(&cfg).unwrap();
        assert_eq!(client.token(), "secret-abc");
        assert_eq!(client.url(), "https://gl.example");
    }

    #[test]
    fn client_errors_when_token_env_missing() {
        unsafe { std::env::remove_var("WORKBENCH_TEST_GITLAB_TOKEN_MISSING"); }
        let cfg = GitlabConfig {
            url: "https://gl.example".into(),
            token_env: "WORKBENCH_TEST_GITLAB_TOKEN_MISSING".into(),
            default_assignees_self: false,
        };
        let err = GitlabClient::new(&cfg).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("WORKBENCH_TEST_GITLAB_TOKEN_MISSING"));
    }

    #[test]
    fn mr_url_parses_web_url_from_body() {
        let resp = GitlabCreateMrResponse {
            status: 201,
            body: r#"{"id":1,"web_url":"https://gl.example/mr/1"}"#.into(),
        };
        assert_eq!(resp.mr_url().as_deref(), Some("https://gl.example/mr/1"));
    }

    #[test]
    fn mr_url_missing_field_returns_none() {
        let resp = GitlabCreateMrResponse {
            status: 401,
            body: r#"{"message":"401 Unauthorized"}"#.into(),
        };
        assert!(resp.mr_url().is_none());
    }

    #[test]
    fn resolver_uses_config_first() {
        let cfg = vec!["alice".to_string(), "bob".to_string()];
        let resolved = resolve_reviewers(&cfg, Some("carol"), &[]);
        assert_eq!(resolved, vec!["alice", "bob"]);
    }

    #[test]
    fn resolver_falls_back_to_owner_when_config_empty() {
        let resolved = resolve_reviewers(&[], Some("carol"), &[]);
        assert_eq!(resolved, vec!["carol"]);
    }

    #[test]
    fn resolver_appends_codeowners_deduped() {
        let resolved = resolve_reviewers(&["alice".into()], None, &["bob".into(), "alice".into()]);
        assert_eq!(resolved, vec!["alice", "bob"]);
    }

    #[test]
    fn resolver_empty_inputs_yields_empty() {
        let resolved = resolve_reviewers(&[], None, &[]);
        assert!(resolved.is_empty());
    }

    #[test]
    fn assignees_uses_config_first() {
        let a = resolve_assignees(&["x".into()], Some("y"));
        assert_eq!(a, vec!["x"]);
    }

    #[test]
    fn assignees_falls_back_to_owner() {
        let a = resolve_assignees(&[], Some("y"));
        assert_eq!(a, vec!["y"]);
    }

    #[test]
    fn codeowners_parses_simple_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".gitlab")).unwrap();
        std::fs::write(
            tmp.path().join(".gitlab/CODEOWNERS"),
            "* @alice\n/src/ @bob @carol\n",
        )
        .unwrap();
        let resolved = resolve_codeowners(tmp.path(), &["src/foo.rs".into()]);
        assert!(resolved.contains(&"alice".to_string()));
        assert!(resolved.contains(&"bob".to_string()));
        assert!(resolved.contains(&"carol".to_string()));
    }

    #[test]
    fn codeowners_missing_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_codeowners(tmp.path(), &["src/foo.rs".into()]);
        assert!(resolved.is_empty());
    }

    #[test]
    fn codeowners_skips_comments_and_blanks() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".gitlab")).unwrap();
        std::fs::write(
            tmp.path().join(".gitlab/CODEOWNERS"),
            "# top comment\n\n* @alice\n   # indented comment\n",
        )
        .unwrap();
        let resolved = resolve_codeowners(tmp.path(), &["anything.rs".into()]);
        assert_eq!(resolved, vec!["alice".to_string()]);
    }
}




// MR payload assembly + HTTP status classifier. Spec §6.6.

use crate::workbench::state_machine::MrSubmitOutcome;

pub fn format_mr_title(tapd_id: &str, title: &str) -> String {
    format!("[{tapd_id}] {title}")
}

pub fn build_mr_payload(
    tapd_id: &str,
    title: &str,
    description: &str,
    acs: &[String],
    source_branch: &str,
    target_branch: &str,
    assignees: &[String],
    reviewers: &[String],
) -> serde_json::Value {
    let acs_block = if acs.is_empty() {
        String::new()
    } else {
        format!(
            "`n`n## Acceptance Criteria`n{}",
            acs.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("`n")
        )
    };
    serde_json::json!({
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": format_mr_title(tapd_id, title),
        "description": format!("{description}{acs_block}"),
        "assignee_ids": assignees,
        "reviewer_ids": reviewers,
        "remove_source_branch": true,
        "squash": false,
    })
}

pub fn classify_response(r: GitlabCreateMrResponse) -> MrSubmitOutcome {
    match r.status {
        201 => MrSubmitOutcome::Ok,
        409 => MrSubmitOutcome::Conflict,
        401 | 403 => MrSubmitOutcome::AuthError,
        500..=599 => MrSubmitOutcome::TransientError,
        _ => MrSubmitOutcome::TransientError,
    }
}

#[cfg(test)]
mod payload_tests {
    use super::*;

    #[test]
    fn payload_includes_required_fields() {
        let p = build_mr_payload(
            "TAPD-1",
            "Fix login",
            "Fix broken login flow",
            &["AC1".to_string()],
            "tapd/TAPD-1-fix-login",
            "main",
            &["alice".to_string()],
            &["bob".to_string()],
        );
        assert_eq!(p["source_branch"], "tapd/TAPD-1-fix-login");
        assert_eq!(p["target_branch"], "main");
        assert_eq!(p["title"], "[TAPD-1] Fix login");
        assert_eq!(p["remove_source_branch"], true);
        assert_eq!(p["squash"], false);
        let desc = p["description"].as_str().unwrap();
        assert!(desc.contains("AC1"));
        assert_eq!(p["reviewer_ids"][0], "bob");
        assert_eq!(p["assignee_ids"][0], "alice");
    }

    #[test]
    fn payload_omits_acs_section_when_empty() {
        let p = build_mr_payload("TAPD-1", "x", "desc", &[], "b", "main", &[], &[]);
        let desc = p["description"].as_str().unwrap();
        assert!(!desc.contains("Acceptance Criteria"));
    }

    #[test]
    fn mr_title_prefix() {
        assert_eq!(format_mr_title("TAPD-9", "Add foo"), "[TAPD-9] Add foo");
    }

    #[test]
    fn submitter_classifies_201_as_ok() {
        let outcome = classify_response(GitlabCreateMrResponse {
            status: 201,
            body: r#"{"web_url":"x"}"#.into(),
        });
        assert!(matches!(outcome, MrSubmitOutcome::Ok));
    }

    #[test]
    fn submitter_classifies_409_as_conflict() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 409, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::Conflict));
    }

    #[test]
    fn submitter_classifies_401_as_auth_error() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 401, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::AuthError));
    }

    #[test]
    fn submitter_classifies_5xx_as_transient() {
        let outcome = classify_response(GitlabCreateMrResponse { status: 503, body: "{}".into() });
        assert!(matches!(outcome, MrSubmitOutcome::TransientError));
    }
}


