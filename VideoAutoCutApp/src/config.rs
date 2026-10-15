use anyhow::{Result, bail};
use std::env;
use std::io::{self, Write};
use std::path::Path;

use crate::cli::{Cli, Source};
use crate::models::RunConfig;
use crate::remote_config;

pub(crate) fn ensure_api_key_file(env_file: &Path) -> Result<()> {
    if remote_config::is_required() && !remote_config::has_key("DASHSCOPE_API_KEY") {
        bail!("账号配置未下发 DASHSCOPE_API_KEY，无法执行 AI 主流程。请重新登录或检查接口配置。");
    }

    if env::var("DASHSCOPE_API_KEY").is_ok() || env_file.exists() {
        return Ok(());
    }

    bail!(
        "缺少运行配置文件: {}。请先登录桌面端同步账号配置，不再支持本地手动录入 API Key。",
        env_file.display()
    )
}

pub(crate) fn prompt(label: &str) -> Result<String> {
    print!("{}: ", label);

    io::stdout().flush()?;

    let mut s = String::new();

    io::stdin().read_line(&mut s)?;

    Ok(s.trim().to_string())
}

pub(crate) fn prompt_source(default: Source) -> Result<Source> {
    println!("请选择素材来源:");
    println!("  1. Pexels（商用素材库）");
    println!("  2. Pixabay（商用素材库）");
    println!("  3. Wikimedia Commons（按文件许可证）");

    let hint = match default {
        Source::Pexels => "默认 1",
        Source::Pixabay => "默认 2",
        Source::WikimediaCommons => "默认 3",
    };

    let answer = prompt(&format!("请输入 1-3 ({})", hint))?;

    if answer.trim().is_empty() {
        return Ok(default);
    }

    match answer.trim().to_lowercase().as_str() {
        "1" | "pexels" => Ok(Source::Pexels),
        "2" | "pixabay" => Ok(Source::Pixabay),
        "3" | "wikimedia" | "wikimedia-commons" => Ok(Source::WikimediaCommons),
        other => bail!("未知素材来源编号: {}", other),
    }
}

pub(crate) fn config_from_env_and_cli(cli: &Cli) -> Result<RunConfig> {
    let downloads_per_shot = cli
        .downloads_per_shot
        .or_else(|| env_usize("DOWNLOADS_PER_SHOT"))
        .unwrap_or(2);

    let download_candidate_pool = env_usize("DOWNLOAD_CANDIDATE_POOL")
        .or_else(|| env_usize("MATERIAL_CANDIDATE_POOL"))
        .unwrap_or_else(|| downloads_per_shot.saturating_mul(5).clamp(8, 30));

    let source = match cli.source.clone() {
        Some(source) => source,
        None => env_source("SOURCE")?.unwrap_or(Source::Pexels),
    };

    let bgm_enabled = env_bool("BGM_ENABLED").unwrap_or(true);
    let bgm_source = env_string("BGM_SOURCE").unwrap_or_else(|| "auto".to_string());
    if remote_config::is_required()
        && bgm_enabled
        && bgm_source_includes(&bgm_source, "jamendo-audio")
        && !remote_config::has_key("JAMENDO_CLIENT_ID")
    {
        bail!(
            "账号配置未下发 JAMENDO_CLIENT_ID，无法使用 Jamendo Audio 添加 BGM。请重新登录或检查接口配置。"
        );
    }
    if remote_config::is_required()
        && bgm_enabled
        && bgm_source_includes(&bgm_source, "openverse-audio")
        && (!remote_config::has_key("OPENVERSE_CLIENT_ID")
            || !remote_config::has_key("OPENVERSE_CLIENT_SECRET"))
    {
        bail!(
            "账号配置未下发 OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET，无法使用 Openverse Audio 添加 BGM。请重新登录或检查接口配置。"
        );
    }

    Ok(RunConfig {
        source,
        downloads_per_shot,
        download_review: env_bool("DOWNLOAD_REVIEW")
            .or_else(|| env_bool("MATERIAL_PREFILTER"))
            .unwrap_or(true),
        download_candidate_pool,
        download_review_threshold: env_f32("DOWNLOAD_REVIEW_THRESHOLD")
            .or_else(|| env_f32("MATERIAL_PREFILTER_THRESHOLD"))
            .unwrap_or(70.0),
        clips_per_shot: cli
            .clips_per_shot
            .or_else(|| env_usize("CLIPS_PER_SHOT"))
            .unwrap_or(1),
        results_per_shot: cli
            .results_per_shot
            .or_else(|| env_usize("RESULTS_PER_SHOT"))
            .unwrap_or(10),
        chunk_duration: cli
            .chunk_duration
            .or_else(|| env_u32("CHUNK_DURATION"))
            .unwrap_or(30),
        min_source_duration: env_u32("MIN_SOURCE_DURATION"),
        max_source_duration: env_u32("MAX_SOURCE_DURATION"),
        // Prefer the desktop setting; retain legacy keys for existing configurations.
        match_accept_threshold: env_f32("MATERIAL_MATCH_MIN_SCORE")
            .or_else(|| env_f32("SENTRY_MATCH_THRESHOLD"))
            .or_else(|| env_f32("MATCH_ACCEPT_THRESHOLD"))
            .unwrap_or(0.25),
        voiceover: cli.voiceover && env_bool("VOICEOVER").unwrap_or(true),
        subtitles: cli.subtitles && env_bool("SUBTITLES").unwrap_or(true),
        progress_bar: cli.progress_bar && env_bool("PROGRESS_BAR").unwrap_or(true),
        bgm_enabled,
        bgm_source,
        bgm_query: env_string("BGM_QUERY"),
        bgm_candidate_pool: env_usize("BGM_CANDIDATE_POOL").unwrap_or(8).clamp(1, 50),
        bgm_min_duration: env_u32("BGM_MIN_DURATION").or(Some(15)),
        bgm_max_duration: env_u32("BGM_MAX_DURATION").or(Some(300)),
        bgm_volume: env_f32("BGM_VOLUME").unwrap_or(0.16).clamp(0.0, 1.0),
    })
}

pub(crate) fn validate_download_source(source: &Source) -> Result<()> {
    if remote_config::is_required() {
        match source {
            Source::Pexels if !remote_config::has_key("PEXELS_API_KEY") => {
                bail!(
                    "账号配置未下发 PEXELS_API_KEY，无法使用 Pexels 下载素材。请重新登录或检查接口配置。"
                )
            }
            Source::Pixabay if !remote_config::has_key("PIXABAY_API_KEY") => {
                bail!(
                    "账号配置未下发 PIXABAY_API_KEY，无法使用 Pixabay 下载素材。请重新登录或检查接口配置。"
                )
            }
            _ => {}
        }
    }
    Ok(())
}

fn bgm_source_includes(value: &str, expected: &str) -> bool {
    value.split(',').any(|item| {
        let normalized = item.trim().replace('_', "-");
        normalized.eq_ignore_ascii_case(expected)
    })
}

fn env_source(key: &str) -> Result<Option<Source>> {
    let Ok(value) = env::var(key) else {
        return Ok(None);
    };

    let source = match value.trim().to_lowercase().as_str() {
        "pexels" => Some(Source::Pexels),
        "pixabay" => Some(Source::Pixabay),
        "wikimedia" | "wikimedia-commons" => Some(Source::WikimediaCommons),
        "" => None,
        other => bail!(
            "{} 只支持 pexels、pixabay 或 wikimedia-commons，当前值: {}",
            key,
            other
        ),
    };

    Ok(source)
}

fn env_usize(key: &str) -> Option<usize> {
    env::var(key).ok()?.trim().parse().ok()
}

fn env_u32(key: &str) -> Option<u32> {
    env::var(key).ok()?.trim().parse().ok()
}

fn env_f32(key: &str) -> Option<f32> {
    env::var(key).ok()?.trim().parse().ok()
}

fn env_string(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_bool(key: &str) -> Option<bool> {
    match env::var(key).ok()?.trim().to_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
