use anyhow::{Context, Result, anyhow};
use chrono::Local;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::cli::Source;
use crate::logging::log_line;
use crate::models::{AppPaths, RunConfig};
use crate::paths::add_child_env;
use crate::process::{run_command, run_command_capture_timeout};

#[derive(Debug, Clone)]
pub(crate) struct DownloadCandidate {
    pub(crate) index: usize,
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) provider: String,
    pub(crate) media_type: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) uploader: String,
    pub(crate) creator: String,
    pub(crate) creator_url: String,
    pub(crate) webpage_url: String,
    pub(crate) download_url: String,
    pub(crate) thumbnail: String,
    pub(crate) duration: Option<f64>,
    pub(crate) filetype: String,
    pub(crate) view_count: Option<u64>,
    pub(crate) upload_date: String,
    pub(crate) tags: Vec<String>,
    pub(crate) license: String,
    pub(crate) license_key: String,
    pub(crate) license_url: String,
    pub(crate) commercial_use: Option<bool>,
    pub(crate) attribution_required: Option<bool>,
    pub(crate) attribution: String,
}

#[derive(Clone, Copy)]
pub(crate) struct ProviderRequestLimits {
    pub(crate) command_timeout: Duration,
    pub(crate) http_timeout: Duration,
    pub(crate) http_attempts: usize,
}

impl DownloadCandidate {
    pub(crate) fn has_download_target(&self) -> bool {
        !self.download_target().trim().is_empty()
    }

    pub(crate) fn download_target(&self) -> &str {
        if self.download_url.trim().is_empty() {
            self.webpage_url.as_str()
        } else {
            self.download_url.as_str()
        }
    }

    pub(crate) fn public_url(&self) -> &str {
        if self.webpage_url.trim().is_empty() {
            self.download_target()
        } else {
            self.webpage_url.as_str()
        }
    }
}

pub(crate) fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

pub(crate) fn value_f64(value: Option<&Value>) -> Option<f64> {
    let parsed = match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    parsed.is_finite().then_some(parsed)
}

pub(crate) fn value_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

pub(crate) fn compact_prompt_text(text: &str, max_chars: usize) -> String {
    let compacted = text.split_whitespace().collect::<Vec<_>>().join(" ");
    compacted.chars().take(max_chars).collect()
}

fn string_array_field(value: &Value, key: &str, max_items: usize) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(max_items)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn thumbnail_from_json(value: &Value) -> String {
    let direct = value_string(value, "thumbnail");
    if !direct.is_empty() {
        return direct;
    }

    value
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().rev().find_map(|item| item.get("url")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn candidate_from_json(value: &Value, index: usize) -> Option<DownloadCandidate> {
    let title = value_string(value, "title");
    let webpage_url = value_string(value, "webpage_url")
        .or_else_if_empty(|| value_string(value, "original_url"))
        .or_else_if_empty(|| value_string(value, "url"));
    let download_url =
        value_string(value, "download_url").or_else_if_empty(|| value_string(value, "direct_url"));

    if title.is_empty() && webpage_url.is_empty() && download_url.is_empty() {
        return None;
    }

    let id = value_string(value, "id")
        .or_else_if_empty(|| webpage_url.clone())
        .or_else_if_empty(|| download_url.clone())
        .or_else_if_empty(|| format!("candidate-{index}"));

    Some(DownloadCandidate {
        index,
        id,
        source: value_string(value, "source"),
        provider: value_string(value, "provider"),
        media_type: value_string(value, "media_type"),
        title,
        description: compact_prompt_text(&value_string(value, "description"), 700),
        uploader: value_string(value, "uploader")
            .or_else_if_empty(|| value_string(value, "channel")),
        creator: value_string(value, "creator"),
        creator_url: value_string(value, "creator_url"),
        webpage_url,
        download_url,
        thumbnail: thumbnail_from_json(value),
        duration: value_f64(value.get("duration")),
        filetype: value_string(value, "filetype"),
        view_count: value_u64(value.get("view_count")),
        upload_date: value_string(value, "upload_date"),
        tags: string_array_field(value, "tags", 12),
        license: value_string(value, "license"),
        license_key: value_string(value, "license_key"),
        license_url: value_string(value, "license_url"),
        commercial_use: value.get("commercial_use").and_then(Value::as_bool),
        attribution_required: value.get("attribution_required").and_then(Value::as_bool),
        attribution: value_string(value, "attribution"),
    })
}

trait EmptyStringFallback {
    fn or_else_if_empty<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl EmptyStringFallback for String {
    fn or_else_if_empty<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

pub(crate) fn parse_download_candidates(output: &str) -> Vec<DownloadCandidate> {
    let mut candidates = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(entries) = value.get("entries").and_then(Value::as_array) {
            for entry in entries {
                if let Some(candidate) = candidate_from_json(entry, candidates.len() + 1) {
                    candidates.push(candidate);
                }
            }
            continue;
        }

        if let Some(candidate) = candidate_from_json(&value, candidates.len() + 1) {
            candidates.push(candidate);
        }
    }

    candidates
}

fn material_provider_entry(paths: &AppPaths) -> Option<(PathBuf, PathBuf)> {
    let entry = paths.root.join("tools").join("material_provider.py");
    if !entry.exists() {
        return None;
    }

    let python_candidates = [
        paths
            .root
            .join("python-3.11.9-embed-amd64")
            .join("python.exe"),
        paths.root.join("python-3.11.9").join("python.exe"),
        paths.root.join("python").join("python.exe"),
    ];

    for python in python_candidates {
        if python.exists() {
            return Some((python, entry));
        }
    }

    paths
        .sentry_py
        .as_ref()
        .map(|(python, _)| (python.clone(), entry))
}

fn parse_provider_candidates(output: &str) -> Result<Vec<DownloadCandidate>> {
    let value: Value =
        serde_json::from_str(output).context("素材 Provider 返回的 JSON 无法解析")?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| anyhow!("素材 Provider 返回 JSON 缺少 items 数组"))?;

    Ok(items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| candidate_from_json(item, index + 1))
        .collect())
}

fn cleanup_provider_output(path: &std::path::Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let warning = format!(
                "清理素材 Provider 临时文件失败: {}: {error}",
                path.display()
            );
            eprintln!("[警告] {warning}");
            log_line(warning);
        }
    }
}

fn with_provider_output_cleanup<T>(
    output_path: &std::path::Path,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let result = operation();
    cleanup_provider_output(output_path);
    result
}

pub(crate) fn collect_provider_candidates(
    paths: &AppPaths,
    source: &Source,
    query: &str,
    limit: usize,
    config: &RunConfig,
) -> Result<Option<Vec<DownloadCandidate>>> {
    collect_provider_candidates_by_key(
        paths,
        source.provider_key(),
        query,
        limit,
        config.min_source_duration,
        config.max_source_duration,
    )
}

pub(crate) fn collect_provider_candidates_by_key(
    paths: &AppPaths,
    source_key: &str,
    query: &str,
    limit: usize,
    min_duration: Option<u32>,
    max_duration: Option<u32>,
) -> Result<Option<Vec<DownloadCandidate>>> {
    collect_provider_candidates_by_key_inner(
        paths,
        source_key,
        query,
        limit,
        min_duration,
        max_duration,
        None,
    )
}

pub(crate) fn collect_provider_candidates_by_key_with_timeout(
    paths: &AppPaths,
    source_key: &str,
    query: &str,
    limit: usize,
    min_duration: Option<u32>,
    max_duration: Option<u32>,
    limits: ProviderRequestLimits,
) -> Result<Option<Vec<DownloadCandidate>>> {
    collect_provider_candidates_by_key_inner(
        paths,
        source_key,
        query,
        limit,
        min_duration,
        max_duration,
        Some(limits),
    )
}

fn collect_provider_candidates_by_key_inner(
    paths: &AppPaths,
    source_key: &str,
    query: &str,
    limit: usize,
    min_duration: Option<u32>,
    max_duration: Option<u32>,
    limits: Option<ProviderRequestLimits>,
) -> Result<Option<Vec<DownloadCandidate>>> {
    let Some((python, entry)) = material_provider_entry(paths) else {
        return Ok(None);
    };

    let temp_dir = paths.data_root.join("temp").join("material-provider");
    fs::create_dir_all(&temp_dir)?;
    let output_path = temp_dir.join(format!(
        "candidates_{}_{}.json",
        Local::now().format("%Y%m%d_%H%M%S_%3f"),
        std::process::id()
    ));

    let mut cmd = Command::new(python);
    add_child_env(&mut cmd, paths);
    cmd.arg(entry)
        .arg("search")
        .arg("--source")
        .arg(source_key)
        .arg("--query")
        .arg(query)
        .arg("--limit")
        .arg(limit.to_string())
        .arg("--output")
        .arg(&output_path);

    if let Some(value) = min_duration {
        cmd.arg("--min-duration").arg(value.to_string());
    }
    if let Some(value) = max_duration {
        cmd.arg("--max-duration").arg(value.to_string());
    }

    with_provider_output_cleanup(&output_path, || {
        if let Some(limits) = limits {
            cmd.env(
                "MATERIAL_PROVIDER_HTTP_TIMEOUT",
                limits.http_timeout.as_secs().max(1).to_string(),
            )
            .env(
                "MATERIAL_PROVIDER_HTTP_ATTEMPTS",
                limits.http_attempts.max(1).to_string(),
            );
            run_command_capture_timeout(
                &mut cmd,
                "material provider search",
                limits.command_timeout,
            )?;
        } else {
            run_command(&mut cmd, "material provider search")?;
        }

        let output = fs::read_to_string(&output_path)
            .with_context(|| format!("读取素材 Provider 输出失败: {}", output_path.display()))?;
        parse_provider_candidates(&output).map(Some)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_output_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "video_auto_candidate_{label}_{}_{nonce}.json",
            std::process::id()
        ))
    }

    #[test]
    fn provider_output_is_removed_when_processing_fails() {
        let output_path = temporary_output_path("cleanup_failure");
        fs::write(&output_path, b"partial output").expect("write provider output");

        let result: Result<()> =
            with_provider_output_cleanup(&output_path, || Err(anyhow!("injected parse failure")));

        assert!(result.is_err());
        assert!(!output_path.exists());
    }

    #[test]
    fn missing_provider_output_is_silently_ignored_during_cleanup() {
        let output_path = temporary_output_path("cleanup_missing");

        with_provider_output_cleanup(&output_path, || Ok(()))
            .expect("missing cleanup target should not fail operation");

        assert!(!output_path.exists());
    }

    #[test]
    fn parses_json_lines_and_uses_direct_url_as_download_target() {
        let output = r#"
noise from downloader
{"title":" Sample ","direct_url":"https://cdn.example/audio.mp3","duration":"12.5","tags":["music","", "calm"]}
{"unrelated":true}
"#;

        let candidates = parse_download_candidates(output);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].title, "Sample");
        assert_eq!(
            candidates[0].download_target(),
            "https://cdn.example/audio.mp3"
        );
        assert_eq!(candidates[0].duration, Some(12.5));
        assert_eq!(candidates[0].tags, ["music", "calm"]);
    }

    #[test]
    fn provider_payload_requires_an_items_array() {
        let error = parse_provider_candidates(r#"{"status":"ok"}"#)
            .expect_err("payload without candidates should fail");

        assert!(error.to_string().contains("缺少 items 数组"));
    }

    #[test]
    fn non_finite_numeric_strings_are_rejected() {
        let not_a_number = Value::String("NaN".to_string());
        let infinity = Value::String("inf".to_string());

        assert_eq!(value_f64(Some(&not_a_number)), None);
        assert_eq!(value_f64(Some(&infinity)), None);
    }
}
