//! HTTP routes for the web UI: `/config` (non-sensitive metadata), the grok
//! `config.toml` editor endpoints, and the SPA static assets (embedded via
//! `assets`).

use axum::{
    Router,
    body::Body,
    extract::Query,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::cors::{Any, CorsLayer};

use crate::assets;
use crate::pty;

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

/// Build the web routes: `/config`, `/config-file` + static SPA assets.
///
/// CORS is permissive so a separately-hosted frontend (vite dev server,
/// nginx/CDN) can call these endpoints; `/config` carries no secrets and
/// `/config-file` requires the server key.
pub fn web_routes(config: &WebConfig) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::PUT, Method::PATCH])
        .allow_headers([header::CONTENT_TYPE, header::HeaderName::from_static("x-server-key")]);

    Router::new()
        .route("/config", get(config_endpoint))
        .route("/browse-dir", get(browse_dir_endpoint))
        .route("/pty/{pty_id}/connect", get(pty::pty_ws_handler))
        .route(
            "/config-file",
            get(config_file_get).put(config_file_put).patch(config_file_patch),
        )
        .layer(cors)
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

#[derive(serde::Deserialize)]
struct SecretQuery {
    #[serde(rename = "server-key")]
    server_key: Option<String>,
    /// `format=json` on GET /config-file additionally returns the parsed TOML.
    format: Option<String>,
}

/// The `x-server-key` header or `?server-key=` query must match the server
/// secret; the config file contains API keys.
fn check_secret(state: &WebConfig, headers: &HeaderMap, query: &SecretQuery) -> Result<(), Response> {
    let provided = headers
        .get("x-server-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query.server_key.clone());
    if provided.as_deref() == Some(state.secret.as_str()) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "invalid or missing server key").into_response())
    }
}

fn grok_config_path() -> std::path::PathBuf {
    xai_grok_config::grok_home().join("config.toml")
}

/// `GET /config-file` — the current `~/.grok/config.toml` contents.
/// With `?format=json`, also returns `parsed` (TOML → JSON) for form UIs.
async fn config_file_get(
    axum::extract::State(state): axum::extract::State<WebConfig>,
    headers: HeaderMap,
    Query(query): Query<SecretQuery>,
) -> Response {
    if let Err(resp) = check_secret(&state, &headers, &query) {
        return resp;
    }
    let path = grok_config_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("read {} failed: {e}", path.display()),
            )
                .into_response()
        }
    };
    let mut body = serde_json::json!({
        "path": path.to_string_lossy(),
        "content": content,
    });
    if query.format.as_deref() == Some("json") {
        match content.parse::<toml::Table>() {
            Ok(table) => {
                body["parsed"] = serde_json::to_value(&table).unwrap_or(serde_json::Value::Null);
            }
            Err(e) => {
                body["parseError"] = serde_json::Value::String(e.to_string());
            }
        }
    }
    axum::Json(body).into_response()
}

#[derive(serde::Deserialize)]
struct ConfigFilePut {
    content: String,
}/// `PUT /config-file` — validate the body as TOML and write it to
/// `~/.grok/config.toml`. The shell's config watcher hot-reloads model and
/// MCP changes, so no restart is needed for those.
async fn config_file_put(
    axum::extract::State(state): axum::extract::State<WebConfig>,
    headers: HeaderMap,
    Query(query): Query<SecretQuery>,
    axum::Json(body): axum::Json<ConfigFilePut>,
) -> Response {
    if let Err(resp) = check_secret(&state, &headers, &query) {
        return resp;
    }
    if let Err(e) = body.content.parse::<toml::Table>() {
        return (StatusCode::BAD_REQUEST, format!("TOML 语法错误: {e}")).into_response();
    }
    let path = grok_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, body.content.as_bytes()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {} failed: {e}", path.display()),
        )
            .into_response();
    }
    axum::Json(serde_json::json!({ "ok": true })).into_response()
}

// ── PATCH /config-file — structured edits that preserve comments ─────

#[derive(serde::Deserialize)]
struct SetOp {
    /// Key path segments, e.g. `["model", "claude-sonnet", "api_key"]`.
    /// Segments may contain dots (model ids like "grok-4.20"), hence an array.
    path: Vec<String>,
    value: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct DeleteOp {
    path: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFilePatch {
    #[serde(default)]
    set: Vec<SetOp>,
    #[serde(default)]
    delete: Vec<DeleteOp>,
}

fn json_to_toml_item(value: &serde_json::Value) -> Result<toml_edit::Item, String> {
    use toml_edit::{value as v, Item};
    Ok(match value {
        serde_json::Value::Null => return Err("null 不能写入 TOML（用 delete 删除该键）".into()),
        serde_json::Value::Bool(b) => v(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                v(i)
            } else if let Some(f) = n.as_f64() {
                v(f)
            } else {
                return Err(format!("无法表示的数字: {n}"));
            }
        }
        serde_json::Value::String(s) => v(s.clone()),
        serde_json::Value::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for item in items {
                match json_to_toml_item(item)? {
                    Item::Value(val) => arr.push(val),
                    _ => return Err("数组元素必须是标量或内联值".into()),
                }
            }
            Item::Value(toml_edit::Value::Array(arr))
        }
        serde_json::Value::Object(map) => {
            let mut table = toml_edit::InlineTable::new();
            for (k, val) in map {
                match json_to_toml_item(val)? {
                    Item::Value(val) => {
                        table.insert(k, val);
                    }
                    _ => return Err("嵌套对象仅支持一层内联表".into()),
                }
            }
            Item::Value(toml_edit::Value::InlineTable(table))
        }
    })
}

/// Walk (and create) tables along `path[..len-1]`, then run `f` on the final
/// table + last key. New intermediate tables are regular (non-inline) tables.
fn with_parent_table<F>(
    doc: &mut toml_edit::DocumentMut,
    path: &[String],
    create_missing: bool,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(&mut toml_edit::Table, &str),
{
    let (last, parents) = path.split_last().ok_or("path 不能为空")?;
    let mut table = doc.as_table_mut();
    for seg in parents {
        if table.get(seg).is_none() {
            if !create_missing {
                return Ok(()); // delete 时父表不存在 = 无事可做
            }
            let mut new_table = toml_edit::Table::new();
            new_table.set_implicit(true);
            table.insert(seg, toml_edit::Item::Table(new_table));
        }
        table = table
            .get_mut(seg)
            .and_then(|item| item.as_table_mut())
            .ok_or_else(|| format!("`{seg}` 已存在且不是表，无法进入"))?;
    }
    f(table, last);
    Ok(())
}

/// `PATCH /config-file` — apply structured set/delete operations via
/// `toml_edit`, preserving comments and formatting of untouched content.
async fn config_file_patch(
    axum::extract::State(state): axum::extract::State<WebConfig>,
    headers: HeaderMap,
    Query(query): Query<SecretQuery>,
    axum::Json(patch): axum::Json<ConfigFilePatch>,
) -> Response {
    if let Err(resp) = check_secret(&state, &headers, &query) {
        return resp;
    }
    let path = grok_config_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("read {} failed: {e}", path.display()),
            )
                .into_response()
        }
    };
    let mut doc = match content.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("现有配置解析失败: {e}")).into_response(),
    };

    for op in &patch.set {
        let item = match json_to_toml_item(&op.value) {
            Ok(i) => i,
            Err(e) => return (StatusCode::BAD_REQUEST, format!("{}: {e}", op.path.join("."))).into_response(),
        };
        if let Err(e) = with_parent_table(&mut doc, &op.path, true, |table, key| {
            table.insert(key, item);
        }) {
            return (StatusCode::BAD_REQUEST, format!("{}: {e}", op.path.join("."))).into_response();
        }
    }
    for op in &patch.delete {
        if let Err(e) = with_parent_table(&mut doc, &op.path, false, |table, key| {
            table.remove(key);
        }) {
            return (StatusCode::BAD_REQUEST, format!("{}: {e}", op.path.join("."))).into_response();
        }
    }

    let new_content = doc.to_string();
    // 写回前再整体校验一遍（防御 toml_edit 与 toml 解析差异）
    if let Err(e) = new_content.parse::<toml::Table>() {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("patch 结果非法: {e}")).into_response();
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, new_content.as_bytes()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write {} failed: {e}", path.display()),
        )
            .into_response();
    }
    axum::Json(serde_json::json!({ "ok": true })).into_response()
}

// ── GET /browse-dir — local filesystem directory browser ──────────────

#[derive(serde::Deserialize)]
struct BrowseDirQuery {
    #[serde(rename = "server-key")]
    server_key: Option<String>,
    path: Option<String>,
}

#[derive(serde::Serialize)]
struct BrowseDirEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

async fn browse_dir_endpoint(
    axum::extract::State(state): axum::extract::State<WebConfig>,
    headers: HeaderMap,
    Query(query): Query<BrowseDirQuery>,
) -> Response {
    let secret_query = SecretQuery {
        server_key: query.server_key,
        format: None,
    };
    if let Err(resp) = check_secret(&state, &headers, &secret_query) {
        return resp;
    }

    let mut path = std::path::PathBuf::new();
    if let Some(p) = &query.path {
        path.push(p);
    }

    // 空路径 → 平台根目录
    if path.as_os_str().is_empty() {
        #[cfg(target_os = "windows")]
        {
            // Windows: 返回盘符列表
            let mut entries: Vec<BrowseDirEntry> = Vec::new();
            for letter in b'A'..=b'Z' {
                let drive = format!("{}:\\", letter as char);
                if std::path::Path::new(&drive).exists() {
                    entries.push(BrowseDirEntry { name: drive, is_dir: true });
                }
            }
            return axum::Json(serde_json::json!({
                "path": "",
                "entries": entries,
                "error": serde_json::Value::Null,
            }))
            .into_response();
        }
        #[cfg(not(target_os = "windows"))]
        {
            path.push("/");
        }
    }

    match std::fs::read_dir(&path) {
        Ok(iter) => {
            let mut entries: Vec<BrowseDirEntry> = Vec::new();
            for entry in iter.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                entries.push(BrowseDirEntry { name, is_dir });
            }
            entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
            axum::Json(serde_json::json!({
                "path": path.to_string_lossy(),
                "entries": entries,
                "error": serde_json::Value::Null,
            }))
            .into_response()
        }
        Err(e) => axum::Json(serde_json::json!({
            "path": path.to_string_lossy(),
            "entries": [],
            "error": format!("无法读取目录: {e}"),
        }))
        .into_response(),
    }
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
