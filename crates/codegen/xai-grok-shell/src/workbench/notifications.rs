//! Notification side-effects after a task reaches a terminal state.
//! Spec §11.2 — TAPD comment is on by default; Slack / Feishu webhooks are
//! off by default and fire only when the URL is configured.

use serde_json::json;

/// Post a comment on a TAPD story / task / bug. Uses the TAPD REST API's
/// `POST /api/v1/{kind}/{id}/comments` endpoint with the user-supplied
/// access token.
pub struct TapdNotifier {
    base_url: String,
    access_token: String,
    http: reqwest::Client,
}

impl TapdNotifier {
    pub fn new(base_url: String, access_token: String) -> anyhow::Result<Self> {
        Ok(Self {
            base_url,
            access_token,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| anyhow::anyhow!("reqwest build failed: {e}"))?,
        })
    }

    pub async fn comment_on_story(
        &self,
        tapd_id: &str,
        message: &str,
    ) -> anyhow::Result<()> {
        let url = format!(
            "{}/api/v1/stories/{}/comments",
            self.base_url.trim_end_matches('/'),
            tapd_id
        );
        self.http
            .post(&url)
            .query(&[("access_token", &self.access_token)])
            .json(&json!({ "data": { "comment": message } }))
            .send()
            .await?;
        Ok(())
    }
}

/// Fire a Slack incoming-webhook POST. No-op when the URL is empty.
pub async fn notify_slack(webhook: &str, message: &str) -> anyhow::Result<()> {
    if webhook.is_empty() {
        return Ok(());
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow::anyhow!("reqwest build failed: {e}"))?;
    http.post(webhook).json(&json!({ "text": message })).send().await?;
    Ok(())
}

/// Fire a Feishu incoming-webhook POST. No-op when the URL is empty.
pub async fn notify_feishu(webhook: &str, message: &str) -> anyhow::Result<()> {
    if webhook.is_empty() {
        return Ok(());
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow::anyhow!("reqwest build failed: {e}"))?;
    http.post(webhook)
        .json(&json!({ "msg_type": "text", "content": { "text": message } }))
        .send()
        .await?;
    Ok(())
}

/// Format the standard "MR submitted" message posted to TAPD / Slack / Feishu.
pub fn format_mr_announcement(tapd_id: &str, mr_url: &str) -> String {
    format!("TAPD workbench: {tapd_id} — MR ready for review: {mr_url}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Async notification paths are exercised via integration tests; the
    // empty-URL no-op is a single early-return and doesn't need its own
    // test in v1.

    #[test]
    fn mr_announcement_format() {
        let s = format_mr_announcement("TAPD-1", "https://gl.example/mr/1");
        assert!(s.contains("TAPD-1"));
        assert!(s.contains("https://gl.example/mr/1"));
    }
}

