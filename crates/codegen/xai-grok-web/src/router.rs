//! HTTP routes for the web UI: `/config` (non-sensitive metadata) and the
//! SPA static assets (embedded via `assets`).

use axum::{
    Router,
    body::Body,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::assets;

/// Runtime configuration for the web server.
#[derive(Debug, Clone)]
pub struct WebConfig {
    pub bind_addr: std::net::SocketAddr,
    pub secret: String,
    /// Version string surfaced on `/config` for the frontend.
    pub version: String,
    /// Working directory sessions are created in (the dir `grok web` ran from).
    pub cwd: std::path::PathBuf,
}

/// Build the web routes: `/config` + static SPA assets.
pub fn web_routes(config: &WebConfig) -> Router {
    Router::new()
        .route("/config", get(config_endpoint))
        .fallback(static_asset)
        .with_state(config.clone())
}

/// `GET /config` — non-sensitive metadata the frontend needs before
/// connecting (the WebSocket path + initial cwd). The secret itself is
/// delivered via the URL fragment, never here.
async fn config_endpoint(
    axum::extract::State(state): axum::extract::State<WebConfig>,
) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "wsPath": "/ws",
        "version": state.version,
        "cwd": state.cwd.to_string_lossy(),
    }))
}

/// Serve an embedded asset; fall back to `index.html` for SPA routes.
async fn static_asset(
    axum::extract::State(_state): axum::extract::State<WebConfig>,
    uri: Uri,
) -> Response {    let path = uri.path().trim_start_matches('/');
    let empty = path.is_empty();
    let asset_path = if empty { "index.html" } else { path };

    match assets::get(asset_path) {
        Some(data) => {
            let mut resp = Response::new(Body::from(data.to_vec()));
            if let Ok(ct) = HeaderValue::from_str(assets::content_type(asset_path)) {
                resp.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            // Vite hashed assets are immutable; index.html must not be cached
            // so new deploys are picked up.
            let cache = if empty || asset_path == "index.html" {
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            };
            if let Ok(cv) = HeaderValue::from_str(cache) {
                resp.headers_mut().insert(header::CACHE_CONTROL, cv);
            }
            resp
        }
        None => {
            // If the file isn't an embedded asset, it might be a client-side
            // route — serve index.html for the SPA (except for real file
            // extensions, which 404).
            if asset_path.contains('.') {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("not found"))
                    .unwrap()
            } else {
                serve_index()
            }
        }
    }
}

fn serve_index() -> Response {
    match assets::get("index.html") {
        Some(data) => {
            let mut resp = Response::new(Body::from(data.to_vec()));
            if let Ok(ct) = HeaderValue::from_str("text/html; charset=utf-8") {
                resp.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            resp
        }
        None => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::from(
                "Web UI not compiled in. Rebuild with `--features web-ui` after \
                 running `bun run build` in web/.",
            ))
            .unwrap(),
    }
}
