//! Stage artifact envelope: frontmatter parse/write + filename convention.
//!
//! Spec §8 — every stage writes a Markdown file under `.workbench/stages/`
//! with this envelope:
//!
//! ```
//! ---
//! stage: <brainstorm|develop|review|verify|mr>
//! task_id: <TAPD-id>
//! attempt: <int>
//! {stage-specific fields}
//! ---
//!
//! <stage-specific body>
//! ```
//!
//! The current attempt lives at `<n>-<stage>.md`; older attempts are kept
//! at `<n>-<stage>-attempt-<k>.md` until task completion (then `.workbench/`
//! is GC''d per spec §9 / §13).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::workbench::state_machine::Stage;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactFrontmatter {
    pub stage: Stage,
    pub task_id: String,
    pub attempt: u8,
    /// Stage-specific extra fields (e.g. `verdict`, `mr_url`, `exit_code`).
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Clone, Debug)]
pub struct ArtifactEnvelope {
    pub frontmatter: ArtifactFrontmatter,
    pub body: String,
}

impl ArtifactEnvelope {
    /// Parse a complete artifact file. Returns Err if the frontmatter
    /// delimiter (`---\n...\n---\n`) is missing or unparseable.
    pub fn parse(md: &str) -> anyhow::Result<Self> {
        let after_first = md
            .strip_prefix("---\n")
            .ok_or_else(|| anyhow::anyhow!("artifact missing opening frontmatter delimiter"))?;
        let (front_str, body_with_delim) = after_first
            .split_once("\n---\n")
            .ok_or_else(|| anyhow::anyhow!("artifact missing closing frontmatter delimiter"))?;
        let frontmatter: ArtifactFrontmatter = serde_yaml::from_str(front_str)?;
        Ok(Self {
            frontmatter,
            body: body_with_delim.to_string(),
        })
    }
}

impl std::fmt::Display for ArtifactEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let yaml = serde_yaml::to_string(&self.frontmatter).map_err(|_| std::fmt::Error)?;
        write!(f, "---\n{}---\n{}", yaml, self.body)
    }
}

/// Canonical path for a stage artifact. Attempt 0 lives at the unsuffixed
/// filename; later attempts use `-attempt-<k>` suffix.
pub fn artifact_path(stage_num: u8, name: &str, attempt: u8) -> String {
    if attempt == 0 {
        format!(".workbench/stages/{stage_num}-{name}.md")
    } else {
        format!(".workbench/stages/{stage_num}-{name}-attempt-{attempt}.md")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_envelope() {
        let md = "---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\n---\n\n# Body\nhello\n";
        let env = ArtifactEnvelope::parse(md).unwrap();
        assert_eq!(env.frontmatter.stage, Stage::Brainstorm);
        assert_eq!(env.frontmatter.task_id, "TAPD-1");
        assert_eq!(env.frontmatter.attempt, 0);
        assert!(env.body.contains("# Body"));
    }

    #[test]
    fn parse_envelope_with_extra_fields() {
        let md = "---\nstage: review\ntask_id: TAPD-1\nattempt: 0\nverdict: approved\ncritical_count: 0\nmajor_count: 1\n---\n\nbody\n";
        let env = ArtifactEnvelope::parse(md).unwrap();
        assert_eq!(env.frontmatter.stage, Stage::CodeReview);
        assert_eq!(env.frontmatter.extra.get("verdict").and_then(|v| v.as_str()), Some("approved"));
        assert_eq!(env.frontmatter.extra.get("critical_count").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(env.frontmatter.extra.get("major_count").and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn parse_rejects_missing_frontmatter() {
        assert!(ArtifactEnvelope::parse("hello\nworld\n").is_err());
    }

    #[test]
    fn parse_rejects_missing_closing_delim() {
        assert!(ArtifactEnvelope::parse("---\nstage: brainstorm\ntask_id: TAPD-1\nattempt: 0\nbody without close\n").is_err());
    }

    #[test]
    fn round_trip_preserves_frontmatter_and_body() {
        let env = ArtifactEnvelope {
            frontmatter: ArtifactFrontmatter {
                stage: Stage::Develop,
                task_id: "TAPD-9".into(),
                attempt: 2,
                extra: BTreeMap::new(),
            },
            body: "## Notes\nline\n".into(),
        };
        let s = env.to_string();
        let parsed = ArtifactEnvelope::parse(&s).unwrap();
        assert_eq!(parsed.frontmatter.task_id, "TAPD-9");
        assert_eq!(parsed.frontmatter.attempt, 2);
        assert!(parsed.body.contains("## Notes"));
    }

    #[test]
    fn round_trip_preserves_extra_fields() {
        let mut extra = BTreeMap::new();
        extra.insert("verdict".into(), serde_yaml::Value::String("ok".into()));
        extra.insert("critical_count".into(), serde_yaml::Value::Number(0.into()));
        let env = ArtifactEnvelope {
            frontmatter: ArtifactFrontmatter {
                stage: Stage::CodeReview,
                task_id: "TAPD-3".into(),
                attempt: 0,
                extra,
            },
            body: "findings".into(),
        };
        let s = env.to_string();
        let parsed = ArtifactEnvelope::parse(&s).unwrap();
        assert_eq!(
            parsed.frontmatter.extra.get("verdict").and_then(|v| v.as_str()),
            Some("ok")
        );
    }

    #[test]
    fn filename_for_attempt_zero() {
        assert_eq!(artifact_path(1, "design", 0), ".workbench/stages/1-design.md");
        assert_eq!(artifact_path(5, "verify", 0), ".workbench/stages/5-verify.md");
    }

    #[test]
    fn filename_for_retry() {
        assert_eq!(artifact_path(3, "develop", 2), ".workbench/stages/3-develop-attempt-2.md");
        assert_eq!(artifact_path(4, "review", 1), ".workbench/stages/4-review-attempt-1.md");
    }
}
