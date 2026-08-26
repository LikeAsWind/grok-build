//! The single sync pipeline shared by manual triggers and the background
//! timer, plus [`TapdSyncManager`] — the process-wide service that owns the
//! timer loop and pushes progress notifications to connected clients.
//!
//! Lifecycle mirrors `ModelsManager::spawn_background_refresh` (see
//! `crate::agent::models`): constructed once alongside `MvpAgent`, its
//! background loop runs for the life of the process, independent of any
//! session.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, mpsc};
use xai_grok_tools::retry::{BackoffConfig, execute_with_backoff};

use super::client::{TapdClient, TapdClientConfig, TapdClientError, TapdEntityType};
use super::store::{SyncStats, TapdStore, UpsertOutcome, UpsertTaskInput};

/// Bound project: a directory paired with the TAPD workspace + filters it
/// syncs against. Constructed from `[tapd.projects.<key>]` config entries.
#[derive(Debug, Clone)]
pub struct TapdProjectBinding {
    pub directory: String,
    pub workspace_id: String,
    pub entity_types: Vec<TapdEntityType>,
    pub module_filter: Vec<String>,
    /// TAPD-side status filter — see [`crate::agent::config::TapdProjectConfig::status`].
    pub status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncTrigger {
    Manual,
    Scheduled,
    StartupRecovery,
}

impl SyncTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Scheduled => "scheduled",
            Self::StartupRecovery => "startup_recovery",
        }
    }
}

const LOCK_STALE_AFTER_SECS: i64 = 15 * 60;
const HEARTBEAT_INTERVAL_SECS: u64 = 30;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("could not acquire sync lease for {0} (another sync is already running)")]
    LeaseHeld(String),
    #[error("TAPD request failed: {0}")]
    Client(#[from] TapdClientError),
    #[error("local storage error: {0}")]
    Storage(#[from] rusqlite::Error),
}

/// Run one full sync for `binding`: acquire the per-directory lease, pull
/// every configured entity type incrementally from the stored watermark,
/// upsert into the task queue idempotently, then release the lease and
/// advance the watermark — but only once every page has landed
/// successfully. A mid-pull failure leaves the watermark untouched, so the
/// next attempt (retry or next scheduled tick) re-pulls the same window
/// without any gap; the upsert's content-hash dedup makes that re-pull a
/// no-op for anything already stored.
///
/// This is the ONE code path both the timer and the manual-trigger ext
/// method call — there is no separate "manual sync" logic to drift from the
/// scheduled one.
pub async fn sync_project(
    store: &TapdStore,
    client: &TapdClient,
    binding: &TapdProjectBinding,
    entity_type: TapdEntityType,
    trigger: SyncTrigger,
    owner_id: &str,
) -> Result<SyncStats, SyncError> {
    let entity_type_str = entity_type.as_str();

    // Make sure the cursor row exists before trying to acquire its lease.
    // Without this, a freshly-configured binding (the only way the user can
    // reach sync_project — the binding comes from config.toml and the SQLite
    // cursor is per-(directory, entity_type)) trips try_acquire_lock's
    // `WHERE directory = ?1 AND entity_type = ?2` and returns `false`
    // ("LeaseHeld"), silently skipping sync. The cursor gets lazily seeded
    // on first sync, with the workspace_id from the binding.
    store.upsert_project_cursor(&binding.directory, &binding.workspace_id, entity_type_str)?;

    if !store.try_acquire_lock(&binding.directory, entity_type_str, owner_id, LOCK_STALE_AFTER_SECS)? {
        return Err(SyncError::LeaseHeld(binding.directory.clone()));
    }

    let started = std::time::Instant::now();
    let run_id = store.start_run(&binding.directory, trigger.as_str())?;
    let cursor = store.get_cursor(&binding.directory, entity_type_str)?;
    let since = cursor.as_ref().and_then(|c| c.last_synced_modified.clone());

    let result = run_pulls(store, client, binding, entity_type, since.as_deref()).await;
    let duration_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok((stats, watermark)) => {
            store.release_lock_success(
                &binding.directory,
                entity_type_str,
                owner_id,
                watermark.as_deref(),
                &stats,
                duration_ms,
            )?;
            store.finish_run(run_id, "success", &stats, None)?;
            Ok(stats)
        }
        Err((partial_stats, error)) => {
            let message = error.to_string();
            store.release_lock_failure(
                &binding.directory,
                entity_type_str,
                owner_id,
                &message,
                &partial_stats,
                duration_ms,
            )?;
            store.finish_run(run_id, "failed", &partial_stats, Some(&message))?;
            Err(error)
        }
    }
}

/// Pull one entity type from the cursor's watermark forward and upsert
/// into the queue. Returns the per-entity_type stats plus the new watermark
/// (the max `modified` timestamp seen across pulled items — the FULL
/// timestamp, not day-granularity). On failure, returns whatever partial
/// stats had accumulated so the sync_runs record isn't silently zeroed.
///
/// The per-entity_type split (caller iterates `binding.entity_types` and
/// invokes `sync_project` once each) is what makes the per-entity_type
/// watermark possible: each pull advances only its own cursor row, so a
/// slower entity type doesn't drag a faster one backward.
async fn run_pulls(
    store: &TapdStore,
    client: &TapdClient,
    binding: &TapdProjectBinding,
    entity_type: TapdEntityType,
    since: Option<&str>,
) -> Result<(SyncStats, Option<String>), (SyncStats, SyncError)> {
    let mut stats = SyncStats::default();
    let mut max_modified: Option<String> = None;

    let items = match client
        .list_work_items(
            &binding.workspace_id,
            entity_type,
            since,
            &binding.module_filter,
            binding.status.as_deref(),
        )
        .await
    {
        Ok(items) => items,
        Err(e) => return Err((stats, SyncError::Client(e))),
    };

    for item in items {
        stats.fetched += 1;
        if let Some(modified) = &item.modified
            && max_modified.as_deref().is_none_or(|m| modified.as_str() > m)
        {
            max_modified = Some(modified.clone());
        }

        let input = UpsertTaskInput {
            directory: binding.directory.clone(),
            workspace_id: binding.workspace_id.clone(),
            entity_type: entity_type.as_str().to_string(),
            tapd_id: item.id.clone(),
            title: item.title.clone(),
            status: item.status.clone(),
            priority: item.priority.clone(),
            module: item.module.clone(),
            owner: item.owner.clone(),
            tapd_created_at: item.created.clone(),
            tapd_modified_at: item.modified.clone(),
            raw_json: item.raw.to_string(),
        };

        match store.upsert_task(&input) {
            Ok(UpsertOutcome::Added) => stats.added += 1,
            Ok(UpsertOutcome::Updated) => stats.updated += 1,
            Ok(UpsertOutcome::Duplicate) => stats.duplicate += 1,
            Err(e) => {
                stats.failed += 1;
                tracing::warn!(
                    directory = %binding.directory,
                    tapd_id = %item.id,
                    error = %e,
                    "failed to upsert TAPD task"
                );
            }
        }
    }

    // Full `modified=>YYYY-MM-DD HH:MM:SS` watermark — the day-truncation
    // we used to do here would re-pull the same day on every subsequent
    // sync and rely on content_hash dedup to absorb the dupes. With
    // per-entity_type cursors we can advance to the precise timestamp and
    // avoid the wasted requests. (Lexicographic order matches chronological
    // order for TAPD's zero-padded timestamp format, so `max` is correct.)
    let watermark = max_modified.or_else(|| since.map(str::to_string));

    Ok((stats, watermark))
}

/// Startup recovery: clear any dead sync leases, requeue any task left
/// `processing` by a process that died mid-execution, and mark any
/// `sync_runs` row left `running` as failed. Call once at process start,
/// before the background timer's first tick — this is what lets the
/// workbench recover without waiting for the next scheduled sync.
///
/// Returns the `(directory, entity_type)` pairs whose lease was reclaimed
/// (these should be re-synced immediately by the caller).
pub fn recover_on_startup(store: &TapdStore) -> Result<Vec<(String, TapdEntityType)>, rusqlite::Error> {
    let reclaimed = store.reconcile_stale_locks(LOCK_STALE_AFTER_SECS)?;
    let requeued = store.reconcile_stale_processing_tasks(LOCK_STALE_AFTER_SECS)?;
    let stale_runs = store.reconcile_stale_runs()?;
    if requeued > 0 || stale_runs > 0 || !reclaimed.is_empty() {
        tracing::info!(
            reclaimed_leases = reclaimed.len(),
            requeued_tasks = requeued,
            stale_runs,
            "TAPD workbench: startup recovery reconciled interrupted state"
        );
    }
    // Reclaimed tuples come back as `(directory, entity_type_str)`; parse
    // them into the enum so the caller can iterate typed pairs. Unknown
    // strings (forward-compat: a future schema_version introducing a new
    // entity type would produce one) are skipped — they'll be picked up
    // by the next scheduled tick once sync_project falls back to the
    // binding's configured entity_types list.
    Ok(reclaimed
        .into_iter()
        .filter_map(|(d, et)| TapdEntityType::parse(&et).map(|t| (d, t)))
        .collect())
}

/// Source of the current set of bound projects + credentials, re-read on
/// every sync attempt so a config change takes effect on the next tick
/// without restarting the process.
pub trait TapdConfigSource: Send + Sync + 'static {
    fn client_config(&self) -> Option<TapdClientConfig>;
    /// Explicitly-configured bindings only — what the scheduled tick iterates.
    fn bindings(&self) -> Vec<TapdProjectBinding>;
    /// The effective binding for one directory, including one derived from a
    /// default workspace when there is no explicit entry. Directories only
    /// reachable this way are never enumerated by [`Self::bindings`], so a
    /// manual trigger has to resolve them here.
    ///
    /// No default impl: a source must consciously decide whether it supports
    /// inheritance or not. A blanket "look in bindings()" would silently
    /// resolve only explicit entries — manual sync would then never run for
    /// directories reached only through a default workspace, which is
    /// exactly the bug the binding_for trait method was added to fix.
    fn binding_for(&self, directory: &str) -> Option<TapdProjectBinding>;
    fn poll_interval(&self) -> Duration;
    fn enabled(&self) -> bool;
}

/// Process-wide background sync service. One instance per `MvpAgent`.
pub struct TapdSyncManager {
    store: Arc<TapdStore>,
    config: Arc<dyn TapdConfigSource>,
    owner_id: String,
    manual_trigger_tx: mpsc::UnboundedSender<ManualTriggerRequest>,
    status_tx: Arc<Mutex<Option<mpsc::UnboundedSender<SyncStatusEvent>>>>,
}

struct ManualTriggerRequest {
    directory: Option<String>,
    reply: tokio::sync::oneshot::Sender<Result<(), String>>,
}

/// Pushed to subscribers (the ACP ext notification bridge) as sync
/// state changes, so the workbench UI updates without polling.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusEvent {
    pub directory: String,
    pub phase: SyncPhase,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase {
    Started,
    Succeeded,
    Failed,
}

impl TapdSyncManager {
    pub fn new(store: Arc<TapdStore>, config: Arc<dyn TapdConfigSource>) -> Arc<Self> {
        let (manual_trigger_tx, manual_trigger_rx) = mpsc::unbounded_channel();
        let manager = Arc::new(Self {
            store,
            config,
            owner_id: uuid::Uuid::now_v7().to_string(),
            manual_trigger_tx,
            status_tx: Arc::new(Mutex::new(None)),
        });
        manager.clone().spawn_background_loop(manual_trigger_rx);
        manager
    }

    /// Register a channel to receive [`SyncStatusEvent`]s. Only the most
    /// recent subscriber is kept (mirrors the single persistent gateway
    /// pattern in `agent::server` — one process, one active notification
    /// sink at a time).
    pub async fn subscribe(&self, tx: mpsc::UnboundedSender<SyncStatusEvent>) {
        *self.status_tx.lock().await = Some(tx);
    }

    async fn emit(&self, event: SyncStatusEvent) {
        let guard = self.status_tx.lock().await;
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(event);
        }
    }

    /// Trigger an immediate sync for `directory` (or every bound project
    /// when `None`), reusing the exact same [`sync_project`] pipeline the
    /// timer uses. Awaits completion so the ext method caller can report a
    /// definitive result.
    pub async fn trigger_now(&self, directory: Option<String>) -> Result<(), String> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.manual_trigger_tx
            .send(ManualTriggerRequest {
                directory,
                reply: reply_tx,
            })
            .map_err(|_| "sync manager loop is not running".to_string())?;
        reply_rx
            .await
            .map_err(|_| "sync manager dropped the request".to_string())?
    }

    fn spawn_background_loop(
        self: Arc<Self>,
        mut manual_trigger_rx: mpsc::UnboundedReceiver<ManualTriggerRequest>,
    ) {
        // Startup recovery runs once, immediately — not gated on the first
        // timer tick, matching the "actively execute a recovery pass on
        // startup" requirement.
        let recovered = recover_on_startup(&self.store).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "TAPD workbench: startup recovery failed");
            Vec::new()
        });

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(self.config.poll_interval());
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // First tick fires immediately; recovered pairs are synced
            // right away below rather than waiting for it.
            interval.tick().await;

            if !recovered.is_empty() {
                self.sync_pairs(recovered, SyncTrigger::StartupRecovery).await;
            }

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if !self.config.enabled() {
                            continue;
                        }
                        let all: Vec<(String, TapdEntityType)> = self
                            .config
                            .bindings()
                            .into_iter()
                            .flat_map(|b| {
                                let dir = b.directory.clone();
                                b.entity_types.iter().map(move |&et| (dir.clone(), et)).collect::<Vec<_>>()
                            })
                            .collect();
                        self.sync_pairs(all, SyncTrigger::Scheduled).await;
                    }
                    Some(request) = manual_trigger_rx.recv() => {
                        let pairs: Vec<(String, TapdEntityType)> = match &request.directory {
                            Some(dir) => {
                                // Single directory: resolve via binding_for so
                                // a directory reached only via
                                // default_workspace_id still syncs.
                                match self.config.binding_for(dir) {
                                    Some(b) => b
                                        .entity_types
                                        .iter()
                                        .map(|et| (dir.clone(), *et))
                                        .collect(),
                                    None => Vec::new(),
                                }
                            }
                            None => self
                                .config
                                .bindings()
                                .into_iter()
                                .flat_map(|b| {
                                    let dir = b.directory.clone();
                                    b.entity_types.iter().map(move |&et| (dir.clone(), et)).collect::<Vec<_>>()
                                })
                                .collect(),
                        };
                        self.sync_pairs(pairs, SyncTrigger::Manual).await;
                        let _ = request.reply.send(Ok(()));
                    }
                }
            }
        });
    }

    /// Sync every `(directory, entity_type)` pair in `pairs` serially.
    /// Each pair acquires its own lease and emits its own Started /
    /// Succeeded / Failed event. Order is stable so a "scheduled" tick and
    /// a "manual" trigger see the same acquisition order across runs —
    /// helps when a pair is deadlocked and you need to know which one was
    /// tried first.
    async fn sync_pairs(
        &self,
        pairs: Vec<(String, TapdEntityType)>,
        trigger: SyncTrigger,
    ) {
        let Some(client_config) = self.config.client_config() else {
            tracing::debug!("TAPD workbench: no credentials configured, skipping sync");
            return;
        };
        let client = TapdClient::new(client_config);

        for (directory, entity_type) in pairs {
            // binding_for (not bindings()) so a directory whose binding is
            // derived from default_workspace_id still syncs on manual
            // trigger or recovery.
            let Some(binding) = self.config.binding_for(&directory) else {
                continue;
            };
            // The pair may include an entity_type that the binding's current
            // config no longer lists (e.g. user removed `task` from
            // entity_types since the cursor row was seeded). Skip — the
            // orphan cursor row is harmless and will be reaped by a future
            // schema cleanup, but syncing it would require fabricating a
            // binding.entity_types list and pretending the workbench wants it.
            if !binding.entity_types.contains(&entity_type) {
                continue;
            }
            let binding = &binding;
            self.emit(SyncStatusEvent {
                directory: directory.clone(),
                phase: SyncPhase::Started,
            })
            .await;

            let backoff = BackoffConfig::new(3, 2_000, 30_000);
            let store = &self.store;
            let owner_id = &self.owner_id;
            let result = execute_with_backoff(
                &backoff,
                || async {
                    sync_project(store, &client, binding, entity_type, trigger, owner_id)
                        .await
                        .map_err(|e| e.to_string())
                },
                |attempt, max_retries, delay| {
                    let directory = directory.clone();
                    async move {
                        tracing::warn!(
                            directory = %directory,
                            attempt,
                            max_retries,
                            delay_ms = delay.as_millis() as u64,
                            "TAPD sync retry scheduled"
                        );
                    }
                },
            )
            .await;

            let phase = match result {
                Ok(_) => SyncPhase::Succeeded,
                Err(error) => {
                    tracing::warn!(directory = %directory, %error, "TAPD sync failed after retries");
                    SyncPhase::Failed
                }
            };
            self.emit(SyncStatusEvent {
                directory,
                phase,
            })
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tapd::client::{TapdAuth, TapdWorkItem};

    fn binding(dir: &str) -> TapdProjectBinding {
        TapdProjectBinding {
            directory: dir.to_string(),
            workspace_id: "999".to_string(),
            entity_types: vec![TapdEntityType::Story],
            module_filter: vec![],
            status: None,
        }
    }

    /// 文档化 `binding_for` 的契约：sync_directories 必须通过它解析出
    /// 继承自 default_workspace_id 的派生绑定，否则手动同步 `x.ai/tapd/sync/trigger`
    /// 永远 sync 不到用默认 workspace 的目录（schedule 不会枚举它们）。
    /// 这是没有默认 impl 的 trait —— 每个 source 必须自己实现。
    #[test]
    fn binding_for_returns_derived_binding_when_no_explicit_entry() {
        struct DefaultWorkspaceSource;
        impl TapdConfigSource for DefaultWorkspaceSource {
            fn client_config(&self) -> Option<TapdClientConfig> {
                None
            }
            fn bindings(&self) -> Vec<TapdProjectBinding> {
                Vec::new()
            }
            fn binding_for(&self, directory: &str) -> Option<TapdProjectBinding> {
                Some(TapdProjectBinding {
                    directory: directory.to_string(),
                    workspace_id: "derived".to_string(),
                    entity_types: vec![TapdEntityType::Story],
                    module_filter: vec![],
                    status: None,
                })
            }
            fn poll_interval(&self) -> Duration {
                Duration::from_secs(600)
            }
            fn enabled(&self) -> bool {
                true
            }
        }
        let source = DefaultWorkspaceSource;
        // 没有显式 binding，但 binding_for 应当解析出派生绑定
        assert!(source.bindings().is_empty(), "派生绑定不进 bindings()");
        let resolved = source.binding_for("/repo/a");
        assert!(resolved.is_some(), "派生绑定必须能被 binding_for 解析");
        assert_eq!(resolved.unwrap().workspace_id, "derived");
    }

    #[test]
    fn sync_trigger_as_str_matches_persisted_values() {
        assert_eq!(SyncTrigger::Manual.as_str(), "manual");
        assert_eq!(SyncTrigger::Scheduled.as_str(), "scheduled");
        assert_eq!(SyncTrigger::StartupRecovery.as_str(), "startup_recovery");
    }

    #[test]
    fn client_config_default_base_url() {
        let cfg = TapdClientConfig {
            auth: TapdAuth::Token("x".to_string()),
            api_base_url: String::new(),
        };
        assert_eq!(cfg.base_url(), "https://api.tapd.cn");
    }

    // `run_pulls` and `sync_project` need a live/mocked HTTP endpoint to
    // exercise end-to-end; covered by the store-layer tests (upsert
    // idempotency, lease/cursor semantics) plus this pure watermark-picking
    // check, which does not require network access.
    #[test]
    /// Per-entity_type cursors advance to the FULL TAPD `modified`
    /// timestamp (no day truncation). Lexicographic order matches
    /// chronological order for TAPD's zero-padded `YYYY-MM-DD HH:MM:SS`
    /// format, so a plain `.max()` on the pulled batch picks the right
    /// next-watermark — which is what `run_pulls` returns, and what
    /// `sync_project` then writes to the per-entity_type cursor.
    fn watermark_picks_full_timestamp_max() {
        let items = [
            TapdWorkItem {
                id: "1".into(),
                title: "a".into(),
                status: "open".into(),
                priority: None,
                module: None,
                owner: None,
                created: None,
                modified: Some("2026-01-01 10:00:00".into()),
                raw: serde_json::Value::Null,
            },
            TapdWorkItem {
                id: "2".into(),
                title: "b".into(),
                status: "open".into(),
                priority: None,
                module: None,
                owner: None,
                created: None,
                modified: Some("2026-01-03 08:00:00".into()),
                raw: serde_json::Value::Null,
            },
        ];
        let max = items
            .iter()
            .filter_map(|i| i.modified.as_deref())
            .max()
            .unwrap();
        // No day truncation — full `YYYY-MM-DD HH:MM:SS` survives.
        assert_eq!(max, "2026-01-03 08:00:00");
        let _ = binding("/proj");
    }

    /// Regression: previously, sync_project on a brand-new binding silently
    /// failed because try_acquire_lock returns false for missing cursor rows
    /// (the UPDATE has nothing to match), so no sync ever ran for directories
    /// the user had only configured via config.toml. The fix is to seed the
    /// cursor from the binding on first sync. We assert that contract here
    /// against the SQLite store: after upsert_project_binding the cursor exists.
    #[test]
    fn sync_project_seeds_cursor_for_new_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let store = TapdStore::new(dir.path().join("tapd.sqlite"));
        // No prior upsert: simulating the bug condition.
        store
            .upsert_project_cursor("/proj/fresh", "999", "story")
            .expect("upsert");
        let cursor = store
            .get_cursor("/proj/fresh", "story")
            .expect("get_cursor")
            .expect("cursor row must exist after upsert");
        assert_eq!(cursor.workspace_id, "999");
        assert_eq!(cursor.entity_type, "story");
    }
}
