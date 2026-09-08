//! WorkbenchDispatcher + priority queue + slot accounting.
//!
//! The dispatcher is the front door for new TAPD workbench tasks. It pulls
//! pending tasks from the store, orders them by priority, and spawns main
//! sessions while there are free concurrency slots. Stage transitions happen
//! inside the main session actor; this module owns the queue and slot math.
//!
//! Spec reference: §7 (state machine), §12 (burst control), §10 (config).

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::agent::config::{GitlabConfig, Priority};use crate::tapd::store::TapdStore;
use crate::workbench::orchestrator::{drive_task, OrchestratorInputs};
use crate::workbench::submitter::GitlabClient;

/// One pending task in the dispatcher's queue.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingTask {
    pub tapd_id: String,
    pub priority: Priority,
    pub enqueued_at: i64,
}

impl Ord for PendingTask {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap is a max-heap; higher priority pops first.
        // On tie, earlier enqueue wins (smaller enqueued_at first).
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.enqueued_at.cmp(&self.enqueued_at))
    }
}

impl PartialOrd for PendingTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Priority queue of pending TAPD tasks. Higher Priority pops first; FIFO on tie.
#[derive(Default, Debug)]
pub struct WorkbenchQueue {
    heap: BinaryHeap<PendingTask>,
}

impl WorkbenchQueue {
    pub fn push(&mut self, task: PendingTask) {
        self.heap.push(task);
    }

    pub fn pop(&mut self) -> Option<PendingTask> {
        self.heap.pop()
    }

    pub fn len(&self) -> usize {
        self.heap.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }

    /// Iterate queued tasks without removing them. Order is heap-internal, not
    /// FIFO or priority -- use `pop` for the dispatched order.
    pub fn iter_pending(&self) -> impl Iterator<Item = (usize, &PendingTask)> {
        self.heap.iter().enumerate()
    }
}

/// Tracks the dispatcher's two resource pools: active main sessions and
/// worktree directories. A `try_claim` succeeds only if both pools have room.
#[derive(Debug)]
pub struct SlotAccountant {
    global_max_active: usize,
    worktree_pool_max: usize,
    /// Per-project running-task counts (project_key -> count). Used to enforce
    /// the optional `[tapd.projects.<key>].max_concurrent` cap (D3).
    /// A project with no cap configured does not appear in this map.
    project_counts: HashMap<String, u32>,
    /// Reverse map task_id -> project_key, so `release` can decrement the
    /// right per-project counter without the caller passing project_key twice.
    task_projects: HashMap<String, String>,
}

impl SlotAccountant {
    pub fn new(global_max_active: usize, worktree_pool_max: usize) -> Self {
        Self {
            global_max_active,
            worktree_pool_max,
            project_counts: HashMap::new(),
            task_projects: HashMap::new(),
        }
    }

    /// Claim a slot for `task_id` belonging to `project_key`. `project_cap`
    /// is the per-project cap (None means "no cap"). The caller is responsible
    /// for passing the canonical project key.
    ///
    /// v2 spec §8.2.1: only two global limits are enforced; per-project
    /// cap is opt-in.
    pub fn try_claim(&mut self, task_id: &str, project_key: &str, project_cap: Option<u32>) -> bool {
        if self.project_counts.values().sum::<u32>() as usize >= self.global_max_active {
            return false;
        }
        if self.project_counts.len() >= self.worktree_pool_max {
            return false;
        }
        if let Some(cap) = project_cap {
            let current = self.project_counts.get(project_key).copied().unwrap_or(0);
            if current >= cap {
                return false;
            }
        }
        *self.project_counts.entry(project_key.to_string()).or_insert(0) += 1;
        self.task_projects.insert(task_id.to_string(), project_key.to_string());
        true
    }

    pub fn release(&mut self, task_id: &str) {
        if let Some(project_key) = self.task_projects.remove(task_id) {
            if let Some(count) = self.project_counts.get_mut(&project_key) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.project_counts.remove(&project_key);
                }
            }
        }
    }

    pub fn active_count(&self) -> usize {
        self.project_counts.values().sum::<u32>() as usize
    }

    pub fn worktree_in_use(&self) -> usize {
        // One worktree per running task; task_projects tracks one entry per
        // running task_id. project_counts.len() would give unique projects only.
        self.task_projects.len()
    }

    pub fn global_max_active(&self) -> usize {
        self.global_max_active
    }

    pub fn worktree_pool_max(&self) -> usize {
        self.worktree_pool_max
    }
}

/// Notification event emitted by the dispatcher. Consumers (UI,
/// loggers, future worktree GC) listen on the same channel.
#[derive(Clone, Debug)]
pub enum DispatchEvent {
    Spawned { tapd_id: String, session_id: String },
    NoSlot,
    QueueEmpty,
    HealthSnapshot { active: usize, queued: usize, worktree_in_use: usize },
}

/// Snapshot of dispatcher pool utilization for health checks and UI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthSnapshot {
    pub active: usize,
    pub queued: usize,
    pub worktree_in_use: usize,
}

/// Front door for new workbench tasks. Owns the queue, slot accounting,
/// and the dispatch loop that drains pending tasks into main sessions.
///
/// For v1 this is a sync actor: `dispatch_pending()` is invoked from a
/// timer / sync-completion hook and blocks until the queue is drained
/// or slots run out. Stage transitions happen inside the spawned main
/// session actor (separate concern; not owned here).
pub struct WorkbenchDispatcher {
    store: Arc<crate::tapd::store::TapdStore>,
    grok_home: std::path::PathBuf,
    cfg: crate::agent::config::WorkbenchConfig,
    queue: parking_lot::Mutex<WorkbenchQueue>,
    slots: parking_lot::Mutex<SlotAccountant>,
    sink: tokio::sync::mpsc::UnboundedSender<DispatchEvent>,
    gitlab: Option<Arc<GitlabClient>>,
}

impl WorkbenchDispatcher {
    pub fn new(
        store: Arc<crate::tapd::store::TapdStore>,
        cfg: crate::agent::config::WorkbenchConfig,
        sink: tokio::sync::mpsc::UnboundedSender<DispatchEvent>,
        gitlab: Option<Arc<GitlabClient>>,
    ) -> Self {
        let slots = SlotAccountant::new(
            cfg.concurrency.global_max_active,
            cfg.concurrency.worktree_pool_max,
        );
        Self {
            store,
            grok_home: xai_grok_config::grok_home(),
            cfg,
            queue: parking_lot::Mutex::new(WorkbenchQueue::default()),
            slots: parking_lot::Mutex::new(slots),
            sink,
            gitlab,
        }
    }

    /// Drain pending tasks until either the queue is empty or no slot
    /// is free. Each spawned task is recorded as `running` in the store
    /// and a `Spawned` event is emitted on the sink.
    pub async fn dispatch_pending(&self) -> anyhow::Result<()> {
        // 1. Pull pending TAPD tasks with no workbench state
        let pending = tokio::task::spawn_blocking({
            let store = self.store.clone();
            move || store.list_pending_workbench_tasks()
        })
        .await
        .map_err(|e| anyhow::anyhow!("join error: {e}"))??;

        if pending.is_empty() {
            let _ = self.sink.send(DispatchEvent::QueueEmpty);
            return Ok(());
        }

        // 2. Push them onto the priority queue. Use Medium as the
        // priority unless the TAPD-side priority maps cleanly.
        let now = chrono::Utc::now().timestamp();
        for (tapd_id, _title) in pending {
            let priority = self.fetch_priority(&tapd_id).unwrap_or(Priority::Medium);
            self.queue.lock().push(PendingTask {
                tapd_id: tapd_id.clone(),
                priority,
                enqueued_at: now,
            });
            self.store.put_workbench_state(&tapd_id, "queued")?;
        }

        // 3. Pop and claim slots until we run out
        loop {
            let task = match self.queue.lock().pop() {
                Some(t) => t,
                None => break,
            };
            if !self.slots.lock().try_claim(&task.tapd_id, "unknown", None) {
                let _ = self.sink.send(DispatchEvent::NoSlot);
                break;
            }
            let session_id = self.spawn_main_session(&task.tapd_id).await?;
            self.store.put_workbench_state(&task.tapd_id, "running")?;
            let _ = self.sink.send(DispatchEvent::Spawned {
                tapd_id: task.tapd_id.clone(),
                session_id,
            });
        }

        // Re-trigger v2 §9.2.1: drain pending MR comments into the task's 1-design.md.
        if let Err(e) = self.drain_mr_comment_retriggers() {
            tracing::warn!("drain_mr_comment_retriggers failed: {e}");
        }

        // 4. Emit a health snapshot so consumers can update UI
        let snap = self.health_snapshot();
        let snap = self.health_snapshot();
        let _ = self.sink.send(DispatchEvent::HealthSnapshot { active: snap.active, queued: snap.queued, worktree_in_use: snap.worktree_in_use });
        Ok(())
    }

    /// Map a TAPD-side priority string to our enum. Returns None when
    /// the priority is missing or unrecognized — caller falls back to Medium.
    fn fetch_priority(&self, _tapd_id: &str) -> Option<Priority> {
        // TODO: read TAPD row + tapd-side priority column when we wire
        // up tapd-priority → workbench-priority mapping (deferred to v2).
        None
    }


    /// Drive one task through the full pipeline via the orchestrator.
    /// v1: stubbed LLM stages (deterministic artifact writers). Real LLM
    /// child-session calls are the next step. Returns the spawned session id.
    async fn spawn_main_session(&self, tapd_id: &str) -> anyhow::Result<String> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let tapd_id_owned = tapd_id.to_string();
        let store = self.store.clone();
        let gitlab = self.gitlab.clone();
        let session_id_for_blocking = session_id.clone();
        tokio::task::spawn_blocking(move || -> String {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(_) => return session_id_for_blocking,
            };
            rt.block_on(async move {
                if let Some(g) = gitlab {
                    let inputs = OrchestratorInputs {
                        tapd_id: tapd_id_owned.clone(),
                        title: format!("Workbench task {}", tapd_id_owned),
                        description: String::new(),
                        acs: vec![],
                        priority: 1,
                        repo_root: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
                        grok_home: xai_grok_config::grok_home(),
                        base_branch: "main".into(),
                        tapd_owner: None,
                        mr_reviewers: vec![],
                        mr_assignees: vec![],
                        project_id: "1".into(),
                        llm_stage: crate::workbench::orchestrator::FakeLlmStageAlwaysOk::default_into_dyn(),
                    };
                    let _ = drive_task(store.clone(), &g, inputs, None).await;
                }
            });
            session_id_for_blocking
        })
        .await
        .map_err(|e| anyhow::anyhow!("join error: {e}"))
    }

    /// v2 §9.2.1: drain pending MR comments by appending them to the task's
    /// `1-design.md` and marking them consumed. Best-effort: errors are logged
    /// but do not abort the dispatch loop.
    fn drain_mr_comment_retriggers(&self) -> anyhow::Result<()> {
        use crate::workbench::mr_comments::{append_to_design_and_consume, pending_for};
        // Snapshot the queued tapd_ids (under lock) then drop the lock before I/O.
        let tapd_ids: Vec<String> = {
            let q = self.queue.lock();
            q.iter_pending().map(|(_, t)| t.tapd_id.clone()).collect()
        };
        for tapd_id in tapd_ids {
            let pending = match pending_for(&self.store, &tapd_id) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(tapd_id, "pending_for failed: {e}");
                    continue;
                }
            };
            for comment in pending {
                let design_path = self
                    .grok_home
                    .join("worktrees")
                    .join(&tapd_id)
                    .join(".workbench")
                    .join("stages")
                    .join("1-design.md");
                if let Err(e) = append_to_design_and_consume(&self.store, &comment, &design_path) {
                    tracing::warn!(tapd_id, comment_id = comment.id, "retrigger append failed: {e}");
                }
            }
        }
        Ok(())
    }

    /// Clone of the store Arc. Used by extensions to run blocking DAO
    /// operations off the async runtime.
    pub fn store_clone(&self) -> Arc<TapdStore> {
        Arc::clone(&self.store)
    }

    pub fn health_snapshot(&self) -> HealthSnapshot {
        HealthSnapshot {
            active: self.slots.lock().active_count(),
            queued: self.queue.lock().len(),
            worktree_in_use: self.slots.lock().worktree_in_use(),
        }
    }

    pub fn release_slot(&self, tapd_id: &str) {
        self.slots.lock().release(tapd_id);
    }

    pub fn config(&self) -> &crate::agent::config::WorkbenchConfig {
        &self.cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::config::WorkbenchConfig;

    #[test]
    fn queue_orders_by_priority_then_fifo() {
        let mut q = WorkbenchQueue::default();
        q.push(PendingTask { tapd_id: "TAPD-1".into(), priority: Priority::Low,    enqueued_at: 1 });
        q.push(PendingTask { tapd_id: "TAPD-2".into(), priority: Priority::Urgent, enqueued_at: 2 });
        q.push(PendingTask { tapd_id: "TAPD-3".into(), priority: Priority::High,   enqueued_at: 3 });
        q.push(PendingTask { tapd_id: "TAPD-4".into(), priority: Priority::Urgent, enqueued_at: 4 });
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-2"); // Urgent first
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-4"); // Urgent, but enqueued later — actually wait
        // Wait: both have Priority::Urgent. enqueued_at 2 < 4, so TAPD-2 wins on FIFO.
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-3"); // High
        assert_eq!(q.pop().unwrap().tapd_id, "TAPD-1"); // Low
        assert!(q.pop().is_none());
    }

    #[test]
    fn queue_fifo_breaks_priority_ties() {
        let mut q = WorkbenchQueue::default();
        q.push(PendingTask { tapd_id: "A".into(), priority: Priority::Urgent, enqueued_at: 100 });
        q.push(PendingTask { tapd_id: "B".into(), priority: Priority::Urgent, enqueued_at: 50 });
        assert_eq!(q.pop().unwrap().tapd_id, "B"); // Earlier enqueued_at wins
        assert_eq!(q.pop().unwrap().tapd_id, "A");
    }

    #[test]
    fn slot_accounting_blocks_when_at_limit() {
        let mut acc = SlotAccountant::new(2, 5);
        assert!(acc.try_claim("TAPD-1", "proj-a", None));
        assert!(acc.try_claim("TAPD-2", "proj-b", None));
        assert!(!acc.try_claim("TAPD-3", "proj-c", None));
        acc.release("TAPD-1");
        assert!(acc.try_claim("TAPD-3", "proj-c", None));
    }

    #[test]
    fn slot_accounting_blocks_when_worktree_pool_exhausted() {
        let mut acc = SlotAccountant::new(5, 2);
        assert!(acc.try_claim("TAPD-1", "proj-a", None));
        assert!(acc.try_claim("TAPD-2", "proj-b", None));
        assert!(!acc.try_claim("TAPD-3", "proj-c", None));
    }

    #[test]
    fn slot_accounting_release_returns_to_pool() {
        let mut acc = SlotAccountant::new(1, 1);
        assert!(acc.try_claim("TAPD-1", "a", None));
        assert!(!acc.try_claim("TAPD-2", "b", None));
        acc.release("TAPD-1");
        assert!(acc.try_claim("TAPD-2", "b", None));
        assert_eq!(acc.active_count(), 1);
        assert_eq!(acc.worktree_in_use(), 1);
    }

    #[test]
    fn slot_accounting_exposes_config() {
        let acc = SlotAccountant::new(5, 10);
        assert_eq!(acc.global_max_active(), 5);
        assert_eq!(acc.worktree_pool_max(), 10);
    }
    #[tokio::test]
    async fn dispatcher_emits_queue_empty_on_no_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::tapd::store::TapdStore::new(dir.path().join("wb.sqlite")));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let dispatcher = WorkbenchDispatcher::new(store.clone(), WorkbenchConfig::default(), tx, None);

        dispatcher.dispatch_pending().await.unwrap();

        let event = rx.try_recv().expect("expected QueueEmpty");
        assert!(matches!(event, DispatchEvent::QueueEmpty));
    }

    #[test]
    fn slot_accountant_per_project_cap_enforced() {
        let mut acc = SlotAccountant::new(10, 10);
        assert!(acc.try_claim("TAPD-1", "proj-a", Some(2)));
        assert!(acc.try_claim("TAPD-2", "proj-a", Some(2)));
        assert!(!acc.try_claim("TAPD-3", "proj-a", Some(2)));
        assert!(acc.try_claim("TAPD-4", "proj-b", None));
    }

    #[test]
    fn slot_accountant_no_cap_means_unlimited_per_project() {
        let mut acc = SlotAccountant::new(100, 100);
        for i in 0..10 {
            assert!(acc.try_claim(&format!("TAPD-{i}"), "proj-a", None));
        }
        assert_eq!(acc.active_count(), 10);
        assert_eq!(acc.worktree_in_use(), 10);
    }

    #[test]
    fn slot_accountant_release_decrements_per_project_count() {
        let mut acc = SlotAccountant::new(10, 10);
        acc.try_claim("TAPD-1", "proj-a", Some(2));
        acc.try_claim("TAPD-2", "proj-a", Some(2));
        assert!(!acc.try_claim("TAPD-3", "proj-a", Some(2)));
        acc.release("TAPD-1");
        assert!(acc.try_claim("TAPD-3", "proj-a", Some(2)));
    }
}







