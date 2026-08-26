//! [`TapdConfigSource`] backed by reading `[tapd]` straight from
//! `config.toml` on disk on every call.
//!
//! The background sync loop runs on a plain `tokio::spawn` task and must be
//! `Send`; `MvpAgent::cfg` is a `!Send` `RefCell` on the agent's `LocalSet`
//! thread and can't be read from there. Re-parsing the small `[tapd]` table
//! directly (bypassing the full layered `Config` bootstrap) sidesteps that
//! entirely, and has the side benefit that editing `config.toml` (the
//! existing `PATCH /config-file` path) takes effect on the sync manager's
//! very next tick with no explicit reload plumbing.

use std::path::PathBuf;
use std::time::Duration;

use super::client::{TapdAuth, TapdClientConfig, TapdEntityType};
use super::sync::{TapdConfigSource, TapdProjectBinding};

/// Mirrors `crate::agent::config::TapdConfig` / `TapdProjectConfig`'s TOML
/// shape but is deserialized standalone, without the full `Config` type
/// (which is `!Send` in the places that hold it live).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct TapdTomlConfig {
    enabled: Option<bool>,
    auth_method: Option<String>,
    access_token: Option<String>,
    api_user: Option<String>,
    api_password: Option<String>,
    api_base_url: Option<String>,
    default_workspace_id: Option<String>,
    /// Default TAPD-side status filter applied to derived bindings (those
    /// that don't have an explicit `[tapd.projects.*]` entry). The user's
    /// expectation is "show me what's currently being worked on" — TAPD's
    /// `planning` is the most common such state across workspaces, but each
    /// workspace defines its own status taxonomy, so this is the default
    /// rather than a hard-coded contract.
    default_status_filter: Option<String>,
    /// Default sort direction for derived bindings (true = `created desc`).
    default_order_desc: Option<bool>,
    poll_interval_secs: Option<u64>,
    projects: std::collections::HashMap<String, TapdTomlProject>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct TapdTomlProject {
    directory: String,
    workspace_id: String,
    entity_types: Vec<String>,
    module_filter: Vec<String>,
    /// TAPD-side status filter (e.g. `planning`, `open`, `in_progress`).
    /// Each workspace has its own status taxonomy, so this is an opaque
    /// string rather than an enum. Default `planning` (configured via
    /// `default_status_filter` below for derived bindings).
    status: Option<String>,
    /// When true (the default), sort the sync pulls by `created desc` so the
    /// workbench sees the most recently created items first.
    #[serde(default)]
    order_desc: bool,
    poll_interval_override_secs: Option<u64>,
    enabled: Option<bool>,
}

/// The directory's own name, lowercased — the default module filter for a
/// derived binding. Trailing separators and Windows drive-letter roots are
/// handled so `C:/repo/grok-build/` yields `grok-build` and `C:/` yields
/// nothing (a drive root has no meaningful project name).
pub fn default_module_for_directory(directory: &str) -> Option<String> {
    let name = directory
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .next_back()?;
    // `C:` / `D:` — a bare drive root, not a project
    if name.ends_with(':') {
        return None;
    }
    let lowered = name.to_lowercase();
    if lowered.is_empty() { None } else { Some(lowered) }
}

pub struct DiskTapdConfigSource {
    config_path: PathBuf,
}

impl DiskTapdConfigSource {
    pub fn new(grok_home: PathBuf) -> Self {
        Self {
            config_path: grok_home.join("config.toml"),
        }
    }

    /// The `[tapd].default_workspace_id` fallback, if set and non-empty.
    pub fn default_workspace_id(&self) -> Option<String> {
        self.read()
            .default_workspace_id
            .filter(|s| !s.trim().is_empty())
    }

    /// The effective binding for `directory`: its explicit
    /// `[tapd.projects.*]` entry if one exists, otherwise a binding derived
    /// from `default_workspace_id` with the directory name as module filter.
    /// Returns `None` when neither is available (no explicit entry and no
    /// default workspace configured).
    ///
    /// This is what makes the workbench work without per-project setup, and
    /// it is the same resolution the sync loop uses — see [`Self::bindings`].
    pub fn binding_for(&self, directory: &str) -> Option<TapdProjectBinding> {
        let cfg = self.read();
        if let Some(explicit) = explicit_binding(&cfg, directory) {
            return Some(explicit);
        }
        derived_binding(&cfg, directory)
    }

    /// Whether `directory` has an explicit `[tapd.projects.*]` entry (as
    /// opposed to a binding derived from `default_workspace_id`). The UI uses
    /// this to tell "configured here" from "inherited default".
    pub fn has_explicit_binding(&self, directory: &str) -> bool {
        let cfg = self.read();
        cfg.projects
            .values()
            .any(|p| p.directory == directory && !p.workspace_id.is_empty())
    }

    fn read(&self) -> TapdTomlConfig {
        let Ok(content) = std::fs::read_to_string(&self.config_path) else {
            return TapdTomlConfig::default();
        };
        let Ok(root) = content.parse::<toml::Table>() else {
            return TapdTomlConfig::default();
        };
        let Some(tapd_value) = root.get("tapd") else {
            return TapdTomlConfig::default();
        };
        toml::Value::Table(tapd_value.as_table().cloned().unwrap_or_default())
            .try_into()
            .unwrap_or_default()
    }
}

/// `entity_types` strings → enum, defaulting to `[task, story, bug]` when
/// empty or when nothing parses (an unrecognised name must not silently
/// sync nothing). The three-way default reflects the user's expectation:
/// stories are "需求", tasks are "任务", bugs are "缺陷" — the workbench
/// is a unified inbox across all TAPD-side item types.
fn parse_entity_types(raw: &[String]) -> Vec<TapdEntityType> {
    let parsed: Vec<_> = raw.iter().filter_map(|s| TapdEntityType::parse(s)).collect();
    if parsed.is_empty() {
        vec![TapdEntityType::Task, TapdEntityType::Story, TapdEntityType::Bug]
    } else {
        parsed
    }
}

fn binding_from_project(p: &TapdTomlProject) -> TapdProjectBinding {
    TapdProjectBinding {
        directory: p.directory.clone(),
        workspace_id: p.workspace_id.clone(),
        entity_types: parse_entity_types(&p.entity_types),
        module_filter: p.module_filter.clone(),
        status: p.status.clone().filter(|s| !s.trim().is_empty()),
        order_desc: p.order_desc,
    }
}

fn explicit_binding(cfg: &TapdTomlConfig, directory: &str) -> Option<TapdProjectBinding> {
    cfg.projects
        .values()
        .find(|p| {
            p.enabled.unwrap_or(true) && p.directory == directory && !p.workspace_id.is_empty()
        })
        .map(binding_from_project)
}

fn derived_binding(cfg: &TapdTomlConfig, directory: &str) -> Option<TapdProjectBinding> {
    let workspace_id = cfg
        .default_workspace_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())?;
    Some(TapdProjectBinding {
        directory: directory.to_string(),
        workspace_id: workspace_id.to_string(),
        // Default to stories only: the user's workbench interest is in
        // requirements/stories (需求), not the executable task or bug queue
        // (which they manage in TAPD's own UI). Per-project bindings can
        // still override `entity_types` to opt in to other types.
        entity_types: vec![TapdEntityType::Story],
        // Don't pre-seed module_filter with the directory name: many workspaces
        // (observed: 69280376) don't use the `module` field as a project axis
        // at all — most items have `module == ""`. A wrong filter silently
        // syncs zero items, so the safe default is "no module filter" — the
        // user opts in by editing the binding.
        module_filter: Vec::new(),
        status: cfg.default_status_filter.clone().filter(|s| !s.trim().is_empty()),
        order_desc: cfg.default_order_desc.unwrap_or(true),
    })
}

impl TapdConfigSource for DiskTapdConfigSource {
    fn binding_for(&self, directory: &str) -> Option<TapdProjectBinding> {
        DiskTapdConfigSource::binding_for(self, directory)
    }

    fn client_config(&self) -> Option<TapdClientConfig> {
        let cfg = self.read();
        let auth = match cfg.auth_method.as_deref() {
            Some("basic") => {
                let user = cfg.api_user?;
                let password = cfg.api_password?;
                if user.is_empty() || password.is_empty() {
                    return None;
                }
                TapdAuth::Basic { user, password }
            }
            _ => {
                let token = cfg.access_token?;
                if token.is_empty() {
                    return None;
                }
                TapdAuth::Token(token)
            }
        };
        Some(TapdClientConfig {
            auth,
            api_base_url: cfg.api_base_url.unwrap_or_default(),
        })
    }

    /// Only explicitly-configured projects. Derived bindings are resolved
    /// per-directory on demand ([`Self::binding_for`]) rather than enumerated
    /// here — there is no way to know which directories exist from config
    /// alone, and the background timer must not invent work for directories
    /// the user never opened.
    fn bindings(&self) -> Vec<TapdProjectBinding> {
        let cfg = self.read();
        cfg.projects
            .values()
            .filter(|p| p.enabled.unwrap_or(true) && !p.directory.is_empty() && !p.workspace_id.is_empty())
            .map(binding_from_project)
            .collect()
    }

    fn poll_interval(&self) -> Duration {
        let cfg = self.read();
        Duration::from_secs(cfg.poll_interval_secs.unwrap_or(600).max(30))
    }

    fn enabled(&self) -> bool {
        self.read().enabled.unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &std::path::Path, toml: &str) -> PathBuf {
        let path = dir.join("config.toml");
        std::fs::write(&path, toml).unwrap();
        path
    }

    #[test]
    fn missing_file_yields_defaults_not_errors() {
        let dir = tempfile::tempdir().unwrap();
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        assert!(source.client_config().is_none());
        assert!(source.bindings().is_empty());
        assert!(source.enabled());
        assert_eq!(source.poll_interval(), Duration::from_secs(600));
    }

    #[test]
    fn parses_token_auth_and_bindings() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd]
            access_token = "secret-token"
            poll_interval_secs = 120

            [tapd.projects.demo]
            directory = "/repo/a"
            workspace_id = "12345"
            entity_types = ["task", "bug"]
            module_filter = ["模块A"]
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        let client_cfg = source.client_config().unwrap();
        assert!(matches!(client_cfg.auth, TapdAuth::Token(t) if t == "secret-token"));
        assert_eq!(source.poll_interval(), Duration::from_secs(120));

        let bindings = source.bindings();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].directory, "/repo/a");
        assert_eq!(bindings[0].workspace_id, "12345");
        assert_eq!(bindings[0].entity_types, vec![TapdEntityType::Task, TapdEntityType::Bug]);
        assert_eq!(bindings[0].module_filter, vec!["模块A".to_string()]);
    }

    #[test]
    fn basic_auth_requires_both_user_and_password() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd]
            auth_method = "basic"
            api_user = "alice"
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        assert!(source.client_config().is_none(), "missing password must not yield a usable auth");
    }

    #[test]
    fn disabled_project_is_excluded_from_bindings() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd.projects.demo]
            directory = "/repo/a"
            workspace_id = "1"
            enabled = false
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        assert!(source.bindings().is_empty());
    }

    #[test]
    fn default_module_is_the_directory_name_lowercased() {
        assert_eq!(
            default_module_for_directory("C:/Program Files/AI/grok-build"),
            Some("grok-build".to_string())
        );
        // 反斜杠、末尾分隔符都要归一
        assert_eq!(
            default_module_for_directory("C:\\repo\\Grok-Build\\"),
            Some("grok-build".to_string())
        );
        // 盘根不是项目
        assert_eq!(default_module_for_directory("C:/"), None);
        assert_eq!(default_module_for_directory(""), None);
    }

    #[test]
    fn default_workspace_derives_a_binding_for_any_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd]
            access_token = "tok"
            default_workspace_id = "69280376"
            default_status_filter = "planning"
            default_order_desc = true
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());

        // 没有任何 [tapd.projects.*]，但默认 workspace 让任意目录都可用
        assert!(source.bindings().is_empty(), "derived bindings must not be enumerated");
        let binding = source.binding_for("D:/work/My-Repo").expect("derived binding");
        assert_eq!(binding.workspace_id, "69280376");
        assert_eq!(binding.module_filter, Vec::<String>::new(), "derived binding has no module filter — must opt in explicitly");
        assert_eq!(
            binding.entity_types,
            vec![TapdEntityType::Story],
            "derived binding defaults to stories only — user's workbench is for 需求"
        );
        assert_eq!(binding.status.as_deref(), Some("planning"));
        assert!(binding.order_desc, "default_order_desc=true flows through");
        assert!(!source.has_explicit_binding("D:/work/My-Repo"));
    }

    #[test]
    fn explicit_binding_wins_over_default_workspace() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd]
            default_workspace_id = "111"
            default_status_filter = "planning"

            [tapd.projects.demo]
            directory = "/repo/a"
            workspace_id = "222"
            module_filter = ["自定义模块"]
            status = "open"
            order_desc = false
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());

        let binding = source.binding_for("/repo/a").unwrap();
        assert_eq!(binding.workspace_id, "222");
        assert_eq!(binding.module_filter, vec!["自定义模块".to_string()]);
        assert_eq!(binding.status.as_deref(), Some("open"));
        assert!(!binding.order_desc, "explicit order_desc=false flows through");
        assert!(source.has_explicit_binding("/repo/a"));

        // 其他目录仍然落到默认 workspace（默认 status 也继承）
        let other = source.binding_for("/repo/b").unwrap();
        assert_eq!(other.workspace_id, "111");
        assert_eq!(other.module_filter, Vec::<String>::new());
        assert_eq!(other.status.as_deref(), Some("planning"));
    }

    #[test]
    fn no_default_workspace_means_unbound_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), "[tapd]\naccess_token = \"tok\"\n");
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        assert!(source.binding_for("/repo/a").is_none());
        assert!(source.default_workspace_id().is_none());
    }

    #[test]
    fn blank_default_workspace_is_treated_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), "[tapd]\ndefault_workspace_id = \"   \"\n");
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        assert!(source.default_workspace_id().is_none());
        assert!(source.binding_for("/repo/a").is_none());
    }

    #[test]
    fn empty_entity_types_falls_back_to_all_three_for_explicit_binding() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            r#"
            [tapd.projects.demo]
            directory = "/repo/a"
            workspace_id = "1"
            "#,
        );
        let source = DiskTapdConfigSource::new(dir.path().to_path_buf());
        let bindings = source.bindings();
        // Explicit binding (workspace_id set, no global [tapd] defaults) —
        // the parse_entity_types fallback kicks in, defaulting to the
        // full story/task/bug trio. (Derived bindings, which only fire when
        // there's no explicit entry, default to Story alone.)
        let binding = source.binding_for("/repo/a").unwrap();
        assert_eq!(
            binding.entity_types,
            vec![TapdEntityType::Task, TapdEntityType::Story, TapdEntityType::Bug]
        );
        let _ = bindings; // both names used to silence unused warnings
    }
}
