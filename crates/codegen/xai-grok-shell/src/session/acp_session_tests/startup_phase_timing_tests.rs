//! Coverage for the `/context` "Startup phases" panel's two previously-stuck
//! timing fields (`skill_discovery_elapsed`, `mcp_startup_elapsed`):
//! `wait_for_mcp_handshakes_bounded`'s no-MCP-configured early return and
//! idempotency, plus the `SessionCommand::Initialize` detached best-effort
//! tasks that populate both fields for a normal (interactive/`Progressive`)
//! Web session — which previously never called either path and so left the
//! panel spinning forever.

use super::support::*;
use super::*;
use tokio::sync::mpsc;

/// A session with no MCP servers configured (`McpState::new(vec![])`, the
/// `create_test_actor` default) must still get a `Some` elapsed time from
/// `wait_for_mcp_handshakes_bounded` — the early-return branch used to skip
/// writing `mcp_startup_elapsed` entirely, leaving the `/context` panel's MCP
/// Startup row spinning forever for the (common) case of a session with no
/// MCP servers at all.
#[tokio::test(flavor = "current_thread")]
async fn no_mcp_configured_still_records_a_near_zero_elapsed() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _gateway_rx) = mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = mpsc::unbounded_channel();
            let actor = create_test_actor(0, 200_000, 85, gateway_tx, persistence_tx).await;

            assert!(actor.mcp_startup_elapsed.lock().unwrap().is_none());
            actor
                .wait_for_mcp_handshakes_bounded(std::time::Duration::from_secs(5))
                .await;
            assert!(
                actor.mcp_startup_elapsed.lock().unwrap().is_some(),
                "no MCP servers configured must still yield a (near-zero) elapsed time, \
                 not leave the field None forever"
            );
        })
        .await;
}

/// A second call must not overwrite an already-recorded elapsed time — this
/// is what lets the `Blocking`-strategy call (from `build_prefix_background`)
/// and the best-effort `Progressive`-strategy timing task (spawned from
/// `SessionCommand::Initialize`) coexist without one clobbering the other's
/// real measurement with a near-zero one.
#[tokio::test(flavor = "current_thread")]
async fn second_call_does_not_overwrite_first_recorded_elapsed() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _gateway_rx) = mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = mpsc::unbounded_channel();
            let actor = create_test_actor(0, 200_000, 85, gateway_tx, persistence_tx).await;

            actor
                .wait_for_mcp_handshakes_bounded(std::time::Duration::from_secs(5))
                .await;
            let first = actor
                .mcp_startup_elapsed
                .lock()
                .unwrap()
                .expect("first call must record a value");

            // Force a distinguishable value so a second write would be detectable.
            *actor.mcp_startup_elapsed.lock().unwrap() = Some(std::time::Duration::from_secs(999));
            actor
                .wait_for_mcp_handshakes_bounded(std::time::Duration::from_secs(5))
                .await;
            let second = actor.mcp_startup_elapsed.lock().unwrap().unwrap();
            assert_eq!(
                second,
                std::time::Duration::from_secs(999),
                "an already-set elapsed time must not be overwritten by a later call"
            );
            let _ = first;
        })
        .await;
}

/// `SessionCommand::Initialize` must, in the background, populate
/// `skill_discovery_elapsed` for a normal session — this is the detached
/// best-effort `reload_skills_from_disk` rerun that gives the `/context`
/// panel a real value (the *actual* initial discovery inside
/// `AgentBuilder::build()` is folded into `system_prompt_build_elapsed` and
/// was never recorded here, leaving this field permanently `None` before the
/// fix).
#[tokio::test(flavor = "current_thread")]
async fn initialize_populates_skill_discovery_elapsed_in_the_background() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _gateway_rx) = mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = mpsc::unbounded_channel();
            let (actor, event_rx) =
                create_test_actor_ex(0, 200_000, 85, gateway_tx, persistence_tx).await;
            let actor = std::sync::Arc::new(actor);

            assert!(actor.skill_discovery_elapsed.lock().unwrap().is_none());

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
            let (_chat_tx, chat_rx) = mpsc::unbounded_channel::<xai_chat_state::ChatStateEvent>();
            let codebase_indexes = std::sync::Arc::new(parking_lot::Mutex::new(
                xai_grok_workspace::file_system::CodebaseIndexManager::new(),
            ));
            tokio::task::spawn_local(super::run_session(
                actor.clone(),
                cmd_rx,
                chat_rx,
                event_rx,
                None,
                codebase_indexes,
                std::path::PathBuf::from("/tmp"),
                crate::session::fs_watch::FsWatchCapabilities::none(),
            ));

            cmd_tx
                .send(SessionCommand::Initialize {
                    system_prompt: "test system prompt".to_string(),
                })
                .unwrap();

            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if actor.skill_discovery_elapsed.lock().unwrap().is_some() {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "skill_discovery_elapsed must be populated within 5s of Initialize"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
}

/// A *resumed* session (non-empty `chat_history`) never sends
/// `SessionCommand::Initialize` — before the fix this meant
/// `skill_discovery_elapsed` / `mcp_startup_elapsed` stayed `None` forever
/// for any loaded session, no matter how long the `/context` panel polled.
/// `SessionCommand::RunStartupPhaseProbes` is the explicit probe-only command
/// sent for that case; it must populate both fields the same way `Initialize`
/// does for a new session.
#[tokio::test(flavor = "current_thread")]
async fn run_startup_phase_probes_populates_both_fields_for_a_resumed_session() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _gateway_rx) = mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = mpsc::unbounded_channel();
            let (actor, event_rx) =
                create_test_actor_ex(0, 200_000, 85, gateway_tx, persistence_tx).await;
            actor.mcp_strategy.set(McpInitStrategy::Progressive);
            let actor = std::sync::Arc::new(actor);

            assert!(actor.skill_discovery_elapsed.lock().unwrap().is_none());
            assert!(actor.mcp_startup_elapsed.lock().unwrap().is_none());

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
            let (_chat_tx, chat_rx) = mpsc::unbounded_channel::<xai_chat_state::ChatStateEvent>();
            let codebase_indexes = std::sync::Arc::new(parking_lot::Mutex::new(
                xai_grok_workspace::file_system::CodebaseIndexManager::new(),
            ));
            tokio::task::spawn_local(super::run_session(
                actor.clone(),
                cmd_rx,
                chat_rx,
                event_rx,
                None,
                codebase_indexes,
                std::path::PathBuf::from("/tmp"),
                crate::session::fs_watch::FsWatchCapabilities::none(),
            ));

            // The resumed-session path never sends `Initialize`.
            cmd_tx.send(SessionCommand::RunStartupPhaseProbes).unwrap();

            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let skill_done = actor.skill_discovery_elapsed.lock().unwrap().is_some();
                let mcp_done = actor.mcp_startup_elapsed.lock().unwrap().is_some();
                if skill_done && mcp_done {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "RunStartupPhaseProbes must populate both fields within 5s for a resumed \
                     session — skill_done={skill_done} mcp_done={mcp_done}"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
}

/// Same as above, for `mcp_startup_elapsed` under the `Progressive` strategy
/// (the interactive/Web default) — `build_prefix_background` never calls
/// `wait_for_mcp_handshakes_bounded` for `Progressive` sessions, so before the
/// fix this field stayed `None` forever for the vast majority of Web
/// sessions.
#[tokio::test(flavor = "current_thread")]
async fn initialize_populates_mcp_startup_elapsed_for_progressive_strategy() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _gateway_rx) = mpsc::unbounded_channel();
            let (persistence_tx, _persistence_rx) = mpsc::unbounded_channel();
            let (actor, event_rx) =
                create_test_actor_ex(0, 200_000, 85, gateway_tx, persistence_tx).await;
            actor.mcp_strategy.set(McpInitStrategy::Progressive);
            let actor = std::sync::Arc::new(actor);

            assert!(actor.mcp_startup_elapsed.lock().unwrap().is_none());

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
            let (_chat_tx, chat_rx) = mpsc::unbounded_channel::<xai_chat_state::ChatStateEvent>();
            let codebase_indexes = std::sync::Arc::new(parking_lot::Mutex::new(
                xai_grok_workspace::file_system::CodebaseIndexManager::new(),
            ));
            tokio::task::spawn_local(super::run_session(
                actor.clone(),
                cmd_rx,
                chat_rx,
                event_rx,
                None,
                codebase_indexes,
                std::path::PathBuf::from("/tmp"),
                crate::session::fs_watch::FsWatchCapabilities::none(),
            ));

            cmd_tx
                .send(SessionCommand::Initialize {
                    system_prompt: "test system prompt".to_string(),
                })
                .unwrap();

            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if actor.mcp_startup_elapsed.lock().unwrap().is_some() {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "mcp_startup_elapsed must be populated within 5s of Initialize \
                     under the Progressive strategy"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
}
