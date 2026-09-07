//! Model fallback policy. Per spec §6.2.1 / D6.
//!
//! Rules:
//! - `role.fallback` must be configured (None => no fallback, behave as v1)
//! - The primary must have failed at least 2 attempts in a row (attempt >= 1)
//! - The current attempt must not have already used fallback (`fallback_used = false`)
//! - After fallback fires once and also fails, route to BlockedForHuman (D6)

#[derive(Clone, Debug)]
pub struct RoleFallback {
    pub primary: String,
    pub fallback: Option<String>,
}

/// Decide whether to switch to a fallback model on the next attempt.
/// Returns `Some(fallback_model_name)` to use the fallback, or `None` to
/// continue with the primary (or escalate to BlockedForHuman if attempts
/// are exhausted).
///
/// `attempt` is the number of completed attempts on the current stage
/// (0 = none yet, 1 = one failed, 2 = two failed, ...).
/// `fallback_used` is true if a fallback was already used for the *current*
/// stage's attempt chain.
pub fn decide_fallback(role: &RoleFallback, attempt: u8, fallback_used: bool) -> Option<String> {
    let fallback = role.fallback.as_deref()?;
    if attempt < 1 {
        return None;
    }
    if fallback_used {
        return None;
    }
    if attempt > 1 {
        // Two fallback attempts have already happened (attempt 1 + attempt 2).
        // Caller should route to BlockedForHuman.
        return None;
    }
    Some(fallback.to_string())
}

/// One-step helper: record the fallback usage in the running state.
pub fn apply_fallback(state_field: &mut Option<String>, model: &str) {
    *state_field = Some(model.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(name: &str) -> RoleFallback { RoleFallback { primary: name.into(), fallback: Some(format!("{name}-fallback")) } }
    fn role_no_fb(name: &str) -> RoleFallback { RoleFallback { primary: name.into(), fallback: None } }

    #[test]
    fn no_fallback_when_role_has_no_fallback_configured() {
        let decision = decide_fallback(&role_no_fb("coder"), 0, false);
        assert!(decision.is_none(), "no fallback configured => no fallback decision");
    }

    #[test]
    fn no_fallback_on_first_attempt() {
        let decision = decide_fallback(&role("coder"), 0, false);
        assert!(decision.is_none(), "first attempt must not fallback");
    }

    #[test]
    fn no_fallback_when_already_fell_back() {
        let decision = decide_fallback(&role("coder"), 1, true);
        assert!(decision.is_none(), "must not use fallback twice on the same stage");
    }

    #[test]
    fn fallback_used_after_two_consecutive_failures() {
        let decision = decide_fallback(&role("coder"), 1, false);
        assert_eq!(decision.as_deref(), Some("coder-fallback"));
    }

    #[test]
    fn fallback_blocked_after_three_failures() {
        let decision = decide_fallback(&role("coder"), 2, false);
        assert!(decision.is_none(), "second fallback not allowed; route to BlockedForHuman instead");
    }
}

