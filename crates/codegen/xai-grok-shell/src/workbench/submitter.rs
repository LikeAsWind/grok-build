//! `MrSubmit` stage: GitLab REST client + MR payload assembly + reviewer
//! resolution + status classifier. Spec §6.6, §11.
//!
//! Auth follows spec §17 D14 — the GitLab token is read from an env var
//! named by `GitlabConfig::token_env`, never stored in `config.toml`.

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
}
