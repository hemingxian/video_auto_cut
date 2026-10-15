use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use sanitize_filename::sanitize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;
use walkdir::WalkDir;

use crate::clip_manifest::checked_clip_path;
use crate::domain::shot_needs_download;
use crate::logging::log_line;
use crate::material_download::{
    MaterialDownloadContext, MaterialDownloadEvent, MaterialItemProgress, download_for_shot,
    has_video_files,
};
use crate::models::{
    AppPaths, GenerationMaterialManifest, RunConfig, Shot, ShotMaterialBinding, ShotPlan,
};
use crate::normalization_cache::NormalizationCache;
use crate::paths::add_child_env;
use crate::process::{IndexBudget, run_command, run_command_capture_timeout, run_index_streaming};

const FALLBACK_CLIP_FILE_NAME: &str = "zzzz_fallback_material.mp4";
const SHOT_METADATA_FILE_NAME: &str = ".videoautocut-shot.json";
static BEST_SIMILARITY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*#\d+\s+\[([0-9]+(?:\.[0-9]+)?)\]")
        .expect("best similarity regex must be valid")
});

pub(crate) struct MaterialClipContext<'a> {
    pub(crate) paths: &'a AppPaths,
    pub(crate) run_raw: &'a Path,
    pub(crate) run_clips: &'a Path,
    pub(crate) config: &'a RunConfig,
    pub(crate) skip_download: bool,
    pub(crate) skip_index: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaterialPreparationMode {
    DownloadOnly,
    IndexForClip,
}

#[derive(Clone, Copy)]
pub(crate) struct MaterialClipProgress {
    pub(crate) current: usize,
    pub(crate) total: usize,
}

pub(crate) struct MaterialClipProgressEvent {
    pub(crate) phase: &'static str,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) label: String,
}

struct ShotWorkspace {
    raw_directory: PathBuf,
    index_directory: PathBuf,
    clip_directory: PathBuf,
}

pub(crate) fn validate_material_contract(
    plan: &ShotPlan,
    manifest: Option<&GenerationMaterialManifest>,
    require_manifest: bool,
) -> Result<()> {
    if plan.schema_version != 2 {
        bail!(
            "unsupported shots schema_version: {}; expected 2",
            plan.schema_version
        );
    }

    let mut shot_ids = HashSet::new();
    let mut has_bound_shot = false;
    for shot in &plan.shots {
        let shot_id = shot.shot_id.trim();
        if shot_id.is_empty() {
            bail!("shot #{} is missing shot_id", shot.shot);
        }
        if !shot_ids.insert(shot_id.to_owned()) {
            bail!("duplicate shot_id {}", shot_id);
        }

        let mut binding_ids = HashSet::new();
        for binding in &shot.material_bindings {
            let binding_key = match binding {
                ShotMaterialBinding::Material { material_id } => {
                    let material_id = material_id.trim();
                    if material_id.is_empty() {
                        bail!("shot {} contains an empty material_id", shot_id);
                    }
                    format!("material:{material_id}")
                }
                ShotMaterialBinding::Folder {
                    folder_id,
                    include_subfolders: _,
                } => {
                    let folder_id = folder_id.trim();
                    if folder_id.is_empty() {
                        bail!("shot {} contains an empty folder_id", shot_id);
                    }
                    format!("folder:{folder_id}")
                }
            };
            if !binding_ids.insert(binding_key.clone()) {
                bail!(
                    "shot {} contains duplicate binding {}",
                    shot_id,
                    binding_key
                );
            }
        }

        if shot_needs_download(shot) {
            if !shot.material_bindings.is_empty() {
                bail!(
                    "shot {} uses automatic download but still contains material_bindings",
                    shot_id
                );
            }
        } else {
            has_bound_shot = true;
            if shot.material_bindings.is_empty() {
                bail!(
                    "shot {} must select at least one material or folder",
                    shot_id
                );
            }
        }
    }

    if require_manifest && has_bound_shot && manifest.is_none() {
        bail!("bound shots require a frozen material manifest");
    }

    let Some(manifest) = manifest else {
        return Ok(());
    };
    if manifest.schema_version != 1 {
        bail!(
            "unsupported material manifest schema_version: {}",
            manifest.schema_version
        );
    }
    if manifest.run_id.trim().is_empty()
        || manifest.task_id.trim().is_empty()
        || manifest.resolved_at.trim().is_empty()
    {
        bail!("material manifest is missing run_id, task_id, or resolved_at");
    }
    if manifest.task_revision != plan.task_revision {
        bail!(
            "material manifest task_revision {} does not match shots task_revision {}",
            manifest.task_revision,
            plan.task_revision
        );
    }

    let mut manifest_shot_ids = HashSet::new();
    for manifest_shot in &manifest.shots {
        let manifest_shot_id = manifest_shot.shot_id.trim();
        if manifest_shot_id.is_empty() || !manifest_shot_ids.insert(manifest_shot_id.to_owned()) {
            bail!("material manifest contains an empty or duplicate shot_id");
        }
        if !shot_ids.contains(manifest_shot_id) {
            bail!(
                "material manifest contains unknown shot_id {}",
                manifest_shot_id
            );
        }

        let mut assets = HashSet::new();
        for material in &manifest_shot.materials {
            if material.material_id.trim().is_empty()
                || material.asset_id.trim().is_empty()
                || material.asset_version == 0
            {
                bail!(
                    "shot {} contains incomplete material identity",
                    manifest_shot_id
                );
            }
            let asset_key = format!("{}:{}", material.asset_id, material.asset_version);
            if !assets.insert(asset_key.clone()) {
                bail!(
                    "shot {} contains duplicate asset {}",
                    manifest_shot_id,
                    asset_key
                );
            }
        }
    }
    if manifest_shot_ids != shot_ids {
        bail!("material manifest does not match the current shot set");
    }

    Ok(())
}

fn compute_sha256(file_path: &Path) -> Result<String> {
    let mut file = fs::File::open(file_path)
        .with_context(|| format!("failed to open material {}", file_path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to read material {}", file_path.display()))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn report_progress(
    progress: Option<MaterialClipProgress>,
    phase: &'static str,
    label: impl FnOnce(MaterialClipProgress) -> String,
    reporter: &mut dyn FnMut(MaterialClipProgressEvent),
) {
    let Some(progress) = progress else {
        return;
    };

    reporter(MaterialClipProgressEvent {
        phase,
        current: progress.current,
        total: progress.total,
        label: label(progress),
    });
}

fn shot_collision_prefix(shot_name: &str, shot_id: &str) -> String {
    let suffix = sanitize(shot_id.trim())
        .chars()
        .filter(|character| character.is_alphanumeric())
        .take(8)
        .collect::<String>();
    let suffix = if suffix.is_empty() { "分镜" } else { &suffix };
    format!("{shot_name} · {suffix}")
}

fn unique_shot_directory(run_raw: &Path, shot_name: &str, shot_id: &str) -> PathBuf {
    let prefix = shot_collision_prefix(shot_name, shot_id);
    let mut candidate = run_raw.join(&prefix);
    let mut collision = 2;
    while candidate.exists() {
        candidate = run_raw.join(format!("{prefix} ({collision})"));
        collision += 1;
    }
    candidate
}

fn prepare_shot_workspace(run_raw: &Path, run_clips: &Path, shot: &Shot) -> Result<ShotWorkspace> {
    let clean_title = sanitize(shot.title.trim());
    let clean_title = clean_title.trim_matches([' ', '.', '_', '-']);
    let clean_title = if clean_title.is_empty() {
        "未命名分镜".to_string()
    } else {
        clean_title.chars().take(48).collect::<String>()
    };
    let shot_name = format!("{:02} · {}", shot.shot, clean_title);
    let metadata = serde_json::json!({
        "schema_version": 1,
        "shot_id": shot.shot_id,
        "order": shot.shot,
        "title": shot.title,
    });
    let desired_directory = run_raw.join(&shot_name);
    let mut existing_directory = None;
    if run_raw.is_dir() && !shot.shot_id.trim().is_empty() {
        for entry in fs::read_dir(run_raw)?.filter_map(|entry| entry.ok()) {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let candidate = entry.path();
            let metadata_path = candidate.join(SHOT_METADATA_FILE_NAME);
            let matches_shot = fs::read_to_string(metadata_path)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|value| {
                    value
                        .get("shot_id")
                        .and_then(|item| item.as_str())
                        .map(str::to_owned)
                })
                .is_some_and(|shot_id| shot_id == shot.shot_id);
            if !matches_shot {
                continue;
            }
            existing_directory = Some(candidate);
            break;
        }
    }
    let desired_belongs_to_shot =
        fs::read_to_string(desired_directory.join(SHOT_METADATA_FILE_NAME))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| {
                value
                    .get("shot_id")
                    .and_then(|item| item.as_str())
                    .map(str::to_owned)
            })
            .is_some_and(|shot_id| shot_id == shot.shot_id);
    let raw_directory = match existing_directory {
        Some(existing) if existing == desired_directory => existing,
        Some(existing) if !desired_directory.exists() => {
            fs::rename(&existing, &desired_directory)?;
            desired_directory
        }
        Some(existing) => {
            let collision_prefix = shot_collision_prefix(&shot_name, &shot.shot_id);
            let existing_name = existing
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or_default();
            if existing_name == collision_prefix
                || existing_name.starts_with(&format!("{collision_prefix} ("))
            {
                existing
            } else {
                let collision_directory = unique_shot_directory(run_raw, &shot_name, &shot.shot_id);
                fs::rename(&existing, &collision_directory)?;
                collision_directory
            }
        }
        None if !desired_directory.exists() || desired_belongs_to_shot => desired_directory,
        None => unique_shot_directory(run_raw, &shot_name, &shot.shot_id),
    };
    let index_directory = raw_directory.join("_indexed_h264");
    let clip_directory = run_clips.join(&shot_name);

    fs::create_dir_all(&raw_directory)?;
    crate::persistence::write_json_pretty_atomic(
        &raw_directory.join(SHOT_METADATA_FILE_NAME),
        &metadata,
    )?;
    fs::create_dir_all(&index_directory)?;
    fs::create_dir_all(&clip_directory)?;

    Ok(ShotWorkspace {
        raw_directory,
        index_directory,
        clip_directory,
    })
}

pub(crate) fn stage_manifest_materials(
    run_raw: &Path,
    run_clips: &Path,
    plan: &ShotPlan,
    manifest: &GenerationMaterialManifest,
) -> Result<()> {
    validate_material_contract(plan, Some(manifest), true)?;
    let mut verified_sources = HashMap::<PathBuf, String>::new();

    for shot in &plan.shots {
        let shot_id = shot.shot_id.trim();
        if shot_id.is_empty() {
            bail!("shot #{} is missing shot_id", shot.shot);
        }
        let manifest_shot = manifest
            .shots
            .iter()
            .find(|item| item.shot_id == shot_id)
            .ok_or_else(|| anyhow!("material manifest is missing shot_id {}", shot_id))?;

        if shot_needs_download(shot) {
            if !manifest_shot.materials.is_empty() {
                bail!(
                    "shot {} uses automatic download but manifest contains bound materials",
                    shot_id
                );
            }
            continue;
        }
        if manifest_shot.materials.is_empty() {
            bail!("shot {} has no available bound materials", shot_id);
        }

        let workspace = prepare_shot_workspace(run_raw, run_clips, shot)?;
        for (index, material) in manifest_shot.materials.iter().enumerate() {
            if material.source_sha256.len() != 64
                || !material
                    .source_sha256
                    .bytes()
                    .all(|value| value.is_ascii_hexdigit())
            {
                bail!(
                    "material {} has an invalid source_sha256",
                    material.material_id
                );
            }
            if !material.local_path.is_file() {
                bail!(
                    "material {} is not available on this device: {}",
                    material.material_id,
                    material.local_path.display()
                );
            }
            let actual_sha256 = if let Some(value) = verified_sources.get(&material.local_path) {
                value.clone()
            } else {
                let value = compute_sha256(&material.local_path)?;
                verified_sources.insert(material.local_path.clone(), value.clone());
                value
            };
            if !actual_sha256.eq_ignore_ascii_case(&material.source_sha256) {
                bail!(
                    "material {} failed SHA-256 verification",
                    material.material_id
                );
            }
            let extension = material
                .local_path
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or("mp4");
            let destination = workspace.raw_directory.join(format!(
                "bound_{:03}_{}_v{}.{}",
                index + 1,
                sanitize(&material.asset_id),
                material.asset_version,
                extension
            ));
            if destination.is_file() {
                let staged_sha256 = compute_sha256(&destination)?;
                if staged_sha256.eq_ignore_ascii_case(&material.source_sha256) {
                    continue;
                }
            }
            if fs::hard_link(&material.local_path, &destination).is_err() {
                fs::copy(&material.local_path, &destination).with_context(|| {
                    format!(
                        "failed to stage material {} into {}",
                        material.material_id,
                        destination.display()
                    )
                })?;
            }
        }
    }

    Ok(())
}

pub(crate) fn prepare_shot_materials(
    context: &MaterialClipContext<'_>,
    shot: &Shot,
    mode: MaterialPreparationMode,
    progress: Option<MaterialClipProgress>,
    mut reporter: impl FnMut(MaterialClipProgressEvent),
) -> Result<()> {
    let MaterialClipContext {
        paths,
        run_raw,
        run_clips,
        config,
        skip_download,
        skip_index,
    } = context;

    let workspace = prepare_shot_workspace(run_raw, run_clips, shot)?;
    let shot_raw_directory = workspace.raw_directory;
    let shot_index_directory = workspace.index_directory;

    println!("\n================================================");
    println!("分镜 #{:02}: {}", shot.shot, shot.title);
    println!("下载关键词: {}", shot.download_query);
    println!("画面搜索描述: {}", shot.visual_query);
    println!("================================================");

    let repair_missing_download = mode != MaterialPreparationMode::DownloadOnly
        && !has_video_files(&shot_raw_directory)
        && shot_needs_download(shot)
        && !skip_download;
    if repair_missing_download {
        println!(
            "分镜 #{:02} 缺少候选视频，正在补下载后继续剪辑。",
            shot.shot
        );
    }
    if mode == MaterialPreparationMode::DownloadOnly || repair_missing_download {
        if !skip_download {
            if let Err(error) = download_for_shot(
                MaterialDownloadContext {
                    paths,
                    source: &config.source,
                    output_directory: &shot_raw_directory,
                    config,
                },
                shot,
                config.downloads_per_shot,
                progress.map(|progress| MaterialItemProgress {
                    current: progress.current,
                    total: progress.total,
                }),
                |event| {
                    let MaterialDownloadEvent {
                        phase,
                        current,
                        total,
                        label,
                    } = event;
                    reporter(MaterialClipProgressEvent {
                        phase,
                        current,
                        total,
                        label,
                    });
                },
            ) {
                eprintln!("[警告] 下载命令返回错误: {error:#}");
                eprintln!("[警告] 将继续使用当前分镜目录里已经下载成功的视频。");
            }
        } else {
            println!("跳过下载: {}", shot_raw_directory.display());
        }

        if !has_video_files(&shot_raw_directory) {
            bail!(
                "分镜 #{:02}（{}）下载失败：没有可用候选视频，请检查下载错误后重试；搜索审核记录不代表视频已下载",
                shot.shot,
                shot.title
            );
        }

        if mode == MaterialPreparationMode::DownloadOnly {
            return Ok(());
        }
    }

    let has_local_downloads = has_video_files(&shot_raw_directory);
    if !has_local_downloads {
        bail!(
            "分镜 {}（{}）没有可用本地素材；请检查绑定文件是否存在或重新设置素材范围",
            shot.shot_id,
            shot.title
        );
    }

    report_progress(
        progress,
        "indexing",
        |progress| format!("索引素材 {}/{}", progress.current + 1, progress.total),
        &mut reporter,
    );
    normalize_downloads_for_index(paths, &shot_raw_directory, &shot_index_directory)?;

    if !has_video_files(&shot_index_directory) {
        bail!(
            "shot {} ({}) has no material that can be normalized for indexing",
            shot.shot_id,
            shot.title
        );
    }

    if let Err(error) = clean_missing_material_index(paths) {
        let warning = format!("清理失效素材索引失败，将继续执行: {error:#}");
        eprintln!("[警告] {warning}");
        log_line(warning);
    }

    if !skip_index {
        run_sentry_os(
            paths,
            [
                OsString::from("index"),
                shot_index_directory.as_os_str().to_os_string(),
                OsString::from("--backend"),
                OsString::from("qwen-cloud"),
                OsString::from("--chunk-duration"),
                OsString::from(config.chunk_duration.to_string()),
            ],
        )?;
    } else {
        println!("跳过索引");
    }

    Ok(())
}

pub(crate) fn create_shot_clips(
    context: &MaterialClipContext<'_>,
    shot: &Shot,
) -> Result<Vec<PathBuf>> {
    let workspace = prepare_shot_workspace(context.run_raw, context.run_clips, shot)?;
    let shot_clip_directory = workspace.clip_directory.clone();

    remove_fallback_clip(&shot_clip_directory)?;

    let exclude_overlays = policy_enabled("MATERIAL_EXCLUDE_OVERLAYS");
    let random_bound =
        policy_enabled("MATERIAL_RANDOM_BOUND_FALLBACK") && !shot_needs_download(shot);
    let (best_score, clip_paths) = search_and_save_matches(
        context.paths,
        &shot.visual_query,
        context.config.results_per_shot,
        if exclude_overlays {
            context
                .config
                .results_per_shot
                .max(context.config.clips_per_shot)
        } else {
            context.config.clips_per_shot
        },
        &workspace.index_directory,
        &shot_clip_directory,
        context.config.match_accept_threshold,
    )
    .with_context(|| {
        format!(
            "shot {} ({}) material matching failed",
            shot.shot_id, shot.title
        )
    })?;

    // The search tool filters each candidate against the full precision threshold
    // before exporting clips; fail closed if an incompatible tool returns no score.
    if !clip_paths.is_empty()
        && !best_score
            .is_some_and(|score| score + 0.000001 >= context.config.match_accept_threshold)
    {
        bail!(
            "分镜 {}（{}）没有可验证的合格匹配分数，停止使用候选片段",
            shot.shot_id,
            shot.title
        );
    }
    if exclude_overlays || (random_bound && clip_paths.is_empty()) {
        return apply_material_selection_policy(
            context,
            shot,
            &workspace,
            &clip_paths,
            exclude_overlays,
            random_bound,
        );
    }
    if clip_paths.is_empty() {
        bail!(
            "分镜 {}（{}）没有达到素材匹配最低分 {:.2} 的片段；请调整素材范围或最低分，也可启用指定范围随机兜底",
            shot.shot_id,
            shot.title,
            context.config.match_accept_threshold
        );
    }

    Ok(clip_paths)
}

fn policy_enabled(key: &str) -> bool {
    env::var(key).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        )
    })
}

fn apply_material_selection_policy(
    context: &MaterialClipContext<'_>,
    shot: &Shot,
    workspace: &ShotWorkspace,
    clips: &[PathBuf],
    exclude_overlays: bool,
    random_bound: bool,
) -> Result<Vec<PathBuf>> {
    let (python, _) = context
        .paths
        .sentry_py
        .as_ref()
        .ok_or_else(|| anyhow!("找不到素材筛选所需的内置 Python"))?;
    let request_path = workspace
        .clip_directory
        .join("material-policy-request.json");
    let report_path = workspace.clip_directory.join("material-policy-report.json");
    let cache_root = context
        .paths
        .data_root
        .join("config/material-visual-review");
    crate::persistence::write_json_pretty_atomic(
        &request_path,
        &serde_json::json!({
            "clip_root": workspace.clip_directory, "paths": clips, "cache_root": cache_root,
            "count": context.config.clips_per_shot, "duration": shot.duration.unwrap_or(4),
            "shot_id": shot.shot_id, "exclude_overlays": exclude_overlays,
            "random_bound_fallback": random_bound,
            "bound_root": if random_bound { Some(&workspace.index_directory) } else { None },
        }),
    )?;
    let mut command = Command::new(python);
    add_child_env(&mut command, context.paths);
    command
        .arg(
            context
                .paths
                .root
                .join("tools/material_selection_policy.py"),
        )
        .arg("--request")
        .arg(&request_path)
        .arg("--output")
        .arg(&report_path);
    run_command(&mut command, "素材画面筛选与兜底")?;
    let report: serde_json::Value = serde_json::from_slice(&fs::read(&report_path)?)?;
    let items = report["paths"]
        .as_array()
        .ok_or_else(|| anyhow!("素材筛选未返回片段路径"))?;
    if report["ok"] != true || items.is_empty() {
        bail!("素材筛选后没有可用片段，请检查 material-policy-report.json 中的具体原因");
    }
    items
        .iter()
        .map(|value| {
            let path = value
                .as_str()
                .ok_or_else(|| anyhow!("素材筛选返回了无效路径"))?;
            checked_clip_path(&workspace.clip_directory, Path::new(path))
        })
        .collect()
}

fn fallback_clip_path(shot_clip_directory: &Path) -> PathBuf {
    shot_clip_directory.join(FALLBACK_CLIP_FILE_NAME)
}

fn remove_fallback_clip(shot_clip_directory: &Path) -> Result<()> {
    let fallback = fallback_clip_path(shot_clip_directory);
    if fallback.exists() {
        fs::remove_file(&fallback)
            .with_context(|| format!("删除旧兜底素材失败: {}", fallback.display()))?;
    }
    Ok(())
}

fn search_and_save_matches(
    paths: &AppPaths,
    visual_query: &str,
    results_per_shot: usize,
    clips_per_shot: usize,
    allowed_source_root: &Path,
    shot_clip_directory: &Path,
    minimum_score: f32,
) -> Result<(Option<f32>, Vec<PathBuf>)> {
    let mut command = make_sentry_command(paths);
    add_child_env(&mut command, paths);
    command.env("VIDEOAUTO_MIN_MATCH_SCORE", minimum_score.to_string());

    command
        .arg("search")
        .arg(visual_query)
        .arg("--backend")
        .arg("qwen-cloud")
        .arg("--results")
        .arg(results_per_shot.to_string())
        .arg("--save-top")
        .arg(clips_per_shot.to_string())
        .arg("--source-root")
        .arg(allowed_source_root)
        .arg("--threshold")
        // 这里设为 0 是为了不再弹出 y/N；是否采用结果由 Rust 按阈值判断。
        .arg("0.0")
        .arg("--verbose")
        .arg("--output-dir")
        .arg(shot_clip_directory);

    let timeout_seconds = env::var("SENTRY_SEARCH_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(120)
        .max(10);
    let output = run_command_capture_timeout(
        &mut command,
        "sentrysearch search",
        Duration::from_secs(timeout_seconds),
    )?;

    let best = parse_best_similarity(&output);
    if let Some(score) = best {
        println!("SentrySearch 最佳匹配分数: {score:.2}");
        log_line(format!("SentrySearch 最佳匹配分数: {score:.2}"));
    } else {
        println!("[警告] SentrySearch 没有解析到匹配分数。");
    }

    let clip_paths = parse_saved_clip_paths(&output, shot_clip_directory)?;
    Ok((best, clip_paths))
}

pub(crate) fn parse_saved_clip_paths(output: &str, clip_directory: &Path) -> Result<Vec<PathBuf>> {
    #[derive(serde::Deserialize)]
    struct SavedClips {
        schema_version: u32,
        paths: Vec<PathBuf>,
    }
    let mut records = output
        .lines()
        .filter_map(|line| line.strip_prefix("VACUT_CLIPS:"));
    let record = records.next().ok_or_else(|| {
        anyhow!(
            "剪辑工具未返回实际文件路径，不能使用目录中的旧文件。请确认引擎与剪辑工具来自同一运行包"
        )
    })?;
    if records.next().is_some() {
        bail!("剪辑工具返回了重复的路径结果");
    }
    let result: SavedClips = serde_json::from_str(record).context("剪辑工具返回的路径结果无效")?;
    if result.schema_version != 1 {
        bail!("不支持的剪辑路径协议版本: {}", result.schema_version);
    }
    let mut seen = HashSet::new();
    result
        .paths
        .into_iter()
        .map(|path| {
            if !path.is_absolute() {
                bail!("剪辑工具返回的路径不是绝对路径: {}", path.display());
            }
            let actual = checked_clip_path(clip_directory, &path)?;
            if !seen.insert(actual.clone()) {
                bail!("剪辑工具返回了重复的文件路径");
            }
            Ok(actual)
        })
        .collect()
}

fn parse_best_similarity(output: &str) -> Option<f32> {
    BEST_SIMILARITY_PATTERN
        .captures(output)?
        .get(1)?
        .as_str()
        .parse::<f32>()
        .ok()
        .filter(|score| score.is_finite())
}

fn video_files_in_dir(directory: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(directory)
        .min_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| {
            matches!(
                path.extension()
                    .and_then(OsStr::to_str)
                    .map(|extension| extension.to_lowercase())
                    .as_deref(),
                Some("mp4" | "webm" | "mkv" | "mov")
            )
        })
        .filter(|path| {
            !path.components().any(|component| {
                ["_indexed_h264", "_indexed_h264_stale"]
                    .iter()
                    .any(|name| component.as_os_str() == *name)
            })
        })
        .collect();

    files.sort();
    files
}

fn normalize_downloads_for_index(
    paths: &AppPaths,
    input_directory: &Path,
    index_directory: &Path,
) -> Result<()> {
    fs::create_dir_all(index_directory)?;
    let actual_input = fs::canonicalize(input_directory)?;
    let actual_index = fs::canonicalize(index_directory)?;
    if actual_index.parent() != Some(actual_input.as_path())
        || actual_index
            .file_name()
            .is_none_or(|name| name != "_indexed_h264")
    {
        bail!("标准化索引目录不属于当前素材工作目录");
    }

    let files = video_files_in_dir(input_directory);
    if files.is_empty() {
        archive_stale_normalized(input_directory, index_directory, &HashSet::new())?;
        return Ok(());
    }
    let cache = NormalizationCache::new(paths)?;

    println!(
        "\n正在为 SentrySearch 标准化下载视频: {} 个文件",
        files.len()
    );

    let mut expected = HashSet::new();
    for (index, input) in files.iter().enumerate() {
        let stem = input
            .file_stem()
            .and_then(OsStr::to_str)
            .map(sanitize)
            .unwrap_or_else(|| format!("video_{:03}", index + 1));
        let output = index_directory.join(format!("{:03}_{stem}.mp4", index + 1));
        expected.insert(output.file_name().unwrap().to_string_lossy().to_lowercase());

        let outcome = cache.normalize(paths, input, &output)?;
        crate::emit_workflow_event(
            "clip",
            "running",
            if outcome.created {
                "normalized"
            } else {
                "normalization-reused"
            },
            Some(index + 1),
            Some(files.len()),
            format!("标准化素材 {}/{}", index + 1, files.len()),
        );
    }
    archive_stale_normalized(input_directory, index_directory, &expected)?;

    Ok(())
}

fn archive_stale_normalized(input: &Path, index: &Path, expected: &HashSet<String>) -> Result<()> {
    let input = fs::canonicalize(input)?;
    let index = fs::canonicalize(index)?;
    if index.parent() != Some(input.as_path())
        || index.file_name().is_none_or(|name| name != "_indexed_h264")
    {
        bail!("标准化索引目录不属于当前素材工作目录");
    }
    let stale: Vec<_> = fs::read_dir(&index)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let path = entry.path();
            !expected.contains(&entry.file_name().to_string_lossy().to_lowercase())
                && path.extension().is_some_and(|extension| {
                    ["mp4", "mov", "mkv", "webm", "avi", "m4v"]
                        .iter()
                        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                })
        })
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    let archive = input.join("_indexed_h264_stale");
    fs::create_dir_all(&archive)?;
    let archive = fs::canonicalize(archive)?;
    if archive.parent() != Some(input.as_path()) {
        bail!("旧索引归档目录超出当前素材工作目录");
    }
    for entry in stale {
        if !entry.file_type()?.is_file() && !entry.file_type()?.is_symlink() {
            continue;
        }
        let source = entry.path();
        let destination = archive.join(format!(
            "{}-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            entry.file_name().to_string_lossy()
        ));
        fs::rename(&source, &destination)?;
        let sidecar = source.with_file_name(format!(
            "{}.source.json",
            entry.file_name().to_string_lossy()
        ));
        if fs::symlink_metadata(&sidecar)
            .is_ok_and(|metadata| metadata.is_file() || metadata.file_type().is_symlink())
        {
            let target = destination.with_file_name(format!(
                "{}.source.json",
                destination.file_name().unwrap().to_string_lossy()
            ));
            fs::rename(sidecar, target)?;
        }
    }
    Ok(())
}

fn make_sentry_command(paths: &AppPaths) -> Command {
    if let Some((python, entry)) = &paths.sentry_py {
        let mut command = Command::new(python);
        command.arg(entry);
        command
    } else {
        Command::new(&paths.sentrysearch)
    }
}

fn run_sentry<'a, I>(paths: &AppPaths, args: I) -> Result<()>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut command = make_sentry_command(paths);
    add_child_env(&mut command, paths);
    for argument in args {
        command.arg(argument);
    }
    run_command(&mut command, "sentrysearch")
}

fn index_input_file_count(input: &Path) -> usize {
    // Count the actual Sentry input, including _indexed_h264; raw discovery deliberately excludes it.
    // Keep these extensions aligned with sentrysearch.chunker.SUPPORTED_VIDEO_EXTENSIONS.
    WalkDir::new(input)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("mov")
                })
        })
        .count()
}

fn run_sentry_os<I>(paths: &AppPaths, args: I) -> Result<()>
where
    I: IntoIterator<Item = OsString>,
{
    let mut command = make_sentry_command(paths);
    add_child_env(&mut command, paths);
    let arguments: Vec<OsString> = args.into_iter().collect();
    command.args(&arguments);
    if arguments
        .first()
        .is_some_and(|argument| argument == OsStr::new("index"))
    {
        let files = arguments
            .get(1)
            .map(|directory| index_input_file_count(Path::new(directory)))
            .unwrap_or(1);
        return run_index_streaming(
            &mut command,
            "sentrysearch index",
            IndexBudget::configured(files),
        );
    }
    run_command(&mut command, "sentrysearch")
}

pub(crate) fn clean_missing_material_index(paths: &AppPaths) -> Result<()> {
    run_sentry(paths, ["clean-missing", "--backend", "qwen-cloud"])
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
                "video_auto_material_clip_{label}_{}_{nonce}",
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

    #[test]
    fn index_budget_counts_normalized_files_and_nested_supported_inputs() {
        let directory = TestDirectory::new("index-count");
        let index = directory.0.join("_indexed_h264");
        fs::create_dir_all(index.join("nested")).unwrap();
        for name in [
            "one.mp4",
            "two.MOV",
            "nested/three.mp4",
            "metadata.json",
            "ignored.mkv",
        ] {
            fs::write(index.join(name), b"fixture").unwrap();
        }
        assert_eq!(video_files_in_dir(&index).len(), 0);
        assert_eq!(index_input_file_count(&index), 3);
        assert_eq!(index_input_file_count(&index.join("one.mp4")), 1);
        assert_eq!(index_input_file_count(&directory.0.join("missing")), 0);
    }

    #[test]
    fn stale_normalized_projections_are_archived_outside_search_and_never_become_raw_candidates() {
        let directory = TestDirectory::new("stale-normalized");
        let raw = directory.0.join("raw");
        let index = raw.join("_indexed_h264");
        fs::create_dir_all(&index).unwrap();
        fs::write(raw.join("original.mp4"), b"original").unwrap();
        fs::write(index.join("current.mp4"), b"current").unwrap();
        fs::write(index.join("old.mp4"), b"old projection").unwrap();
        fs::write(index.join("old.mp4.source.json"), b"old provenance").unwrap();
        archive_stale_normalized(&raw, &index, &HashSet::from(["current.mp4".to_string()]))
            .unwrap();
        assert!(index.join("current.mp4").is_file());
        assert!(!index.join("old.mp4").exists());
        assert!(!index.join("old.mp4.source.json").exists());
        assert_eq!(
            fs::read_dir(raw.join("_indexed_h264_stale"))
                .unwrap()
                .count(),
            2
        );
        assert_eq!(video_files_in_dir(&raw), vec![raw.join("original.mp4")]);
        assert_eq!(fs::read(raw.join("original.mp4")).unwrap(), b"original");
        assert!(archive_stale_normalized(&directory.0, &index, &HashSet::new()).is_err());
        assert!(index.join("current.mp4").is_file());
        archive_stale_normalized(&raw, &index, &HashSet::new()).unwrap();
        assert!(!index.join("current.mp4").exists());
    }

    #[test]
    fn parses_best_similarity_from_ranked_output() {
        let output = "header\n  #1 [0.873] clip-a.mp4\n#2 [0.421] clip-b.mp4";

        assert_eq!(parse_best_similarity(output), Some(0.873));
        assert_eq!(parse_best_similarity("no ranked result"), None);
    }

    #[test]
    fn rejects_non_finite_similarity_values() {
        let huge_number = "9".repeat(500);
        let output = format!("#1 [{huge_number}] clip.mp4");

        assert_eq!(parse_best_similarity(&output), None);
    }

    #[test]
    fn saved_paths_use_only_current_results_in_rank_order() {
        let directory = TestDirectory::new("actual_paths");
        let first = directory.0.join("z_中文.MP4");
        let second = directory.0.join("a.mp4");
        for path in [&first, &second, &directory.0.join("000_stale.mp4")] {
            fs::write(path, b"video").unwrap();
        }
        let output = format!(
            "Saved clip: ignored.mp4\nVACUT_CLIPS:{}\n",
            serde_json::json!({
                "schema_version": 1, "paths": [first, second]
            })
        );
        let paths = parse_saved_clip_paths(&output, &directory.0).unwrap();
        assert_eq!(
            paths,
            vec![
                fs::canonicalize(first).unwrap(),
                fs::canonicalize(second).unwrap()
            ]
        );
        assert!(parse_saved_clip_paths("Saved clip: old.mp4", &directory.0).is_err());
        assert!(parse_saved_clip_paths(&(output.clone() + &output), &directory.0).is_err());
        assert!(parse_saved_clip_paths("VACUT_CLIPS:broken", &directory.0).is_err());
        assert!(
            parse_saved_clip_paths(
                "VACUT_CLIPS:{\"schema_version\":1,\"paths\":[\"relative.mp4\"]}",
                &directory.0
            )
            .is_err()
        );
        assert!(
            parse_saved_clip_paths(
                "VACUT_CLIPS:{\"schema_version\":1,\"paths\":[]}",
                &directory.0
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn produced_workspace_paths_round_trip_through_manifest_to_composer() {
        let directory = TestDirectory::new("clip_handoff");
        let raw = directory.0.join("分镜视频");
        let clips = directory.0.join("run_test/clips");
        fs::create_dir_all(&clips).unwrap();
        let plan: ShotPlan = serde_json::from_value(serde_json::json!({
            "topic":"贯通测试", "shots":[{"shot_id":"stable-id", "shot":101, "title":"真实标题 / 含特殊字符"}]
        })).unwrap();
        let shot = &plan.shots[0];
        let workspace = prepare_shot_workspace(&raw, &clips, shot).unwrap();
        let actual = workspace.clip_directory.join("z_actual.mp4");
        fs::write(&actual, b"video").unwrap();
        fs::write(workspace.clip_directory.join("a_stale.mp4"), b"old video").unwrap();
        let result = format!(
            "VACUT_CLIPS:{}",
            serde_json::json!({"schema_version":1,"paths":[actual]})
        );
        let paths = parse_saved_clip_paths(&result, &workspace.clip_directory).unwrap();
        let mut manifest = crate::clip_manifest::ClipManifest::start(&clips, &plan).unwrap();
        manifest.record(&clips, shot, paths).unwrap();
        assert_eq!(
            crate::clip_manifest::resolve_clips(&clips, &plan).unwrap(),
            vec![fs::canonicalize(actual).unwrap()]
        );
    }

    #[test]
    fn shot_workspace_groups_materials_by_dynamic_storyboard_title() {
        let directory = TestDirectory::new("direct_task_materials");
        let clips = directory
            .0
            .join(".videoautocut")
            .join("run_test")
            .join("clips");
        let shot: Shot = serde_json::from_value(serde_json::json!({
            "shot": 1,
            "shot_id": "shot_1",
            "title": "开场"
        }))
        .expect("deserialize shot");

        let workspace =
            prepare_shot_workspace(&directory.0, &clips, &shot).expect("prepare shot workspace");

        assert_eq!(workspace.raw_directory, directory.0.join("01 · 开场"));
        assert_eq!(
            workspace.index_directory,
            directory.0.join("01 · 开场").join("_indexed_h264")
        );
        assert!(workspace.clip_directory.ends_with("01 · 开场"));
        assert!(
            workspace
                .raw_directory
                .join(SHOT_METADATA_FILE_NAME)
                .is_file()
        );

        let renamed_shot: Shot = serde_json::from_value(serde_json::json!({
            "shot": 2,
            "shot_id": "shot_1",
            "title": "更新后的标题"
        }))
        .expect("deserialize renamed shot");
        let renamed = prepare_shot_workspace(&directory.0, &clips, &renamed_shot)
            .expect("rename shot workspace");
        assert_eq!(renamed.raw_directory, directory.0.join("02 · 更新后的标题"));
        assert!(!directory.0.join("01 · 开场").exists());
    }

    #[test]
    fn recursive_video_files_exclude_generated_index_and_remain_sorted() {
        let directory = TestDirectory::new("recursive_files");
        fs::write(directory.0.join("root.webm"), b"video").expect("write root video");
        fs::create_dir_all(directory.0.join("nested")).expect("create nested directory");
        fs::write(directory.0.join("nested").join("clip.mov"), b"video")
            .expect("write nested video");
        fs::write(directory.0.join("nested").join("notes.txt"), b"notes").expect("write text file");
        fs::create_dir_all(directory.0.join("_indexed_h264")).expect("create index directory");
        fs::write(
            directory.0.join("_indexed_h264").join("generated.mp4"),
            b"video",
        )
        .expect("write indexed video");

        let files = video_files_in_dir(&directory.0);

        assert_eq!(files.len(), 2);
        assert!(files.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(
            files
                .iter()
                .all(|path| !path.to_string_lossy().contains("_indexed_h264"))
        );
        assert!(files.iter().any(|path| path.ends_with("root.webm")));
        assert!(
            files
                .iter()
                .any(|path| path.ends_with(Path::new("nested").join("clip.mov")))
        );
    }

    #[test]
    fn fallback_path_uses_reserved_last_sorting_name() {
        let directory = Path::new("clips").join("shot_001");

        assert_eq!(
            fallback_clip_path(&directory),
            directory.join("zzzz_fallback_material.mp4")
        );
    }

    #[test]
    fn rejects_conflicting_download_and_material_bindings() {
        let plan: ShotPlan = serde_json::from_value(serde_json::json!({
            "schema_version": 2,
            "task_revision": 1,
            "topic": "test",
            "shots": [{
                "shot": 1,
                "shot_id": "shot_1",
                "title": "test",
                "download_material": true,
                "material_bindings": [{
                    "binding_type": "material",
                    "material_id": "mat_1"
                }]
            }]
        }))
        .expect("deserialize plan");

        let error = validate_material_contract(&plan, None, true)
            .expect_err("conflicting material mode must fail");
        assert!(error.to_string().contains("material_bindings"));
    }

    #[test]
    fn stages_only_hash_verified_manifest_materials() {
        let directory = TestDirectory::new("manifest");
        let source = directory.0.join("source.mp4");
        fs::write(&source, b"verified-video").expect("write source");
        let source_sha256 = compute_sha256(&source).expect("hash source");
        let plan: ShotPlan = serde_json::from_value(serde_json::json!({
            "schema_version": 2,
            "task_revision": 4,
            "topic": "test",
            "shots": [{
                "shot": 1,
                "shot_id": "shot_1",
                "title": "test",
                "download_material": false,
                "material_bindings": [{
                    "binding_type": "material",
                    "material_id": "mat_1"
                }]
            }]
        }))
        .expect("deserialize plan");
        let manifest = GenerationMaterialManifest {
            schema_version: 1,
            run_id: "run_test".to_string(),
            task_id: "task_1".to_string(),
            task_revision: 4,
            resolved_at: "2026-07-31T00:00:00Z".to_string(),
            shots: vec![crate::models::GenerationManifestShot {
                shot_id: "shot_1".to_string(),
                materials: vec![crate::models::GenerationManifestItem {
                    material_id: "mat_1".to_string(),
                    asset_id: "asset_1".to_string(),
                    asset_version: 1,
                    source_sha256,
                    local_path: source.clone(),
                }],
            }],
        };
        let run_raw = directory.0.join("raw");
        let run_clips = directory.0.join("clips");

        stage_manifest_materials(&run_raw, &run_clips, &plan, &manifest)
            .expect("stage verified material");
        assert!(video_files_in_dir(&run_raw).len() == 1);

        fs::write(&source, b"changed-video").expect("change source");
        let error = stage_manifest_materials(&run_raw, &run_clips, &plan, &manifest)
            .expect_err("changed source must fail");
        assert!(error.to_string().contains("SHA-256"));
    }
}
