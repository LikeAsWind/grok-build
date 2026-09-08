//! Configure a GitLab project webhook to forward MR comments to the local
//! `x.ai/workbench/mr_comment` endpoint (v2 spec §9.2.1).
//!
//! Usage:
//!   configure_gitlab_webhook \
//!     --gitlab-url https://gitlab.example.com \
//!     --project-id 12345 \
//!     --token-env GITLAB_TOKEN \
//!     --local-url "http://localhost:2420/x.ai/workbench/mr_comment" \
//!     --local-secret dev-secret
//!
//! Reads the personal access token from the named env var (D14 — never
//! store tokens in config.toml). Issues `PUT /api/v4/projects/:id/hooks`
//! with `mr_events: true, note_events: false` so the workbench pipeline
//! gets every MR comment posted by reviewers.
//!
//! Exit codes:
//!   0  success (201 from GitLab)
//!   1  bad args / missing token / non-201 response
//!   2  network / transport failure

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "configure_gitlab_webhook", about = "Configure GitLab MR webhook for workbench")]
struct Args {
    /// GitLab base URL, e.g. https://gitlab.example.com
    #[arg(long)]
    gitlab_url: String,

    /// Numeric project ID.
    #[arg(long)]
    project_id: String,

    /// Name of the env var holding the GitLab personal access token (D14).
    #[arg(long)]
    token_env: String,

    /// Full URL of the local workbench endpoint that should receive the
/// webhook POST (typically http://localhost:<port>/x.ai/workbench/mr_comment).
    #[arg(long)]
    local_url: String,

    /// Shared secret sent on the webhook URL; the receiver compares it to
/// its configured value to reject spoofed callbacks.
    #[arg(long)]
    local_secret: String,

    /// Optional HTTP timeout in seconds. Defaults to 30.
    #[arg(long, default_value_t = 30)]
    timeout_secs: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let token = match std::env::var(&args.token_env) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => anyhow::bail!("env var {} is set but empty", args.token_env),
        Err(_) => anyhow::bail!("env var {} is not set", args.token_env),
    };

    let url = format!("{}/api/v4/projects/{}/hooks", args.gitlab_url.trim_end_matches('/'), args.project_id);
    let body = serde_json::json!({
        "url": format!("{}?secret={}", args.local_url, args.local_secret),
        "mr_events": true,
        "note_events": false,
        "push_events": false,
        "merge_requests_events": true,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(args.timeout_secs))
        .build()
        .map_err(|e| anyhow::anyhow!("reqwest build failed: {e}"))?;

    let resp = client
        .put(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("PUT {} failed: {e}", url))?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();

    if status.is_success() {
        eprintln!("OK: configured webhook for project {} (status {})", args.project_id, status.as_u16());
        eprintln!("    url: {}", body["url"]);
        Ok(())
    } else {
        eprintln!("ERROR: GitLab returned status {}", status.as_u16());
        eprintln!("    body: {}", body_text);
        std::process::exit(1);
    }
}
