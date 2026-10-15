use anyhow::{Context, Result, anyhow, bail};
use sanitize_filename::sanitize;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::clip_manifest::resolve_clips;
use crate::domain::{shot_needs_voice, shot_voice_text};
use crate::models::{AppPaths, RunConfig, Shot, ShotPlan};
use crate::paths::add_child_env;
use crate::process::{run_command, run_command_capture_timeout};
use crate::video_encoder::{force_cpu_encoder, selected_video_encoder};

pub(crate) struct FinalVideoContext<'a> {
    pub(crate) paths: &'a AppPaths,
    pub(crate) plan: &'a ShotPlan,
    pub(crate) clips_root: &'a Path,
    pub(crate) norm_directory: &'a Path,
    pub(crate) voice_directory: &'a Path,
    pub(crate) final_clips_directory: &'a Path,
    pub(crate) final_file: &'a Path,
    pub(crate) config: &'a RunConfig,
}

struct SegmentRenderContext<'a> {
    paths: &'a AppPaths,
    clip: &'a Path,
    shot: &'a Shot,
    index: usize,
    progress_labels: &'a [String],
    voice_directory: &'a Path,
    output: &'a Path,
    config: &'a RunConfig,
}

fn concat_list_entry(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let escaped = normalized.replace('\'', r"'\''");
    format!("file '{escaped}'")
}

pub(crate) fn concat_final_video(context: FinalVideoContext<'_>) -> Result<()> {
    let FinalVideoContext {
        paths,
        plan,
        clips_root,
        norm_directory,
        voice_directory,
        final_clips_directory,
        final_file,
        config,
    } = context;

    let ffmpeg = paths.ffmpeg.as_ref().ok_or_else(|| {
        anyhow!("找不到 ffmpeg.exe。请放到 VideoAuto/ffmpeg/bin，或加入系统 PATH")
    })?;

    fs::create_dir_all(norm_directory)?;
    fs::create_dir_all(voice_directory)?;
    fs::create_dir_all(final_clips_directory)?;

    let clips = resolve_clips(clips_root, plan)?;
    let ffprobe = ffmpeg.with_file_name(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
    for (shot, clip) in plan.shots.iter().zip(&clips) {
        verify_video_clip(&ffprobe, clip)
            .with_context(|| format!("分镜 #{} ({}) 的剪辑无法用于合成", shot.shot, shot.title))?;
    }

    println!("\n正在合成最终视频，片段数: {}", clips.len());

    let mut final_segments = Vec::new();
    let progress_labels: Vec<String> = plan.shots.iter().map(progress_module_label).collect();

    for (index, (shot, clip)) in plan.shots.iter().zip(&clips).enumerate() {
        let output = final_clips_directory.join(format!("{:04}_final.mp4", index + 1));
        render_shot_segment_with_script(&SegmentRenderContext {
            paths,
            clip,
            shot,
            index,
            progress_labels: &progress_labels,
            voice_directory,
            output: &output,
            config,
        })?;

        final_segments.push(output);
    }

    if final_segments.is_empty() {
        bail!(
            "没有渲染成功的片段可用于合成: {}",
            final_clips_directory.display()
        );
    }

    let temporary_directory = final_clips_directory
        .parent()
        .unwrap_or(&paths.data_root)
        .join("temp")
        .join("concat");
    fs::create_dir_all(&temporary_directory)?;

    let final_stem = final_file
        .file_stem()
        .and_then(OsStr::to_str)
        .map(sanitize)
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "final".to_string());
    let list_path = temporary_directory.join(format!(
        "{}_{}_concat_list.txt",
        final_stem,
        std::process::id()
    ));

    let mut list_file = File::create(&list_path)?;
    for segment in &final_segments {
        writeln!(list_file, "{}", concat_list_entry(segment))?;
    }
    list_file.flush()?;
    drop(list_file);

    let mut command = Command::new(ffmpeg);
    command
        .arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&list_path)
        .arg("-c")
        .arg("copy")
        .arg(final_file);

    run_command(&mut command, "ffmpeg concat")?;

    println!("\n最终视频: {}", final_file.display());
    Ok(())
}

fn verify_video_clip(ffprobe: &Path, clip: &Path) -> Result<()> {
    let output = run_command_capture_timeout(
        Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_type:format=duration",
                "-of",
                "json",
            ])
            .arg(clip),
        "ffprobe clip preflight",
        std::time::Duration::from_secs(30),
    )?;
    let info: serde_json::Value = serde_json::from_str(&output).context("读取剪辑媒体信息失败")?;
    let has_video = info["streams"]
        .as_array()
        .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video"));
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok());
    if !has_video || !duration.is_some_and(|value| value.is_finite() && value > 0.0) {
        bail!("剪辑缺少可读取的视频流或有效时长: {}", clip.display());
    }
    Ok(())
}

fn render_shot_segment_with_script(context: &SegmentRenderContext<'_>) -> Result<()> {
    let SegmentRenderContext {
        paths,
        clip,
        shot,
        index,
        progress_labels,
        voice_directory,
        output,
        config,
    } = *context;

    let (python, _) = paths
        .sentry_py
        .as_ref()
        .ok_or_else(|| anyhow!("找不到用于 tools/render_segment.py 的内置 Python"))?;

    let script = paths.root.join("tools").join("render_segment.py");
    if !script.exists() {
        bail!("缺少统一片段渲染脚本: {}", script.display());
    }

    let voice_output = voice_directory.join(format!("{:04}_voice.mp3", index + 1));
    let subtitle = segment_subtitle(shot, config.voiceover);
    let voice_text = shot_voice_text(shot).unwrap_or("");
    let modules = progress_labels.join("|");
    let duration = shot.duration.unwrap_or(4).max(1).to_string();

    let fallback_file = voice_directory
        .parent()
        .unwrap_or(voice_directory)
        .join("temp")
        .join("video-encoder-fallback.flag");
    let mut encoder = selected_video_encoder(paths);
    if fallback_file.exists() {
        force_cpu_encoder(encoder, "前一个分镜已触发硬件编码回退");
        encoder = selected_video_encoder(paths);
    }

    let mut command = Command::new(python);
    add_child_env(&mut command, paths);
    command
        .env("VIDEOAUTO_VIDEO_ENCODER_RESOLVED", encoder.key())
        .env("VIDEOAUTO_VIDEO_ENCODER_FALLBACK_FILE", &fallback_file);

    if let Some(run_directory) = voice_directory.parent() {
        command.env("VIDEOAUTO_TEMP_DIR", run_directory.join("temp"));
    }
    command
        .arg(script)
        .arg("--clip")
        .arg(clip)
        .arg("--output")
        .arg(output)
        .arg("--duration")
        .arg(duration)
        .arg("--subtitle")
        .arg(subtitle)
        .arg("--voice-text")
        .arg(voice_text)
        .arg("--voice-output")
        .arg(voice_output)
        .arg("--modules")
        .arg(modules)
        .arg("--current")
        .arg((index + 1).to_string())
        .arg("--shots-json")
        .arg(
            voice_directory
                .parent()
                .unwrap_or(voice_directory)
                .join("shots.json"),
        )
        .arg("--shot-index")
        .arg((index + 1).to_string())
        .arg("--no-cards");

    if !config.voiceover || !shot_needs_voice(shot) {
        command.arg("--no-voiceover");
    } else {
        command.arg("--require-prepared-voice");
    }
    if !config.subtitles {
        command.arg("--no-subtitles");
    }
    if !config.progress_bar {
        command.arg("--no-progress");
    }

    let result = run_command(&mut command, "python render_segment");
    if fallback_file.exists() {
        force_cpu_encoder(encoder, "分镜渲染触发了 CPU 回退");
    }
    result
}

fn segment_subtitle(shot: &Shot, voiceover: bool) -> &str {
    // Spoken captions follow the narration. The script's subtitle can be a
    // separate screen summary and is used for segments without narration.
    if voiceover {
        if let Some(text) = shot_voice_text(shot) {
            return text;
        }
    }
    shot.subtitle
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .or(shot.voice_text.as_deref())
        .unwrap_or("")
}

fn progress_module_label(shot: &Shot) -> String {
    shot.module_label
        .as_deref()
        .or(Some(shot.title.as_str()))
        .map(clean_progress_label)
        .unwrap_or_else(|| shot.title.clone())
}

fn clean_progress_label(value: &str) -> String {
    let mut text = value.trim().to_string();

    if let Some((position, separator_length)) = text
        .find('：')
        .map(|position| (position, '：'.len_utf8()))
        .or_else(|| text.find(':').map(|position| (position, ':'.len_utf8())))
    {
        let prefix = &text[..position];
        if prefix.chars().count() <= 12 {
            text = text[position + separator_length..].trim().to_string();
        }
    }

    if let Some(position) = text
        .find('，')
        .or_else(|| text.find(','))
        .or_else(|| text.find('；'))
        .or_else(|| text.find(';'))
    {
        text = text[..position].trim().to_string();
    }

    // The renderer fits labels using the selected font and available pixels.
    // Character cuts here can destroy English words before layout sees them.
    let cleaned: String = text.chars().filter(|c| !c.is_control()).collect();
    if cleaned.trim().is_empty() {
        "分镜".to_string()
    } else {
        cleaned.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir().join(format!(
                "video_auto_final_video_{label}_{}_{nonce}",
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
    #[ignore = "requires VIDEOAUTO_TEST_RUNTIME, VIDEOAUTO_TEST_RUN and a new VIDEOAUTO_TEST_OUTPUT directory"]
    fn real_task_copy_composes_from_legacy_and_recorded_paths() {
        use clap::Parser;

        fn copy_tree(source: &Path, target: &Path) {
            fs::create_dir_all(target).unwrap();
            for entry in fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                assert!(!kind.is_symlink());
                let output = target.join(entry.file_name());
                if kind.is_dir() {
                    copy_tree(&entry.path(), &output);
                } else {
                    fs::copy(entry.path(), output).unwrap();
                }
            }
        }

        let runtime =
            PathBuf::from(std::env::var_os("VIDEOAUTO_TEST_RUNTIME").expect("runtime required"));
        let source =
            PathBuf::from(std::env::var_os("VIDEOAUTO_TEST_RUN").expect("source run required"));
        let output = PathBuf::from(
            std::env::var_os("VIDEOAUTO_TEST_OUTPUT").expect("new output directory required"),
        );
        fs::create_dir(&output).expect("test output must not already exist");
        let run = output.join(source.file_name().unwrap());
        fs::create_dir(&run).unwrap();
        copy_tree(&source.join("clips"), &run.join("clips"));
        copy_tree(&source.join("voice"), &run.join("voice"));
        fs::copy(source.join("shots.json"), run.join("shots.json")).unwrap();
        let plan: ShotPlan =
            serde_json::from_str(&fs::read_to_string(run.join("shots.json")).unwrap()).unwrap();
        for (index, shot) in plan.shots.iter().enumerate() {
            if shot_needs_voice(shot) {
                assert!(
                    fs::metadata(
                        run.join("voice")
                            .join(format!("{:04}_voice.mp3", index + 1))
                    )
                    .unwrap()
                    .len()
                        > 1024,
                    "all voices must be cached; this test must not synthesize audio"
                );
            }
        }
        let paths = AppPaths {
            root: runtime.clone(),
            data_root: output.clone(),
            env_path: output.join("test.env"),
            yt_dlp: runtime.join("yt-dlp.exe"),
            sentrysearch: runtime.join("sentrysearch/sentrysearch.exe"),
            sentry_py: Some((
                runtime.join("python-3.11.9-embed-amd64/python.exe"),
                runtime.join("sentrysearch/sentrysearch_entry.py"),
            )),
            ffmpeg: Some(runtime.join("ffmpeg/bin/ffmpeg.exe")),
            node: None,
            runs_dir: output.clone(),
            archive: output.join("downloaded.txt"),
        };
        let mut config =
            crate::config::config_from_env_and_cli(&crate::cli::Cli::parse_from(["test"])).unwrap();
        config.bgm_enabled = false;
        config.voiceover = true;
        config.subtitles = true;
        config.progress_bar = true;
        let ffprobe = runtime.join("ffmpeg/bin/ffprobe.exe");
        let clips = resolve_clips(&run.join("clips"), &plan).unwrap();
        assert_eq!(clips.len(), plan.shots.len());
        // Reload from the persisted manifest, after the legacy import has completed.
        assert_eq!(resolve_clips(&run.join("clips"), &plan).unwrap(), clips);
        if std::env::var("VIDEOAUTO_TEST_RETRIM").as_deref() == Ok("1") {
            let source_package =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../VideoAutoCut/sentrysearch");
            let python = &paths.sentry_py.as_ref().unwrap().0;
            let mut manifest =
                crate::clip_manifest::ClipManifest::start(&run.join("clips"), &plan).unwrap();
            for (index, (shot, source_clip)) in plan.shots.iter().zip(&clips).enumerate() {
                let target = run.join("clips").join(format!("by-id-{}", index + 1));
                fs::create_dir(&target).unwrap();
                let mut command = Command::new(python);
                add_child_env(&mut command, &paths);
                command
                    .arg("-c")
                    .arg(
                        r#"
import sys, importlib
sys.path.insert(0, sys.argv[1])
cli = importlib.import_module('sentrysearch.cli')
cli._cache_last_clip = lambda path: None
from sentrysearch.chunker import _get_video_duration
cli._present_results([{'source_file':sys.argv[2], 'start_time':0,
    'end_time':_get_video_duration(sys.argv[2]), 'similarity_score':0.9}],
    0.0, True, 1, sys.argv[3], False, False, False)
"#,
                    )
                    .arg(&source_package)
                    .arg(source_clip)
                    .arg(&target);
                let output = run_command_capture_timeout(
                    &mut command,
                    "real clip producer",
                    std::time::Duration::from_secs(120),
                )
                .unwrap();
                let actual =
                    crate::material_clip::parse_saved_clip_paths(&output, &target).unwrap();
                manifest.record(&run.join("clips"), shot, actual).unwrap();
            }
            let new_clips = resolve_clips(&run.join("clips"), &plan).unwrap();
            assert_eq!(new_clips.len(), clips.len());
            assert!(new_clips.iter().all(|path| {
                path.parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("by-id-")
            }));
        }
        let final_file = output.join("recovered-final.mp4");
        concat_final_video(FinalVideoContext {
            paths: &paths,
            plan: &plan,
            clips_root: &run.join("clips"),
            norm_directory: &run.join("normalized"),
            voice_directory: &run.join("voice"),
            final_clips_directory: &run.join("final_clips"),
            final_file: &final_file,
            config: &config,
        })
        .unwrap();
        verify_video_clip(&ffprobe, &final_file).unwrap();
        assert_eq!(
            fs::read_dir(run.join("final_clips"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "mp4"))
                .count(),
            plan.shots.len()
        );
        let broken = TestDirectory::new("broken_media");
        let broken_clip = broken.0.join("corrupt.mp4");
        fs::write(&broken_clip, b"not a video").unwrap();
        assert!(verify_video_clip(&ffprobe, &broken_clip).is_err());
        println!(
            "Verified {} shots and final video: {}",
            clips.len(),
            final_file.display()
        );
    }

    #[test]
    fn spoken_captions_follow_narration_and_silent_segments_keep_display_text() {
        let mut shot: Shot = serde_json::from_value(serde_json::json!({
            "shot": 1, "title": "码垛前序检查流程",
            "voice_text": "食品饮料码垛，先看包装怎样到位，再看机械臂如何抓取和落放。",
            "subtitle": "包装到位 → 抓取 → 落放"
        }))
        .unwrap();
        assert_eq!(
            segment_subtitle(&shot, true),
            shot.voice_text.as_deref().unwrap()
        );
        assert_eq!(segment_subtitle(&shot, false), "包装到位 → 抓取 → 落放");
        shot.voiceover = Some(false);
        assert_eq!(segment_subtitle(&shot, true), "包装到位 → 抓取 → 落放");
        shot.voiceover = Some(true);
        shot.voice_text = Some(" ".into());
        assert_eq!(segment_subtitle(&shot, true), "包装到位 → 抓取 → 落放");
        shot.voice_text = Some("Updated spoken sentence.".into());
        assert_eq!(segment_subtitle(&shot, true), "Updated spoken sentence.");
    }

    #[test]
    fn progress_labels_remove_short_prefixes_and_trailing_details() {
        assert_eq!(
            clean_progress_label("模块一：核心标题，补充说明"),
            "核心标题"
        );
        assert_eq!(
            clean_progress_label("Module: Main title; details"),
            "Main title"
        );
        assert_eq!(clean_progress_label("   "), "分镜");
        assert_eq!(
            clean_progress_label("Precision engineering improves manufacturing reliability"),
            "Precision engineering improves manufacturing reliability"
        );
    }

    #[test]
    fn concat_list_entries_normalize_windows_separators() {
        assert_eq!(
            concat_list_entry(Path::new(r"C:\clips\001_final.mp4")),
            "file 'C:/clips/001_final.mp4'"
        );
    }

    #[test]
    fn concat_list_entries_escape_single_quotes_for_ffmpeg_tokens() {
        assert_eq!(
            concat_list_entry(Path::new(r"C:\clips\director's\001_final.mp4")),
            "file 'C:/clips/director'\\''s/001_final.mp4'"
        );
    }
}
