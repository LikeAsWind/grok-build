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

use crate::agent::config::Priority;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
