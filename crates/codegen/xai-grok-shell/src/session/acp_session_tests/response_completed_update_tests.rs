use super::support::*;
use super::*;
use xai_grok_sampling_types::{ConversationItem, ConversationResponse, TokenUsage};

fn response_with_usage_and_cost(cost_usd_ticks: Option<i64>) -> ConversationResponse {
    ConversationResponse {
        items: vec![ConversationItem::assistant("ok")],
        stop_reason: None,
        usage: Some(TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            reasoning_tokens: 5,
            cached_prompt_tokens: 10,
            cache_creation_prompt_tokens: 20,
        }),
        cost_usd_ticks,
        message_chunks_emitted: 1,
        doom_loop_signals: Vec::new(),
        stop_message: None,
        message_id: Some("msg-1".to_string()),
        raw_stop_reason: Some("end_turn".to_string()),
        stop_sequence: None,
    }
}

fn response_without_usage() -> ConversationResponse {
    ConversationResponse {
        items: vec![ConversationItem::assistant("ok")],
        stop_reason: None,
        usage: None,
        cost_usd_ticks: None,
        message_chunks_emitted: 1,
        doom_loop_signals: Vec::new(),
        stop_message: None,
        message_id: None,
        raw_stop_reason: None,
        stop_sequence: None,
    }
}

/// `response.cost_usd_ticks` (the single-call cost already normalized by the
/// sampler) must be carried through into `ResponseUsage.cost_usd_ticks` on the
/// wire notification — this is the field the web UI's Step Finish info line
/// reads for its cost display.
#[tokio::test(flavor = "current_thread")]
async fn carries_cost_usd_ticks_into_response_usage() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _) =
                tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
            let (persistence_tx, _) = tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
            let actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;

            let update = actor.response_completed_update(&response_with_usage_and_cost(Some(42)));

            let XaiSessionUpdate::ResponseCompleted { usage, .. } = update else {
                panic!("expected ResponseCompleted");
            };
            let usage = usage.expect("usage present when response.usage is Some");
            assert_eq!(usage.cost_usd_ticks, Some(42));
        })
        .await;
}

/// A response with no reported cost must carry `None`, not `Some(0)` — the
/// wire distinguishes "unreported" from "free".
#[tokio::test(flavor = "current_thread")]
async fn none_cost_stays_none_on_response_usage() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _) =
                tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
            let (persistence_tx, _) = tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
            let actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;

            let update = actor.response_completed_update(&response_with_usage_and_cost(None));

            let XaiSessionUpdate::ResponseCompleted { usage, .. } = update else {
                panic!("expected ResponseCompleted");
            };
            let usage = usage.expect("usage present when response.usage is Some");
            assert_eq!(usage.cost_usd_ticks, None);
        })
        .await;
}

/// A response with no `usage` at all must produce `usage: None` on the
/// notification (not a zeroed `ResponseUsage`) — the web bridge relies on
/// `usage` absence to skip emitting a step-finish part.
#[tokio::test(flavor = "current_thread")]
async fn no_usage_on_response_yields_no_usage_on_notification() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _) =
                tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
            let (persistence_tx, _) = tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
            let actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;

            let update = actor.response_completed_update(&response_without_usage());

            let XaiSessionUpdate::ResponseCompleted { usage, .. } = update else {
                panic!("expected ResponseCompleted");
            };
            assert!(usage.is_none());
        })
        .await;
}

/// `ResponseCompleted` must reach the client via [`SessionActor::send_xai_notification`]
/// (persist + gateway), not [`SessionActor::send_buffered_xai_update`] (the
/// `ReplayBuffer` path reserved for high-frequency streaming deltas like
/// `ToolCallDeltaChunk`, which deliberately skips persistence). Sending it
/// through the buffered path means it never lands in `updates.jsonl`, so a
/// reconnect/reload replay silently drops the web UI's Step Finish info line
/// — this test pins the caller to the persisting path so that regression
/// can't reappear silently.
#[tokio::test(flavor = "current_thread")]
async fn response_completed_is_persisted_via_send_xai_notification() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (gateway_tx, _) =
                tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
            let (persistence_tx, mut prx) =
                tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
            let actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;

            let update = actor.response_completed_update(&response_with_usage_and_cost(Some(7)));
            actor.send_xai_notification(update).await;

            let persisted = prx
                .try_recv()
                .expect("ResponseCompleted must be persisted immediately");
            let PersistenceMsg::Update(crate::session::storage::SessionUpdate::Xai(notif)) =
                persisted
            else {
                panic!("expected a persisted xAI update");
            };
            assert!(matches!(
                notif.update,
                XaiSessionUpdate::ResponseCompleted { .. }
            ));
            assert!(
                notif
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("eventId"))
                    .is_some(),
                "persisted line must carry an eventId for cursor-addressable replay"
            );
        })
        .await;
}
