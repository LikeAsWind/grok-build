//! Embedded web frontend assets.
//!
//! When the `web-ui` feature is enabled, `web/dist` (the vite production build)
//! is compiled into the binary at build time. When disabled, asset lookups
//! fail so the router can serve a notice page instead.

use std::borrow::Cow;

#[cfg(feature = "web-ui")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../../../web/dist"]
struct WebAssets;

/// Content-Type for a vite dist asset, by extension.
pub fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" | "map" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Look up an embedded asset by path; always `None` when `web-ui` is off.
pub fn get(path: &str) -> Option<Cow<'static, [u8]>> {
    #[cfg(feature = "web-ui")]
    {
        WebAssets::get(path).map(|f| f.data)
    }
    #[cfg(not(feature = "web-ui"))]
    {
        let _ = path;
        None
    }
}
