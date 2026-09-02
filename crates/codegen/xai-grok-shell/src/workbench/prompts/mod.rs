//! Per-role system prompt templates and renderers.
//!
//! Each prompt lives in a sibling `.md.tmpl` file (loaded via `include_str!`)
//! and is rendered via the corresponding `render_*` function. Templating is
//! plain string replacement on `{{var}}` placeholders — no template engine
//! to keep the dependency surface small (matches YAGNI per AGENTS.md).

pub mod planner;

pub use planner::*;
