//! Content-addressed, verified normalization shared across shots and runs.
use crate::{
    checkpoint::hash_file,
    logging::log_line,
    models::AppPaths,
    persistence::write_json_pretty_atomic,
    process::run_command_output_timeout_quiet,
    video_encoder::{VideoEncoder, run_video_encode_with_fallback, selected_video_encoder},
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

const CONTRACT: &str = "h264-index-normalization-v1";

#[derive(Clone)]
pub(crate) struct NormalizationCache {
    root: PathBuf,
    ffmpeg: PathBuf,
    ffmpeg_sha256: String,
    quality: u8,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheReceipt {
    schema_version: u32,
    source_sha256: String,
    source_size: u64,
    normalized_sha256: String,
    normalized_size: u64,
    normalization_profile: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct SourceSidecar {
    schema_version: u32,
    source_path: PathBuf,
    source_sha256: String,
    source_size: u64,
    normalized_sha256: String,
    normalized_size: u64,
    normalization_profile: Value,
    time_mapping: String,
}

pub(crate) struct CacheOutcome {
    pub(crate) created: bool,
}

fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}

fn source_sidecar(output: &Path) -> PathBuf {
    let mut name = output.as_os_str().to_os_string();
    name.push(".source.json");
    PathBuf::from(name)
}

fn temporary(parent: &Path, suffix: &str) -> PathBuf {
    parent.join(format!(
        ".normalize-{}-{}.{suffix}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

// OS locks are released even when the engine is killed. A stale lock filename is harmless.
fn lock_source(root: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("normalize.lock"))?;
    let started = Instant::now();
    let mut reported = false;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) => {
                if !reported {
                    println!("等待相同素材的标准化任务完成，将复用其结果");
                    reported = true;
                }
                if started.elapsed() > Duration::from_secs(30 * 60) {
                    bail!("等待素材标准化缓存超时，请稍后继续任务");
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

impl NormalizationCache {
    pub(crate) fn new(paths: &AppPaths) -> Result<Self> {
        let ffmpeg = fs::canonicalize(
            paths
                .ffmpeg
                .as_ref()
                .context("找不到 ffmpeg 视频处理工具")?,
        )?;
        let root = paths
            .data_root
            .join("video")
            .join("normalization-cache")
            .join("v1");
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: fs::canonicalize(root)?,
            ffmpeg_sha256: hash_file(&ffmpeg)?,
            ffmpeg,
            quality: 23,
        })
    }

    fn command(&self, input: &Path, output: &Path, encoder: VideoEncoder) -> Command {
        let mut command = Command::new(&self.ffmpeg);
        command
            .args(["-y", "-i"])
            .arg(input)
            .args(["-map", "0:v:0", "-map", "0:a?", "-vf"])
            .arg(format!(
                "scale='min(1920,iw)':-2,fps=30,format={}",
                encoder.pixel_format()
            ));
        encoder.append_ffmpeg_args(&mut command, self.quality);
        command
            .args([
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ])
            .arg(output);
        command
    }

    fn profile(&self, encoder: VideoEncoder) -> Value {
        let command = self.command(Path::new("$SOURCE"), Path::new("$OUTPUT"), encoder);
        json!({
            "contract": CONTRACT, "ffmpeg_sha256": self.ffmpeg_sha256,
            "encoder": encoder.key(),
            "ffmpeg_arguments": command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()
        })
    }

    fn verify_video(&self, video: &Path) -> Result<()> {
        let probe = self
            .ffmpeg
            .with_file_name(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
        let output = run_command_output_timeout_quiet(
            Command::new(probe).args(["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration", "-of", "json"]).arg(video),
            "验证标准化视频缓存", Duration::from_secs(30),
        )?;
        if !output.status.success() {
            bail!("标准化视频无法读取: {}", video.display());
        }
        let info: Value =
            serde_json::from_slice(&output.stdout).context("标准化视频媒体信息无效")?;
        let streams = info["streams"].as_array().context("标准化视频缺少媒体流")?;
        let duration = info["format"]["duration"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let video_ok = streams.iter().any(|stream| {
            let fps = stream["r_frame_rate"]
                .as_str()
                .and_then(|value| value.split_once('/'))
                .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
                .unwrap_or(0.0);
            stream["codec_type"] == "video"
                && stream["codec_name"] == "h264"
                && stream["width"]
                    .as_u64()
                    .is_some_and(|width| width > 0 && width <= 1920 && width % 2 == 0)
                && stream["height"]
                    .as_u64()
                    .is_some_and(|height| height > 0 && height % 2 == 0)
                && (fps - 30.0).abs() < 0.01
        });
        let audio_ok = streams
            .iter()
            .filter(|stream| stream["codec_type"] == "audio")
            .all(|stream| {
                stream["codec_name"] == "aac"
                    && stream["sample_rate"] == "48000"
                    && stream["channels"] == 2
            });
        if !video_ok || !audio_ok || !duration.is_finite() || duration <= 0.0 {
            bail!(
                "标准化视频不符合 H.264/30fps 标准或时长无效: {}",
                video.display()
            );
        }
        Ok(())
    }

    fn verified_entry(
        &self,
        directory: &Path,
        source_hash: &str,
        source_size: u64,
        profile: &Value,
    ) -> Option<CacheReceipt> {
        let receipt: CacheReceipt =
            serde_json::from_slice(&fs::read(directory.join("receipt.json")).ok()?).ok()?;
        let video = fs::canonicalize(directory.join("video.mp4")).ok()?;
        if !video.starts_with(&self.root)
            || !video.is_file()
            || receipt.schema_version != 1
            || receipt.source_sha256 != source_hash
            || receipt.source_size != source_size
            || receipt.normalization_profile != *profile
            || receipt.normalized_size == 0
            || fs::metadata(&video).ok()?.len() != receipt.normalized_size
            || hash_file(&video).ok()? != receipt.normalized_sha256
            || self.verify_video(&video).is_err()
        {
            return None;
        }
        Some(receipt)
    }

    pub(crate) fn normalize(
        &self,
        paths: &AppPaths,
        input: &Path,
        output: &Path,
    ) -> Result<CacheOutcome> {
        self.normalize_with(input, output, selected_video_encoder(paths), |temporary| {
            let actual = Cell::new(selected_video_encoder(paths));
            run_video_encode_with_fallback(
                paths,
                temporary,
                "ffmpeg normalize-download",
                None,
                |encoder| {
                    actual.set(encoder);
                    self.command(input, temporary, encoder)
                },
            )?;
            Ok(actual.get())
        })
    }

    fn normalize_with(
        &self,
        input: &Path,
        output: &Path,
        preferred: VideoEncoder,
        encode: impl FnOnce(&Path) -> Result<VideoEncoder>,
    ) -> Result<CacheOutcome> {
        let source = fs::canonicalize(input)?;
        let source_size = fs::metadata(&source)?.len();
        if !source.is_file() || source_size == 0 {
            bail!("待标准化素材为空或不是文件: {}", input.display());
        }
        let source_hash = hash_file(&source)?;
        let source_root = self.root.join(&source_hash);
        fs::create_dir_all(&source_root)?;
        let source_root = fs::canonicalize(source_root)?;
        if !source_root.starts_with(&self.root) {
            bail!("素材缓存目录超出工作区缓存范围");
        }
        let _lock = lock_source(&source_root)?;
        let preferred_profile = self.profile(preferred);
        let preferred_directory = source_root.join(digest(&preferred_profile));
        let (directory, receipt, created) = if let Some(receipt) = self.verified_entry(
            &preferred_directory,
            &source_hash,
            source_size,
            &preferred_profile,
        ) {
            (preferred_directory, receipt, false)
        } else {
            let temporary = Temporary(temporary(&source_root, "mp4"));
            let actual = encode(&temporary.0)?;
            self.verify_video(&temporary.0)?;
            if fs::metadata(&source)?.len() != source_size || hash_file(&source)? != source_hash {
                bail!("标准化过程中源素材发生变化，请重新尝试");
            }
            let profile = self.profile(actual);
            let directory = source_root.join(digest(&profile));
            fs::create_dir_all(&directory)?;
            let directory = fs::canonicalize(directory)?;
            if !directory.starts_with(&self.root) {
                bail!("素材缓存目录超出工作区缓存范围");
            }
            let receipt = CacheReceipt {
                schema_version: 1,
                source_sha256: source_hash.clone(),
                source_size,
                normalized_sha256: hash_file(&temporary.0)?,
                normalized_size: fs::metadata(&temporary.0)?.len(),
                normalization_profile: profile,
            };
            // Replace the inode, never overwrite it: other shots may still hard-link the old entry.
            let cache_video = directory.join("video.mp4");
            if cache_video.exists() {
                fs::remove_file(&cache_video)?;
            }
            fs::rename(&temporary.0, &cache_video)?;
            write_json_pretty_atomic(&directory.join("receipt.json"), &receipt)?;
            (directory, receipt, true)
        };
        if fs::metadata(&source)?.len() != source_size || hash_file(&source)? != source_hash {
            bail!("源素材在缓存复用前发生变化，请重新尝试");
        }
        let parent = output.parent().context("标准化输出缺少目录")?;
        fs::create_dir_all(parent)?;
        let already_valid = fs::symlink_metadata(output)
            .is_ok_and(|info| info.is_file() && info.len() == receipt.normalized_size)
            && hash_file(output).ok().as_ref() == Some(&receipt.normalized_sha256);
        if !already_valid {
            let projected = Temporary(temporary(parent, "mp4"));
            let cached_video = directory.join("video.mp4");
            if fs::hard_link(&cached_video, &projected.0).is_err() {
                fs::copy(&cached_video, &projected.0)?;
            }
            if hash_file(&projected.0)? != receipt.normalized_sha256 {
                bail!("标准化缓存复制校验失败");
            }
            if output.exists() {
                fs::remove_file(output)?;
            }
            fs::rename(&projected.0, output)?;
        }
        let sidecar = SourceSidecar {
            schema_version: 1,
            source_path: source,
            source_sha256: source_hash,
            source_size,
            normalized_sha256: receipt.normalized_sha256,
            normalized_size: receipt.normalized_size,
            normalization_profile: receipt.normalization_profile,
            time_mapping: "identity".into(),
        };
        write_json_pretty_atomic(&source_sidecar(output), &sidecar)?;
        let message = format!(
            "标准化缓存{}: {}",
            if created { "已建立" } else { "已复用" },
            output.display()
        );
        println!("{message}");
        log_line(message);
        Ok(CacheOutcome { created })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    };

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            // 进程内原子计数器：并行测试线程可能拿到同一个时间戳（与 clip_manifest 同一类偶发）
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "vacut-normalization-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                chrono::Utc::now().timestamp_nanos_opt().unwrap()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn paths(root: &Path) -> AppPaths {
        let runtime = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("VideoAutoCut");
        AppPaths {
            root: runtime.clone(),
            data_root: root.into(),
            env_path: root.join("unused.env"),
            yt_dlp: root.join("must-not-execute"),
            sentrysearch: root.join("must-not-execute"),
            sentry_py: None,
            ffmpeg: Some(
                runtime
                    .join("ffmpeg/bin")
                    .join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)),
            ),
            node: None,
            runs_dir: root.join("video/runs"),
            archive: root.join("unused-archive"),
        }
    }
    fn fake_cache() -> NormalizationCache {
        NormalizationCache {
            root: PathBuf::new(),
            ffmpeg: "ffmpeg".into(),
            ffmpeg_sha256: "ffmpeg-one".into(),
            quality: 23,
        }
    }

    #[test]
    fn profile_keys_include_encoder_binary_and_all_encode_arguments_but_not_source_paths() {
        let cache = fake_cache();
        let profile = cache.profile(VideoEncoder::CpuX264);
        let args = profile["ffmpeg_arguments"].as_array().unwrap();
        for argument in [
            "$SOURCE",
            "$OUTPUT",
            "-crf",
            "23",
            "-g",
            "60",
            "-ar",
            "48000",
            "-ac",
            "2",
            "+faststart",
        ] {
            assert!(args.contains(&json!(argument)), "profile misses {argument}");
        }
        assert_ne!(
            digest(&profile),
            digest(&cache.profile(VideoEncoder::NvidiaNvenc))
        );
        let mut changed = cache.clone();
        changed.quality = 24;
        assert_ne!(
            digest(&profile),
            digest(&changed.profile(VideoEncoder::CpuX264))
        );
        changed = cache.clone();
        changed.ffmpeg_sha256 = "another-build".into();
        assert_ne!(
            digest(&profile),
            digest(&changed.profile(VideoEncoder::CpuX264))
        );
        assert_eq!(
            source_sidecar(Path::new("example.mp4")),
            PathBuf::from("example.mp4.source.json")
        );
    }

    fn make_source(cache: &NormalizationCache, output: &Path, color: &str, size: &str) {
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        let result = run_command_output_timeout_quiet(
            Command::new(&cache.ffmpeg)
                .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("color=c={color}:s={size}:r=24"))
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=600:sample_rate=44100",
                    "-t",
                    "0.8",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                ])
                .arg(output),
            "隔离短视频测试素材",
            Duration::from_secs(30),
        )
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    fn encode(
        cache: &NormalizationCache,
        input: &Path,
        output: &Path,
        calls: &AtomicUsize,
    ) -> Result<VideoEncoder> {
        calls.fetch_add(1, Ordering::SeqCst);
        let result = run_command_output_timeout_quiet(
            &mut cache.command(input, output, VideoEncoder::CpuX264),
            "真实标准化缓存回归",
            Duration::from_secs(30),
        )?;
        if !result.status.success() {
            bail!(
                "FFmpeg test encode failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        Ok(VideoEncoder::CpuX264)
    }

    #[test]
    #[ignore = "Requires bundled FFmpeg/ffprobe; isolated real-media regression, no models or user data"]
    fn real_three_sources_two_shots_and_new_task_encode_only_three_times() {
        let root = TestRoot::new();
        let cache = NormalizationCache::new(&paths(&root.0)).unwrap();
        let calls = AtomicUsize::new(0);
        let first = root.0.join("任务一/01 · 原素材");
        let second = root.0.join("任务一/02 · 相同素材不同路径");
        fs::create_dir_all(&second).unwrap();
        for (index, (color, size)) in [
            ("red", "320x240"),
            ("blue", "426x240"),
            ("green", "240x320"),
        ]
        .into_iter()
        .enumerate()
        {
            let a = first.join(format!("素材{index}.mp4"));
            let b = second.join(format!("重命名{index}.mp4"));
            make_source(&cache, &a, color, size);
            fs::copy(&a, &b).unwrap();
            let output = first.join("_indexed_h264").join(format!("{index}.mp4"));
            assert!(
                cache
                    .normalize_with(&a, &output, VideoEncoder::CpuX264, |temp| encode(
                        &cache, &a, temp, &calls
                    ))
                    .unwrap()
                    .created
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        for index in 0..3 {
            let b = second.join(format!("重命名{index}.mp4"));
            let output = second.join("_indexed_h264").join(format!("{index}.mp4"));
            assert!(
                !cache
                    .normalize_with(
                        &b,
                        &output,
                        VideoEncoder::CpuX264,
                        |_| -> Result<VideoEncoder> {
                            panic!("second shot must not launch FFmpeg")
                        }
                    )
                    .unwrap()
                    .created
            );
            let sidecar: SourceSidecar =
                serde_json::from_slice(&fs::read(source_sidecar(&output)).unwrap()).unwrap();
            assert_eq!(sidecar.source_path, fs::canonicalize(&b).unwrap());
            assert_eq!(sidecar.source_sha256, hash_file(&b).unwrap());
            assert_eq!(sidecar.normalized_sha256, hash_file(&output).unwrap());
            assert_eq!(sidecar.time_mapping, "identity");
        }
        let next_process = NormalizationCache::new(&paths(&root.0)).unwrap();
        let output = root.0.join("任务二/_indexed_h264/legacy.mp4");
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        fs::write(&output, vec![b'x'; 8192]).unwrap();
        let source = first.join("素材0.mp4");
        next_process
            .normalize_with(
                &source,
                &output,
                VideoEncoder::CpuX264,
                |_| -> Result<VideoEncoder> { panic!("new task must use shared verified cache") },
            )
            .unwrap();
        next_process.verify_video(&output).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        println!(
            "REAL_NORMALIZATION_E2E: first_shot_encodes=3 second_shot_encodes=0 new_task_encodes=0"
        );
    }

    #[test]
    #[ignore = "Requires bundled FFmpeg/ffprobe; corruption and concurrent producer regression"]
    fn real_corruption_source_config_changes_and_parallel_producers_are_verified() {
        let root = TestRoot::new();
        let cache = NormalizationCache::new(&paths(&root.0)).unwrap();
        let a = root.0.join("source/a.mp4");
        let b = root.0.join("source/b.mp4");
        make_source(&cache, &a, "red", "320x240");
        make_source(&cache, &b, "blue", "320x240");
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        thread::scope(|scope| {
            for index in 0..2 {
                let (cache, a, calls, barrier) =
                    (cache.clone(), a.clone(), calls.clone(), barrier.clone());
                let output = root.0.join(format!("parallel/{index}.mp4"));
                scope.spawn(move || {
                    barrier.wait();
                    cache
                        .normalize_with(&a, &output, VideoEncoder::CpuX264, |temp| {
                            encode(&cache, &a, temp, &calls)
                        })
                        .unwrap();
                });
            }
        });
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "two parallel shots share one producer"
        );
        let old_source_hash = hash_file(&a).unwrap();
        let directory = cache
            .root
            .join(&old_source_hash)
            .join(digest(&cache.profile(VideoEncoder::CpuX264)));
        let normalized = directory.join("video.mp4");
        fs::write(&normalized, vec![b'x'; 8192]).unwrap();
        // Even a forged matching size/hash receipt cannot turn non-video bytes into valid cache.
        let mut receipt: CacheReceipt =
            serde_json::from_slice(&fs::read(directory.join("receipt.json")).unwrap()).unwrap();
        receipt.normalized_sha256 = hash_file(&normalized).unwrap();
        receipt.normalized_size = 8192;
        write_json_pretty_atomic(&directory.join("receipt.json"), &receipt).unwrap();
        let repaired = root.0.join("repaired/output.mp4");
        assert!(
            cache
                .normalize_with(&a, &repaired, VideoEncoder::CpuX264, |temp| encode(
                    &cache, &a, temp, &calls
                ))
                .unwrap()
                .created
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let mut changed = cache.clone();
        changed.quality = 24;
        assert!(
            changed
                .normalize_with(
                    &a,
                    &root.0.join("changed-profile/output.mp4"),
                    VideoEncoder::CpuX264,
                    |temp| encode(&changed, &a, temp, &calls)
                )
                .unwrap()
                .created
        );
        fs::copy(&b, &a).unwrap();
        assert!(
            cache
                .normalize_with(
                    &a,
                    &root.0.join("changed-source/output.mp4"),
                    VideoEncoder::CpuX264,
                    |temp| encode(&cache, &a, temp, &calls)
                )
                .unwrap()
                .created
        );
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        let sidecar: SourceSidecar = serde_json::from_slice(
            &fs::read(source_sidecar(&root.0.join("changed-source/output.mp4"))).unwrap(),
        )
        .unwrap();
        assert_ne!(sidecar.source_sha256, old_source_hash);
        assert_eq!(sidecar.source_sha256, hash_file(&b).unwrap());
        let failed = root.0.join("failed/output.mp4");
        changed.quality = 25;
        assert!(
            changed
                .normalize_with(&a, &failed, VideoEncoder::CpuX264, |temp| {
                    fs::write(temp, vec![b'x'; 8192])?;
                    Ok(VideoEncoder::CpuX264)
                })
                .is_err()
        );
        assert!(!failed.exists());
        assert!(!source_sidecar(&failed).exists());

        // A hardware fallback is stored under the encoder that really produced the bytes.
        let fallback = root.0.join("fallback/output.mp4");
        changed
            .normalize_with(&a, &fallback, VideoEncoder::NvidiaNvenc, |temp| {
                encode(&changed, &a, temp, &calls)
            })
            .unwrap();
        let sidecar: SourceSidecar =
            serde_json::from_slice(&fs::read(source_sidecar(&fallback)).unwrap()).unwrap();
        assert_eq!(sidecar.normalization_profile["encoder"], "cpu");
        changed
            .normalize_with(
                &a,
                &root.0.join("fallback-reuse/output.mp4"),
                VideoEncoder::CpuX264,
                |_| -> Result<VideoEncoder> { panic!("CPU fallback result must be cached as CPU") },
            )
            .unwrap();

        changed.quality = 26;
        let raced = root.0.join("source-race/output.mp4");
        assert!(
            changed
                .normalize_with(&a, &raced, VideoEncoder::CpuX264, |temp| {
                    let encoder = encode(&changed, &a, temp, &calls)?;
                    fs::copy(&repaired, &a)?;
                    Ok(encoder)
                })
                .is_err()
        );
        assert!(!raced.exists());
        assert!(!source_sidecar(&raced).exists());
    }
}
