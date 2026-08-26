//! TAPD workbench: per-directory task sync from TAPD into a local SQLite
//! queue, with incremental cursors, idempotent upserts, retry, and restart
//! recovery.
//!
//! Module map:
//! - [`store`] — SQLite persistence (cursors, task queue, sync run history).
//! - [`client`] — TAPD REST client (stories/tasks/bugs, auth, pagination).
//! - [`sync`] — the single sync pipeline shared by manual triggers and the
//!   background timer; [`sync::TapdSyncManager`] is the process-wide service.

pub mod client;
pub mod disk_config_source;
pub mod store;
pub mod sync;
