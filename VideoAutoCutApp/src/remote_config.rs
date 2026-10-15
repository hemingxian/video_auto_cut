use std::env;

pub(crate) fn is_required() -> bool {
    env::var("VIDEOAUTO_REQUIRE_REMOTE_CONFIG")
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

pub(crate) fn has_key(key: &str) -> bool {
    env::var("VIDEOAUTO_REMOTE_CONFIG_KEYS")
        .unwrap_or_default()
        .split(',')
        .any(|item| item.trim() == key)
}
