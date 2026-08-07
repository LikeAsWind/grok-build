//! OpenCode-style web UI for Grok Build.
//!
//! `grok web` serves the compiled frontend (from `web/dist`, embedded via
//! rust-embed behind the `web-ui` feature) alongside the existing ACP agent
//! WebSocket endpoint (`/ws`, reused from `xai-grok-shell::agent::server`).
//! Browsers speak the native ACP JSON-RPC protocol directly over that
//! WebSocket — no backend protocol changes.

pub mod assets;
pub mod daemon;
pub mod router;

pub use router::WebConfig;

use std::net::SocketAddr;

use axum::Router;
use tokio::net::TcpListener;
use tracing::info;

use xai_grok_shell::agent::config::Config as AgentConfig;
use xai_grok_shell::agent::server::{ServerConfig, agent_ws_router};

/// Serve the web UI + ACP agent endpoint on a TCP listener.
pub async fn run_web_server(web: WebConfig, agent: AgentConfig) -> anyhow::Result<()> {
    let server_config = ServerConfig {
        bind_addr: web.bind_addr,
        secret: web.secret.clone(),
    };

    let app: Router = agent_ws_router(server_config, agent).merge(router::web_routes(&web));

    let listener = TcpListener::bind(web.bind_addr).await?;
    info!("Grok web UI listening on http://{}/", web.bind_addr);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
