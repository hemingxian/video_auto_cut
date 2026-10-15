use anyhow::{Result, anyhow};
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::logging::log_line;
use crate::models::AppPaths;
use crate::process::{run_command_output_timeout_quiet, run_command_timeout};

const BENCHMARK_ITEM_TIMEOUT: Duration = Duration::from_secs(8);
const BENCHMARK_TOTAL_TIMEOUT: Duration = Duration::from_secs(24);
const HARDWARE_ENCODE_MIN_TIMEOUT_SECONDS: u64 = 60;
const HARDWARE_ENCODE_MAX_TIMEOUT_SECONDS: u64 = 5 * 60;
const CPU_ENCODE_MIN_TIMEOUT_SECONDS: u64 = 2 * 60;
const CPU_ENCODE_MAX_TIMEOUT_SECONDS: u64 = 15 * 60;
// Four seconds is close to a normal shot and includes each encoder's startup cost.
// Shared scale/ASS filters are intentionally excluded because they cost the same
// regardless of encoder and would only make detection slower and noisier.
const BENCHMARK_FRAMES: usize = 120;
const HARDWARE_TOLERANCE: f64 = 1.05;

static SELECTED_ENCODER: OnceLock<Mutex<VideoEncoder>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct VideoEncodeTimeouts {
    hardware: Duration,
    cpu: Duration,
}

impl VideoEncodeTimeouts {
    fn for_expected_duration(expected_duration_seconds: Option<u64>) -> Self {
        let Some(duration) = expected_duration_seconds else {
            return Self {
                hardware: Duration::from_secs(HARDWARE_ENCODE_MAX_TIMEOUT_SECONDS),
                cpu: Duration::from_secs(CPU_ENCODE_MAX_TIMEOUT_SECONDS),
            };
        };

        Self {
            hardware: scaled_encode_timeout(
                duration,
                6,
                30,
                HARDWARE_ENCODE_MIN_TIMEOUT_SECONDS,
                HARDWARE_ENCODE_MAX_TIMEOUT_SECONDS,
            ),
            cpu: scaled_encode_timeout(
                duration,
                12,
                60,
                CPU_ENCODE_MIN_TIMEOUT_SECONDS,
                CPU_ENCODE_MAX_TIMEOUT_SECONDS,
            ),
        }
    }

    fn for_encoder(self, encoder: VideoEncoder) -> Duration {
        if encoder.is_hardware() {
            self.hardware
        } else {
            self.cpu
        }
    }
}

fn scaled_encode_timeout(
    duration_seconds: u64,
    multiplier: u64,
    padding_seconds: u64,
    minimum_seconds: u64,
    maximum_seconds: u64,
) -> Duration {
    let seconds = duration_seconds
        .saturating_mul(multiplier)
        .saturating_add(padding_seconds)
        .clamp(minimum_seconds, maximum_seconds);
    Duration::from_secs(seconds)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoEncoder {
    NvidiaNvenc,
    AmdAmf,
    IntelQsv,
    CpuX264,
}

impl VideoEncoder {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::NvidiaNvenc => "nvidia",
            Self::AmdAmf => "amd",
            Self::IntelQsv => "intel",
            Self::CpuX264 => "cpu",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::NvidiaNvenc => "NVIDIA NVENC",
            Self::AmdAmf => "AMD AMF",
            Self::IntelQsv => "Intel Quick Sync",
            Self::CpuX264 => "CPU (libx264)",
        }
    }

    pub(crate) fn is_hardware(self) -> bool {
        self != Self::CpuX264
    }

    pub(crate) fn pixel_format(self) -> &'static str {
        match self {
            Self::IntelQsv | Self::AmdAmf => "nv12",
            Self::NvidiaNvenc | Self::CpuX264 => "yuv420p",
        }
    }

    pub(crate) fn append_ffmpeg_args(self, command: &mut Command, quality: u8) {
        let quality = quality.clamp(1, 51);
        command.arg("-pix_fmt").arg(self.pixel_format());

        match self {
            Self::NvidiaNvenc => {
                command
                    .arg("-c:v")
                    .arg("h264_nvenc")
                    .arg("-preset")
                    .arg("p4")
                    .arg("-tune")
                    .arg("hq")
                    .arg("-rc")
                    .arg("constqp")
                    .arg("-qp")
                    .arg(quality.to_string());
            }
            Self::AmdAmf => {
                command
                    .arg("-c:v")
                    .arg("h264_amf")
                    .arg("-usage")
                    .arg("transcoding")
                    .arg("-quality")
                    .arg("balanced")
                    .arg("-rc")
                    .arg("cqp")
                    .arg("-qp_i")
                    .arg(quality.saturating_sub(2).max(1).to_string())
                    .arg("-qp_p")
                    .arg(quality.to_string())
                    .arg("-qp_b")
                    .arg(quality.saturating_add(2).min(51).to_string());
            }
            Self::IntelQsv => {
                command
                    .arg("-c:v")
                    .arg("h264_qsv")
                    .arg("-preset")
                    .arg("veryfast")
                    .arg("-global_quality")
                    .arg(quality.to_string());
            }
            Self::CpuX264 => {
                command
                    .arg("-c:v")
                    .arg("libx264")
                    .arg("-preset")
                    .arg("veryfast")
                    .arg("-crf")
                    .arg(quality.to_string());
            }
        }

        command.arg("-profile:v").arg("high").arg("-g").arg("60");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncoderPreference {
    Auto,
    Nvidia,
    Amd,
    Intel,
    Cpu,
}

fn configured_preference() -> EncoderPreference {
    let value = env::var("VIDEOAUTO_VIDEO_ENCODER")
        .ok()
        .or_else(|| env::var("VIDEO_ENCODER").ok())
        .unwrap_or_else(|| "auto".to_string());

    match value.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => EncoderPreference::Auto,
        "cpu" | "software" | "x264" | "libx264" => EncoderPreference::Cpu,
        "nvidia" | "nvenc" | "h264_nvenc" => EncoderPreference::Nvidia,
        "amd" | "amf" | "h264_amf" => EncoderPreference::Amd,
        "intel" | "qsv" | "h264_qsv" => EncoderPreference::Intel,
        other => {
            let message = format!("[警告] 未识别的视频编码模式 {other}，改为自动测速");
            println!("{message}");
            log_line(&message);
            EncoderPreference::Auto
        }
    }
}

fn preference_candidates(preference: EncoderPreference) -> Vec<VideoEncoder> {
    match preference {
        EncoderPreference::Auto => vec![
            VideoEncoder::NvidiaNvenc,
            VideoEncoder::AmdAmf,
            VideoEncoder::IntelQsv,
            VideoEncoder::CpuX264,
        ],
        EncoderPreference::Nvidia => vec![VideoEncoder::NvidiaNvenc],
        EncoderPreference::Amd => vec![VideoEncoder::AmdAmf],
        EncoderPreference::Intel => vec![VideoEncoder::IntelQsv],
        EncoderPreference::Cpu => vec![VideoEncoder::CpuX264],
    }
}

fn benchmark_command(ffmpeg: &Path, encoder: VideoEncoder, frames: usize) -> Command {
    let mut command = Command::new(ffmpeg);
    let filter = format!("format={}", encoder.pixel_format());

    command
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("testsrc2=size=1920x1080:rate=30")
        .arg("-frames:v")
        .arg(frames.to_string())
        .arg("-vf")
        .arg(filter)
        .arg("-an");
    encoder.append_ffmpeg_args(&mut command, 20);
    command.arg("-f").arg("null").arg("-");
    command
}

fn timed_benchmark(
    ffmpeg: &Path,
    encoder: VideoEncoder,
    frames: usize,
    timeout: Duration,
) -> Result<Duration> {
    let mut command = benchmark_command(ffmpeg, encoder, frames);
    let started = Instant::now();
    let output = run_command_output_timeout_quiet(
        &mut command,
        &format!("video encoder benchmark: {}", encoder.label()),
        timeout,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(anyhow!("{} 不可用: {}", encoder.label(), detail.trim()));
    }
    Ok(started.elapsed())
}

fn measure_encoder(ffmpeg: &Path, encoder: VideoEncoder, timeout: Duration) -> Option<Duration> {
    match timed_benchmark(ffmpeg, encoder, BENCHMARK_FRAMES, timeout) {
        Ok(elapsed) => Some(elapsed),
        Err(error) => {
            let message = format!("编码器不可用或测速超时: {} ({error:#})", encoder.label());
            println!("{message}");
            log_line(&message);
            None
        }
    }
}

fn benchmark_item_timeout(total_elapsed: Duration) -> Option<Duration> {
    let remaining = BENCHMARK_TOTAL_TIMEOUT.checked_sub(total_elapsed)?;
    if remaining.is_zero() {
        return None;
    }
    Some(remaining.min(BENCHMARK_ITEM_TIMEOUT))
}

fn choose_auto_encoder(results: &[(VideoEncoder, Duration)]) -> VideoEncoder {
    let cpu = results
        .iter()
        .find(|(encoder, _)| *encoder == VideoEncoder::CpuX264)
        .copied();
    let hardware = results
        .iter()
        .filter(|(encoder, _)| encoder.is_hardware())
        .min_by_key(|(_, elapsed)| *elapsed)
        .copied();

    match (hardware, cpu) {
        (Some((hardware_encoder, hardware_time)), Some((_, cpu_time)))
            if hardware_time <= cpu_time.mul_f64(HARDWARE_TOLERANCE) =>
        {
            hardware_encoder
        }
        (_, Some((cpu_encoder, _))) => cpu_encoder,
        (Some((hardware_encoder, _)), None) => hardware_encoder,
        (None, None) => VideoEncoder::CpuX264,
    }
}

fn detect_video_encoder(paths: &AppPaths) -> VideoEncoder {
    let preference = configured_preference();
    if preference == EncoderPreference::Cpu {
        let message = "视频编码: 已指定 CPU (libx264)";
        println!("{message}");
        log_line(message);
        return VideoEncoder::CpuX264;
    }

    let Some(ffmpeg) = paths.ffmpeg.as_deref() else {
        let message = "[警告] 未找到 FFmpeg，视频编码暂按 CPU 配置";
        println!("{message}");
        log_line(message);
        return VideoEncoder::CpuX264;
    };

    println!("视频编码器首次使用，正在进行一次性自动测速...");
    let candidates = preference_candidates(preference);
    let mut results = Vec::new();
    let benchmark_started = Instant::now();
    for encoder in candidates {
        let Some(timeout) = benchmark_item_timeout(benchmark_started.elapsed()) else {
            let message = format!(
                "[警告] 视频编码器测速达到总时限（{} 秒），停止测试剩余候选",
                BENCHMARK_TOTAL_TIMEOUT.as_secs(),
            );
            println!("{message}");
            log_line(&message);
            break;
        };
        if let Some(elapsed) = measure_encoder(ffmpeg, encoder, timeout) {
            println!(
                "编码器测速: {} {:.3} 秒",
                encoder.label(),
                elapsed.as_secs_f64()
            );
            log_line(format!(
                "编码器测速: {} {:.3} 秒",
                encoder.label(),
                elapsed.as_secs_f64(),
            ));
            results.push((encoder, elapsed));
        }
    }

    let selected = if preference == EncoderPreference::Auto {
        choose_auto_encoder(&results)
    } else {
        results
            .iter()
            .find(|(encoder, _)| encoder.is_hardware())
            .map(|(encoder, _)| *encoder)
            .unwrap_or(VideoEncoder::CpuX264)
    };
    let message = format!("视频编码器已选择: {}", selected.label());
    println!("{message}");
    log_line(&message);
    selected
}

pub(crate) fn selected_video_encoder(paths: &AppPaths) -> VideoEncoder {
    let state = SELECTED_ENCODER.get_or_init(|| Mutex::new(detect_video_encoder(paths)));
    *state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn force_cpu_encoder(failed: VideoEncoder, reason: &str) {
    if !failed.is_hardware() {
        return;
    }
    let Some(state) = SELECTED_ENCODER.get() else {
        return;
    };
    let mut selected = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *selected != failed {
        return;
    }

    let message = format!(
        "[警告] {} 正式编码失败，当前任务改用 CPU (libx264): {reason}",
        failed.label(),
    );
    println!("{message}");
    log_line(&message);
    *selected = VideoEncoder::CpuX264;
}

pub(crate) fn run_video_encode_with_fallback(
    paths: &AppPaths,
    output: &Path,
    label: &str,
    expected_duration_seconds: Option<u64>,
    build_command: impl Fn(VideoEncoder) -> Command,
) -> Result<()> {
    let selected = selected_video_encoder(paths);
    let timeouts = VideoEncodeTimeouts::for_expected_duration(expected_duration_seconds);
    run_video_encode_with_fallback_inner(
        selected,
        output,
        label,
        timeouts,
        &build_command,
        run_command_timeout,
        force_cpu_encoder,
    )
}

fn run_video_encode_with_fallback_inner(
    selected: VideoEncoder,
    output: &Path,
    label: &str,
    timeouts: VideoEncodeTimeouts,
    build_command: &impl Fn(VideoEncoder) -> Command,
    mut run_command: impl FnMut(&mut Command, &str, Duration) -> Result<()>,
    mut on_hardware_failure: impl FnMut(VideoEncoder, &str),
) -> Result<()> {
    let first_result = run_video_encode_attempt(
        selected,
        output,
        label,
        timeouts,
        build_command,
        &mut run_command,
    );
    if first_result.is_ok() || !selected.is_hardware() {
        return first_result;
    }

    let hardware_error = first_result.expect_err("hardware failure must contain an error");
    on_hardware_failure(selected, &format!("{hardware_error:#}"));
    run_video_encode_attempt(
        VideoEncoder::CpuX264,
        output,
        &format!("{label} (CPU fallback)"),
        timeouts,
        build_command,
        &mut run_command,
    )
}

fn run_video_encode_attempt(
    encoder: VideoEncoder,
    output: &Path,
    label: &str,
    timeouts: VideoEncodeTimeouts,
    build_command: &impl Fn(VideoEncoder) -> Command,
    run_command: &mut impl FnMut(&mut Command, &str, Duration) -> Result<()>,
) -> Result<()> {
    let mut command = build_command(encoder);
    let result = run_command(&mut command, label, timeouts.for_encoder(encoder))
        .and_then(|_| validate_output(output, label));
    if result.is_err() && output.exists() {
        let _ = fs::remove_file(output);
    }
    result
}

fn validate_output(output: &Path, label: &str) -> Result<()> {
    let length = output
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if length <= 1024 {
        return Err(anyhow!("{label} 未生成有效视频文件: {}", output.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestOutput(PathBuf);

    impl TestOutput {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos();
            Self(env::temp_dir().join(format!(
                "video-auto-cut-encoder-{name}-{}-{nonce}.mp4",
                std::process::id(),
            )))
        }
    }

    impl Drop for TestOutput {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn auto_prefers_cpu_when_hardware_is_meaningfully_slower() {
        let selected = choose_auto_encoder(&[
            (VideoEncoder::IntelQsv, Duration::from_millis(900)),
            (VideoEncoder::CpuX264, Duration::from_millis(700)),
        ]);
        assert_eq!(selected, VideoEncoder::CpuX264);
    }

    #[test]
    fn auto_prefers_hardware_when_it_is_faster_or_nearly_equal() {
        let selected = choose_auto_encoder(&[
            (VideoEncoder::NvidiaNvenc, Duration::from_millis(720)),
            (VideoEncoder::IntelQsv, Duration::from_millis(680)),
            (VideoEncoder::CpuX264, Duration::from_millis(700)),
        ]);
        assert_eq!(selected, VideoEncoder::IntelQsv);
    }

    #[test]
    fn encoder_arguments_keep_quality_controls_separate() {
        let mut qsv = Command::new("ffmpeg");
        VideoEncoder::IntelQsv.append_ffmpeg_args(&mut qsv, 20);
        let qsv_args = qsv
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(qsv_args.iter().any(|value| value == "h264_qsv"));
        assert!(qsv_args.iter().any(|value| value == "-global_quality"));
        assert!(!qsv_args.iter().any(|value| value == "-crf"));

        let mut cpu = Command::new("ffmpeg");
        VideoEncoder::CpuX264.append_ffmpeg_args(&mut cpu, 20);
        let cpu_args = cpu
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(cpu_args.iter().any(|value| value == "libx264"));
        assert!(cpu_args.iter().any(|value| value == "-crf"));
    }

    #[test]
    fn benchmark_budget_caps_each_candidate_and_the_whole_detection() {
        assert_eq!(
            benchmark_item_timeout(Duration::ZERO),
            Some(BENCHMARK_ITEM_TIMEOUT)
        );
        assert_eq!(
            benchmark_item_timeout(BENCHMARK_TOTAL_TIMEOUT - Duration::from_secs(2)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(benchmark_item_timeout(BENCHMARK_TOTAL_TIMEOUT), None);
        assert_eq!(
            benchmark_item_timeout(BENCHMARK_TOTAL_TIMEOUT + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn formal_encode_timeouts_scale_with_duration_and_stay_bounded() {
        let short = VideoEncodeTimeouts::for_expected_duration(Some(1));
        assert_eq!(short.hardware, Duration::from_secs(60));
        assert_eq!(short.cpu, Duration::from_secs(120));

        let typical = VideoEncodeTimeouts::for_expected_duration(Some(10));
        assert_eq!(typical.hardware, Duration::from_secs(90));
        assert_eq!(typical.cpu, Duration::from_secs(180));

        let long = VideoEncodeTimeouts::for_expected_duration(Some(10_000));
        assert_eq!(long.hardware, Duration::from_secs(5 * 60));
        assert_eq!(long.cpu, Duration::from_secs(15 * 60));

        let unknown = VideoEncodeTimeouts::for_expected_duration(None);
        assert_eq!(unknown.hardware, Duration::from_secs(5 * 60));
        assert_eq!(unknown.cpu, Duration::from_secs(15 * 60));
    }

    #[test]
    fn hardware_failure_removes_partial_output_before_cpu_retry() {
        let output = TestOutput::new("hardware-fallback");
        let attempts = RefCell::new(Vec::new());
        let fallback_called = Cell::new(false);
        let timeouts = VideoEncodeTimeouts::for_expected_duration(Some(10));

        run_video_encode_with_fallback_inner(
            VideoEncoder::NvidiaNvenc,
            &output.0,
            "test encode",
            timeouts,
            &|encoder| {
                let mut command = Command::new("unused-test-command");
                command.arg(encoder.key());
                command
            },
            |command, _, timeout| {
                let encoder = command
                    .get_args()
                    .next()
                    .expect("encoder argument")
                    .to_string_lossy()
                    .into_owned();
                attempts.borrow_mut().push(encoder.clone());
                if encoder == "nvidia" {
                    assert_eq!(timeout, timeouts.hardware);
                    fs::write(&output.0, b"partial hardware output")?;
                    return Err(anyhow!("simulated hardware timeout"));
                }

                assert_eq!(timeout, timeouts.cpu);
                assert!(
                    !output.0.exists(),
                    "partial hardware output must be removed before CPU retry"
                );
                fs::write(&output.0, vec![0_u8; 2048])?;
                Ok(())
            },
            |encoder, reason| {
                assert_eq!(encoder, VideoEncoder::NvidiaNvenc);
                assert!(reason.contains("simulated hardware timeout"));
                fallback_called.set(true);
            },
        )
        .expect("CPU fallback should succeed");

        assert_eq!(attempts.into_inner(), ["nvidia", "cpu"]);
        assert!(fallback_called.get());
        assert!(output.0.exists());
    }

    #[test]
    fn cpu_failure_does_not_retry_and_removes_partial_output() {
        let output = TestOutput::new("cpu-failure");
        let attempts = Cell::new(0_u8);
        let fallback_called = Cell::new(false);
        let timeouts = VideoEncodeTimeouts::for_expected_duration(None);

        let error = run_video_encode_with_fallback_inner(
            VideoEncoder::CpuX264,
            &output.0,
            "test CPU encode",
            timeouts,
            &|_| Command::new("unused-test-command"),
            |_, _, timeout| {
                assert_eq!(timeout, timeouts.cpu);
                attempts.set(attempts.get() + 1);
                fs::write(&output.0, b"partial CPU output")?;
                Err(anyhow!("simulated CPU timeout"))
            },
            |_, _| fallback_called.set(true),
        )
        .expect_err("CPU timeout must be returned");

        assert!(error.to_string().contains("simulated CPU timeout"));
        assert_eq!(attempts.get(), 1);
        assert!(!fallback_called.get());
        assert!(!output.0.exists());
    }

    #[test]
    #[ignore = "requires the bundled FFmpeg and may use local GPU hardware"]
    fn bundled_ffmpeg_benchmark_smoke() {
        let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("VideoAutoCut")
            .join("ffmpeg")
            .join("bin")
            .join("ffmpeg.exe");
        assert!(
            ffmpeg.is_file(),
            "bundled FFmpeg is missing: {}",
            ffmpeg.display()
        );

        let mut results = Vec::new();
        for encoder in [
            VideoEncoder::NvidiaNvenc,
            VideoEncoder::AmdAmf,
            VideoEncoder::IntelQsv,
            VideoEncoder::CpuX264,
        ] {
            if let Some(elapsed) = measure_encoder(&ffmpeg, encoder, BENCHMARK_ITEM_TIMEOUT) {
                println!("{}: {:.3}s", encoder.label(), elapsed.as_secs_f64());
                results.push((encoder, elapsed));
            }
        }

        assert!(
            results
                .iter()
                .any(|(encoder, _)| *encoder == VideoEncoder::CpuX264)
        );
        let selected = choose_auto_encoder(&results);
        assert!(results.iter().any(|(encoder, _)| *encoder == selected));
        println!("selected: {}", selected.label());
    }
}
