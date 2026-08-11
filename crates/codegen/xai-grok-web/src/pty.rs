//! PTY WebSocket endpoint — `/pty/{pty_id}/connect`
//!
//! Spawns a shell process per connection and bridges raw binary I/O between
//! the frontend xterm.js and ptyctl's PtySession.  The protocol is:
//!   Server → Client:  raw binary output frames, with periodic `\0`+JSON
//!                     control frames (`{"cursor": N}`) for offset tracking.
//!   Client → Server:  raw UTF-8 text frames (keystrokes).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use ptyctl::pty::PtyConfig;
use ptyctl::session::{PtySession, SessionConfig};
use tokio::sync::{RwLock, broadcast};

use crate::WebConfig;

// ── Session registry ─────────────────────────────────────────────────

static REGISTRY: LazyLock<RwLock<HashMap<String, Arc<PtySession>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Look up or auto-create a PTY session for the given id.
///
/// When a frontend opens `/pty/{id}/connect`, the backend spawns a default
/// shell in the server's CWD if no session exists for `id` yet.
async fn get_or_create(id: &str, state: &WebConfig) -> Option<Arc<PtySession>> {
    {
        let reg = REGISTRY.read().await;
        if let Some(s) = reg.get(id) {
            if s.is_alive() {
                return Some(s.clone());
            }
        }
    }
    // Create new session
    let mut reg = REGISTRY.write().await;
    // Double-check after acquiring write lock
    if let Some(s) = reg.get(id) {
        if s.is_alive() {
            return Some(s.clone());
        }
        // dead session → remove and recreate
        reg.remove(id);
    }
    let shell = resolve_shell();
    let cwd = state.cwd.clone();
    let config = SessionConfig {
        pty: PtyConfig {
            command: shell,
            cols: 120,
            rows: 40,
            cwd: Some(cwd),
            env: std::collections::HashMap::new(),
        },
        timeout: None,
        linger: false,
    };
    match PtySession::start(config).await {
        Ok(session) => {
            let arc = Arc::new(session);
            let handle = arc.clone();
            reg.insert(id.to_string(), arc);
            tracing::info!(pty_id = %id, "PTY session created");
            Some(handle)
        }
        Err(e) => {
            tracing::error!(pty_id = %id, error = %e, "Failed to create PTY session");
            None
        }
    }
}

fn resolve_shell() -> Vec<String> {
    #[cfg(windows)]
    {
        if let Ok(c) = std::env::var("COMSPEC") { return vec![c] }
        vec!["cmd.exe".to_string()]
    }
    #[cfg(not(windows))]
    {
        if let Ok(s) = std::env::var("SHELL") { return vec![s] }
        vec!["/bin/sh".to_string()]
    }
}

// ── Query params ─────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
pub struct PtyQuery {
    #[serde(default)]
    auth_token: Option<String>,
    #[serde(default)]
    directory: Option<String>,
}

// ── WebSocket handler ────────────────────────────────────────────────

pub(crate) async fn pty_ws_handler(
    ws: WebSocketUpgrade,
    Path(pty_id): Path<String>,
    Query(query): Query<PtyQuery>,
    State(state): State<WebConfig>,
) -> impl axum::response::IntoResponse {
    // Auth: in dev mode (no secret) allow all; otherwise verify token
    if !state.secret.is_empty() && !query.auth_token.as_deref().map_or(false, |t| is_valid_auth(t, &state)) {
        return (axum::http::StatusCode::UNAUTHORIZED, "invalid auth_token").into_response();
    }

    ws.on_upgrade(move |socket| handle_pty_ws(socket, pty_id, query, state))
}

fn is_valid_auth(token: &str, state: &WebConfig) -> bool {
    if state.secret.is_empty() { return true }
    let creds = format!("user:{}", state.secret);
    token == simple_base64(&creds)
}

fn simple_base64(input: &str) -> String {
    // Same as JS `btoa(str)` for ASCII input
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 0x3F) as usize]);
        out.push(CHARS[((n >> 12) & 0x3F) as usize]);
        if chunk.len() > 1 { out.push(CHARS[((n >> 6) & 0x3F) as usize]); } else { out.push(b'='); }
        if chunk.len() > 2 { out.push(CHARS[(n & 0x3F) as usize]); } else { out.push(b'='); }
    }
    String::from_utf8(out).unwrap_or_default()
}

async fn handle_pty_ws(mut socket: WebSocket, pty_id: String, query: PtyQuery, state: WebConfig) {
    let Some(session) = get_or_create(&pty_id, &state).await else {
        let _ = socket.close().await;
        return;
    };

    let _ = query.directory;

    let (mut writer, mut reader) = socket.split();
    let mut rx = session.subscribe();

    // ── Reader task: PTY output → WebSocket ──────────────────────
    let _session_read = session.clone();
    let read_task = tokio::spawn(async move {
        let mut control_tick = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            tokio::select! {
                output = rx.recv() => {
                    match output {
                        Ok(data) => {
                            if writer.send(Message::Binary(data.into())).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = control_tick.tick() => {
                    // Periodic keep-alive
                    let _ = writer.send(Message::Text("\0{\"cursor\":0}".into())).await;
                }
            }
        }
    });

    // ── Writer task: WebSocket input → PTY ──────────────────────
    let session_write = session.clone();
    let write_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = reader.next().await {
            match msg {
                Message::Text(text) => {
                    if session_write.send_bytes(text.as_bytes()).await.is_err() { break; }
                }
                Message::Binary(data) => {
                    if session_write.send_bytes(&data).await.is_err() { break; }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = read_task => {}
        _ = write_task => {}
    }

    // Cleanup: remove dead session
    let mut reg = REGISTRY.write().await;
    reg.remove(&pty_id);
    tracing::info!(pty_id = %pty_id, "PTY session closed");
}
