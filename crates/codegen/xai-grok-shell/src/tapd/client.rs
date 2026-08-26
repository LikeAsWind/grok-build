//! TAPD REST client: authentication, `stories`/`tasks`/`bugs` listing with
//! incremental `modified` filtering and pagination.
//!
//! Wire format confirmed against the reference client script and
//! cross-checked with Apache DevLake's TAPD plugin (a production consumer of
//! the same API): every request appends `?s=mcp` (or `&s=mcp`), auth is
//! `Authorization: Bearer <token>` or HTTP Basic, and incremental pulls pass
//! `modified=>YYYY-MM-DD HH:MM:SS` (full timestamp, single-sided lower
//! bound — NOT a `~`-separated range) combined with `order=created asc` for
//! stable paging. The lower-bound semantics of `modified=>T` only work with
//! ascending order: paging from the newest end of `created` would silently
//! miss items whose `created` is older than the page window.
//!
//! `module=` is passed as a hint when configured — TAPD's server-side
//! handling of it is inconsistent across endpoints, so the client also
//! post-filters pages against the configured module list. The query hint
//! is harmless when ignored, useful when honored.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const DEFAULT_API_BASE_URL: &str = "https://api.tapd.cn";

#[derive(Debug, Clone)]
pub enum TapdAuth {
    Token(String),
    Basic { user: String, password: String },
}

#[derive(Debug, Clone)]
pub struct TapdClientConfig {
    pub auth: TapdAuth,
    pub api_base_url: String,
}

impl TapdClientConfig {
    pub fn base_url(&self) -> &str {
        if self.api_base_url.is_empty() {
            DEFAULT_API_BASE_URL
        } else {
            self.api_base_url.trim_end_matches('/')
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TapdClientError {
    #[error("TAPD request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("TAPD API error (status {status}): {body}")]
    Api { status: u16, body: String },
    #[error("unexpected TAPD response shape: {0}")]
    Shape(String),
}

/// One TAPD work item (`stories`, `tasks`, or `bugs`), normalized to the
/// fields the workbench needs. `raw` retains the full response object for
/// the task detail drawer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TapdWorkItem {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<String>,
    pub module: Option<String>,
    pub owner: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub raw: serde_json::Value,
}

/// `stories`, `tasks`, or `bugs` — the TAPD entity types the workbench syncs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TapdEntityType {
    Story,
    Task,
    Bug,
}

impl TapdEntityType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Story => "story",
            Self::Task => "task",
            Self::Bug => "bug",
        }
    }

    /// The TAPD API endpoint path for listing this entity type.
    fn endpoint(self) -> &'static str {
        match self {
            Self::Story => "stories",
            Self::Task => "tasks",
            Self::Bug => "bugs",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "story" => Some(Self::Story),
            "task" => Some(Self::Task),
            "bug" => Some(Self::Bug),
            _ => None,
        }
    }
}

pub struct TapdClient {
    http: reqwest::Client,
    config: TapdClientConfig,
}

impl TapdClient {
    pub fn new(config: TapdClientConfig) -> Self {
        Self {
            http: reqwest::Client::new(),
            config,
        }
    }

    fn auth_header(&self) -> (String, String) {
        match &self.config.auth {
            TapdAuth::Token(token) => ("Authorization".to_string(), format!("Bearer {token}")),
            TapdAuth::Basic { user, password } => {
                use base64::Engine;
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
                ("Authorization".to_string(), format!("Basic {encoded}"))
            }
        }
    }

    /// List work items of `entity_type` for `workspace_id`, optionally
    /// filtered to items modified since `since` (full TAPD `modified`
    /// timestamp `YYYY-MM-DD HH:MM:SS`), to items in one of the given
    /// `modules`, to a TAPD-side `status` value. Always sorts
    /// `order=created asc` (no `order_desc` knob — ascending is the only
    /// mode compatible with the `modified=>T` lower-bound pagination).
    /// Pages through the result set until one of the four terminating
    /// conditions fires.
    ///
    /// **Termination conditions.** The loop stops at the first one of:
    /// 1. The page comes back empty (`< 1` items) — TAPD ran out, or the
    ///    server-side `module` / `status` filter narrowed it to nothing.
    /// 2. After the multi-module post-filter, every item on this page was
    ///    discarded — the next page will discard everything too, so stop.
    /// 3. The page comes back smaller than `PAGE_LIMIT` (200) — classic
    ///    "last page" signal.
    /// 4. We've already requested `MAX_PAGES` (200) pages — defensive cap
    ///    against workspaces where `page` is broken and TAPD always returns
    ///    a full window of the earliest items (observed in production; see
    ///    workspace 69280376).
    ///
    /// (2) only fires when `module_filter` has more than one entry. When it
    /// has one, the single module goes onto the query string and TAPD does
    /// the filter server-side, making (2) equivalent to (1).
    /// Page through TAPD's `stories` / `tasks` / `bugs` list for one
    /// workspace, optionally filtered to items modified since `since` (full
    /// `YYYY-MM-DD HH:MM:SS` timestamp — the per-entity_type cursor), and
    /// filtered to items whose `module` matches any of `modules`.
    ///
    /// **Always sorts `order=created asc`** — the lower bound semantics of
    /// `modified=>T` only make sense in chronological order: anything
    /// modified after T can sit anywhere in a created-desc sorted set, and
    /// paging from the newest end would silently miss items whose
    /// `created` is older than the page window. Asc + full-timestamp
    /// `modified=>T` is the only stable combo for incremental syncs. (No
    /// `order_desc` knob — it's gone.)
    pub async fn list_work_items(
        &self,
        workspace_id: &str,
        entity_type: TapdEntityType,
        since: Option<&str>,
        modules: &[String],
        status: Option<&str>,
    ) -> Result<Vec<TapdWorkItem>, TapdClientError> {
        let mut all = Vec::new();
        let mut page = 1u32;
        const PAGE_LIMIT: u32 = 200;
        const MAX_PAGES: u32 = 200;
        // Post-filter by module on the client as well — TAPD's task/story/bug
        // endpoints are inconsistent on whether the `module` query is honored
        // (see the `module` doc comment at the top of this file), so the
        // safe path is server-side hint + client-side authoritative filter.
        let post_filter = !modules.is_empty();
        let allowed: std::collections::HashSet<&String> = if post_filter {
            modules.iter().collect()
        } else {
            std::collections::HashSet::new()
        };
        // Push the first configured module onto the query string as a hint
        // — useful when TAPD does honor `module` server-side, harmless when
        // it doesn't (see post-filter above). Comma-joined if the caller
        // somehow passes more than one (binding.module_filter is a Vec for
        // future expansion; today's UI sends at most one).
        let module_query = if !modules.is_empty() {
            Some(modules.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(","))
        } else {
            None
        };

        loop {
            let mut params: HashMap<&str, String> = HashMap::new();
            params.insert("workspace_id", workspace_id.to_string());
            params.insert("page", page.to_string());
            params.insert("limit", PAGE_LIMIT.to_string());
            params.insert("order", "created asc".to_string());
            if let Some(since) = since {
                params.insert("modified", format!(">{since}"));
            }
            if let Some(status) = status {
                params.insert("status", status.to_string());
            }
            if let Some(m) = module_query.as_deref() {
                params.insert("module", m.to_string());
            }

            let page_items = self.fetch_page(entity_type, &params).await?;
            let raw_got = page_items.len();

            // Condition 1: TAPD returned an empty page — workspace exhausted
            // or server-side filter narrowed to nothing.
            if raw_got == 0 {
                break;
            }

            let kept: Vec<TapdWorkItem> = if post_filter {
                page_items
                    .into_iter()
                    .filter(|item| {
                        item.module
                            .as_ref()
                            .is_some_and(|m| allowed.contains(m))
                    })
                    .collect()
            } else {
                page_items
            };
            let kept_got = kept.len();

            // Condition 2: server gave us a full page but our post-filter
            // dropped everything — further pages will only repeat the same
            // out-of-range window.
            if post_filter && kept_got == 0 && raw_got == PAGE_LIMIT as usize {
                break;
            }

            all.extend(kept);

            // Condition 3: short page — classic "this is the last page".
            if raw_got < PAGE_LIMIT as usize {
                break;
            }
            page += 1;
            if page > MAX_PAGES {
                tracing::warn!(
                    workspace_id,
                    entity_type = entity_type.as_str(),
                    pages = page - 1,
                    items = all.len(),
                    "TAPD list exceeded max pages; returning partial result (workspace likely has more items than the cap)",
                );
                break;
            }
        }

        Ok(all)
    }

    async fn fetch_page(
        &self,
        entity_type: TapdEntityType,
        params: &HashMap<&str, String>,
    ) -> Result<Vec<TapdWorkItem>, TapdClientError> {
        let base = self.config.base_url();
        let url = format!("{base}/{}", entity_type.endpoint());
        tracing::info!(method = "GET", url = %url, params = ?params, "TAPD request");
        let (header_name, header_value) = self.auth_header();

        let resp = self
            .http
            .get(&url)
            .query(&[("s", "mcp")])
            .query(params)
            .header(&header_name, &header_value)
            .header("Content-Type", "application/json")
            .header("Via", "mcp")
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(TapdClientError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| TapdClientError::Shape(format!("invalid JSON: {e}")))?;
        parse_work_items(entity_type, &parsed)
    }
}

/// TAPD wraps each list item under a singular key matching the entity type
/// (`{"Story": {...}}`, `{"Task": {...}}`, `{"Bug": {...}}`), per the
/// reference API docs' documented response shape.
fn parse_work_items(
    entity_type: TapdEntityType,
    body: &serde_json::Value,
) -> Result<Vec<TapdWorkItem>, TapdClientError> {
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| TapdClientError::Shape("missing `data` array".to_string()))?;

    let wrapper_key = match entity_type {
        TapdEntityType::Story => "Story",
        TapdEntityType::Task => "Task",
        TapdEntityType::Bug => "Bug",
    };

    let mut items = Vec::with_capacity(data.len());
    for entry in data {
        let item = entry.get(wrapper_key).unwrap_or(entry);
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TapdClientError::Shape("missing `id`".to_string()))?
            .to_string();
        let title = item
            .get("name")
            .or_else(|| item.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("(untitled)")
            .to_string();
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        items.push(TapdWorkItem {
            id,
            title,
            status,
            priority: str_field(item, "priority_label").or_else(|| str_field(item, "priority")),
            module: str_field(item, "module"),
            owner: str_field(item, "owner").or_else(|| str_field(item, "current_owner")),
            created: str_field(item, "created"),
            modified: str_field(item, "modified"),
            raw: item.clone(),
        });
    }
    Ok(items)
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_work_items_unwraps_singular_key() {
        let body = serde_json::json!({
            "status": 1,
            "data": [
                { "Task": { "id": "1001", "name": "修复登录", "status": "open", "module": "登录模块", "priority_label": "high", "created": "2026-01-01 10:00:00", "modified": "2026-01-02 09:00:00" } }
            ]
        });
        let items = parse_work_items(TapdEntityType::Task, &body).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "1001");
        assert_eq!(items[0].title, "修复登录");
        assert_eq!(items[0].module, Some("登录模块".to_string()));
        assert_eq!(items[0].priority, Some("high".to_string()));
    }

    #[test]
    fn parse_work_items_missing_data_is_shape_error() {
        let body = serde_json::json!({ "status": 1 });
        let err = parse_work_items(TapdEntityType::Task, &body).unwrap_err();
        assert!(matches!(err, TapdClientError::Shape(_)));
    }

    #[test]
    fn parse_work_items_tolerates_flat_shape_without_wrapper_key() {
        let body = serde_json::json!({
            "data": [ { "id": "2", "name": "x", "status": "open" } ]
        });
        let items = parse_work_items(TapdEntityType::Bug, &body).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "2");
    }

    #[test]
    fn entity_type_endpoint_mapping() {
        assert_eq!(TapdEntityType::Story.endpoint(), "stories");
        assert_eq!(TapdEntityType::Task.endpoint(), "tasks");
        assert_eq!(TapdEntityType::Bug.endpoint(), "bugs");
    }

    #[test]
    fn entity_type_parse_roundtrip() {
        for et in [TapdEntityType::Story, TapdEntityType::Task, TapdEntityType::Bug] {
            assert_eq!(TapdEntityType::parse(et.as_str()), Some(et));
        }
        assert_eq!(TapdEntityType::parse("bogus"), None);
    }
}
