use anyhow::{Context, Result, anyhow, bail};
use chrono::Local;
use reqwest::blocking::Client;
use reqwest::header::USER_AGENT;
use sanitize_filename::sanitize;
use serde_json::json;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::{Duration, Instant};

use crate::candidate::{
    DownloadCandidate, ProviderRequestLimits, collect_provider_candidates_by_key_with_timeout,
    compact_prompt_text,
};
use crate::logging::log_line;
use crate::models::{AppPaths, RunConfig, ShotPlan};
use crate::paths::find_exe;
use crate::persistence::{write_bytes_atomic, write_json_pretty_atomic};
use crate::process::{run_command_capture_timeout, run_command_output_status};

mod selection;

use selection::{
    BgmAttemptPhase, bgm_query_fallbacks, resolve_bgm_provider_sources, select_bgm_from_sources,
};

pub(crate) struct BgmContext<'a> {
    pub(crate) paths: &'a AppPaths,
    pub(crate) plan: &'a ShotPlan,
    pub(crate) directory: &'a Path,
    pub(crate) final_file: &'a Path,
    pub(crate) config: &'a RunConfig,
}

pub(crate) struct BgmProgressEvent {
    pub(crate) phase: &'static str,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) label: String,
}

impl BgmProgressEvent {
    fn new(phase: &'static str, current: usize, label: impl Into<String>) -> Self {
        Self {
            phase,
            current,
            total: 3,
            label: label.into(),
        }
    }
}

const DEFAULT_BGM_SEARCH_TIMEOUT_SECONDS: u64 = 75;
const DEFAULT_BGM_HTTP_TIMEOUT_SECONDS: u64 = 20;
const DEFAULT_BGM_HTTP_ATTEMPTS: usize = 2;
const DEFAULT_BGM_ACQUIRE_TIMEOUT_SECONDS: u64 = 180;
const DEFAULT_BGM_DOWNLOAD_TIMEOUT_SECONDS: u64 = 120;
const DEFAULT_BGM_DOWNLOAD_ITEM_TIMEOUT_SECONDS: u64 = 45;
const BGM_AUDIO_PROBE_TIMEOUT_SECONDS: u64 = 10;
const BGM_AUDIO_HEADER_BYTES: u64 = 4096;

pub(crate) fn prepare_and_mix_bgm(
    context: BgmContext<'_>,
    mut report_progress: impl FnMut(BgmProgressEvent),
) -> Result<bool> {
    let BgmContext {
        paths,
        plan,
        directory,
        final_file,
        config,
    } = context;

    fs::create_dir_all(directory)?;

    let initial_query = bgm_search_query(plan, config);
    let queries = bgm_query_fallbacks(&initial_query);
    let sources = bgm_provider_sources(config);
    let ffprobe = find_exe(&paths.root, "ffprobe.exe").or_else(|| find_exe(&paths.root, "ffprobe"));
    let (command_timeout, http_timeout, http_attempts) = bgm_search_limits();
    let (download_timeout, item_timeout) = bgm_download_limits();
    let selection = select_bgm_from_sources(
        &sources,
        &queries,
        bgm_acquire_timeout(),
        |source, query, remaining| {
            collect_provider_candidates_by_key_with_timeout(
                paths,
                source,
                query,
                config.bgm_candidate_pool,
                config.bgm_min_duration,
                config.bgm_max_duration,
                ProviderRequestLimits {
                    command_timeout: command_timeout.min(remaining),
                    http_timeout,
                    http_attempts,
                },
            )
        },
        |candidates, remaining| {
            download_first_available_bgm(
                candidates,
                directory,
                ffprobe.as_deref(),
                download_timeout.min(remaining),
                item_timeout,
            )
        },
        |phase| match phase {
            BgmAttemptPhase::Searching {
                source,
                query,
                current,
            } => {
                println!("BGM 素材源: {source}");
                println!("BGM 搜索: {query}");
                report_progress(BgmProgressEvent::new(
                    "searching",
                    current,
                    format!("搜索背景音乐: {query}"),
                ));
            }
            BgmAttemptPhase::Downloading {
                source,
                query,
                current,
            } => {
                report_progress(BgmProgressEvent::new(
                    "downloading",
                    current,
                    format!("下载背景音乐: {source} / {query}"),
                ));
            }
        },
    )?;
    let Some(selection) = selection else {
        return Ok(false);
    };

    println!(
        "BGM 选中: {} / {} / {}",
        selection.candidate.title, selection.candidate.source, selection.candidate.license
    );
    write_bgm_license(
        directory,
        &selection.query,
        &selection.candidate,
        &selection.artifact,
    )?;
    report_progress(BgmProgressEvent::new("mixing", 2, "混入背景音乐"));
    mix_bgm_into_video(paths, final_file, &selection.artifact, config.bgm_volume)?;

    Ok(true)
}

fn bgm_search_query(plan: &ShotPlan, config: &RunConfig) -> String {
    if let Some(query) = config
        .bgm_query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
    {
        return query.to_string();
    }
    if let Some(query) = plan
        .background_music
        .as_ref()
        .and_then(|bgm| bgm.query.as_deref())
        .map(str::trim)
        .filter(|query| !query.is_empty())
    {
        return query.to_string();
    }

    let mut parts = Vec::new();
    if let Some(description) = plan
        .background_music
        .as_ref()
        .and_then(|bgm| bgm.description.as_deref())
        .map(str::trim)
        .filter(|description| !description.is_empty())
    {
        parts.push(description.to_string());
    }
    if !plan.topic.trim().is_empty() {
        parts.push(plan.topic.trim().to_string());
    }
    for shot in plan.shots.iter().take(4) {
        if !shot.title.trim().is_empty() {
            parts.push(shot.title.trim().to_string());
        }
    }

    let context = compact_prompt_text(&parts.join(" "), 120);
    if context.is_empty() {
        "corporate background music instrumental".to_string()
    } else {
        format!("{context} background music instrumental")
    }
}

fn env_has_value(name: &str) -> bool {
    env::var(name).is_ok_and(|value| !value.trim().is_empty())
}

fn env_u64_bounded(name: &str, default: u64, minimum: u64, maximum: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

fn env_usize_bounded(name: &str, default: usize, minimum: usize, maximum: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

fn bgm_search_limits() -> (Duration, Duration, usize) {
    (
        Duration::from_secs(env_u64_bounded(
            "BGM_SEARCH_TIMEOUT_SECONDS",
            DEFAULT_BGM_SEARCH_TIMEOUT_SECONDS,
            10,
            600,
        )),
        Duration::from_secs(env_u64_bounded(
            "BGM_HTTP_TIMEOUT_SECONDS",
            DEFAULT_BGM_HTTP_TIMEOUT_SECONDS,
            5,
            120,
        )),
        env_usize_bounded("BGM_HTTP_ATTEMPTS", DEFAULT_BGM_HTTP_ATTEMPTS, 1, 5),
    )
}

fn bgm_acquire_timeout() -> Duration {
    Duration::from_secs(env_u64_bounded(
        "BGM_ACQUIRE_TIMEOUT_SECONDS",
        DEFAULT_BGM_ACQUIRE_TIMEOUT_SECONDS,
        15,
        900,
    ))
}

fn bgm_download_limits() -> (Duration, Duration) {
    (
        Duration::from_secs(env_u64_bounded(
            "BGM_DOWNLOAD_TIMEOUT_SECONDS",
            DEFAULT_BGM_DOWNLOAD_TIMEOUT_SECONDS,
            10,
            600,
        )),
        Duration::from_secs(env_u64_bounded(
            "BGM_DOWNLOAD_ITEM_TIMEOUT_SECONDS",
            DEFAULT_BGM_DOWNLOAD_ITEM_TIMEOUT_SECONDS,
            5,
            180,
        )),
    )
}

fn bgm_provider_sources(config: &RunConfig) -> Vec<String> {
    resolve_bgm_provider_sources(
        &config.bgm_source,
        env_has_value("JAMENDO_CLIENT_ID"),
        env_has_value("OPENVERSE_CLIENT_ID") && env_has_value("OPENVERSE_CLIENT_SECRET"),
    )
}

fn audio_extension(candidate: &DownloadCandidate) -> String {
    let from_filetype = candidate
        .filetype
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if matches!(
        from_filetype.as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac"
    ) {
        return from_filetype;
    }

    let url_path = candidate
        .download_target()
        .split('?')
        .next()
        .unwrap_or("")
        .split('/')
        .next_back()
        .unwrap_or("");
    let extension = Path::new(url_path)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac"
    ) {
        return extension;
    }

    "mp3".to_string()
}

fn download_first_available_bgm(
    candidates: &[DownloadCandidate],
    directory: &Path,
    ffprobe: Option<&Path>,
    download_timeout: Duration,
    item_timeout: Duration,
) -> Result<(usize, PathBuf)> {
    let started = Instant::now();
    let mut errors = Vec::new();

    for (index, candidate) in candidates.iter().enumerate() {
        let Some(remaining) = download_timeout.checked_sub(started.elapsed()) else {
            break;
        };
        if remaining.is_zero() {
            break;
        }

        let timeout = item_timeout.min(remaining);
        println!(
            "BGM 下载候选 {}/{}: {}",
            index + 1,
            candidates.len(),
            candidate.title
        );
        match download_bgm_candidate(candidate, directory, ffprobe, timeout) {
            Ok(path) => return Ok((index, path)),
            Err(error) => {
                let warning = format!(
                    "BGM 候选下载失败，将尝试下一个: {}: {error:#}",
                    candidate.title
                );
                eprintln!("[警告] {warning}");
                log_line(&warning);
                errors.push(warning);
            }
        }
    }

    if started.elapsed() >= download_timeout {
        errors.push(format!(
            "BGM 下载总超时（{} 秒）",
            download_timeout.as_secs()
        ));
    }
    bail!("所有 BGM 候选均下载失败: {}", errors.join(" | "))
}

fn download_bgm_candidate(
    candidate: &DownloadCandidate,
    directory: &Path,
    ffprobe: Option<&Path>,
    timeout: Duration,
) -> Result<PathBuf> {
    let started = Instant::now();
    let extension = audio_extension(candidate);
    let stem = sanitize(format!("{}_{}", candidate.source, candidate.title));
    let output = directory.join(format!("{stem}.{extension}"));
    if output.exists()
        && output
            .metadata()
            .map(|metadata| metadata.len() > 1024)
            .unwrap_or(false)
    {
        match validate_audio_file(
            &output,
            ffprobe,
            remaining_operation_timeout(started, timeout, "验证 BGM 缓存")?,
        ) {
            Ok(()) => return Ok(output),
            Err(error) => {
                let warning = format!(
                    "BGM 缓存不是有效音频，将重新下载: {}: {error:#}",
                    output.display()
                );
                eprintln!("[警告] {warning}");
                log_line(&warning);
                remove_file_if_exists(&output)
                    .with_context(|| format!("删除无效 BGM 缓存失败: {}", output.display()))?;
            }
        }
    }

    let request_timeout = remaining_operation_timeout(started, timeout, "下载 BGM")?;
    let client = Client::builder()
        .connect_timeout(request_timeout.min(Duration::from_secs(10)))
        .timeout(request_timeout)
        .build()?;
    let bytes = client
        .get(candidate.download_target())
        .header(USER_AGENT, "VideoAutoCut/0.1 bgm-downloader")
        .send()
        .with_context(|| format!("BGM 下载请求失败: {}", candidate.download_target()))?
        .error_for_status()
        .with_context(|| format!("BGM 下载 HTTP 状态异常: {}", candidate.download_target()))?
        .bytes()
        .context("BGM 下载内容读取失败")?;

    if bytes.len() < 1024 {
        bail!(
            "BGM 下载内容过小，疑似无效: {}",
            candidate.download_target()
        );
    }

    write_bytes_atomic(&output, &bytes)
        .with_context(|| format!("写入 BGM 文件失败: {}", output.display()))?;

    let validation_timeout = match remaining_operation_timeout(started, timeout, "验证下载的 BGM")
    {
        Ok(timeout) => timeout,
        Err(error) => {
            remove_file_if_exists(&output)
                .with_context(|| format!("验证超时后清理未验证 BGM 失败: {}", output.display()))?;
            return Err(error);
        }
    };
    let validation_result = validate_audio_file(&output, ffprobe, validation_timeout);
    if let Err(error) = validation_result {
        if let Err(cleanup_error) = remove_file_if_exists(&output) {
            return Err(error).context(format!(
                "下载内容不是有效音频，且清理无效文件失败: {}: {cleanup_error:#}",
                output.display()
            ));
        }
        return Err(error).context("下载内容不是可解码的音频");
    }
    Ok(output)
}

fn remaining_operation_timeout(
    started: Instant,
    timeout: Duration,
    operation: &str,
) -> Result<Duration> {
    let remaining = timeout
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| anyhow!("{operation} 超时（{} 秒）", timeout.as_secs()))?;
    Ok(remaining)
}

fn validate_audio_file(path: &Path, ffprobe: Option<&Path>, timeout: Duration) -> Result<()> {
    let header = read_audio_header(path)?;
    if obvious_non_audio_payload(&header) {
        bail!("文件内容是 HTML、XML 或 JSON，不是音频: {}", path.display());
    }

    if let Some(ffprobe) = ffprobe {
        let mut command = Command::new(ffprobe);
        command
            .arg("-v")
            .arg("error")
            .arg("-select_streams")
            .arg("a:0")
            .arg("-show_entries")
            .arg("stream=codec_type")
            .arg("-of")
            .arg("default=noprint_wrappers=1:nokey=1")
            .arg(path);
        let output = run_command_capture_timeout(
            &mut command,
            "ffprobe bgm validation",
            timeout.min(Duration::from_secs(BGM_AUDIO_PROBE_TIMEOUT_SECONDS)),
        )
        .with_context(|| format!("ffprobe 无法解析 BGM: {}", path.display()))?;
        if output.lines().any(|line| line.trim() == "audio") {
            return Ok(());
        }
        bail!("ffprobe 未检测到音频流: {}", path.display());
    }

    if known_audio_signature(&header) {
        return Ok(());
    }
    bail!(
        "未找到 ffprobe，且文件头不是受支持的音频格式: {}",
        path.display()
    )
}

fn read_audio_header(path: &Path) -> Result<Vec<u8>> {
    let file =
        fs::File::open(path).with_context(|| format!("读取 BGM 文件头失败: {}", path.display()))?;
    let mut header = Vec::with_capacity(BGM_AUDIO_HEADER_BYTES as usize);
    file.take(BGM_AUDIO_HEADER_BYTES)
        .read_to_end(&mut header)
        .with_context(|| format!("读取 BGM 文件头失败: {}", path.display()))?;
    Ok(header)
}

fn obvious_non_audio_payload(header: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(header);
    let normalized = prefix
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    normalized.starts_with("<!doctype html")
        || normalized.starts_with("<html")
        || normalized.starts_with("<head")
        || normalized.starts_with("<body")
        || normalized.starts_with("<?xml")
        || normalized.starts_with('{')
        || normalized.starts_with('[')
}

fn known_audio_signature(header: &[u8]) -> bool {
    header.starts_with(b"ID3")
        || header.starts_with(b"OggS")
        || header.starts_with(b"fLaC")
        || (header.len() >= 12
            && matches!(&header[..4], b"RIFF" | b"RF64")
            && &header[8..12] == b"WAVE")
        || (header.len() >= 8 && &header[4..8] == b"ftyp")
        || header
            .windows(2)
            .take(1024)
            .any(|pair| pair[0] == 0xff && pair[1] & 0xe0 == 0xe0)
}

fn write_bgm_license(
    directory: &Path,
    query: &str,
    candidate: &DownloadCandidate,
    local_file: &Path,
) -> Result<()> {
    let payload = json!({
        "query": query,
        "local_file": local_file.to_string_lossy(),
        "candidate": {
            "id": candidate.id,
            "source": candidate.source,
            "provider": candidate.provider,
            "media_type": candidate.media_type,
            "title": candidate.title,
            "creator": candidate.creator,
            "creator_url": candidate.creator_url,
            "webpage_url": candidate.webpage_url,
            "download_url": candidate.download_url,
            "duration_seconds": candidate.duration,
            "license": candidate.license,
            "license_key": candidate.license_key,
            "license_url": candidate.license_url,
            "commercial_use": candidate.commercial_use,
            "attribution_required": candidate.attribution_required,
            "attribution": candidate.attribution,
            "tags": candidate.tags,
        },
        "downloaded_at": Local::now().to_rfc3339(),
    });

    write_json_pretty_atomic(&directory.join("selected_bgm.json"), &payload)
}

fn mix_bgm_into_video(
    paths: &AppPaths,
    final_file: &Path,
    bgm_file: &Path,
    volume: f32,
) -> Result<()> {
    let ffmpeg = paths
        .ffmpeg
        .as_ref()
        .ok_or_else(|| anyhow!("找不到 ffmpeg.exe，无法混入 BGM"))?;

    let temporary_file = final_file.with_file_name(format!(
        "{}_bgm_tmp.mp4",
        final_file
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("final")
    ));
    remove_file_if_exists(&temporary_file)?;

    let filter_with_ducking = format!(
        "[1:a]volume={volume:.3},afade=t=in:st=0:d=2[bgm];\
         [bgm][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=800[ducked];\
         [0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[aout]"
    );
    let status = run_bgm_ffmpeg(
        ffmpeg,
        final_file,
        bgm_file,
        &temporary_file,
        &filter_with_ducking,
    )?;
    if !status.success() {
        remove_file_if_exists(&temporary_file)?;
        let fallback_filter =
            format!("[1:a]volume={volume:.3},afade=t=in:st=0:d=2,alimiter=limit=0.95[aout]");
        let fallback_status = run_bgm_ffmpeg(
            ffmpeg,
            final_file,
            bgm_file,
            &temporary_file,
            &fallback_filter,
        )?;
        if !fallback_status.success() {
            bail!("ffmpeg BGM 混音失败，退出码: {:?}", fallback_status.code());
        }
    }

    replace_file(final_file, &temporary_file)?;
    Ok(())
}

fn run_bgm_ffmpeg(
    ffmpeg: &Path,
    final_file: &Path,
    bgm_file: &Path,
    output_file: &Path,
    filter: &str,
) -> Result<ExitStatus> {
    let mut command = Command::new(ffmpeg);
    command
        .arg("-y")
        .arg("-i")
        .arg(final_file)
        .arg("-stream_loop")
        .arg("-1")
        .arg("-i")
        .arg(bgm_file)
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("[aout]")
        .arg("-c:v")
        .arg("copy")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("192k")
        .arg("-shortest")
        .arg(output_file);

    run_command_output_status(&mut command, "ffmpeg bgm mix")
}

fn replace_file(target: &Path, replacement: &Path) -> Result<()> {
    let backup = target.with_file_name(format!(
        "{}_before_bgm.mp4",
        target
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("final")
    ));
    remove_file_if_exists(&backup)?;
    fs::rename(target, &backup).with_context(|| {
        format!(
            "备份原始成片失败: {} -> {}",
            target.display(),
            backup.display()
        )
    })?;

    match fs::rename(replacement, target) {
        Ok(()) => {
            if let Err(error) = remove_file_if_exists(&backup) {
                let warning = format!(
                    "新成片已生成，但清理原片备份失败（可手动删除 {}）: {error:#}",
                    backup.display()
                );
                eprintln!("[警告] {warning}");
                log_line(warning);
            }
            Ok(())
        }
        Err(error) => {
            if let Err(restore_error) = fs::rename(&backup, target) {
                bail!(
                    "替换 BGM 成片失败: {} -> {}: {}; 恢复原始成片也失败: {} -> {}: {}。原始文件仍可能位于 {}",
                    replacement.display(),
                    target.display(),
                    error,
                    backup.display(),
                    target.display(),
                    restore_error,
                    backup.display()
                );
            }
            Err(error).with_context(|| {
                format!(
                    "替换 BGM 成片失败: {} -> {}",
                    replacement.display(),
                    target.display()
                )
            })
        }
    }
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("删除文件失败: {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir().join(format!(
                "video_auto_app_{label}_{}_{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate() -> DownloadCandidate {
        DownloadCandidate {
            index: 1,
            id: "candidate".to_string(),
            source: "source".to_string(),
            provider: "provider".to_string(),
            media_type: "audio".to_string(),
            title: "title".to_string(),
            description: String::new(),
            uploader: String::new(),
            creator: String::new(),
            creator_url: String::new(),
            webpage_url: "https://example.com/track".to_string(),
            download_url: "https://cdn.example.com/track.mp3".to_string(),
            thumbnail: String::new(),
            duration: Some(60.0),
            filetype: "mp3".to_string(),
            view_count: None,
            upload_date: String::new(),
            tags: vec![],
            license: "CC0".to_string(),
            license_key: "cc0".to_string(),
            license_url: String::new(),
            commercial_use: Some(true),
            attribution_required: Some(false),
            attribution: String::new(),
        }
    }

    #[test]
    fn audio_extension_prefers_metadata_then_falls_back_to_url() {
        let mut input = candidate();
        input.filetype = ".WAV".to_string();
        assert_eq!(audio_extension(&input), "wav");

        input.filetype = "unknown".to_string();
        input.download_url = "https://cdn.example.com/track.ogg?token=123".to_string();
        assert_eq!(audio_extension(&input), "ogg");

        input.download_url = "https://cdn.example.com/no-extension".to_string();
        assert_eq!(audio_extension(&input), "mp3");
    }

    #[test]
    fn fallback_audio_validation_accepts_known_container_and_rejects_documents() {
        let directory = TestDirectory::new("audio_validation");
        let wav = directory.0.join("valid.wav");
        let html = directory.0.join("invalid.mp3");
        let mut wav_bytes = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
        wav_bytes.resize(2048, 0);
        fs::write(&wav, wav_bytes).expect("write wav fixture");
        fs::write(
            &html,
            b"<!doctype html><html><body>download denied</body></html>",
        )
        .expect("write html fixture");

        validate_audio_file(&wav, None, Duration::from_secs(1))
            .expect("known audio signature should pass without ffprobe");
        let error = validate_audio_file(&html, None, Duration::from_secs(1))
            .expect_err("document payload must not be accepted as audio");

        assert!(error.to_string().contains("不是音频"));
    }

    #[test]
    fn complete_file_install_replaces_stale_output_without_leaving_partial_file() {
        let directory = TestDirectory::new("complete_download");
        let target = directory.0.join("track.mp3");
        fs::write(&target, b"stale").expect("write stale target");

        write_bytes_atomic(&target, b"complete audio").expect("install complete file");

        assert_eq!(
            fs::read(&target).expect("read installed file"),
            b"complete audio"
        );
        assert!(!directory.0.join(".track.mp3.vacut.tmp").exists());
        assert!(!directory.0.join(".track.mp3.vacut.bak").exists());
    }

    #[test]
    fn replace_file_installs_replacement_and_removes_backup() {
        let directory = TestDirectory::new("replace_success");
        let target = directory.0.join("final.mp4");
        let replacement = directory.0.join("final_bgm_tmp.mp4");
        let stale_backup = directory.0.join("final_before_bgm.mp4");
        fs::write(&target, b"original").expect("write target");
        fs::write(&replacement, b"replacement").expect("write replacement");
        fs::write(&stale_backup, b"stale backup").expect("write stale backup");

        replace_file(&target, &replacement).expect("replace target");

        assert_eq!(fs::read(&target).expect("read target"), b"replacement");
        assert!(!replacement.exists());
        assert!(!stale_backup.exists());
    }

    #[test]
    fn replace_file_restores_target_when_replacement_is_missing() {
        let directory = TestDirectory::new("replace_rollback");
        let target = directory.0.join("final.mp4");
        let replacement = directory.0.join("missing.mp4");
        let backup = directory.0.join("final_before_bgm.mp4");
        fs::write(&target, b"original").expect("write target");

        let error = replace_file(&target, &replacement).expect_err("replacement should fail");

        assert!(error.to_string().contains("替换 BGM 成片失败"));
        assert_eq!(
            fs::read(&target).expect("read restored target"),
            b"original"
        );
        assert!(!backup.exists());
    }
}
