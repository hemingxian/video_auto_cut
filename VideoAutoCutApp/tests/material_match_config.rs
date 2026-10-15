use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn verify_threshold(case: &str, settings: &[(&str, &str)], expected: f32) {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".codex-tmp/material-match-config-tests");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = scratch.join(format!("{}-{nonce}-{case}", std::process::id()));
    fs::create_dir_all(root.join("sentrysearch")).unwrap();

    // Plan-only must not invoke these runtime tools. Non-executable placeholders
    // satisfy discovery and make any accidental processing attempt fail offline.
    fs::write(root.join("yt-dlp.exe"), []).unwrap();
    fs::write(root.join("sentrysearch/sentrysearch.exe"), []).unwrap();
    let config = root.join("app.env");
    let config_text = settings
        .iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect::<String>();
    fs::write(&config, config_text).unwrap();
    let shots = root.join("input-shots.json");
    fs::write(
        &shots,
        serde_json::to_vec_pretty(&json!({
            "schema_version": 2,
            "task_revision": 0,
            "topic": "Offline threshold regression",
            "shots": [{
                "shot_id": "shot_threshold_regression",
                "shot": 1,
                "title": "Threshold regression",
                "visual_mode": "stock_video",
                "download_query": "factory",
                "visual_query": "factory robot",
                "duration": 3,
                "download_material": true
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_VideoAutoCutEngine"));
    command.env_clear();
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = command
        .current_dir(&root)
        .env("VIDEOAUTO_ENV_PATH", &config)
        .env("VIDEOAUTO_DATA_ROOT", root.join("workspace"))
        .env("VIDEOAUTO_REQUIRE_REMOTE_CONFIG", "false")
        .env("VIDEOAUTO_NO_PAUSE", "true")
        .env("BGM_ENABLED", "false")
        .args(["--shots-json"])
        .arg(&shots)
        .args([
            "--plan-only",
            "--source",
            "pexels",
            "--no-voiceover",
            "--no-subtitles",
            "--no-progress-bar",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    fs::write(root.join("stdout.log"), output.stdout.as_slice()).unwrap();
    fs::write(root.join("stderr.log"), output.stderr.as_slice()).unwrap();
    assert!(output.status.success(), "{case}: {stdout}\n{stderr}");
    assert!(
        stdout.contains(&format!("匹配接受阈值: {expected:.2}")),
        "{case}: {stdout}"
    );

    let run_path = stdout
        .lines()
        .find_map(|line| line.strip_prefix("全部完成. run: "))
        .map(PathBuf::from)
        .expect("plan-only should finish a real run");
    let checkpoint: Value =
        serde_json::from_slice(&fs::read(run_path.join("checkpoint.json")).unwrap()).unwrap();
    let signature = checkpoint["signature"].as_str().unwrap();
    assert!(
        signature.contains(&format!("match_accept_threshold: {expected}")),
        "{case}: unexpected persisted threshold"
    );
    assert_eq!(
        checkpoint["steps"].as_array().unwrap().len(),
        2,
        "plan-only must only parse and plan"
    );
}

#[test]
fn desktop_material_match_setting_reaches_engine_config() {
    verify_threshold("low", &[("MATERIAL_MATCH_MIN_SCORE", "0.1")], 0.1);
    verify_threshold("high", &[("MATERIAL_MATCH_MIN_SCORE", "0.6")], 0.6);
}

#[test]
fn desktop_material_match_setting_takes_precedence_over_legacy_keys() {
    verify_threshold(
        "priority",
        &[
            ("MATERIAL_MATCH_MIN_SCORE", "0.1"),
            ("SENTRY_MATCH_THRESHOLD", "0.6"),
            ("MATCH_ACCEPT_THRESHOLD", "0.8"),
        ],
        0.1,
    );
}

#[test]
fn legacy_material_match_settings_remain_supported() {
    verify_threshold(
        "legacy-sentry",
        &[
            ("SENTRY_MATCH_THRESHOLD", "0.6"),
            ("MATCH_ACCEPT_THRESHOLD", "0.8"),
        ],
        0.6,
    );
    verify_threshold("legacy-accept", &[("MATCH_ACCEPT_THRESHOLD", "0.6")], 0.6);
    verify_threshold(
        "blank-desktop-legacy",
        &[
            ("MATERIAL_MATCH_MIN_SCORE", ""),
            ("SENTRY_MATCH_THRESHOLD", "0.6"),
        ],
        0.6,
    );
}

#[test]
fn missing_or_empty_material_match_settings_keep_default() {
    verify_threshold("default", &[], 0.25);
    verify_threshold(
        "blank",
        &[
            ("MATERIAL_MATCH_MIN_SCORE", ""),
            ("SENTRY_MATCH_THRESHOLD", ""),
            ("MATCH_ACCEPT_THRESHOLD", ""),
        ],
        0.25,
    );
}

#[test]
fn zero_is_valid_and_invalid_desktop_value_falls_back() {
    verify_threshold(
        "zero",
        &[
            ("MATERIAL_MATCH_MIN_SCORE", "0"),
            ("SENTRY_MATCH_THRESHOLD", "0.6"),
        ],
        0.0,
    );
    verify_threshold(
        "invalid-desktop-legacy",
        &[
            ("MATERIAL_MATCH_MIN_SCORE", "invalid"),
            ("SENTRY_MATCH_THRESHOLD", "0.6"),
        ],
        0.6,
    );
}
