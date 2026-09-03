//! WorkbenchDispatcher + priority queue + slot accounting.
//!
//! The dispatcher is the front door for new TAPD workbench tasks. It pulls
//! pending tasks from the store, orders them by priority, and spawns main
//! sessions while there are free concurrency slots. Stage transitions happen
//! inside the main session actor; this module owns the queue and slot math.
//!
//! Spec reference: §7 (state machine), §12 (burst control), §10 (config).

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::agent::config::{GitlabConfig, Priority};
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
}

/// Tracks the dispatcher's two resource pools: active main sessions and
/// worktree directories. A `try_claim` succeeds only if both pools have room.
#[derive(Debug)]
pub struct SlotAccountant {
    global_max_active: usize,
    worktree_pool_max: usize,
    active: HashSet<String>,
    worktree_users: HashSet<String>,
}

impl SlotAccountant {
    pub fn new(global_max_active: usize, worktree_pool_max: usize) -> Self {
        Self {
            global_max_active,
            worktree_pool_max,
            active: HashSet::new(),
            worktree_users: HashSet::new(),
        }
    }

    pub fn try_claim(&mut self, task_id: &str) -> bool {
        if self.active.len() >= self.global_max_active {
            return false;
        }
        if self.worktree_users.len() >= self.worktree_pool_max {
            return false;
        }
        self.active.insert(task_id.to_string());
        self.worktree_users.insert(task_id.to_string());
        true
    }

    pub fn release(&mut self, task_id: &str) {
        self.active.remove(task_id);
        self.worktree_users.remove(task_id);
    }

    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    pub fn worktree_in_use(&self) -> usize {
        self.worktree_users.len()
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
            if !self.slots.lock().try_claim(&task.tapd_id) {
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
                    };
                    let _ = drive_task(store.clone(), &g, inputs).await;
                }
            });
            session_id_for_blocking
        })
        .await
        .map_err(|e| anyhow::anyhow!("join error: {e}"))
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
        assert!(acc.try_claim("proj-a"));
        assert!(acc.try_claim("proj-b"));
        assert!(!acc.try_claim("proj-c"));
        acc.release("proj-a");
        assert!(acc.try_claim("proj-c"));
    }

    #[test]
    fn slot_accounting_blocks_when_worktree_pool_exhausted() {
        let mut acc = SlotAccountant::new(5, 2);
        assert!(acc.try_claim("proj-a"));
        assert!(acc.try_claim("proj-b"));
        assert!(!acc.try_claim("proj-c"));
    }

    #[test]
    fn slot_accounting_release_returns_to_pool() {
        let mut acc = SlotAccountant::new(1, 1);
        assert!(acc.try_claim("a"));
        assert!(!acc.try_claim("b"));
        acc.release("a");
        assert!(acc.try_claim("b"));
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


}







