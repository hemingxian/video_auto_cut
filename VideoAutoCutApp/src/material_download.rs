use anyhow::{Result, anyhow, bail};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

use crate::candidate::{DownloadCandidate, collect_provider_candidates, parse_download_candidates};
use crate::cli::Source;
use crate::logging::log_line;
use crate::material_review::{
    review_download_candidates, select_candidates_for_download, write_download_review,
};
use crate::models::{AppPaths, RunConfig, Shot};
use crate::paths::add_child_env;
use crate::process::{run_command_capture, run_command_output_status};

#[derive(Clone, Copy)]
pub(crate) struct MaterialDownloadContext<'a> {
    pub(crate) paths: &'a AppPaths,
    pub(crate) source: &'a Source,
    pub(crate) output_directory: &'a Path,
    pub(crate) config: &'a RunConfig,
}

#[derive(Clone, Copy)]
pub(crate) struct MaterialItemProgress {
    pub(crate) current: usize,
    pub(crate) total: usize,
}

pub(crate) struct MaterialDownloadEvent {
    pub(crate) phase: &'static str,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) label: String,
}

fn report_progress(
    progress: Option<MaterialItemProgress>,
    phase: &'static str,
    label: impl FnOnce(MaterialItemProgress) -> String,
    reporter: &mut dyn FnMut(MaterialDownloadEvent),
) {
    let Some(progress) = progress else {
        return;
    };

    reporter(MaterialDownloadEvent {
        phase,
        current: progress.current,
        total: progress.total,
        label: label(progress),
    });
}

fn add_yt_dlp_common_args(command: &mut Command, paths: &AppPaths) {
    add_child_env(command, paths);

    if let Some(node) = &paths.node {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }

    if let Some(ffmpeg) = &paths.ffmpeg {
        command.arg("--ffmpeg-location").arg(ffmpeg);
    }
}

fn source_duration_filters(config: &RunConfig) -> Vec<String> {
    [
        config
            .min_source_duration
            .map(|value| format!("duration >= {value}")),
        config
            .max_source_duration
            .map(|value| format!("duration <= {value}")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn collect_download_candidates(
    paths: &AppPaths,
    source: &Source,
    query: &str,
    config: &RunConfig,
) -> Result<Vec<DownloadCandidate>> {
    let duration_filters = source_duration_filters(config);
    let search_count = if duration_filters.is_empty() {
        config.download_candidate_pool
    } else {
        config
            .download_candidate_pool
            .saturating_mul(2)
            .max(config.download_candidate_pool)
            .min(50)
    };

    if let Some(candidates) =
        collect_provider_candidates(paths, source, query, search_count, config)?
    {
        return Ok(candidates);
    }

    let search_prefix = source.yt_dlp_search_prefix().ok_or_else(|| {
        anyhow!(
            "{} 当前没有可用的素材 Provider，也不是 yt-dlp 搜索源。",
            source.label()
        )
    })?;

    let mut command = Command::new(&paths.yt_dlp);
    add_yt_dlp_common_args(&mut command, paths);

    command
        .arg("--dump-json")
        .arg("--skip-download")
        .arg("--ignore-errors")
        .arg("--no-warnings")
        .arg("--no-playlist");

    if !duration_filters.is_empty() {
        command
            .arg("--match-filter")
            .arg(duration_filters.join(" & "));
    }

    command.arg(format!("{search_prefix}{search_count}:{query}"));

    let output = run_command_capture(&mut command, "yt-dlp candidate scan")?;
    Ok(parse_download_candidates(&output))
}

fn download_candidate_urls(
    paths: &AppPaths,
    candidates: &[DownloadCandidate],
    output_directory: &Path,
) -> Result<()> {
    let mut command = Command::new(&paths.yt_dlp);
    add_yt_dlp_common_args(&mut command, paths);

    command
        .arg("--download-archive")
        .arg(&paths.archive)
        .arg("--no-playlist")
        .arg("-f")
        .arg("bv*[height<=1080]+ba/best[height<=1080]/best")
        .arg("-o")
        .arg(output_directory.join("%(id)s_%(title).80s.%(ext)s"));

    for candidate in candidates {
        if candidate.has_download_target() {
            command.arg(candidate.download_target());
        }
    }

    let status = run_command_output_status(&mut command, "yt-dlp reviewed candidates")?;
    let reused = reuse_archived_candidates(candidates, output_directory)?;
    if reused > 0 {
        println!("已从当前项目复用 {reused} 个曾下载的候选素材。");
    }

    let missing = candidates
        .iter()
        .filter(|candidate| !candidate_exists(output_directory, &candidate.id))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let mut retry = Command::new(&paths.yt_dlp);
        add_yt_dlp_common_args(&mut retry, paths);
        retry
            .arg("--no-playlist")
            .arg("-f")
            .arg("bv*[height<=1080]+ba/best[height<=1080]/best")
            .arg("-o")
            .arg(output_directory.join("%(id)s_%(title).80s.%(ext)s"));
        for candidate in missing {
            retry.arg(candidate.download_target());
        }
        let retry_status =
            run_command_output_status(&mut retry, "yt-dlp missing archived candidates")?;
        if !retry_status.success() && !has_video_files(output_directory) {
            bail!(
                "yt-dlp could not restore archived candidates, exit code: {:?}",
                retry_status.code()
            );
        }
    }

    if !status.success() && !has_video_files(output_directory) {
        bail!(
            "yt-dlp reviewed candidate download failed and no video was downloaded, exit code: {:?}",
            status.code()
        );
    }

    if !status.success() {
        println!("[警告] yt-dlp 部分候选下载失败，但已有视频下载成功，将继续处理。");
    }

    Ok(())
}

fn is_video_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_lowercase())
            .as_deref(),
        Some("mp4" | "webm" | "mkv" | "mov")
    )
}

fn candidate_file_prefix(candidate_id: &str) -> String {
    format!("{}_", sanitize_filename::sanitize(candidate_id.trim()))
}

fn candidate_exists(directory: &Path, candidate_id: &str) -> bool {
    let prefix = candidate_file_prefix(candidate_id);
    WalkDir::new(directory)
        .min_depth(1)
        .max_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry.file_type().is_file()
                && is_video_path(entry.path())
                && entry.file_name().to_string_lossy().starts_with(&prefix)
        })
}

fn archived_candidate_path(
    project_material_root: &Path,
    output_directory: &Path,
    candidate_id: &str,
) -> Option<PathBuf> {
    let prefix = candidate_file_prefix(candidate_id);
    WalkDir::new(project_material_root)
        .min_depth(1)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != "_indexed_h264")
        .filter_map(|entry| entry.ok())
        .find_map(|entry| {
            let source = entry.path();
            if !entry.file_type().is_file()
                || source.starts_with(output_directory)
                || !is_video_path(source)
                || !entry.file_name().to_string_lossy().starts_with(&prefix)
            {
                return None;
            }
            Some(source.to_path_buf())
        })
}

fn reuse_archived_candidates(
    candidates: &[DownloadCandidate],
    output_directory: &Path,
) -> Result<usize> {
    let Some(project_material_root) = output_directory.parent() else {
        return Ok(0);
    };
    fs::create_dir_all(output_directory)?;
    let mut reused = 0;
    for candidate in candidates {
        if candidate_exists(output_directory, &candidate.id) {
            continue;
        }
        let Some(source) =
            archived_candidate_path(project_material_root, output_directory, &candidate.id)
        else {
            continue;
        };
        let Some(file_name) = source.file_name() else {
            continue;
        };
        let destination = output_directory.join(file_name);
        if fs::hard_link(&source, &destination).is_err() {
            fs::copy(&source, &destination)?;
        }
        reused += 1;
    }
    Ok(reused)
}

fn download_reviewed_candidates(
    context: MaterialDownloadContext<'_>,
    shot: &Shot,
    count: usize,
    progress: Option<MaterialItemProgress>,
    reporter: &mut dyn FnMut(MaterialDownloadEvent),
) -> Result<bool> {
    let MaterialDownloadContext {
        paths,
        source,
        output_directory,
        config,
    } = context;

    if !config.download_review {
        return Ok(false);
    }

    println!(
        "\n正在下载前审核候选素材：候选池 {}，目标下载 {}",
        config.download_candidate_pool, count
    );

    report_progress(
        progress,
        "searching",
        |progress| format!("搜索候选素材 {}/{}", progress.current + 1, progress.total),
        reporter,
    );
    let candidates = collect_download_candidates(paths, source, &shot.download_query, config)?;
    if candidates.is_empty() {
        bail!("没有扫描到可审核的候选素材");
    }

    println!("候选素材: {} 个，开始 AI 文本审核", candidates.len());
    report_progress(
        progress,
        "reviewing",
        |progress| format!("审核候选素材 {}/{}", progress.current + 1, progress.total),
        reporter,
    );
    let decisions = review_download_candidates(paths, shot, &candidates, config)?;
    if decisions.is_empty() {
        bail!("模型没有返回候选审核结果");
    }

    let selected = select_candidates_for_download(
        &candidates,
        &decisions,
        count,
        config.download_review_threshold,
    );

    for candidate in &candidates {
        let decision = decisions
            .iter()
            .find(|item| item.id == candidate.id || item.index == candidate.index);
        if let Some(decision) = decision {
            println!(
                "候选 #{} {:.0} {}: {}",
                candidate.index, decision.score, decision.decision, candidate.title
            );
            if !decision.reason.is_empty() {
                println!("  {}", decision.reason);
            }
        }
    }

    if let Err(error) = write_download_review(output_directory, &candidates, &decisions, &selected)
    {
        let warning = format!("写入素材审核报告失败，将继续下载: {error:#}");
        eprintln!("[警告] {warning}");
        log_line(warning);
    }

    if selected.is_empty() {
        println!(
            "[警告] AI 文本审核没有放行任何候选素材，本分镜不按关键词盲目下载。审核结果: {}",
            output_directory.join("download_review.json").display()
        );
        return Ok(true);
    }

    println!("通过审核: {} 个，开始下载", selected.len());
    report_progress(
        progress,
        "downloading",
        |progress| format!("下载素材 {}/{}", progress.current + 1, progress.total),
        reporter,
    );
    download_candidate_urls(paths, &selected, output_directory)?;

    Ok(true)
}

fn download_search_query(
    context: MaterialDownloadContext<'_>,
    query: &str,
    count: usize,
) -> Result<()> {
    let MaterialDownloadContext {
        paths,
        source,
        output_directory,
        config,
    } = context;

    if source.yt_dlp_search_prefix().is_none() {
        let candidates = collect_download_candidates(paths, source, query, config)?;
        let selected: Vec<DownloadCandidate> = candidates
            .into_iter()
            .filter(DownloadCandidate::has_download_target)
            .take(count)
            .collect();

        if selected.is_empty() {
            bail!("素材 Provider 没有返回可下载候选素材。");
        }

        return download_candidate_urls(paths, &selected, output_directory);
    }

    let search_prefix = source.yt_dlp_search_prefix().ok_or_else(|| {
        anyhow!(
            "{} 当前没有可用的素材 Provider，也不是 yt-dlp 搜索源。",
            source.label()
        )
    })?;
    let mut command = Command::new(&paths.yt_dlp);
    add_yt_dlp_common_args(&mut command, paths);

    let duration_filters = source_duration_filters(config);
    let search_count = if duration_filters.is_empty() {
        count
    } else {
        (count * 5).max(count).min(30)
    };

    if !duration_filters.is_empty() {
        command
            .arg("--match-filter")
            .arg(duration_filters.join(" & "));
        command.arg("--max-downloads").arg(count.to_string());
    }

    command
        .arg("--download-archive")
        .arg(&paths.archive)
        .arg("-f")
        .arg("bv*[height<=1080]+ba/best[height<=1080]/best")
        .arg("-o")
        .arg(output_directory.join("%(id)s_%(title).80s.%(ext)s"))
        .arg(format!("{search_prefix}{search_count}:{query}"));

    let status = run_command_output_status(&mut command, "yt-dlp")?;

    if !status.success() && !has_video_files(output_directory) {
        bail!(
            "yt-dlp failed and no video was downloaded, exit code: {:?}",
            status.code()
        );
    }

    if !status.success() {
        println!("[warning] yt-dlp partially failed, but some videos were downloaded.");
    }

    Ok(())
}

pub(crate) fn download_for_shot(
    context: MaterialDownloadContext<'_>,
    shot: &Shot,
    count: usize,
    progress: Option<MaterialItemProgress>,
    mut reporter: impl FnMut(MaterialDownloadEvent),
) -> Result<()> {
    match download_reviewed_candidates(context, shot, count, progress, &mut reporter) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(error) => {
            println!("[警告] 下载前候选收集或审核失败，将尝试直接下载同一来源候选: {error:#}");
        }
    }

    report_progress(
        progress,
        "downloading",
        |progress| format!("直接下载素材 {}/{}", progress.current + 1, progress.total),
        &mut reporter,
    );
    download_search_query(context, &shot.download_query, count)
}

pub(crate) fn has_video_files(directory: &Path) -> bool {
    WalkDir::new(directory)
        .min_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry.file_type().is_file()
                && matches!(
                    entry
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| extension.to_lowercase())
                        .as_deref(),
                    Some("mp4" | "webm" | "mkv" | "mov")
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn progress_reporting_preserves_item_position_and_phase() {
        let mut events = Vec::new();
        report_progress(
            Some(MaterialItemProgress {
                current: 1,
                total: 4,
            }),
            "reviewing",
            |progress| format!("审核候选素材 {}/{}", progress.current + 1, progress.total),
            &mut |event| events.push(event),
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].phase, "reviewing");
        assert_eq!(events[0].current, 1);
        assert_eq!(events[0].total, 4);
        assert_eq!(events[0].label, "审核候选素材 2/4");

        report_progress(None, "downloading", |_| String::new(), &mut |event| {
            events.push(event);
        });
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn archived_candidate_is_reused_in_a_later_shot() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        // 带进程号：两个 `cargo test` 进程并发时只靠时间戳会撞名（Mac 复核实测偶发失败）
        let root = std::env::temp_dir().join(format!(
            "vacut-archive-reuse-{}-{nonce}",
            std::process::id()
        ));
        let first = root.join("01 first");
        let second = root.join("02 second");
        fs::create_dir_all(&first).expect("create first shot");
        fs::write(first.join("12345_machine.mp4"), b"video").expect("write candidate");

        let candidate = DownloadCandidate {
            index: 1,
            id: "12345".to_string(),
            source: String::new(),
            provider: String::new(),
            media_type: "video".to_string(),
            title: "machine".to_string(),
            description: String::new(),
            uploader: String::new(),
            creator: String::new(),
            creator_url: String::new(),
            webpage_url: String::new(),
            download_url: "https://example.com/video.mp4".to_string(),
            thumbnail: String::new(),
            duration: None,
            filetype: "mp4".to_string(),
            view_count: None,
            upload_date: String::new(),
            tags: Vec::new(),
            license: String::new(),
            license_key: String::new(),
            license_url: String::new(),
            commercial_use: Some(true),
            attribution_required: Some(false),
            attribution: String::new(),
        };

        let reused = reuse_archived_candidates(&[candidate], &second).expect("reuse candidate");
        assert_eq!(reused, 1);
        assert_eq!(
            fs::read(second.join("12345_machine.mp4")).expect("read reused"),
            b"video"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
