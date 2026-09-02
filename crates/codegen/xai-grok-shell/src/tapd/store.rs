//! SQLite persistence for the TAPD workbench.
//!
//! Three tables, one file (`~/.grok/tapd/tapd.sqlite`):
//! - `sync_cursor` — one row per (directory, entity_type) pair: workspace
//!   binding, per-entity_type incremental watermark (full TAPD `modified`
//!   timestamp, not day-granularity), sync-lease (lock) fields, and the
//!   last-run summary shown in the workbench header. Splitting by
//!   entity_type keeps one type's progress from being artificially held
//!   back by another's slower watermark.
//! - `tasks` — the local task queue. Primary key is the TAPD-native identity
//!   (`workspace_id:entity_type:tapd_id`), so re-pulling the same item is
//!   always an idempotent upsert, never a duplicate row.
//! - `sync_runs` — append-only history of each sync attempt, for the
//!   workbench's sync history panel and postmortems.
//!
//! Every public method opens its own connection (self-healing, WAL-mode on
//! local disks per [`xai_sqlite_journal`]) — matching the
//! `session::storage::search_fts` convention. SQLite's own file locking
//! serializes concurrent writers; callers on the async side should run these
//! through `spawn_blocking`.

use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i64 = 2;

pub fn db_path(grok_home: &Path) -> PathBuf {
    let dir = grok_home.join("tapd");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("tapd.sqlite");
    xai_sqlite_journal::JournalMode::for_db_path(&path).effective_db_path(&path)
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncStats {
    pub fetched: i64,
    pub added: i64,
    pub updated: i64,
    pub duplicate: i64,
    pub failed: i64,
}

impl SyncStats {
    pub fn merge(&mut self, other: &SyncStats) {
        self.fetched += other.fetched;
        self.added += other.added;
        self.updated += other.updated;
        self.duplicate += other.duplicate;
        self.failed += other.failed;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCursor {
    pub directory: String,
    pub workspace_id: String,
    /// TAPD-side entity type this cursor tracks (`story` / `task` / `bug`).
    /// Combined with `directory` as the row's primary key — each
    /// (directory, entity_type) pair has its own watermark and lock so a
    /// slower entity type doesn't drag a faster one backward.
    pub entity_type: String,
    pub last_synced_modified: Option<String>,
    pub last_sync_started_at: Option<i64>,
    pub last_sync_finished_at: Option<i64>,
    pub last_sync_status: Option<String>,
    pub last_sync_error: Option<String>,
    pub last_sync_duration_ms: Option<i64>,
    pub last_sync_stats: SyncStats,
    pub lock_owner: Option<String>,
    pub lock_heartbeat_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertOutcome {
    Added,
    Updated,
    Duplicate,
}

#[derive(Debug, Clone)]
pub struct UpsertTaskInput {
    pub directory: String,
    pub workspace_id: String,
    pub entity_type: String,
    pub tapd_id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<String>,
    pub module: Option<String>,
    pub owner: Option<String>,
    pub tapd_created_at: Option<String>,
    pub tapd_modified_at: Option<String>,
    pub raw_json: String,
}

fn task_id(directory: &str, workspace_id: &str, entity_type: &str, tapd_id: &str) -> String {
    // Directory is part of the id so each project binding gets its own row
    // for the same TAPD item. Without this, the second binding to sync the
    // same story (e.g. yaoex-searchcenter after grok-build) sees a
    // duplicate on every item — the story is already in the DB under the
    // grok-build binding's directory. Scoping by directory lets the UI
    // show "this project's tasks" independently per project.
    format!("{directory}:{workspace_id}:{entity_type}:{tapd_id}")
}

fn content_hash(input: &UpsertTaskInput) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.title.hash(&mut hasher);
    input.status.hash(&mut hasher);
    input.priority.hash(&mut hasher);
    input.module.hash(&mut hasher);
    input.owner.hash(&mut hasher);
    input.tapd_modified_at.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub directory: String,
    pub workspace_id: String,
    pub entity_type: String,
    pub tapd_id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<String>,
    pub module: Option<String>,
    pub owner: Option<String>,
    pub tapd_created_at: Option<String>,
    pub tapd_modified_at: Option<String>,
    pub raw_json: String,
    pub queue_state: String,
    pub enqueued_at: i64,
    pub processing_started_at: Option<i64>,
    pub processing_heartbeat_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub retry_count: i64,
    pub max_retries: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskListFilter {
    pub queue_state: Option<String>,
    pub entity_type: Option<String>,
    pub module: Option<String>,
    pub search: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskCounts {
    pub pending: i64,
    pub processing: i64,
    pub completed: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRunRow {
    pub id: i64,
    pub directory: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub trigger: String,
    pub status: String,
    pub stats: SyncStats,
    pub error: Option<String>,
}

pub struct TapdStore {
    db_path: PathBuf,
}

impl TapdStore {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    fn open(&self) -> rusqlite::Result<rusqlite::Connection> {
        let journal_mode = xai_sqlite_journal::JournalMode::for_db_path(&self.db_path);
        if let Some(parent) = self.db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = journal_mode.open(&self.db_path)?;
        Self::migrate(&conn)?;
        Ok(conn)
    }

    fn migrate(db: &rusqlite::Connection) -> rusqlite::Result<()> {
        let stored: Option<i64> = db
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap_or(None)
            .and_then(|s| s.parse().ok());

        db.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_cursor (
                directory TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                last_synced_modified TEXT,
                last_sync_started_at INTEGER,
                last_sync_finished_at INTEGER,
                last_sync_status TEXT,
                last_sync_error TEXT,
                last_sync_duration_ms INTEGER,
                last_sync_fetched INTEGER NOT NULL DEFAULT 0,
                last_sync_added INTEGER NOT NULL DEFAULT 0,
                last_sync_updated INTEGER NOT NULL DEFAULT 0,
                last_sync_duplicate INTEGER NOT NULL DEFAULT 0,
                last_sync_failed INTEGER NOT NULL DEFAULT 0,
                lock_owner TEXT,
                lock_heartbeat_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (directory, entity_type)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                tapd_id TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT,
                module TEXT,
                owner TEXT,
                tapd_created_at TEXT,
                tapd_modified_at TEXT,
                raw_json TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                queue_state TEXT NOT NULL DEFAULT 'pending',
                enqueued_at INTEGER NOT NULL,
                processing_started_at INTEGER,
                processing_heartbeat_at INTEGER,
                completed_at INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tasks_directory_idx ON tasks(directory);
            CREATE INDEX IF NOT EXISTS tasks_queue_state_idx ON tasks(directory, queue_state);

            CREATE TABLE IF NOT EXISTS sync_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                directory TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                fetched INTEGER NOT NULL DEFAULT 0,
                added INTEGER NOT NULL DEFAULT 0,
                updated INTEGER NOT NULL DEFAULT 0,
                duplicate INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );
            CREATE TABLE IF NOT EXISTS workbench_task_state (
    tapd_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

            CREATE INDEX IF NOT EXISTS sync_runs_directory_idx ON sync_runs(directory, started_at DESC);
            ",
        )?;

        if let Some(v) = stored {
            // v1 —> v2: split sync_cursor by entity_type. The old schema had
            // only (directory) as the primary key and stored a single shared
            // day-granularity watermark; the new schema has
            // (directory, entity_type) and stores a full TAPD 'modified'
            // timestamp. We DROP the old table — the watermark is the only
            // thing lost, and the task queue is preserved (it never lived
            // in sync_cursor). The next sync repopulates cursors as it walks
            // the per-(directory, entity_type) schedule.
            if v < 2 {
                db.execute_batch(
                    "DROP TABLE IF EXISTS sync_cursor;
                     CREATE TABLE sync_cursor (
                         directory TEXT NOT NULL,
                         entity_type TEXT NOT NULL,
                         workspace_id TEXT NOT NULL,
                         last_synced_modified TEXT,
                         last_sync_started_at INTEGER,
                         last_sync_finished_at INTEGER,
                         last_sync_status TEXT,
                         last_sync_error TEXT,
                         last_sync_duration_ms INTEGER,
                         last_sync_fetched INTEGER NOT NULL DEFAULT 0,
                         last_sync_added INTEGER NOT NULL DEFAULT 0,
                         last_sync_updated INTEGER NOT NULL DEFAULT 0,
                         last_sync_duplicate INTEGER NOT NULL DEFAULT 0,
                         last_sync_failed INTEGER NOT NULL DEFAULT 0,
                         lock_owner TEXT,
                         lock_heartbeat_at INTEGER,
                         updated_at INTEGER NOT NULL,
                         PRIMARY KEY (directory, entity_type)
                     );",
                )?;
            }
        }

        if stored.is_none_or(|v| v < SCHEMA_VERSION) {
            db.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![SCHEMA_VERSION.to_string()],
            )?;
        }
        Ok(())
    }

    // ── Project bindings / cursor ──────────────────────────────────────

    /// Seed the cursor row for one (directory, entity_type) pair if it does
    /// not exist yet, or refresh the workspace_id if the binding changed.
    /// Called once per entity_type at the start of every sync so a
    /// freshly-added project type doesn't trip `try_acquire_lock`'s
    /// `WHERE directory = ?1 AND entity_type = ?2` predicate and silently
    /// skip the sync.
    pub fn upsert_project_cursor(
        &self,
        directory: &str,
        workspace_id: &str,
        entity_type: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO sync_cursor (directory, entity_type, workspace_id, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(directory, entity_type) DO UPDATE SET
                 workspace_id = excluded.workspace_id, updated_at = excluded.updated_at",
            params![directory, entity_type, workspace_id, now_secs()],
        )?;
        Ok(())
    }

    pub fn remove_project_binding(&self, directory: &str) -> rusqlite::Result<()> {
        let conn = self.open()?;
        conn.execute(
            "DELETE FROM sync_cursor WHERE directory = ?1",
            params![directory],
        )?;
        Ok(())
    }

    /// Cursor for one specific (directory, entity_type) pair. Used by
    /// `sync_project` to read the per-entity_type watermark before a pull.

    pub fn get_cursor(
        &self,
        directory: &str,
        entity_type: &str,
    ) -> rusqlite::Result<Option<SyncCursor>> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT directory, entity_type, workspace_id, last_synced_modified,
                    last_sync_started_at, last_sync_finished_at, last_sync_status,
                    last_sync_error, last_sync_duration_ms, last_sync_fetched,
                    last_sync_added, last_sync_updated, last_sync_duplicate,
                    last_sync_failed, lock_owner, lock_heartbeat_at, updated_at
             FROM sync_cursor WHERE directory = ?1 AND entity_type = ?2",
            params![directory, entity_type],
            row_to_cursor,
        )
        .optional()
    }

    /// Aggregated cursor view over **all** entity_types for a directory.
    /// Used by `handle_status` to feed the workbench header — a single
    /// project may carry story + task + bug cursors; the workbench UI only
    /// surfaces one combined state.
    ///
    /// Aggregation rules:
    /// - `last_synced_modified` — max over all entity_types (lexicographic on
    ///   TAPD's `YYYY-MM-DD HH:MM:SS` is equivalent to chronological, so
    ///   `max_str` is correct).
    /// - `last_sync_started_at` / `last_sync_finished_at` / `updated_at` —
    ///   max.
    /// - `last_sync_status` — `failed` if any cursor failed, else `success`.
    /// - `last_sync_error` — first non-empty error encountered.
    /// - `last_sync_stats` — summed across cursors.
    /// - `is_syncing` (encoded via `lock_owner`) — true if any cursor has a
    ///   live lease.
    pub fn get_cursor_summary(&self, directory: &str) -> rusqlite::Result<Option<SyncCursor>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT directory, entity_type, workspace_id, last_synced_modified,
                    last_sync_started_at, last_sync_finished_at, last_sync_status,
                    last_sync_error, last_sync_duration_ms, last_sync_fetched,
                    last_sync_added, last_sync_updated, last_sync_duplicate,
                    last_sync_failed, lock_owner, lock_heartbeat_at, updated_at
             FROM sync_cursor WHERE directory = ?1",
        )?;
        let rows: Vec<SyncCursor> = stmt
            .query_map(params![directory], row_to_cursor)?
            .collect::<rusqlite::Result<_>>()?;
        if rows.is_empty() {
            return Ok(None);
        }
        let mut summary = rows[0].clone();
        // entity_type in the summary is meaningless — pick the lexicographically
        // first one for stability (it's not displayed anywhere).
        summary.entity_type = rows.iter().map(|c| &c.entity_type).min().cloned().unwrap_or_default();
        for c in &rows[1..] {
            summary.last_synced_modified = max_str(summary.last_synced_modified.as_deref(), c.last_synced_modified.as_deref()).map(str::to_string);
            summary.last_sync_started_at = max_opt(summary.last_sync_started_at, c.last_sync_started_at);
            summary.last_sync_finished_at = max_opt(summary.last_sync_finished_at, c.last_sync_finished_at);
            summary.updated_at = summary.updated_at.max(c.updated_at);
            summary.last_sync_duration_ms = match (summary.last_sync_duration_ms, c.last_sync_duration_ms) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            summary.last_sync_stats.merge(&c.last_sync_stats);
            if c.last_sync_status.as_deref() == Some("failed")
                || summary.last_sync_status.as_deref() == Some("failed")
            {
                summary.last_sync_status = Some("failed".to_string());
            }
            if summary.last_sync_error.is_none() {
                summary.last_sync_error = c.last_sync_error.clone();
            }
            // lock_owner: any live lease means the workbench is syncing.
            if summary.lock_owner.is_none() && c.lock_owner.is_some() {
                summary.lock_owner = c.lock_owner.clone();
                summary.lock_heartbeat_at = c.lock_heartbeat_at;
            } else if c.lock_owner.is_some() {
                summary.lock_heartbeat_at = max_opt(summary.lock_heartbeat_at, c.lock_heartbeat_at);
            }
        }
        Ok(Some(summary))
    }

    /// All cursor rows across all (directory, entity_type) pairs. Used by
    /// startup recovery and tests; the workbench UI uses
    /// [`Self::get_cursor_summary`] for a per-directory aggregate view.
    pub fn list_cursors(&self) -> rusqlite::Result<Vec<SyncCursor>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT directory, entity_type, workspace_id, last_synced_modified,
                    last_sync_started_at, last_sync_finished_at, last_sync_status,
                    last_sync_error, last_sync_duration_ms, last_sync_fetched,
                    last_sync_added, last_sync_updated, last_sync_duplicate,
                    last_sync_failed, lock_owner, lock_heartbeat_at, updated_at
             FROM sync_cursor",
        )?;
        let rows = stmt.query_map([], row_to_cursor)?;
        rows.collect()
    }

    /// Try to acquire the sync lease for one (directory, entity_type) pair.
    /// Fails (returns `false`) if another owner holds a live (non-stale)
    /// lease for the same pair. A lease held by a dead process is reclaimed
    /// transparently — restart recovery does not require a separate step for
    /// the *acquire* path, only for the *startup reconciliation* of orphaned
    /// `sync_runs`/task state (see [`Self::reconcile_stale_locks`]).
    pub fn try_acquire_lock(
        &self,
        directory: &str,
        entity_type: &str,
        owner: &str,
        stale_after_secs: i64,
    ) -> rusqlite::Result<bool> {
        let conn = self.open()?;
        let now = now_secs();
        let updated = conn.execute(
            "UPDATE sync_cursor
             SET lock_owner = ?3, lock_heartbeat_at = ?4, updated_at = ?4
             WHERE directory = ?1 AND entity_type = ?2
               AND (lock_owner IS NULL OR lock_heartbeat_at < ?5)",
            params![directory, entity_type, owner, now, now - stale_after_secs],
        )?;
        Ok(updated > 0)
    }

    pub fn heartbeat_lock(
        &self,
        directory: &str,
        entity_type: &str,
        owner: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE sync_cursor SET lock_heartbeat_at = ?4
             WHERE directory = ?1 AND entity_type = ?2 AND lock_owner = ?3",
            params![directory, entity_type, owner, now_secs()],
        )?;
        Ok(())
    }

    /// Record a successful sync: advance the cursor (only if `new_watermark`
    /// is `Some`), release the lease, and store the run summary. Per
    /// (directory, entity_type) so a successful story sync does not erase the
    /// lock/watermark state of an in-progress task sync on the same binding.
    pub fn release_lock_success(
        &self,
        directory: &str,
        entity_type: &str,
        owner: &str,
        new_watermark: Option<&str>,
        stats: &SyncStats,
        duration_ms: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = now_secs();
        conn.execute(
            "UPDATE sync_cursor
             SET lock_owner = NULL, lock_heartbeat_at = NULL,
                 last_synced_modified = COALESCE(?4, last_synced_modified),
                 last_sync_started_at = ?5, last_sync_finished_at = ?6,
                 last_sync_status = 'success', last_sync_error = NULL,
                 last_sync_duration_ms = ?7,
                 last_sync_fetched = ?8, last_sync_added = ?9, last_sync_updated = ?10,
                 last_sync_duplicate = ?11, last_sync_failed = ?12,
                 updated_at = ?6
             WHERE directory = ?1 AND entity_type = ?2 AND lock_owner = ?3",
            params![
                directory,
                entity_type,
                owner,
                new_watermark,
                now,
                now,
                duration_ms,
                stats.fetched,
                stats.added,
                stats.updated,
                stats.duplicate,
                stats.failed,
            ],
        )?;
        Ok(())
    }

    pub fn release_lock_failure(
        &self,
        directory: &str,
        entity_type: &str,
        owner: &str,
        error: &str,
        stats: &SyncStats,
        duration_ms: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = now_secs();
        conn.execute(
            "UPDATE sync_cursor
             SET lock_owner = NULL, lock_heartbeat_at = NULL,
                 last_sync_finished_at = ?4,
                 last_sync_status = 'failed', last_sync_error = ?5,
                 last_sync_duration_ms = ?6,
                 last_sync_fetched = ?7, last_sync_added = ?8, last_sync_updated = ?9,
                 last_sync_duplicate = ?10, last_sync_failed = ?11,
                 updated_at = ?4
             WHERE directory = ?1 AND entity_type = ?2 AND lock_owner = ?3",
            params![
                directory,
                entity_type,
                owner,
                now,
                error,
                duration_ms,
                stats.fetched,
                stats.added,
                stats.updated,
                stats.duplicate,
                stats.failed,
            ],
        )?;
        Ok(())
    }

    /// Startup recovery: clear any lease whose heartbeat is older than
    /// `stale_after_secs` (the holder died mid-sync) and mark its
    /// last-known status as an interrupted failure. Returns the
    /// `(directory, entity_type)` pairs that were reconciled, so the caller
    /// can immediately re-sync them per-entity_type.
    pub fn reconcile_stale_locks(
        &self,
        stale_after_secs: i64,
    ) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.open()?;
        let now = now_secs();
        let mut stmt = conn.prepare(
            "SELECT directory, entity_type FROM sync_cursor
             WHERE lock_owner IS NOT NULL AND lock_heartbeat_at < ?1",
        )?;
        let stale: Vec<(String, String)> = stmt
            .query_map(params![now - stale_after_secs], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;

        for (directory, entity_type) in &stale {
            conn.execute(
                "UPDATE sync_cursor
                 SET lock_owner = NULL, lock_heartbeat_at = NULL,
                     last_sync_status = 'failed',
                     last_sync_error = 'interrupted: process restarted mid-sync',
                     last_sync_finished_at = ?3, updated_at = ?3
                 WHERE directory = ?1 AND entity_type = ?2",
                params![directory, entity_type, now],
            )?;
        }
        Ok(stale)
    }

    // ── Task queue ──────────────────────────────────────────────────────

    pub fn upsert_task(&self, input: &UpsertTaskInput) -> rusqlite::Result<UpsertOutcome> {
        let conn = self.open()?;
        let id = task_id(&input.directory, &input.workspace_id, &input.entity_type, &input.tapd_id);
        let hash = content_hash(input);
        let now = now_secs();

        let existing: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM tasks WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;

        match existing {
            None => {
                conn.execute(
                    "INSERT INTO tasks (
                        id, directory, workspace_id, entity_type, tapd_id, title, status,
                        priority, module, owner, tapd_created_at, tapd_modified_at, raw_json,
                        content_hash, queue_state, enqueued_at, retry_count, max_retries,
                        created_at, updated_at
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'pending',?15,0,3,?15,?15)",
                    params![
                        id,
                        input.directory,
                        input.workspace_id,
                        input.entity_type,
                        input.tapd_id,
                        input.title,
                        input.status,
                        input.priority,
                        input.module,
                        input.owner,
                        input.tapd_created_at,
                        input.tapd_modified_at,
                        input.raw_json,
                        hash,
                        now,
                    ],
                )?;
                Ok(UpsertOutcome::Added)
            }
            Some(prev_hash) if prev_hash == hash => Ok(UpsertOutcome::Duplicate),
            Some(_) => {
                conn.execute(
                    "UPDATE tasks SET
                        title = ?2, status = ?3, priority = ?4, module = ?5, owner = ?6,
                        tapd_created_at = ?7, tapd_modified_at = ?8, raw_json = ?9,
                        content_hash = ?10, updated_at = ?11
                     WHERE id = ?1",
                    params![
                        id,
                        input.title,
                        input.status,
                        input.priority,
                        input.module,
                        input.owner,
                        input.tapd_created_at,
                        input.tapd_modified_at,
                        input.raw_json,
                        hash,
                        now,
                    ],
                )?;
                Ok(UpsertOutcome::Updated)
            }
        }
    }

    /// Upsert the per-TAPD-task workbench state (used by the dispatcher and state machine).
    /// `state` is an opaque string (e.g. "pending", "queued", "running:develop:0");
    /// semantic interpretation lives in the workbench crate.
    pub fn put_workbench_state(&self, tapd_id: &str, state: &str) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO workbench_task_state (tapd_id, state, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(tapd_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
            rusqlite::params![tapd_id, state, now],
        )?;
        Ok(())
    }

    pub fn get_workbench_state(&self, tapd_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare("SELECT state FROM workbench_task_state WHERE tapd_id = ?1")?;
        let mut rows = stmt.query(rusqlite::params![tapd_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Pending TAPD tasks that have no workbench state yet — these are the
    /// candidates the dispatcher should claim on its next sweep.
    pub fn list_pending_workbench_tasks(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT t.tapd_id, t.title
             FROM tasks t
             LEFT JOIN workbench_task_state w ON w.tapd_id = t.tapd_id
             WHERE t.queue_state = 'pending' AND w.state IS NULL"
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub fn list_tasks(        &self,
        directory: &str,
        filter: &TaskListFilter,
    ) -> rusqlite::Result<Vec<TaskRow>> {
        let conn = self.open()?;
        let mut sql = String::from(
            "SELECT id, directory, workspace_id, entity_type, tapd_id, title, status, priority,
                    module, owner, tapd_created_at, tapd_modified_at, raw_json, queue_state,
                    enqueued_at, processing_started_at, processing_heartbeat_at, completed_at,
                    retry_count, max_retries, last_error, created_at, updated_at
             FROM tasks WHERE directory = ?1",
        );
        let mut idx = 2;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(directory.to_string())];
        if let Some(qs) = &filter.queue_state {
            sql.push_str(&format!(" AND queue_state = ?{idx}"));
            params_vec.push(Box::new(qs.clone()));
            idx += 1;
        }
        if let Some(et) = &filter.entity_type {
            sql.push_str(&format!(" AND entity_type = ?{idx}"));
            params_vec.push(Box::new(et.clone()));
            idx += 1;
        }
        if let Some(m) = &filter.module {
            sql.push_str(&format!(" AND module = ?{idx}"));
            params_vec.push(Box::new(m.clone()));
            idx += 1;
        }
        if let Some(search) = &filter.search {
            sql.push_str(&format!(" AND title LIKE ?{idx}"));
            params_vec.push(Box::new(format!("%{search}%")));
            idx += 1;
        }
        let order = match filter.sort.as_deref() {
            Some("modified_asc") => "tapd_modified_at ASC",
            Some("created_desc") => "tapd_created_at DESC",
            Some("priority") => "priority DESC, tapd_modified_at DESC",
            _ => "tapd_modified_at DESC",
        };
        sql.push_str(&format!(" ORDER BY {order}"));
        let limit = filter.limit.unwrap_or(200).clamp(1, 1000);
        sql.push_str(&format!(" LIMIT ?{idx}"));
        params_vec.push(Box::new(limit));
        idx += 1;
        if let Some(offset) = filter.offset {
            sql.push_str(&format!(" OFFSET ?{idx}"));
            params_vec.push(Box::new(offset));
        }

        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), row_to_task)?;
        rows.collect()
    }

    pub fn task_counts(&self, directory: &str) -> rusqlite::Result<TaskCounts> {
        let conn = self.open()?;
        let mut counts = TaskCounts::default();
        let mut stmt = conn.prepare(
            "SELECT queue_state, COUNT(*) FROM tasks WHERE directory = ?1 GROUP BY queue_state",
        )?;
        let rows = stmt.query_map(params![directory], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (state, count) = row?;
            match state.as_str() {
                "pending" => counts.pending = count,
                "processing" => counts.processing = count,
                "completed" => counts.completed = count,
                "failed" => counts.failed = count,
                _ => {}
            }
        }
        Ok(counts)
    }

    pub fn distinct_modules(&self, directory: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT module FROM tasks WHERE directory = ?1 AND module IS NOT NULL ORDER BY module",
        )?;
        let rows = stmt.query_map(params![directory], |row| row.get(0))?;
        rows.collect()
    }

    /// Transition a task to `processing`, stamping the heartbeat. No-op (and
    /// returns `false`) if the task is not currently `pending` or a
    /// previously-orphaned `processing` row past its heartbeat.
    pub fn claim_task(&self, id: &str, heartbeat_stale_secs: i64) -> rusqlite::Result<bool> {
        let conn = self.open()?;
        let now = now_secs();
        let updated = conn.execute(
            "UPDATE tasks SET queue_state = 'processing', processing_started_at = ?2,
                    processing_heartbeat_at = ?2, updated_at = ?2
             WHERE id = ?1 AND (
                queue_state = 'pending'
                OR (queue_state = 'processing' AND processing_heartbeat_at < ?3)
             )",
            params![id, now, now - heartbeat_stale_secs],
        )?;
        Ok(updated > 0)
    }

    pub fn complete_task(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = now_secs();
        conn.execute(
            "UPDATE tasks SET queue_state = 'completed', completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    /// Fail a task's processing attempt. Requeues to `pending` while under
    /// `max_retries`; past the limit it stays `failed` for good.
    pub fn fail_task(&self, id: &str, error: &str) -> rusqlite::Result<()> {
        let conn = self.open()?;
        let now = now_secs();
        conn.execute(
            "UPDATE tasks SET
                retry_count = retry_count + 1,
                last_error = ?2,
                queue_state = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
                updated_at = ?3
             WHERE id = ?1",
            params![id, error, now],
        )?;
        Ok(())
    }

    /// Startup recovery: any task stuck `processing` past `heartbeat_stale_secs`
    /// (its owning process died) is requeued via [`Self::fail_task`]'s retry
    /// accounting. Returns the number of tasks recovered.
    pub fn reconcile_stale_processing_tasks(
        &self,
        heartbeat_stale_secs: i64,
    ) -> rusqlite::Result<usize> {
        let conn = self.open()?;
        let now = now_secs();
        let mut stmt = conn.prepare(
            "SELECT id FROM tasks WHERE queue_state = 'processing' AND processing_heartbeat_at < ?1",
        )?;
        let stale: Vec<String> = stmt
            .query_map(params![now - heartbeat_stale_secs], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for id in &stale {
            conn.execute(
                "UPDATE tasks SET
                    retry_count = retry_count + 1,
                    last_error = 'interrupted: process restarted while processing',
                    queue_state = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
                    processing_heartbeat_at = NULL,
                    updated_at = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
        }
        Ok(stale.len())
    }

    // ── Sync run history ────────────────────────────────────────────────

    pub fn start_run(&self, directory: &str, trigger: &str) -> rusqlite::Result<i64> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO sync_runs (directory, started_at, trigger, status) VALUES (?1, ?2, ?3, 'running')",
            params![directory, now_secs(), trigger],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn finish_run(
        &self,
        run_id: i64,
        status: &str,
        stats: &SyncStats,
        error: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE sync_runs SET finished_at = ?2, status = ?3, fetched = ?4, added = ?5,
                    updated = ?6, duplicate = ?7, failed = ?8, error = ?9
             WHERE id = ?1",
            params![
                run_id,
                now_secs(),
                status,
                stats.fetched,
                stats.added,
                stats.updated,
                stats.duplicate,
                stats.failed,
                error,
            ],
        )?;
        Ok(())
    }

    pub fn recent_runs(&self, directory: &str, limit: i64) -> rusqlite::Result<Vec<SyncRunRow>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT id, directory, started_at, finished_at, trigger, status,
                    fetched, added, updated, duplicate, failed, error
             FROM sync_runs WHERE directory = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![directory, limit.clamp(1, 200)], row_to_run)?;
        rows.collect()
    }

    /// Startup recovery: any `sync_runs` row left `running` (the process died
    /// mid-sync, before `finish_run` could be called) is marked `failed`.
    /// Returns the number of runs reconciled.
    pub fn reconcile_stale_runs(&self) -> rusqlite::Result<usize> {
        let conn = self.open()?;
        let updated = conn.execute(
            "UPDATE sync_runs SET status = 'failed', finished_at = ?1,
                    error = 'interrupted: process restarted mid-sync'
             WHERE status = 'running'",
            params![now_secs()],
        )?;
        Ok(updated)
    }
}

fn row_to_cursor(row: &rusqlite::Row) -> rusqlite::Result<SyncCursor> {
    Ok(SyncCursor {
        directory: row.get(0)?,
        entity_type: row.get(1)?,
        workspace_id: row.get(2)?,
        last_synced_modified: row.get(3)?,
        last_sync_started_at: row.get(4)?,
        last_sync_finished_at: row.get(5)?,
        last_sync_status: row.get(6)?,
        last_sync_error: row.get(7)?,
        last_sync_duration_ms: row.get(8)?,
        last_sync_stats: SyncStats {
            fetched: row.get(9)?,
            added: row.get(10)?,
            updated: row.get(11)?,
            duplicate: row.get(12)?,
            failed: row.get(13)?,
        },
        lock_owner: row.get(14)?,
        lock_heartbeat_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn max_str<'a>(a: Option<&'a str>, b: Option<&'a str>) -> Option<&'a str> {
    // Both inputs are borrowed from the same source (rows in
    // get_cursor_summary), so the returned reference can borrow from
    // whichever is larger. The lifetime parameter is required so the
    // compiler knows the output references one of the inputs.
    match (a, b) {
        (Some(x), Some(y)) => {
            if x >= y { Some(x) } else { Some(y) }
        }
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
}

fn max_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    }
}

fn row_to_task(row: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get(0)?,
        directory: row.get(1)?,
        workspace_id: row.get(2)?,
        entity_type: row.get(3)?,
        tapd_id: row.get(4)?,
        title: row.get(5)?,
        status: row.get(6)?,
        priority: row.get(7)?,
        module: row.get(8)?,
        owner: row.get(9)?,
        tapd_created_at: row.get(10)?,
        tapd_modified_at: row.get(11)?,
        raw_json: row.get(12)?,
        queue_state: row.get(13)?,
        enqueued_at: row.get(14)?,
        processing_started_at: row.get(15)?,
        processing_heartbeat_at: row.get(16)?,
        completed_at: row.get(17)?,
        retry_count: row.get(18)?,
        max_retries: row.get(19)?,
        last_error: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
    })
}

fn row_to_run(row: &rusqlite::Row) -> rusqlite::Result<SyncRunRow> {
    Ok(SyncRunRow {
        id: row.get(0)?,
        directory: row.get(1)?,
        started_at: row.get(2)?,
        finished_at: row.get(3)?,
        trigger: row.get(4)?,
        status: row.get(5)?,
        stats: SyncStats {
            fetched: row.get(6)?,
            added: row.get(7)?,
            updated: row.get(8)?,
            duplicate: row.get(9)?,
            failed: row.get(10)?,
        },
        error: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (TapdStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = TapdStore::new(dir.path().join("test.sqlite"));
        (store, dir)
    }

    fn sample_task(dir: &str, id: &str) -> UpsertTaskInput {
        UpsertTaskInput {
            directory: dir.to_string(),
            workspace_id: "12345".to_string(),
            entity_type: "task".to_string(),
            tapd_id: id.to_string(),
            title: "示例任务".to_string(),
            status: "open".to_string(),
            priority: Some("high".to_string()),
            module: Some("模块A".to_string()),
            owner: Some("alice".to_string()),
            tapd_created_at: Some("2026-01-01 10:00:00".to_string()),
            tapd_modified_at: Some("2026-01-01 10:00:00".to_string()),
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    fn upsert_task_first_insert_is_added() {
        let (store, _dir) = store();
        let input = sample_task("/proj", "1");
        assert_eq!(store.upsert_task(&input).unwrap(), UpsertOutcome::Added);
        let counts = store.task_counts("/proj").unwrap();
        assert_eq!(counts.pending, 1);
    }

    #[test]
    fn upsert_task_same_content_is_duplicate() {
        let (store, _dir) = store();
        let input = sample_task("/proj", "1");
        store.upsert_task(&input).unwrap();
        assert_eq!(
            store.upsert_task(&input).unwrap(),
            UpsertOutcome::Duplicate
        );
    }

    #[test]
    fn upsert_task_changed_content_is_updated_without_resetting_queue_state() {
        let (store, _dir) = store();
        let input = sample_task("/proj", "1");
        store.upsert_task(&input).unwrap();
        let id = task_id(&input.directory, &input.workspace_id, &input.entity_type, &input.tapd_id);
        store.claim_task(&id, 600).unwrap();
        store.complete_task(&id).unwrap();

        let mut changed = input.clone();
        changed.status = "done".to_string();
        assert_eq!(
            store.upsert_task(&changed).unwrap(),
            UpsertOutcome::Updated
        );
        let counts = store.task_counts("/proj").unwrap();
        assert_eq!(counts.completed, 1, "re-pulling a completed task must not reset its queue state");
    }

    #[test]
    fn lock_acquire_and_release_roundtrip() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        assert!(store.try_acquire_lock("/proj", "task", "owner-a", 300).unwrap());
        // Second owner cannot acquire a live lease.
        assert!(!store.try_acquire_lock("/proj", "task", "owner-b", 300).unwrap());

        let stats = SyncStats {
            fetched: 3,
            added: 2,
            updated: 1,
            duplicate: 0,
            failed: 0,
        };
        store
            .release_lock_success("/proj", "task", "owner-a", Some("2026-01-02 12:00:00"), &stats, 500)
            .unwrap();

        let cursor = store.get_cursor("/proj", "task").unwrap().unwrap();
        assert!(cursor.lock_owner.is_none());
        assert_eq!(cursor.last_synced_modified, Some("2026-01-02 12:00:00".to_string()));
        assert_eq!(cursor.last_sync_status, Some("success".to_string()));
        assert_eq!(cursor.last_sync_stats.added, 2);
    }

    #[test]
    fn cursor_not_advanced_on_failure() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        store.try_acquire_lock("/proj", "task", "owner-a", 300).unwrap();
        store
            .release_lock_success(
                "/proj",
                "task",
                "owner-a",
                Some("2026-01-01 09:00:00"),
                &SyncStats::default(),
                10,
            )
            .unwrap();

        store.try_acquire_lock("/proj", "task", "owner-a", 300).unwrap();
        store
            .release_lock_failure("/proj", "task", "owner-a", "network error", &SyncStats::default(), 10)
            .unwrap();

        let cursor = store.get_cursor("/proj", "task").unwrap().unwrap();
        assert_eq!(
            cursor.last_synced_modified,
            Some("2026-01-01 09:00:00".to_string()),
            "a failed sync must not advance the watermark"
        );
        assert_eq!(cursor.last_sync_status, Some("failed".to_string()));
    }

    #[test]
    fn reconcile_stale_locks_clears_dead_owner_and_reports_pair() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        store.try_acquire_lock("/proj", "task", "dead-owner", 300).unwrap();

        let reconciled = store.reconcile_stale_locks(-1).unwrap();
        assert_eq!(reconciled, vec![("/proj".to_string(), "task".to_string())]);

        let cursor = store.get_cursor("/proj", "task").unwrap().unwrap();
        assert!(cursor.lock_owner.is_none());
        assert_eq!(cursor.last_sync_status, Some("failed".to_string()));
    }

    #[test]
    fn locks_are_isolated_per_entity_type() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "story").unwrap();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        // Locking story does not block task on the same directory.
        assert!(store.try_acquire_lock("/proj", "story", "owner", 300).unwrap());
        assert!(
            store.try_acquire_lock("/proj", "task", "owner", 300).unwrap(),
            "task should be lockable independently of story"
        );
    }

    #[test]
    fn cursors_are_isolated_per_entity_type() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "story").unwrap();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        store.try_acquire_lock("/proj", "story", "owner", 300).unwrap();
        store
            .release_lock_success(
                "/proj",
                "story",
                "owner",
                Some("2026-08-26 10:00:00"),
                &SyncStats::default(),
                100,
            )
            .unwrap();

        // story has a full watermark; task only has a placeholder row (created
        // by upsert_project_cursor above but never written to by a sync).
        // get_cursor is per-entity_type, so the two never leak into each other.
        assert_eq!(
            store.get_cursor("/proj", "story").unwrap().unwrap().last_synced_modified,
            Some("2026-08-26 10:00:00".to_string()),
        );
        assert_eq!(
            store.get_cursor("/proj", "task").unwrap().unwrap().last_synced_modified,
            None,
            "task cursor exists but never written to"
        );
    }

    #[test]
    fn cursor_summary_aggregates_across_entity_types() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "story").unwrap();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();

        // story: success, watermark 10:00, 3 fetched/2 added
        store.try_acquire_lock("/proj", "story", "owner", 300).unwrap();
        store
            .release_lock_success(
                "/proj",
                "story",
                "owner",
                Some("2026-08-26 10:00:00"),
                &SyncStats { fetched: 3, added: 2, updated: 1, duplicate: 0, failed: 0 },
                100,
            )
            .unwrap();

        // task: failure, no advance
        store.try_acquire_lock("/proj", "task", "owner", 300).unwrap();
        store
            .release_lock_failure(
                "/proj",
                "task",
                "owner",
                "network error",
                &SyncStats { fetched: 1, added: 0, updated: 0, duplicate: 0, failed: 1 },
                50,
            )
            .unwrap();

        let summary = store.get_cursor_summary("/proj").unwrap().unwrap();
        assert_eq!(
            summary.last_sync_status,
            Some("failed".to_string()),
            "any cursor failed → summary failed"
        );
        assert_eq!(summary.last_sync_error, Some("network error".to_string()));
        assert_eq!(summary.last_sync_stats.fetched, 4);
        assert_eq!(summary.last_sync_stats.added, 2);
        assert_eq!(summary.last_sync_stats.failed, 1);
        assert!(
            summary.lock_owner.is_none(),
            "no live leases → summary is not syncing"
        );
    }

    #[test]
    fn cursor_summary_is_syncing_when_any_entity_type_is_locked() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/proj", "12345", "story").unwrap();
        store.upsert_project_cursor("/proj", "12345", "task").unwrap();
        assert!(store.try_acquire_lock("/proj", "task", "owner", 300).unwrap());

        let summary = store.get_cursor_summary("/proj").unwrap().unwrap();
        assert_eq!(
            summary.lock_owner,
            Some("owner".to_string()),
            "any live lease → workbench shows syncing"
        );
    }

    #[test]
    fn reconcile_stale_processing_tasks_requeues_under_retry_limit() {
        let (store, _dir) = store();
        let input = sample_task("/proj", "1");
        store.upsert_task(&input).unwrap();
        let id = task_id(&input.directory, &input.workspace_id, &input.entity_type, &input.tapd_id);
        store.claim_task(&id, 600).unwrap();

        let n = store.reconcile_stale_processing_tasks(-1).unwrap();
        assert_eq!(n, 1);

        let counts = store.task_counts("/proj").unwrap();
        assert_eq!(counts.pending, 1, "recovered task should be requeued, not lost");
    }

    #[test]
    fn reconcile_stale_processing_tasks_marks_failed_past_max_retries() {
        let (store, _dir) = store();
        let input = sample_task("/proj", "1");
        store.upsert_task(&input).unwrap();
        let id = task_id(&input.directory, &input.workspace_id, &input.entity_type, &input.tapd_id);

        for _ in 0..3 {
            store.claim_task(&id, 600).unwrap();
            store.reconcile_stale_processing_tasks(-1).unwrap();
        }

        let counts = store.task_counts("/proj").unwrap();
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.pending, 0);
    }

    #[test]
    fn reconcile_stale_runs_marks_running_as_failed() {
        let (store, _dir) = store();
        let run_id = store.start_run("/proj", "manual").unwrap();
        let n = store.reconcile_stale_runs().unwrap();
        assert_eq!(n, 1);
        let runs = store.recent_runs("/proj", 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run_id);
        assert_eq!(runs[0].status, "failed");
    }

    #[test]
    fn list_tasks_filters_by_queue_state_and_module() {
        let (store, _dir) = store();
        let mut t1 = sample_task("/proj", "1");
        t1.module = Some("A".to_string());
        let mut t2 = sample_task("/proj", "2");
        t2.module = Some("B".to_string());
        store.upsert_task(&t1).unwrap();
        store.upsert_task(&t2).unwrap();

        let filtered = store
            .list_tasks(
                "/proj",
                &TaskListFilter {
                    module: Some("A".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].tapd_id, "1");
    }

    #[test]
    fn directories_are_isolated() {
        let (store, _dir) = store();
        store.upsert_project_cursor("/a", "111", "task").unwrap();
        store.upsert_project_cursor("/b", "222", "task").unwrap();
        store.try_acquire_lock("/a", "task", "owner", 300).unwrap();
        // Locking /a must not affect /b's ability to be locked.
        assert!(store.try_acquire_lock("/b", "task", "owner", 300).unwrap());
    }

    #[test]
    fn workbench_state_round_trip() {
        let (store, _dir) = store();
        store.put_workbench_state("TAPD-1234", "pending").unwrap();
        assert_eq!(
            store.get_workbench_state("TAPD-1234").unwrap(),
            Some("pending".into())
        );
        store.put_workbench_state("TAPD-1234", "running:develop:0").unwrap();
        assert_eq!(
            store.get_workbench_state("TAPD-1234").unwrap(),
            Some("running:develop:0".into())
        );
        assert!(store.get_workbench_state("TAPD-9999").unwrap().is_none());
    }
}
