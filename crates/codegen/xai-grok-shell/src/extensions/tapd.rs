//! `x.ai/tapd/*` ext methods for the TAPD workbench.
//!
//! - `x.ai/tapd/status` — workbench snapshot for one directory (binding,
//!   cursor, task counts, known modules, recent sync runs).
//! - `x.ai/tapd/tasks/list` — the task queue for one directory, filtered.
//! - `x.ai/tapd/sync/trigger` — manual sync; awaits completion and runs the
//!   exact same [`crate::tapd::sync::sync_project`] pipeline the background
//!   timer uses.
//!
//! Project bindings and credentials are not exposed here — they are managed
//! through the existing `PATCH /config-file` mechanism (`[tapd]` /
//! `[tapd.projects.<key>]` in `config.toml`), same as `mcp_servers`.

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};

use super::{ExtResult, parse_params, to_ext_response};
use crate::agent::MvpAgent;
use crate::tapd::disk_config_source::DiskTapdConfigSource;
use crate::tapd::store::{TapdStore, TaskListFilter};
use crate::workbench::dispatcher::HealthSnapshot;
use crate::tapd::sync::TapdConfigSource;

pub mod tapd_methods {
    pub const STATUS: &str = "x.ai/tapd/status";
    pub const TASKS_LIST: &str = "x.ai/tapd/tasks/list";
    pub const SYNC_TRIGGER: &str = "x.ai/tapd/sync/trigger";
    pub const SYNC_STATUS_NOTIFICATION: &str = "x.ai/tapd/sync_status";
    pub const WORKBENCH_HEALTH: &str = "x.ai/tapd/workbench/health";
pub const WORKBENCH_METRICS: &str = "x.ai/workbench/metrics";
pub const WORKBENCH_TIMELINE: &str = "x.ai/workbench/timeline";
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryRequest {
    directory: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchStatusResponse {
    /// Whether a usable binding exists at all — explicit entry OR one derived
    /// from `[tapd].default_workspace_id`.
    bound: bool,
    /// The binding actually in effect for this directory, so the UI can show
    /// and edit the resolved workspace/modules without re-deriving them.
    #[serde(skip_serializing_if = "Option::is_none")]
    binding: Option<BindingDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<CursorDto>,
    counts: CountsDto,
    modules: Vec<String>,
    recent_runs: Vec<RunDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingDto {
    directory: String,
    workspace_id: String,
    entity_types: Vec<String>,
    module_filter: Vec<String>,
    /// false = inherited from `default_workspace_id` (nothing written under
    /// `[tapd.projects.*]` for this directory yet).
    explicit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorDto {
    directory: String,
    workspace_id: String,
    last_synced_modified: Option<String>,
    last_sync_started_at: Option<i64>,
    last_sync_finished_at: Option<i64>,
    last_sync_status: Option<String>,
    last_sync_error: Option<String>,
    last_sync_duration_ms: Option<i64>,
    last_sync_stats: StatsDto,
    is_syncing: bool,
    next_sync_at: Option<i64>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct StatsDto {
    fetched: i64,
    added: i64,
    updated: i64,
    duplicate: i64,
    failed: i64,
}

impl From<&crate::tapd::store::SyncStats> for StatsDto {
    fn from(s: &crate::tapd::store::SyncStats) -> Self {
        Self {
            fetched: s.fetched,
            added: s.added,
            updated: s.updated,
            duplicate: s.duplicate,
            failed: s.failed,
        }
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct CountsDto {
    pending: i64,
    processing: i64,
    completed: i64,
    failed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    id: i64,
    directory: String,
    started_at: i64,
    finished_at: Option<i64>,
    trigger: String,
    status: String,
    stats: StatsDto,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksListRequest {
    directory: String,
    #[serde(default)]
    filter: TaskFilterDto,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TaskFilterDto {
    queue_state: Option<String>,
    entity_type: Option<String>,
    module: Option<String>,
    search: Option<String>,
    sort: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

impl From<TaskFilterDto> for TaskListFilter {
    fn from(f: TaskFilterDto) -> Self {
        Self {
            queue_state: f.queue_state,
            entity_type: f.entity_type,
            module: f.module,
            search: f.search,
            sort: f.sort,
            limit: f.limit,
            offset: f.offset,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TasksListResponse {
    tasks: Vec<TaskDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDto {
    id: String,
    directory: String,
    workspace_id: String,
    entity_type: String,
    tapd_id: String,
    title: String,
    status: String,
    priority: Option<String>,
    module: Option<String>,
    owner: Option<String>,
    tapd_created_at: Option<String>,
    tapd_modified_at: Option<String>,
    queue_state: String,
    enqueued_at: i64,
    completed_at: Option<i64>,
    retry_count: i64,
    max_retries: i64,
    last_error: Option<String>,
    /// Deep link to the item on TAPD's own site, per the reference client's
    /// documented link format (`{base}/{workspace_id}/prong/{kind}/view/{id}`
    /// for stories/tasks, `.../bugtrace/bugs/view/{id}` for bugs).
    tapd_url: String,
}

fn tapd_url(base_url: &str, workspace_id: &str, entity_type: &str, tapd_id: &str) -> String {
    let base = if base_url.is_empty() {
        "https://www.tapd.cn"
    } else {
        base_url
    };
    match entity_type {
        "story" => format!("{base}/{workspace_id}/prong/stories/view/{tapd_id}"),
        "bug" => format!("{base}/{workspace_id}/bugtrace/bugs/view/{tapd_id}"),
        _ => format!("{base}/{workspace_id}/prong/tasks/view/{tapd_id}"),
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncTriggerRequest {
    directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncTriggerResponse {
    ok: bool,
}

pub async fn handle(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    match args.method.as_ref() {
        tapd_methods::STATUS => handle_status(agent, args).await,
        tapd_methods::TASKS_LIST => handle_tasks_list(agent, args).await,
        tapd_methods::SYNC_TRIGGER => handle_sync_trigger(agent, args).await,
        tapd_methods::WORKBENCH_HEALTH => handle_workbench_health(agent, args).await,
        tapd_methods::WORKBENCH_METRICS => handle_workbench_metrics(agent, args).await,
        tapd_methods::WORKBENCH_TIMELINE => handle_workbench_timeline(agent, args).await,
        _ => Err(acp::Error::method_not_found()),
    }
}

/// Deep links always go to the documented public site
/// (`https://www.tapd.cn`), never the configured API base — the API base is
/// typically `api.tapd.cn`, which isn't browsable.
fn frontend_base_url() -> String {
    "https://www.tapd.cn".to_string()
}

/// Reads `[tapd]` straight from `config.toml` on disk — same as the
/// background sync manager (see `crate::tapd::disk_config_source`'s doc
/// comment). `agent.cfg` is a snapshot taken at process/session start and
/// never refreshed, so it would show a binding as absent right after the
/// user saves it via `PATCH /config-file`.
fn disk_config_source() -> DiskTapdConfigSource {
    DiskTapdConfigSource::new(xai_grok_config::grok_home())
}

async fn handle_status(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: DirectoryRequest = parse_params(args)?;
    let store = agent.tapd_store();
    let base_url = frontend_base_url();
    let config_source = disk_config_source();

    // Effective binding: explicit `[tapd.projects.*]` entry, else derived from
    // `[tapd].default_workspace_id` with the directory name as module filter.
    let effective = config_source.binding_for(&req.directory);
    let explicit = config_source.has_explicit_binding(&req.directory);
    let binding_dto = effective.as_ref().map(|b| BindingDto {
        directory: b.directory.clone(),
        workspace_id: b.workspace_id.clone(),
        entity_types: b.entity_types.iter().map(|e| e.as_str().to_string()).collect(),
        module_filter: b.module_filter.clone(),
        explicit,
    });
    let binding_exists = effective.is_some();

    let result = tokio::task::spawn_blocking({
        let store = store.clone();
        let directory = req.directory.clone();
        move || -> anyhow::Result<(Option<CursorDto>, CountsDto, Vec<String>, Vec<RunDto>)> {
            // get_cursor_summary aggregates per-(directory, entity_type)
            // cursors into a single view for the workbench header. The
            // aggregate carries a synthetic `entity_type` (lexicographic min)
            // since the summary has no single type.
            let cursor = store.get_cursor_summary(&directory)?;
            let is_syncing = cursor.as_ref().is_some_and(|c| c.lock_owner.is_some());
            let cursor_dto = cursor.map(|c| CursorDto {
                directory: c.directory,
                workspace_id: c.workspace_id,
                last_synced_modified: c.last_synced_modified,
                last_sync_started_at: c.last_sync_started_at,
                last_sync_finished_at: c.last_sync_finished_at,
                last_sync_status: c.last_sync_status,
                last_sync_error: c.last_sync_error,
                last_sync_duration_ms: c.last_sync_duration_ms,
                last_sync_stats: StatsDto::from(&c.last_sync_stats),
                is_syncing,
                // Resolved below, once the poll interval is available from
                // config — the store has no notion of it.
                next_sync_at: None,
            });
            let counts_raw = store.task_counts(&directory)?;
            let counts = CountsDto {
                pending: counts_raw.pending,
                processing: counts_raw.processing,
                completed: counts_raw.completed,
                failed: counts_raw.failed,
            };
            let modules = store.distinct_modules(&directory)?;
            let runs = store
                .recent_runs(&directory, 20)?
                .into_iter()
                .map(|r| RunDto {
                    id: r.id,
                    directory: r.directory,
                    started_at: r.started_at,
                    finished_at: r.finished_at,
                    trigger: r.trigger,
                    status: r.status,
                    stats: StatsDto::from(&r.stats),
                    error: r.error,
                })
                .collect();
            Ok((cursor_dto, counts, modules, runs))
        }
    })
    .await
    .map_err(|e| acp::Error::internal_error().data(e.to_string()))?;

    let (mut cursor_dto, counts, modules, recent_runs) =
        result.map_err(|e| acp::Error::internal_error().data(e.to_string()))?;

    // Resolve next_sync_at properly now that we have the poll interval from
    // config (the store layer is interval-agnostic by design).
    if let Some(cursor) = cursor_dto.as_mut() {
        let poll_secs = config_source.poll_interval().as_secs() as i64;
        cursor.next_sync_at = cursor
            .last_sync_finished_at
            .filter(|_| !cursor.is_syncing)
            .map(|finished| finished + poll_secs);
    }
    let _ = base_url;

    to_ext_response(Ok(WorkbenchStatusResponse {
        bound: binding_exists,
        binding: binding_dto,
        cursor: cursor_dto,
        counts,
        modules,
        recent_runs,
    }))
}

async fn handle_tasks_list(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: TasksListRequest = parse_params(args)?;
    let store = agent.tapd_store();
    let base_url = frontend_base_url();
    let filter: TaskListFilter = req.filter.into();

    let tasks = tokio::task::spawn_blocking({
        let store = store.clone();
        let directory = req.directory.clone();
        move || store.list_tasks(&directory, &filter)
    })
    .await
    .map_err(|e| acp::Error::internal_error().data(e.to_string()))?
    .map_err(|e| acp::Error::internal_error().data(e.to_string()))?;

    let tasks = tasks
        .into_iter()
        .map(|t| TaskDto {
            tapd_url: tapd_url(&base_url, &t.workspace_id, &t.entity_type, &t.tapd_id),
            id: t.id,
            directory: t.directory,
            workspace_id: t.workspace_id,
            entity_type: t.entity_type,
            tapd_id: t.tapd_id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            module: t.module,
            owner: t.owner,
            tapd_created_at: t.tapd_created_at,
            tapd_modified_at: t.tapd_modified_at,
            queue_state: t.queue_state,
            enqueued_at: t.enqueued_at,
            completed_at: t.completed_at,
            retry_count: t.retry_count,
            max_retries: t.max_retries,
            last_error: t.last_error,
        })
        .collect();

    to_ext_response(Ok(TasksListResponse { tasks }))
}

async fn handle_sync_trigger(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: SyncTriggerRequest = parse_params(args)?;
    let manager = agent
        .tapd_sync_manager()
        .ok_or_else(|| acp::Error::internal_error().data("TAPD sync service is not running"))?;

    manager
        .trigger_now(req.directory)
        .await
        .map_err(|e| acp::Error::internal_error().data(e))?;

    to_ext_response(Ok(SyncTriggerResponse { ok: true }))
}


async fn handle_workbench_health(agent: &MvpAgent, _args: &acp::ExtRequest) -> ExtResult {
    let snapshot = match agent.workbench_dispatcher.borrow().as_ref() {
        Some(d) => d.health_snapshot(),
        None => crate::workbench::dispatcher::HealthSnapshot::default(),
    };
    to_ext_response(Ok(snapshot))
}

#[derive(serde::Deserialize, Default)]
struct MetricsRequest {
    task_id: Option<String>,
    since_ts: Option<i64>,
}

/// v2 spec §9.2.2: aggregate `workbench_task_metrics` rows into a per-stage
/// summary (p50/p90/retry_count/fallback_count). Pulls rows from the
/// `TapdStore::task_metrics` DAO (per-task); the front-end calls this with
/// no project_key for the global view, or with one for the per-project
/// dashboard.
async fn handle_workbench_metrics(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: MetricsRequest = parse_params(args)?;
    let since_ts = req.since_ts.unwrap_or(0);
    let dispatcher = match agent.workbench_dispatcher.borrow().as_ref() {
        Some(d) => d.clone(),
      None => return to_ext_response(Ok(default_metrics_summary(req.task_id, since_ts))),
    };
    let rows = tokio::task::spawn_blocking({
        let store = dispatcher.store_clone();
        let task_id = req.task_id.clone();
        move || -> anyhow::Result<Vec<crate::tapd::store::TaskMetricRow>> {
            match task_id {
                Some(id) => Ok(store.task_metrics(&id)?),
                None => Ok(store.all_task_metrics()?),
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("join error: {e}"))??;
    let summary = crate::workbench::metrics::aggregate(&rows, since_ts);
    to_ext_response(Ok(summary))
}

fn default_metrics_summary(task_id: Option<String>, since_ts: i64) -> serde_json::Value {
    serde_json::json!({
        "project_key": task_id,
        "since_ts": since_ts,
        "totals": { "done": 0, "blocked": 0, "dead": 0, "sample_size": 0 },
        "stages": [],
    })
}

/// v2 spec §9.2.4: read the per-task event log. Joins `workbench_task_metrics`
/// (one row per (stage, attempt)) with `workbench_task_state` text field
/// (which encodes e.g. "running:<stage>:<attempt>") to build an ordered event list.
async fn handle_workbench_timeline(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    #[derive(serde::Deserialize)]
    struct Req {
        tapd_id: String,
    }
    let req: Req = parse_params(args)?;
    let dispatcher = match agent.workbench_dispatcher.borrow().as_ref() {
        Some(d) => d.clone(),
        None => return to_ext_response(Ok(serde_json::json!({"tapd_id": req.tapd_id, "events": []}))),
    };
    let events = tokio::task::spawn_blocking({
        let store = dispatcher.store_clone();
        let tapd_id = req.tapd_id.clone();
        move || -> anyhow::Result<serde_json::Value> {
            let rows = store.task_metrics(&tapd_id)?;
            let current_state = store.get_workbench_state(&tapd_id)?.unwrap_or_default();
            let mut events: Vec<serde_json::Value> = Vec::with_capacity(rows.len() + 1);
            events.push(serde_json::json!({"ts": 0, "kind": "pending"}));
            for row in rows {
                let kind = match row.finished_at {
                    Some(_) => "stage_done",
                    None => "running",
                };
                let mut evt = serde_json::json!({
                    "ts": row.started_at,
                    "kind": kind,
                    "stage": row.stage,
                    "attempt": row.attempt,
                    "model": row.model,
                });
                if let Some(d) = row.duration_ms {
                    evt["duration_ms"] = serde_json::json!(d);
                }
                if let Some(f) = row.finished_at {
                    evt["finished_at"] = serde_json::json!(f);
                }
                if row.fallback_used != 0 {
                    evt["fallback_used"] = serde_json::json!(true);
                }
                events.push(evt);
            }
            if !current_state.is_empty() {
                events.push(serde_json::json!({
                    "ts": chrono::Utc::now().timestamp(),
                    "kind": "state",
                    "state": current_state,
                }));
            }
            Ok(serde_json::json!({"tapd_id": tapd_id, "events": events}))
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("join error: {e}"))??;
    to_ext_response(Ok(events))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tapd_url_uses_documented_link_formats() {
        assert_eq!(
            tapd_url("https://www.tapd.cn", "123", "task", "456"),
            "https://www.tapd.cn/123/prong/tasks/view/456"
        );
        assert_eq!(
            tapd_url("https://www.tapd.cn", "123", "story", "456"),
            "https://www.tapd.cn/123/prong/stories/view/456"
        );
        assert_eq!(
            tapd_url("https://www.tapd.cn", "123", "bug", "456"),
            "https://www.tapd.cn/123/bugtrace/bugs/view/456"
        );
    }

    #[test]
    fn tapd_url_falls_back_to_default_site_when_empty() {
        assert_eq!(
            tapd_url("", "123", "task", "456"),
            "https://www.tapd.cn/123/prong/tasks/view/456"
        );
    }
}

#[test]
fn metrics_request_parses_task_id_and_since_ts() {
    let json = r#"{"task_id": "TAPD-1", "since_ts": 1700000000}"#;
    let req: MetricsRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.task_id.as_deref(), Some("TAPD-1"));
    assert_eq!(req.since_ts, Some(1700000000));
}

#[test]
fn metrics_request_allows_missing_fields() {
    let json = "{}";
    let req: MetricsRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.task_id, None);
    assert_eq!(req.since_ts, None);
}



